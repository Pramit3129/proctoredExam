import type { NextRequest } from "next/server";

import { MAX_PDF_BYTES, PdfReadError, extractPdfLines } from "@/lib/exam-import/extract";
import { parseExamPapers } from "@/lib/exam-import/parse";
import type { ParsePreview } from "@/lib/exam-types";
import { requireAdmin } from "@/lib/server/auth";
import { sha256Hex } from "@/lib/server/crypto";
import { HttpError, assertSameOrigin, handler, json, readForm } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";

async function readPdf(form: FormData, field: string, label: string): Promise<{ name: string; bytes: Uint8Array }> {
  const file = form.get(field);
  if (!(file instanceof File)) throw new HttpError(400, "missing_file", `Choose the ${label} PDF.`);
  if (file.size > MAX_PDF_BYTES) throw new HttpError(413, "too_large", `The ${label} PDF is larger than 10 MB.`);
  const name = file.name.replace(/[^\w .()-]/g, "_").slice(0, 120) || `${field}.pdf`;
  return { name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Parses the question paper and answer key into a preview. Nothing is saved. */
export const POST = handler(async (req: NextRequest) => {
  assertSameOrigin(req);
  const admin = await requireAdmin(req);
  rateLimit(`admin-parse:${admin.id}`, 0.5, 6);
  const form = await readForm(req, 2 * MAX_PDF_BYTES + 64 * 1024);
  const questions = await readPdf(form, "questions", "question paper");
  const answers = await readPdf(form, "answers", "answer key");

  const read = async (file: { name: string; bytes: Uint8Array }, label: string) => {
    try {
      return await extractPdfLines(file.bytes);
    } catch (error) {
      if (error instanceof PdfReadError) throw new HttpError(422, "bad_pdf", `${label}: ${error.message}`);
      throw error;
    }
  };
  const [q, a] = await Promise.all([read(questions, "Question paper"), read(answers, "Answer key")]);
  const parsed = parseExamPapers(q.lines, a.lines);

  const preview: ParsePreview = {
    title: parsed.title,
    subtitle: parsed.subtitle,
    description: parsed.description,
    questions: parsed.questions,
    errors: parsed.errors,
    warnings: parsed.warnings,
    stats: parsed.stats,
    source: {
      questionsFile: questions.name,
      answersFile: answers.name,
      questionsSha256: sha256Hex(questions.bytes),
      answersSha256: sha256Hex(answers.bytes),
      questionPages: q.pages,
      answerPages: a.pages,
    },
  };
  return json(preview);
});
