"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type DragEvent } from "react";

import type { ExamSettings, ParsePreview } from "@/lib/exam-types";

import { api, errorMessage } from "../api";
import { CheckIcon, DocIcon, UploadIcon, WarningIcon } from "../icons";
import { Button, Card, Notice, Spinner, cx } from "../ui";
import { AdminPage } from "./admin-shell";
import { ExamSettingsForm, QuestionReview, settingsErrors, suggestCode } from "./exam-form";

const MAX_BYTES = 10 * 1024 * 1024;

function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Dropzone({
  label,
  hint,
  file,
  onFile,
  disabled,
}: {
  label: string;
  hint: string;
  file: File | null;
  onFile: (file: File | null, error?: string) => void;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = (f: File | undefined) => {
    if (!f) return;
    if (f.type !== "application/pdf" && !f.name.toLowerCase().endsWith(".pdf")) return onFile(null, `${f.name} is not a PDF.`);
    if (f.size > MAX_BYTES) return onFile(null, `${f.name} is larger than 10 MB.`);
    onFile(f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled) take(e.dataTransfer.files[0]);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cx(
        "rounded-[18px] border-2 border-dashed bg-surface p-6 transition-colors duration-150",
        over ? "border-accent bg-accent-soft/60" : file ? "border-transparent shadow-[var(--shadow-sm)] ring-1 ring-line" : "border-line-strong",
      )}
    >
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <div className="flex items-center gap-4">
        <span className={cx("flex size-12 shrink-0 items-center justify-center rounded-[14px]", file ? "bg-ok-soft text-ok" : "bg-accent-soft text-accent")}>
          {file ? <CheckIcon size={22} strokeWidth={2.4} /> : <DocIcon size={22} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-headline">{label}</p>
          <p className="truncate text-[13px] text-muted">{file ? `${file.name} · ${formatSize(file.size)}` : hint}</p>
        </div>
        <Button variant={file ? "secondary" : "primary"} size="sm" onClick={() => input.current?.click()} disabled={disabled}>
          {file ? "Replace" : "Choose PDF"}
        </Button>
      </div>
    </div>
  );
}

const DEFAULT_SETTINGS: ExamSettings = {
  code: "",
  title: "",
  subtitle: null,
  description: null,
  instructions: null,
  status: "draft",
  durationMinutes: 60,
  maxAttempts: 1,
  passPercent: null,
  shuffleQuestions: false,
  shuffleOptions: false,
  strictFocus: true,
  opensAt: null,
  closesAt: null,
};

export function ExamCreate() {
  const router = useRouter();
  const [questionsFile, setQuestionsFile] = useState<File | null>(null);
  const [answersFile, setAnswersFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<ParsePreview | null>(null);
  const [settings, setSettings] = useState<ExamSettings>(DEFAULT_SETTINGS);
  const [saving, setSaving] = useState<"draft" | "published" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [triedSave, setTriedSave] = useState(false);

  async function parse() {
    if (!questionsFile || !answersFile) return;
    setParsing(true);
    setFileError(null);
    try {
      const form = new FormData();
      form.set("questions", questionsFile);
      form.set("answers", answersFile);
      const result = await api<ParsePreview>("/api/admin/exams/parse", { method: "POST", body: form });
      setPreview(result);
      const title = result.title ?? questionsFile.name.replace(/\.pdf$/i, "");
      setSettings((s) => ({
        ...s,
        title: s.title || title,
        subtitle: s.subtitle ?? result.subtitle,
        description: s.description ?? result.description,
        code: s.code || suggestCode(title),
        // A sensible default: about 1.2 minutes per question, rounded to 5.
        durationMinutes: s.durationMinutes === DEFAULT_SETTINGS.durationMinutes ? Math.max(10, Math.round((result.questions.length * 1.2) / 5) * 5) : s.durationMinutes,
      }));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setFileError(errorMessage(e));
    } finally {
      setParsing(false);
    }
  }

  const issues = useMemo(() => {
    const map: Record<number, { tone: "danger" | "warn"; message: string }[]> = {};
    for (const e of preview?.errors ?? []) if (e.number !== undefined) (map[e.number] ??= []).push({ tone: "danger", message: e.message });
    for (const w of preview?.warnings ?? []) if (w.number !== undefined) (map[w.number] ??= []).push({ tone: "warn", message: w.message });
    return map;
  }, [preview]);

  const generalErrors = preview?.errors.filter((e) => e.number === undefined) ?? [];
  const generalWarnings = preview?.warnings.filter((w) => w.number === undefined) ?? [];
  const missingAnswers = preview?.questions.filter((q) => !q.answer).length ?? 0;
  const blocking = preview ? preview.questions.length === 0 || missingAnswers > 0 : true;

  async function save(status: "draft" | "published") {
    if (!preview) return;
    setTriedSave(true);
    setSaveError(null);
    if (Object.keys(settingsErrors(settings)).length > 0) {
      setSaveError("Fix the highlighted settings first.");
      return;
    }
    if (blocking) {
      setSaveError(missingAnswers > 0 ? `${missingAnswers} question${missingAnswers === 1 ? " has" : "s have"} no correct answer.` : "There are no questions to save.");
      return;
    }
    setSaving(status);
    try {
      const { id } = await api<{ id: string }>("/api/admin/exams", {
        method: "POST",
        json: {
          ...settings,
          status,
          questions: preview.questions.map((q) => ({ ...q, answer: q.answer })),
          source: preview.source,
        },
      });
      router.push(`/admin/exams/${id}`);
    } catch (e) {
      setSaveError(errorMessage(e));
      setSaving(null);
    }
  }

  function reset() {
    setPreview(null);
    setSettings(DEFAULT_SETTINGS);
    setTriedSave(false);
    setSaveError(null);
  }

  if (!preview) {
    return (
      <AdminPage title="New exam" subtitle="Upload the question paper and its answer key. You'll review everything before it's saved." back={{ href: "/admin/exams", label: "Exams" }}>
        <div className="max-w-[720px] space-y-3">
          <Dropzone
            label="Question paper"
            hint="Numbered questions with lettered options (A, B, C, D)."
            file={questionsFile}
            onFile={(f, err) => {
              setFileError(err ?? null);
              if (f || !err) setQuestionsFile(f);
            }}
            disabled={parsing}
          />
          <Dropzone
            label="Answer key"
            hint="Lines like “1. C” or “1. C - explanation”. Numbers must match the paper."
            file={answersFile}
            onFile={(f, err) => {
              setFileError(err ?? null);
              if (f || !err) setAnswersFile(f);
            }}
            disabled={parsing}
          />
          {fileError && <Notice>{fileError}</Notice>}
          <div className="flex items-center justify-between gap-4 pt-3">
            <p className="text-[13px] text-muted">PDFs are read on the server and not stored. Up to 10 MB each.</p>
            <Button size="lg" onClick={() => void parse()} disabled={!questionsFile || !answersFile || parsing}>
              {parsing ? <Spinner /> : <UploadIcon size={18} />} {parsing ? "Reading PDFs…" : "Read PDFs"}
            </Button>
          </div>
        </div>
      </AdminPage>
    );
  }

  const { stats } = preview;
  return (
    <AdminPage
      title="Review new exam"
      subtitle={`${preview.source.questionsFile} + ${preview.source.answersFile}`}
      back={{ href: "/admin/exams", label: "Exams" }}
      actions={
        <>
          <Button variant="secondary" onClick={reset} disabled={saving !== null}>
            Start over
          </Button>
          <Button variant="secondary" onClick={() => void save("draft")} disabled={saving !== null}>
            {saving === "draft" && <Spinner />} Save as draft
          </Button>
          <Button onClick={() => void save("published")} disabled={saving !== null}>
            {saving === "published" && <Spinner />} Publish
          </Button>
        </>
      }
    >
      <Card className={cx("mb-6 flex flex-wrap items-center gap-x-8 gap-y-3 p-5", blocking ? "ring-danger/30" : undefined)}>
        <span className={cx("flex size-11 items-center justify-center rounded-full", blocking ? "bg-danger-soft text-danger" : "bg-ok-soft text-ok")}>
          {blocking ? <WarningIcon size={22} /> : <CheckIcon size={22} strokeWidth={2.4} />}
        </span>
        {[
          ["Questions", stats.questionCount],
          ["With answers", `${preview.questions.filter((q) => q.answer).length}`],
          ["Explanations", stats.explanationCount],
          ["Sections", stats.sections.length ? stats.sections.join(", ") : "—"],
          ["Pages", `${preview.source.questionPages} + ${preview.source.answerPages}`],
        ].map(([k, v]) => (
          <div key={k}>
            <p className="text-[12px] text-muted">{k}</p>
            <p className="text-[17px] font-semibold tracking-[-0.015em] tabular-nums">{v}</p>
          </div>
        ))}
      </Card>

      {(generalErrors.length > 0 || generalWarnings.length > 0) && (
        <div className="mb-6 space-y-2">
          {generalErrors.map((e, i) => (
            <Notice key={`e${i}`}>{e.message}</Notice>
          ))}
          {generalWarnings.map((w, i) => (
            <Notice key={`w${i}`} tone="warn">
              {w.message}
            </Notice>
          ))}
        </div>
      )}
      {saveError && <Notice className="mb-6">{saveError}</Notice>}

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_400px]">
        <section className="order-2 xl:order-1">
          <h2 className="text-headline mb-1 px-1">Questions</h2>
          <QuestionReview
            questions={preview.questions}
            issues={issues}
            editable
            onSetAnswer={(index, key) =>
              setPreview((p) => (p ? { ...p, questions: p.questions.map((q, i) => (i === index ? { ...q, answer: key } : q)) } : p))
            }
          />
        </section>
        <aside className="order-1 max-w-[720px] xl:sticky xl:top-6 xl:order-2 xl:max-h-[calc(100dvh-3rem)] xl:self-start xl:overflow-y-auto xl:pb-4">
          <ExamSettingsForm value={settings} onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))} showErrors={triedSave} />
        </aside>
      </div>
    </AdminPage>
  );
}
