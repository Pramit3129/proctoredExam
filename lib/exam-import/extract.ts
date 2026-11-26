import { getDocumentProxy } from "unpdf";

import type { PdfLine } from "./parse";

export class PdfReadError extends Error {}

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 200;

interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/**
 * Extracts positioned text lines from a PDF.
 *
 * pdf.js returns text runs with coordinates; runs on the same baseline are
 * merged into one line (sorted left to right) so the parser can use both the
 * text and its indentation. Font loading and XFA forms are disabled: uploads
 * are untrusted input even from admins.
 */
export async function extractPdfLines(bytes: Uint8Array): Promise<{ lines: PdfLine[]; pages: number }> {
  if (bytes.byteLength === 0) throw new PdfReadError("The file is empty.");
  if (bytes.byteLength > MAX_PDF_BYTES) throw new PdfReadError("PDFs must be 10 MB or smaller.");
  // "%PDF-" may be preceded by a little junk, which readers tolerate.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  if (!head.includes("%PDF-")) throw new PdfReadError("This file is not a PDF.");

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // This pdf.js build has no eval-based font path; fonts are not loaded at all.
    pdf = await getDocumentProxy(new Uint8Array(bytes), {
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      stopAtErrors: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) throw new PdfReadError("This PDF is password protected. Remove the password and upload it again.");
    throw new PdfReadError("This PDF could not be read. Re-export it and try again.");
  }

  try {
    if (pdf.numPages > MAX_PAGES) throw new PdfReadError(`PDFs can have at most ${MAX_PAGES} pages.`);
    const lines: PdfLine[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = (content.items as unknown[]).filter(
        (it): it is TextItem => typeof it === "object" && it !== null && "str" in it && typeof (it as TextItem).str === "string",
      );
      lines.push(...groupIntoLines(items, pageNumber));
      page.cleanup();
    }
    if (lines.filter((l) => l.text.trim()).length < 3) {
      throw new PdfReadError("This PDF has no selectable text (it may be a scan). Upload a PDF exported from a document editor.");
    }
    return { lines, pages: pdf.numPages };
  } finally {
    // Release parsed objects; the document proxy API differs slightly between pdf.js builds.
    const disposable = pdf as unknown as { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
    await (disposable.destroy ?? disposable.cleanup)?.call(pdf).catch(() => undefined);
  }
}

function groupIntoLines(items: TextItem[], page: number): PdfLine[] {
  const runs = items
    .filter((it) => it.str.length > 0)
    .map((it) => ({
      text: it.str,
      x: it.transform[4] ?? 0,
      y: it.transform[5] ?? 0,
      width: it.width,
      size: Math.abs(it.height) || Math.hypot(it.transform[2] ?? 0, it.transform[3] ?? 0),
    }));
  // Top of the page first, then left to right.
  runs.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines: { runs: typeof runs; y: number; size: number }[] = [];
  for (const run of runs) {
    const current = lines.at(-1);
    const tolerance = Math.max(2, (current?.size ?? run.size) * 0.4);
    if (current && Math.abs(current.y - run.y) <= tolerance) {
      current.runs.push(run);
      current.size = Math.max(current.size, run.size);
    } else {
      lines.push({ runs: [run], y: run.y, size: run.size });
    }
  }

  return lines
    .map((line) => {
      const sorted = line.runs.sort((a, b) => a.x - b.x);
      let text = "";
      let end = -Infinity;
      for (const run of sorted) {
        const gap = run.x - end;
        if (text && gap > Math.max(1, run.size * 0.15) && !text.endsWith(" ") && !run.text.startsWith(" ")) text += " ";
        text += run.text;
        end = run.x + run.width;
      }
      const first = sorted.find((r) => r.text.trim()) ?? sorted[0]!;
      return { page, x: Math.round(first.x * 10) / 10, y: Math.round(line.y * 10) / 10, size: Math.round(line.size * 10) / 10, text: text.trim() };
    })
    .filter((l) => l.text.length > 0);
}
