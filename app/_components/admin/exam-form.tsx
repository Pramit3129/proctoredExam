"use client";

import { useMemo, useState } from "react";

import { fromLocalInput, toLocalInput } from "@/lib/format";
import type { ExamSettings, QuestionInput } from "@/lib/exam-types";

import { CheckIcon, WarningIcon } from "../icons";
import { Badge, Card, Field, Input, Segmented, Textarea, Toggle, cx } from "../ui";

export const CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

export function suggestCode(title: string): string {
  const stop = new Set(["THE", "OF", "AND", "A", "AN", "FOR", "QUESTIONS", "QUESTION", "ANSWERS", "ANSWER", "PAPER", "EXAM", "TEST", "KEY"]);
  const words = title
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !stop.has(w));
  let code = words.join("-").slice(0, 32).replace(/-+$/, "");
  if (code.length < 3) code = `EXAM-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  return code;
}

export function settingsErrors(s: ExamSettings): Partial<Record<keyof ExamSettings, string>> {
  const errors: Partial<Record<keyof ExamSettings, string>> = {};
  if (!s.title.trim()) errors.title = "Give the exam a title.";
  if (!CODE_RE.test(s.code)) errors.code = "3–40 capital letters, digits or dashes.";
  if (!Number.isInteger(s.durationMinutes) || s.durationMinutes < 1 || s.durationMinutes > 600) errors.durationMinutes = "1 to 600 minutes.";
  if (!Number.isInteger(s.maxAttempts) || s.maxAttempts < 1 || s.maxAttempts > 20) errors.maxAttempts = "1 to 20 attempts.";
  if (s.passPercent !== null && (s.passPercent < 0 || s.passPercent > 100)) errors.passPercent = "0 to 100%.";
  if (s.opensAt !== null && s.closesAt !== null && s.closesAt <= s.opensAt) errors.closesAt = "Must be after the opening time.";
  return errors;
}

function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  placeholder,
  describedBy,
  disabled,
}: {
  id: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min: number;
  max: number;
  placeholder?: string;
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      placeholder={placeholder}
      aria-describedby={describedBy}
      disabled={disabled}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    />
  );
}

export function ExamSettingsForm({
  value,
  onChange,
  codeLocked = false,
  showErrors = false,
}: {
  value: ExamSettings;
  onChange: (patch: Partial<ExamSettings>) => void;
  codeLocked?: boolean;
  showErrors?: boolean;
}) {
  const errors = showErrors ? settingsErrors(value) : {};
  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-5 sm:p-6">
        <p className="text-headline">Details</p>
        <Field label="Title" error={errors.title}>
          {(id, d) => <Input id={id} aria-describedby={d} maxLength={200} value={value.title} onChange={(e) => onChange({ title: e.target.value })} />}
        </Field>
        <Field label="Subtitle" hint="Optional. Shown under the title.">
          {(id, d) => (
            <Input id={id} aria-describedby={d} maxLength={200} value={value.subtitle ?? ""} onChange={(e) => onChange({ subtitle: e.target.value || null })} />
          )}
        </Field>
        <Field
          label="Exam code"
          error={errors.code}
          hint={codeLocked ? "Fixed once candidates have started." : `Students open /exam/${value.code || "CODE"}.`}
        >
          {(id, d) => (
            <Input
              id={id}
              aria-describedby={d}
              className="font-mono uppercase"
              maxLength={40}
              disabled={codeLocked}
              value={value.code}
              onChange={(e) => onChange({ code: e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "") })}
            />
          )}
        </Field>
        <Field label="Description" hint="Optional. Shown on the exam's start page.">
          {(id, d) => (
            <Textarea id={id} aria-describedby={d} maxLength={4000} value={value.description ?? ""} onChange={(e) => onChange({ description: e.target.value || null })} />
          )}
        </Field>
        <Field label="Instructions" hint="Optional. Extra rules for candidates.">
          {(id, d) => (
            <Textarea id={id} aria-describedby={d} maxLength={4000} value={value.instructions ?? ""} onChange={(e) => onChange({ instructions: e.target.value || null })} />
          )}
        </Field>
      </Card>

      <Card className="space-y-4 p-5 sm:p-6">
        <p className="text-headline">Rules</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Duration (minutes)" error={errors.durationMinutes}>
            {(id, d) => <NumberInput id={id} describedBy={d} min={1} max={600} value={value.durationMinutes} onChange={(v) => onChange({ durationMinutes: v ?? 0 })} />}
          </Field>
          <Field label="Attempts per student" error={errors.maxAttempts} hint="Grant more per student later.">
            {(id, d) => <NumberInput id={id} describedBy={d} min={1} max={20} value={value.maxAttempts} onChange={(v) => onChange({ maxAttempts: v ?? 0 })} />}
          </Field>
          <Field label="Pass mark (%)" error={errors.passPercent} hint="Optional.">
            {(id, d) => (
              <NumberInput id={id} describedBy={d} min={0} max={100} placeholder="None" value={value.passPercent} onChange={(v) => onChange({ passPercent: v })} />
            )}
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Opens" hint="Optional. Your local time.">
            {(id, d) => (
              <Input id={id} aria-describedby={d} type="datetime-local" value={toLocalInput(value.opensAt)} onChange={(e) => onChange({ opensAt: fromLocalInput(e.target.value) })} />
            )}
          </Field>
          <Field label="Closes" error={errors.closesAt} hint="Optional. Attempts end at this time.">
            {(id, d) => (
              <Input id={id} aria-describedby={d} type="datetime-local" value={toLocalInput(value.closesAt)} onChange={(e) => onChange({ closesAt: fromLocalInput(e.target.value) })} />
            )}
          </Field>
        </div>
        <div className="divide-y divide-line border-t border-line">
          <Toggle
            label="Submit when the candidate switches away"
            description="Leaving full screen always submits. With this on, switching to another tab or app, or locking the screen, submits too."
            checked={value.strictFocus}
            onChange={(strictFocus) => onChange({ strictFocus })}
          />
          <Toggle
            label="Shuffle question order"
            description="Each candidate sees the questions in a different order."
            checked={value.shuffleQuestions}
            onChange={(shuffleQuestions) => onChange({ shuffleQuestions })}
          />
          <Toggle
            label="Shuffle answer options"
            description="Avoid for questions like “I and II only” or “All of the above”."
            checked={value.shuffleOptions}
            onChange={(shuffleOptions) => onChange({ shuffleOptions })}
          />
        </div>
      </Card>
    </div>
  );
}

// ── Questions ───────────────────────────────────────────────────────────────

type ReviewQuestion = Omit<QuestionInput, "answer"> & { answer: string | null; id?: string };

export function QuestionReview({
  questions,
  issues = {},
  editable = false,
  onSetAnswer,
}: {
  questions: ReviewQuestion[];
  issues?: Record<number, { tone: "danger" | "warn"; message: string }[]>;
  editable?: boolean;
  onSetAnswer?: (index: number, key: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "issues">("all");
  const flaggedCount = useMemo(() => questions.filter((q) => issues[q.number]?.length || !q.answer).length, [questions, issues]);
  const shown = questions.map((q, i) => ({ q, i })).filter(({ q }) => filter === "all" || issues[q.number]?.length || !q.answer);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-1">
        <p className="text-[13px] text-muted">
          {editable ? "Click an option to make it the correct answer." : "Correct answers are marked in green."}
        </p>
        {flaggedCount > 0 && (
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: `All ${questions.length}` },
              { value: "issues", label: `Needs attention ${flaggedCount}` },
            ]}
          />
        )}
      </div>
      <ol className="space-y-3">
        {shown.map(({ q, i }) => {
          const qIssues = issues[q.number] ?? [];
          const [stem, ...items] = q.prompt.split("\n");
          return (
            <li key={q.id ?? `${q.number}-${i}`}>
              <Card className={cx("p-5", qIssues.some((x) => x.tone === "danger") || !q.answer ? "ring-danger/40" : undefined)}>
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-surface-3/70 px-1.5 text-[12px] font-semibold tabular-nums">
                    {q.number}
                  </span>
                  <div className="min-w-0 flex-1">
                    {q.section && <p className="text-eyebrow mb-1 text-subtle">{q.section}</p>}
                    <p className="text-[15px] leading-relaxed font-medium text-pretty">{stem}</p>
                    {items.length > 0 && (
                      <ul className="mt-2 space-y-0.5 rounded-[10px] bg-surface-2 px-3 py-2 text-[14px]">
                        {items.map((line, j) => (
                          <li key={j}>{line}</li>
                        ))}
                      </ul>
                    )}
                    <div className="mt-3 grid gap-1.5">
                      {q.options.map((o) => {
                        const correct = q.answer === o.key;
                        const content = (
                          <>
                            <span
                              className={cx(
                                "flex size-6 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold",
                                correct ? "bg-ok text-white" : "bg-surface-2 text-muted",
                              )}
                            >
                              {correct ? <CheckIcon size={13} strokeWidth={2.8} /> : o.key}
                            </span>
                            <span className="pt-0.5 text-[14px] leading-snug text-pretty">{o.text}</span>
                          </>
                        );
                        const cls = cx(
                          "flex w-full items-start gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left",
                          correct ? "bg-ok-soft" : editable ? "hover:bg-surface-2" : undefined,
                        );
                        return editable ? (
                          <button
                            key={o.key}
                            type="button"
                            className={cx("pressable focus-ring", cls)}
                            aria-pressed={correct}
                            onClick={() => onSetAnswer?.(i, o.key)}
                          >
                            {content}
                          </button>
                        ) : (
                          <div key={o.key} className={cls}>
                            {content}
                          </div>
                        );
                      })}
                    </div>
                    {q.explanation && (
                      <details className="group mt-3">
                        <summary className="focus-ring inline-flex cursor-pointer list-none items-center gap-1 rounded text-[13px] text-accent">
                          <span className="transition-transform group-open:rotate-90">›</span> Explanation
                        </summary>
                        <p className="mt-1.5 text-[13px] leading-relaxed text-muted text-pretty">{q.explanation}</p>
                      </details>
                    )}
                    {(qIssues.length > 0 || !q.answer) && (
                      <div className="mt-3 space-y-1">
                        {!q.answer && !qIssues.length && (
                          <p className="flex items-center gap-1.5 text-[13px] text-danger">
                            <WarningIcon size={14} /> No correct answer. Choose one above.
                          </p>
                        )}
                        {qIssues.map((x, j) => (
                          <p key={j} className={cx("flex items-start gap-1.5 text-[13px]", x.tone === "danger" ? "text-danger" : "text-warn")}>
                            <WarningIcon size={14} className="mt-0.5 shrink-0" /> {x.message}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                  {q.points !== undefined && q.points !== 1 && <Badge>{q.points} pts</Badge>}
                </div>
              </Card>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
