"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { formatCountdown } from "@/lib/format";
import type { EngineStatus, ProctorEngine } from "@/lib/proctor/client/engine";
import type { EndReason, ExamQuestionPublic, SessionBootstrap } from "@/lib/proctor/protocol";

import { CheckIcon, ChevronLeft, ChevronRight, ClockIcon, FlagIcon, GridIcon, WarningIcon } from "../icons";
import { Button, Card, Dot, Notice, Sheet, Spinner, cx, type Tone } from "../ui";
import { CameraPreview } from "./camera-preview";

const LETTERS = "ABCDEFGH";

function useClock(offsetMs: number): number {
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() + offsetMs), 500);
    return () => window.clearInterval(id);
  }, [offsetMs]);
  return now;
}

function Watermark({ text }: { text: string }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden select-none">
      <div className="absolute -inset-1/2 grid rotate-[-24deg] grid-cols-3 content-start gap-x-16 gap-y-24 opacity-[0.035]">
        {Array.from({ length: 48 }, (_, i) => (
          <span key={i} className="font-mono text-[13px] whitespace-nowrap">
            {text}
          </span>
        ))}
      </div>
    </div>
  );
}

/** First line is the stem; following lines (e.g. "I. …", "II. …") are statements. */
function Prompt({ text }: { text: string }) {
  const [stem, ...items] = text.split("\n");
  return (
    <div>
      <p className="text-[19px] leading-[1.45] font-medium tracking-[-0.015em] text-pretty sm:text-[21px]">{stem}</p>
      {items.length > 0 && (
        <ul className="mt-4 space-y-1.5 rounded-[14px] bg-surface-2 px-4 py-3">
          {items.map((line, i) => (
            <li key={i} className="text-[15px] leading-relaxed text-pretty">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ExamRoom({
  boot,
  engine,
  stream,
  onFinished,
}: {
  boot: SessionBootstrap;
  engine: ProctorEngine;
  stream: MediaStream;
  onFinished: (status: EngineStatus, reason: EndReason | null) => void;
}) {
  const state = useSyncExternalStore(engine.store.subscribe, engine.store.get, engine.store.get);
  const [clockOffset] = useState(() => boot.serverTime - Date.now());
  const now = useClock(clockOffset);
  const remaining = boot.exam.endsAt - now;
  const questions = boot.exam.questions;

  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>(() => ({ ...boot.answers }));
  const [marked, setMarked] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showNav, setShowNav] = useState(false);

  const submittedRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  const answersRef = useRef(answers);
  const markedRef = useRef(marked);
  useEffect(() => {
    onFinishedRef.current = onFinished;
    answersRef.current = answers;
    markedRef.current = marked;
  });

  const question: ExamQuestionPublic | undefined = questions[index];
  const answeredCount = useMemo(() => questions.filter((q) => answers[q.id]).length, [questions, answers]);

  const submit = useCallback(
    async (reason: EndReason) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      setSubmitting(true);
      setSubmitError(null);
      try {
        const result = await engine.submit(reason);
        onFinishedRef.current(result.status === "active" ? "submitted" : result.status, result.endReason ?? reason);
      } catch (e) {
        if (reason === "submitted") {
          // A deliberate submit can be retried; the server still holds every saved answer.
          submittedRef.current = false;
          setSubmitting(false);
          setSubmitError(e instanceof Error ? e.message : String(e));
        } else {
          // Automatic submission: the server closes the attempt on its own as well.
          onFinishedRef.current("auto_submitted", reason);
        }
      }
    },
    [engine],
  );

  // React to the engine: leaving full screen (or, in strict exams, hiding the page)
  // ends the exam, and so does the server closing the attempt.
  useEffect(() => {
    const check = () => {
      if (submittedRef.current) return;
      const s = engine.store.get();
      if (s.status !== "running") {
        submittedRef.current = true;
        onFinishedRef.current(s.status, s.endReason);
      } else if (!s.env.fullscreen) void submit("fullscreen_exit");
      else if (boot.exam.strictFocus && !s.env.visible) void submit("tab_hidden");
    };
    const initial = window.setTimeout(check, 0);
    const unsubscribe = engine.store.subscribe(check);
    return () => {
      window.clearTimeout(initial);
      unsubscribe();
    };
  }, [engine, boot.exam.strictFocus, submit]);

  // Time up (server clock).
  useEffect(() => {
    const ms = Math.max(0, boot.exam.endsAt - (Date.now() + clockOffset));
    const id = window.setTimeout(() => void submit("time_up"), ms);
    return () => window.clearTimeout(id);
  }, [boot.exam.endsAt, clockOffset, submit]);

  // Record which question is on screen.
  useEffect(() => {
    if (question) engine.viewQuestion(question.id, index);
  }, [engine, question, index]);

  const choose = useCallback(
    (q: ExamQuestionPublic, key: string | null) => {
      if (submittedRef.current) return;
      const prev = answersRef.current;
      if ((prev[q.id] ?? null) === key) return;
      engine.answer(q.id, key);
      const next = { ...prev };
      if (key === null) delete next[q.id];
      else next[q.id] = key;
      answersRef.current = next;
      setAnswers(next);
    },
    [engine],
  );

  const toggleMark = useCallback(
    (q: ExamQuestionPublic) => {
      const next = new Set(markedRef.current);
      const on = !next.has(q.id);
      if (on) next.add(q.id);
      else next.delete(q.id);
      engine.markQuestion(q.id, on);
      markedRef.current = next;
      setMarked(next);
    },
    [engine],
  );

  const go = useCallback((i: number) => setIndex(Math.max(0, Math.min(questions.length - 1, i))), [questions.length]);

  // Keyboard: A–H choose, ←/→ move.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirming || e.ctrlKey || e.metaKey || e.altKey || !question) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowRight") go(index + 1);
      else if (e.key === "ArrowLeft") go(index - 1);
      else if (e.key.length === 1) {
        const i = LETTERS.indexOf(e.key.toUpperCase());
        const option = question.options[i];
        if (option) choose(question, option.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, question, index, go, choose]);

  const saveState: { tone: Tone; label: string } =
    state.connection !== "online"
      ? { tone: "warn", label: state.connection === "offline" ? "Offline — reconnecting" : "Reconnecting…" }
      : state.unsavedAnswers > 0
        ? { tone: "accent", label: "Saving…" }
        : { tone: "ok", label: "All answers saved" };

  const timeTone = remaining < 60_000 ? "danger" : remaining < 5 * 60_000 ? "warn" : "neutral";
  const faceOk = state.faceCount === 1;
  const unanswered = questions.length - answeredCount;
  const watermark = `${boot.user.email} · ${boot.sessionId.slice(0, 8)}`;

  const navigator = (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[13px] font-medium">Questions</p>
        <p className="text-[12px] text-muted tabular-nums">
          {answeredCount}/{questions.length} answered
        </p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(36px,1fr))] gap-1.5">
        {questions.map((q, i) => {
          const isCurrent = i === index;
          const isAnswered = !!answers[q.id];
          return (
            <button
              key={q.id}
              type="button"
              onClick={() => {
                go(i);
                setShowNav(false);
              }}
              aria-label={`Question ${i + 1}${isAnswered ? ", answered" : ""}${marked.has(q.id) ? ", marked for review" : ""}`}
              aria-current={isCurrent ? "step" : undefined}
              className={cx(
                "pressable focus-ring relative h-9 rounded-[10px] text-[13px] font-medium tabular-nums",
                isAnswered ? "bg-accent text-white" : "bg-surface-2 text-foreground hover:bg-surface-3",
                isCurrent && "ring-2 ring-foreground ring-offset-2 ring-offset-surface",
              )}
            >
              {i + 1}
              {marked.has(q.id) && <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-[#ff9f0a] ring-2 ring-surface" />}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-accent" /> Answered
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-surface-3" /> Not answered
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-[#ff9f0a]" /> Marked
        </span>
      </div>
    </div>
  );

  return (
    <div data-proctor-root className="flex min-h-dvh flex-col bg-background">
      <header className="material sticky top-0 z-20 border-b border-line">
        <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center gap-3 px-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold tracking-[-0.015em]">{boot.exam.title}</p>
            <p className="flex items-center gap-1.5 truncate text-[12px] text-muted" aria-live="polite">
              <Dot tone={saveState.tone} />
              {saveState.label}
            </p>
          </div>
          <div
            className={cx(
              "flex h-9 items-center gap-1.5 rounded-full px-3.5 font-mono text-[15px] font-semibold tabular-nums transition-colors",
              timeTone === "danger" && "bg-danger text-white",
              timeTone === "warn" && "bg-warn-soft text-warn",
              timeTone === "neutral" && "bg-surface-3/70",
            )}
            role="timer"
            aria-label="Time remaining"
          >
            <ClockIcon size={16} />
            {formatCountdown(remaining)}
          </div>
          <Button variant="secondary" size="sm" className="lg:hidden" onClick={() => setShowNav((v) => !v)} aria-expanded={showNav}>
            <GridIcon size={15} /> {index + 1}/{questions.length}
          </Button>
          <Button size="sm" onClick={() => setConfirming(true)} disabled={submitting}>
            Submit
          </Button>
        </div>
        <div className="h-[3px] bg-surface-3/60">
          <div
            className="h-full bg-accent transition-[width] duration-300 ease-[var(--ease-out)]"
            style={{ width: `${(answeredCount / Math.max(1, questions.length)) * 100}%` }}
          />
        </div>
      </header>

      {state.warnings.length > 0 && (
        <div role="alert" className="border-b border-danger/15 bg-danger-soft">
          <div className="mx-auto flex max-w-[1280px] items-center gap-2 px-4 py-2 text-[14px] font-medium text-danger sm:px-6">
            <WarningIcon size={17} className="shrink-0" />
            {state.warnings.map((w) => w.message).join("  ·  ")}
          </div>
        </div>
      )}

      {showNav && (
        <div className="border-b border-line bg-surface px-4 py-4 lg:hidden">
          <div className="mx-auto max-w-[1280px]">{navigator}</div>
        </div>
      )}

      <div className="mx-auto grid w-full max-w-[1280px] flex-1 gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[1fr_300px] lg:py-8">
        <main className="relative min-w-0">
          <Watermark text={watermark} />
          {question && (
            <div key={question.id} className="animate-enter relative">
              <div className="mb-4 flex items-center gap-2 text-[13px] text-muted">
                <span className="font-medium text-foreground tabular-nums">
                  Question {index + 1} of {questions.length}
                </span>
                {question.section && (
                  <>
                    <span aria-hidden>·</span>
                    <span>{question.section}</span>
                  </>
                )}
              </div>

              <Card className="p-6 sm:p-8">
                <Prompt text={question.prompt} />
                <div className="mt-7 grid gap-2.5" role="radiogroup" aria-label="Options">
                  {question.options.map((option, i) => {
                    const selected = answers[question.id] === option.key;
                    return (
                      <button
                        key={option.key}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => choose(question, option.key)}
                        className={cx(
                          "pressable focus-ring group flex w-full items-start gap-3.5 rounded-[14px] border px-4 py-3.5 text-left",
                          selected ? "border-accent bg-accent-soft" : "border-line-strong bg-surface hover:border-subtle hover:bg-surface-2/60",
                        )}
                      >
                        <span
                          className={cx(
                            "mt-px flex size-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold transition-colors",
                            selected ? "bg-accent text-white" : "bg-surface-2 text-muted group-hover:bg-surface-3",
                          )}
                        >
                          {selected ? <CheckIcon size={15} strokeWidth={2.6} /> : LETTERS[i]}
                        </span>
                        <span className="pt-[3px] text-[16px] leading-[1.45] text-pretty">{option.text}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => toggleMark(question)}
                    className={cx(
                      "pressable focus-ring inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium",
                      marked.has(question.id) ? "bg-[#fff4e5] text-warn" : "text-muted hover:bg-surface-2",
                    )}
                  >
                    <FlagIcon size={15} /> {marked.has(question.id) ? "Marked for review" : "Mark for review"}
                  </button>
                  {answers[question.id] && (
                    <button
                      type="button"
                      onClick={() => choose(question, null)}
                      className="focus-ring rounded-full px-3 py-1 text-[13px] text-muted hover:text-foreground"
                    >
                      Clear answer
                    </button>
                  )}
                </div>
              </Card>

              <div className="mt-5 flex items-center justify-between gap-3">
                <Button variant="secondary" onClick={() => go(index - 1)} disabled={index === 0}>
                  <ChevronLeft size={17} /> Previous
                </Button>
                <p className="hidden text-[12px] text-subtle sm:block">Press A–{LETTERS[(question.options.length || 1) - 1]} to answer, ← → to move</p>
                {index < questions.length - 1 ? (
                  <Button onClick={() => go(index + 1)}>
                    Next <ChevronRight size={17} />
                  </Button>
                ) : (
                  <Button onClick={() => setConfirming(true)}>Review and submit</Button>
                )}
              </div>
            </div>
          )}
        </main>

        <aside className="hidden space-y-4 lg:sticky lg:top-[84px] lg:block lg:self-start">
          <CameraPreview stream={stream} className="rounded-[18px] shadow-[var(--shadow-md)]">
            <span className="absolute top-2.5 left-2.5 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
              <span className="size-1.5 rounded-full bg-[#ff3b30]" /> Proctored
            </span>
          </CameraPreview>
          <Card className="divide-y divide-line">
            {[
              { label: "Camera", ok: state.cameraLive, value: state.cameraLive ? "On" : "Off" },
              { label: "Microphone", ok: state.micLive, value: state.micLive ? "On" : "Off" },
              {
                label: "Face",
                ok: faceOk,
                value: faceOk ? "Visible" : state.faceCount === 0 ? "Not visible" : `${state.faceCount} people`,
              },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                <span className="text-muted">{row.label}</span>
                <span className={cx("flex items-center gap-2 font-medium", !row.ok && "text-danger")}>
                  <Dot tone={row.ok ? "ok" : "danger"} /> {row.value}
                </span>
              </div>
            ))}
          </Card>
          <Card className="p-4">{navigator}</Card>
        </aside>
      </div>

      <Sheet
        open={confirming}
        onClose={() => !submitting && setConfirming(false)}
        title="Submit your exam?"
        dismissible={!submitting}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={submitting}>
              Keep working
            </Button>
            <Button onClick={() => void submit("submitted")} disabled={submitting}>
              {submitting && <Spinner />} Submit exam
            </Button>
          </>
        }
      >
        <p>
          You&apos;ve answered <strong className="font-semibold text-foreground">{answeredCount}</strong> of {questions.length} questions.
          {unanswered > 0 && ` ${unanswered} unanswered.`}
          {marked.size > 0 && ` ${marked.size} marked for review.`} You can&apos;t change answers after submitting.
        </p>
        {submitError && <Notice className="mt-4">{submitError}</Notice>}
      </Sheet>
    </div>
  );
}
