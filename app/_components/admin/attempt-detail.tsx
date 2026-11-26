"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { describeData, formatClock, formatDateTime, formatDuration, formatPercent, formatScore } from "@/lib/format";
import type { AttemptDetail, AttemptEvent } from "@/lib/exam-types";
import { SEVERITY_RANK, specOf, type Severity } from "@/lib/proctor/catalog";

import { api, errorMessage } from "../api";
import { usePoll } from "../hooks/use-poll";
import { CheckIcon, CloseIcon } from "../icons";
import { Badge, Button, Card, Dot, EmptyState, LoadingScreen, Notice, Segmented, Sheet, Spinner, cx, severityTone, toneText } from "../ui";
import { AdminPage } from "./admin-shell";
import { ATTEMPT_STATUS, END_REASON, riskLabel, scoreTone } from "./labels";

type TimelineFilter = "flags" | "all" | "answers";

function offset(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `+${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `+${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function AttemptDetailView({ id }: { id: string }) {
  const [live, setLive] = useState(true);
  const { data, error, reload } = usePoll<AttemptDetail & { serverTime: number }>(`/api/admin/attempts/${id}`, 5_000, live);
  const [filter, setFilter] = useState<TimelineFilter>("flags");
  const [answerFilter, setAnswerFilter] = useState<"all" | "wrong" | "blank">("all");
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);

  if (data && data.attempt.status !== "active" && live) setLive(false);

  const numbers = useMemo(() => new Map((data?.answers ?? []).map((a) => [a.questionId, a.number])), [data?.answers]);

  if (!data) {
    return (
      <AdminPage title="Attempt" back={{ href: "/admin/exams", label: "Exams" }}>
        {error ? <Notice>{error}</Notice> : <LoadingScreen />}
      </AdminPage>
    );
  }

  const { attempt, answers, events, flagSummary } = data;
  const status = ATTEMPT_STATUS[attempt.status];
  const risk = riskLabel(attempt.riskScore);
  const startedAt = attempt.startedAt;

  const describe = (e: AttemptEvent): string => {
    const q = typeof e.data.q === "string" ? numbers.get(e.data.q) : undefined;
    if (e.type === "ANSWER_SELECTED") return `Question ${q ?? "?"} → ${String(e.data.o)}`;
    if (e.type === "ANSWER_CLEARED") return `Question ${q ?? "?"} cleared`;
    if (e.type === "QUESTION_VIEWED") return `Question ${q ?? "?"}`;
    if (e.type === "QUESTION_MARKED") return `Question ${q ?? "?"} ${e.data.on ? "marked" : "unmarked"}`;
    if (e.type === "AUTO_SUBMITTED" || e.type === "SESSION_ENDED" || e.type === "SESSION_EXPIRED") {
      const reason = typeof e.data.reason === "string" ? END_REASON[e.data.reason as keyof typeof END_REASON] : undefined;
      return [reason, typeof e.data.answered === "number" ? `${e.data.answered} answered` : null].filter(Boolean).join(" · ");
    }
    const rest: Record<string, unknown> = { ...e.data };
    delete rest.q;
    return describeData(rest);
  };

  const shown = events
    .filter((e) => {
      if (filter === "answers") return e.category === "interaction" && e.type !== "QUESTION_VIEWED";
      if (filter === "flags") return SEVERITY_RANK[e.severity as Severity] >= SEVERITY_RANK.low || e.category === "lifecycle";
      return true;
    })
    .slice()
    .reverse();

  const answerRows = answers.filter((a) => (answerFilter === "wrong" ? a.chosenKey && !a.isCorrect : answerFilter === "blank" ? !a.chosenKey : true));

  async function terminate() {
    setEnding(true);
    setEndError(null);
    try {
      await api(`/api/admin/attempts/${id}/terminate`, { method: "POST", json: {} });
      setConfirmEnd(false);
      setLive(true);
      reload();
    } catch (e) {
      setEndError(errorMessage(e));
    } finally {
      setEnding(false);
    }
  }

  const client = attempt.clientInfo;

  return (
    <AdminPage
      back={{ href: `/admin/exams/${attempt.examId}`, label: attempt.examTitle }}
      title={attempt.userName}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span>{attempt.userEmail}</span>
          <span aria-hidden>·</span>
          <span>
            Attempt {attempt.attemptNo} of {attempt.attemptsAllowed}
          </span>
        </span>
      }
      actions={
        attempt.status === "active" ? (
          <Button variant="danger" onClick={() => setConfirmEnd(true)}>
            End attempt
          </Button>
        ) : undefined
      }
    >
      {error && <Notice className="mb-4">{error}</Notice>}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card className="p-5">
          <p className="text-[13px] text-muted">Score</p>
          {attempt.percent === null ? (
            <p className="mt-1 text-[28px] font-semibold text-subtle">{attempt.status === "active" ? "In progress" : "—"}</p>
          ) : (
            <>
              <p className={cx("mt-1 text-[40px] leading-none font-semibold tracking-[-0.03em] tabular-nums", toneText(attempt.passed === null ? scoreTone(attempt.percent, null) : attempt.passed ? "ok" : "danger"))}>
                {formatPercent(attempt.percent, 1)}
              </p>
              <p className="mt-2 flex items-center gap-2 text-[13px] text-muted tabular-nums">
                {formatScore(attempt.score, attempt.maxScore)} points
                {attempt.passed !== null && <Badge tone={attempt.passed ? "ok" : "danger"}>{attempt.passed ? "Passed" : "Not passed"}</Badge>}
              </p>
            </>
          )}
        </Card>
        <Card className="p-5">
          <p className="text-[13px] text-muted">Answers</p>
          {attempt.correct === null ? (
            <p className="mt-1 text-[15px] text-muted">{answers.filter((a) => a.chosenKey).length} answered so far</p>
          ) : (
            <>
              <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-surface-3">
                <div className="bg-ok" style={{ width: `${(attempt.correct / Math.max(1, answers.length)) * 100}%` }} />
                <div className="bg-danger" style={{ width: `${((attempt.incorrect ?? 0) / Math.max(1, answers.length)) * 100}%` }} />
              </div>
              <div className="mt-3 grid grid-cols-3 text-[13px]">
                <p>
                  <span className="block text-[20px] font-semibold text-ok tabular-nums">{attempt.correct}</span>Right
                </p>
                <p>
                  <span className="block text-[20px] font-semibold text-danger tabular-nums">{attempt.incorrect}</span>Wrong
                </p>
                <p>
                  <span className="block text-[20px] font-semibold text-muted tabular-nums">{attempt.unanswered}</span>Blank
                </p>
              </div>
            </>
          )}
        </Card>
        <Card className="p-5">
          <p className="text-[13px] text-muted">Integrity</p>
          <p className="mt-1 flex items-center gap-2">
            <span className={cx("text-[28px] font-semibold tracking-[-0.025em] tabular-nums", toneText(risk.tone))}>{attempt.riskScore}</span>
            <Badge tone={risk.tone}>{risk.label} risk</Badge>
          </p>
          <p className="mt-2 text-[13px] text-muted">
            {attempt.flagCount} flagged event{attempt.flagCount === 1 ? "" : "s"}
            {attempt.resyncCount > 0 ? ` · ${attempt.resyncCount} re-sync${attempt.resyncCount === 1 ? "" : "s"}` : ""}
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-[13px] text-muted">Timing</p>
          <p className="mt-1 text-[20px] font-semibold tracking-[-0.02em] tabular-nums">
            {attempt.durationMs === null ? formatDuration(data.serverTime - startedAt) : formatDuration(attempt.durationMs)}
          </p>
          <p className="mt-2 text-[13px] text-muted">
            Started {formatDateTime(startedAt)}
            {attempt.endedAt ? ` · ended ${formatClock(attempt.endedAt)}` : ""}
          </p>
          {attempt.endReason && <p className="mt-1 text-[13px] font-medium">{END_REASON[attempt.endReason]}</p>}
        </Card>
      </div>

      <div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-1">
            <h2 className="text-headline">Timeline</h2>
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "flags", label: "Violations" },
                { value: "answers", label: "Answers" },
                { value: "all", label: `Everything ${events.length}` },
              ]}
            />
          </div>
          <Card className="overflow-hidden">
            {shown.length === 0 ? (
              <EmptyState icon={<CheckIcon size={22} />} title={filter === "flags" ? "No violations recorded" : "Nothing recorded"} />
            ) : (
              <ol className="max-h-[720px] divide-y divide-line overflow-y-auto">
                {shown.map((e) => {
                  const spec = specOf(e.type);
                  const ended = e.phase === "end";
                  const detail = describe(e);
                  return (
                    <li key={e.id} className="flex gap-3 px-5 py-3">
                      <div className="w-[84px] shrink-0 text-right">
                        <p className="font-mono text-[12px] tabular-nums">{formatClock(e.serverTs)}</p>
                        <p className="font-mono text-[11px] text-subtle tabular-nums">{offset((e.clientTs ?? e.serverTs) - startedAt)}</p>
                      </div>
                      <span className="mt-1.5">
                        <Dot tone={ended ? "neutral" : severityTone(spec.severity)} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className={cx("text-[14px]", ended ? "text-muted" : "font-medium")}>
                          {spec.label}
                          {ended ? ` ended${e.durationMs !== null ? ` · lasted ${formatDuration(e.durationMs)}` : ""}` : ""}
                          {e.source === "server" && <span className="ml-2 text-[11px] font-normal text-subtle">server</span>}
                        </p>
                        {detail && <p className="mt-0.5 text-[12px] break-words text-muted">{detail}</p>}
                        {!ended && SEVERITY_RANK[spec.severity] >= SEVERITY_RANK.medium && filter !== "answers" && (
                          <p className="mt-0.5 text-[12px] text-subtle">{spec.description}</p>
                        )}
                      </div>
                      {e.riskPoints > 0 && <span className="shrink-0 text-[12px] font-medium text-warn tabular-nums">+{e.riskPoints}</span>}
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </section>

        <aside className="space-y-4">
          <div>
            <h2 className="text-headline mb-3 px-1">Violations summary</h2>
            <Card className="overflow-hidden">
              {flagSummary.length === 0 ? (
                <p className="px-5 py-4 text-[14px] text-muted">Nothing flagged.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {flagSummary.map((f) => {
                    const spec = specOf(f.type);
                    return (
                      <li key={f.type} className="flex items-center gap-3 px-5 py-2.5">
                        <Dot tone={severityTone(spec.severity)} />
                        <span className="min-w-0 flex-1 truncate text-[14px]">{spec.label}</span>
                        <span className="text-[13px] text-muted tabular-nums">
                          ×{f.count}
                          {f.totalMs > 0 ? ` · ${formatDuration(f.totalMs)}` : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          </div>
          <div>
            <h2 className="text-headline mb-3 px-1">Device</h2>
            <Card className="divide-y divide-line text-[13px]">
              {[
                ["Camera", client?.camera?.label || "—"],
                ["Microphone", client?.microphone?.label || "—"],
                ["Screen", client?.screen ? `${client.screen.width}×${client.screen.height} @${client.screen.dpr}x` : "—"],
                ["Platform", client?.platform || "—"],
                ["Time zone", client?.timezone || "—"],
                ["IP", attempt.ip ?? "—"],
                ["Browser", attempt.userAgent ?? "—"],
              ].map(([k, v]) => (
                <div key={k} className="flex gap-3 px-4 py-2.5">
                  <span className="w-24 shrink-0 text-muted">{k}</span>
                  <span className="min-w-0 break-words">{v}</span>
                </div>
              ))}
            </Card>
          </div>
        </aside>
      </div>

      <section className="mt-10">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-1">
          <h2 className="text-headline">Answers</h2>
          <Segmented
            value={answerFilter}
            onChange={setAnswerFilter}
            options={[
              { value: "all", label: "All" },
              { value: "wrong", label: "Wrong" },
              { value: "blank", label: "Blank" },
            ]}
          />
        </div>
        <Card className="overflow-hidden">
          {answerRows.length === 0 ? (
            <EmptyState title="Nothing here" />
          ) : (
            <ul className="divide-y divide-line">
              {answerRows.map((a) => {
                const chosen = a.options.find((o) => o.key === a.chosenKey);
                const correct = a.options.find((o) => o.key === a.correctKey);
                return (
                  <li key={a.questionId} className="flex gap-4 px-5 py-4">
                    <span
                      className={cx(
                        "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full",
                        !a.chosenKey ? "bg-surface-3 text-muted" : a.isCorrect ? "bg-ok text-white" : "bg-danger text-white",
                      )}
                      aria-label={!a.chosenKey ? "Not answered" : a.isCorrect ? "Correct" : "Incorrect"}
                    >
                      {!a.chosenKey ? "–" : a.isCorrect ? <CheckIcon size={15} strokeWidth={2.6} /> : <CloseIcon size={14} strokeWidth={2.6} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium text-pretty">
                        <span className="text-muted tabular-nums">{a.number}.</span> {a.prompt.split("\n")[0]}
                      </p>
                      <p className="mt-1 text-[13px] text-muted text-pretty">
                        {chosen ? (
                          <>
                            Chose <strong className={cx("font-semibold", a.isCorrect ? "text-ok" : "text-danger")}>{chosen.key}</strong> {chosen.text}
                          </>
                        ) : (
                          "Not answered"
                        )}
                        {!a.isCorrect && correct && (
                          <>
                            {" "}
                            · Correct <strong className="font-semibold text-ok">{correct.key}</strong> {correct.text}
                          </>
                        )}
                      </p>
                      {a.changes > 1 && <p className="mt-0.5 text-[12px] text-subtle">Changed {a.changes - 1}×</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      <p className="mt-6 px-1 text-[12px] text-subtle">
        Exam <Link href={`/admin/exams/${attempt.examId}`} className="text-accent hover:underline">{attempt.examCode}</Link> · reference {attempt.sessionId} · {attempt.lastSeq} signed client events
      </p>

      <Sheet
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        title="End this attempt now?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmEnd(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void terminate()} disabled={ending}>
              {ending && <Spinner />} End attempt
            </Button>
          </>
        }
      >
        <p>{attempt.userName}&apos;s exam closes immediately and is graded on the answers given so far. They see that an administrator ended it.</p>
        {endError && <Notice className="mt-3">{endError}</Notice>}
      </Sheet>
    </AdminPage>
  );
}
