"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { formatDateTime, formatDuration, formatPercent, formatScore } from "@/lib/format";
import type { AdminExamDetail, Allowance, ExamSettings, ExamStatus, LmsUserLite, ResultRow } from "@/lib/exam-types";

import { api, errorMessage } from "../api";
import { usePoll } from "../hooks/use-poll";
import { DownloadIcon, LinkIcon, PlusIcon, SearchIcon, UsersIcon } from "../icons";
import { Badge, Button, Card, EmptyState, Input, LoadingScreen, Notice, Segmented, Sheet, Spinner, Stat, buttonClasses, cx, toneText } from "../ui";
import { AdminPage } from "./admin-shell";
import { ExamSettingsForm, QuestionReview, settingsErrors } from "./exam-form";
import { ATTEMPT_STATUS, END_REASON, EXAM_STATUS, riskLabel, scoreTone } from "./labels";
import { RowLink, Td, Th } from "./overview";

type Tab = "results" | "questions" | "settings" | "access";

function settingsOf(e: AdminExamDetail): ExamSettings {
  return {
    code: e.code,
    title: e.title,
    subtitle: e.subtitle,
    description: e.description,
    instructions: e.instructions,
    status: e.status,
    durationMinutes: e.durationMinutes,
    maxAttempts: e.maxAttempts,
    passPercent: e.passPercent,
    shuffleQuestions: e.shuffleQuestions,
    shuffleOptions: e.shuffleOptions,
    strictFocus: e.strictFocus,
    opensAt: e.opensAt,
    closesAt: e.closesAt,
  };
}

export function ExamDetail({ id }: { id: string }) {
  const router = useRouter();
  const [exam, setExam] = useState<AdminExamDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("results");
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ exam: AdminExamDetail }>(`/api/admin/exams/${id}`)
      .then(({ exam: e }) => !cancelled && setExam(e))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 3500);
    return () => window.clearTimeout(t);
  }, [flash]);

  async function patch(body: Record<string, unknown>, message: string) {
    setBusy(message);
    try {
      const { exam: e } = await api<{ exam: AdminExamDetail }>(`/api/admin/exams/${id}`, { method: "PATCH", json: body });
      setExam(e);
      setFlash(message);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("delete");
    try {
      await api(`/api/admin/exams/${id}`, { method: "DELETE" });
      router.push("/admin/exams");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
      setConfirmDelete(false);
    }
  }

  if (!exam) {
    return (
      <AdminPage title="Exam" back={{ href: "/admin/exams", label: "Exams" }}>
        {error ? <Notice>{error}</Notice> : <LoadingScreen />}
      </AdminPage>
    );
  }

  const status = EXAM_STATUS[exam.status];
  const setStatus = (s: ExamStatus, message: string) => void patch({ status: s }, message);
  const link = typeof window === "undefined" ? `/exam/${exam.code}` : `${window.location.origin}/exam/${exam.code}`;

  return (
    <AdminPage
      back={{ href: "/admin/exams", label: "Exams" }}
      title={exam.title}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="font-mono text-[13px]">{exam.code}</span>
          <span aria-hidden>·</span>
          <span>
            {exam.questionCount} questions · {exam.durationMinutes} min · {exam.maxAttempts} attempt{exam.maxAttempts === 1 ? "" : "s"}
          </span>
        </span>
      }
      actions={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(link).then(() => setFlash("Exam link copied."));
            }}
          >
            <LinkIcon size={16} /> Copy link
          </Button>
          <a href={`/api/admin/exams/${id}/results?format=csv`} className={buttonClasses("secondary")}>
            <DownloadIcon size={16} /> Export CSV
          </a>
          {exam.status === "published" ? (
            <Button variant="secondary" onClick={() => setStatus("closed", "Exam closed to new attempts.")} disabled={busy !== null}>
              Close exam
            </Button>
          ) : exam.status !== "archived" ? (
            <Button onClick={() => setStatus("published", "Exam published.")} disabled={busy !== null || exam.questionCount === 0}>
              {busy === "Exam published." && <Spinner />} Publish
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setStatus("draft", "Exam restored as a draft.")} disabled={busy !== null}>
              Restore
            </Button>
          )}
        </>
      }
    >
      {error && (
        <Notice className="mb-4">
          {error}{" "}
          <button type="button" className="underline" onClick={() => setError(null)}>
            Dismiss
          </button>
        </Notice>
      )}
      {flash && (
        <Notice tone="ok" className="mb-4">
          {flash}
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Attempts" value={exam.stats.attempts} detail={`${exam.stats.candidates} candidates`} />
        <Stat label="Completed" value={exam.stats.completed} detail={exam.stats.active > 0 ? `${exam.stats.active} in progress` : "None in progress"} />
        <Stat label="Average score" value={formatPercent(exam.stats.averagePercent)} />
        <Stat label="Pass rate" value={exam.passPercent === null ? "—" : formatPercent(exam.stats.passRate)} detail={exam.passPercent === null ? "No pass mark" : `Pass mark ${exam.passPercent}%`} />
        <Stat label="Flagged" value={exam.stats.flagged} tone={exam.stats.flagged > 0 ? "warn" : undefined} detail="Attempts with violations" />
      </div>

      <div className="mt-8 mb-5">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "results", label: "Results" },
            { value: "questions", label: "Questions" },
            { value: "settings", label: "Settings" },
            { value: "access", label: "Attempts" },
          ]}
        />
      </div>

      {tab === "results" && <ResultsPanel examId={id} passPercent={exam.passPercent} onGranted={(m) => setFlash(m)} />}
      {tab === "questions" && <QuestionsPanel exam={exam} onSave={(questions) => patch({ questions }, "Answer key updated.")} />}
      {tab === "settings" && (
        <SettingsPanel
          exam={exam}
          busy={busy !== null}
          onSave={(s) => patch({ ...s }, "Settings saved.")}
          onArchive={() => setStatus("archived", "Exam archived.")}
          onDelete={() => setConfirmDelete(true)}
        />
      )}
      {tab === "access" && <AccessPanel exam={exam} onChanged={(m) => setFlash(m)} />}

      <Sheet
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this exam?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void remove()} disabled={busy === "delete"}>
              {busy === "delete" && <Spinner />} Delete exam
            </Button>
          </>
        }
      >
        <p>
          “{exam.title}” and its {exam.questionCount} questions will be permanently deleted. This can&apos;t be undone. Exams with attempts can only be
          archived.
        </p>
      </Sheet>
    </AdminPage>
  );
}

// ── Results ─────────────────────────────────────────────────────────────────

type Sort = "latest" | "score" | "flags";

function ResultsPanel({ examId, passPercent, onGranted }: { examId: string; passPercent: number | null; onGranted: (message: string) => void }) {
  const { data, error, reload } = usePoll<{ results: ResultRow[]; serverTime: number }>(`/api/admin/exams/${examId}/results`, 15_000);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("latest");
  const [granting, setGranting] = useState<string | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (data?.results ?? []).filter((r) => !q || r.userName.toLowerCase().includes(q) || r.userEmail.toLowerCase().includes(q));
    const sorted = [...list];
    if (sort === "score") sorted.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
    if (sort === "flags") sorted.sort((a, b) => b.flagCount - a.flagCount || b.riskScore - a.riskScore);
    return sorted;
  }, [data, query, sort]);

  async function grant(r: ResultRow) {
    setGranting(r.userId);
    setGrantError(null);
    try {
      await api(`/api/admin/exams/${examId}/allowances`, { method: "POST", json: { userId: r.userId, add: 1 } });
      onGranted(`${r.userName} can take the exam once more.`);
      reload();
    } catch (e) {
      setGrantError(errorMessage(e));
    } finally {
      setGranting(null);
    }
  }

  if (!data) return error ? <Notice>{error}</Notice> : <LoadingScreen />;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle" />
          <Input className="h-9 pl-9 text-[14px]" placeholder="Search candidates" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Segmented
          value={sort}
          onChange={setSort}
          options={[
            { value: "latest", label: "Latest" },
            { value: "score", label: "Highest score" },
            { value: "flags", label: "Most flagged" },
          ]}
        />
      </div>
      {grantError && <Notice className="mb-3">{grantError}</Notice>}
      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <EmptyState icon={<UsersIcon size={22} />} title={data.results.length ? "No matches" : "No attempts yet"} body={data.results.length ? undefined : "Results appear as soon as candidates finish."} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px]">
              <thead className="border-b border-line">
                <tr>
                  <Th>Candidate</Th>
                  <Th className="text-right">Score</Th>
                  <Th className="text-right">Right · Wrong · Blank</Th>
                  <Th>Status</Th>
                  <Th>Integrity</Th>
                  <Th>Finished</Th>
                  <Th className="text-right">Time</Th>
                  <Th className="text-right">Attempts</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => {
                  const st = ATTEMPT_STATUS[r.status];
                  const risk = riskLabel(r.riskScore);
                  const left = r.attemptsAllowed - r.attemptsUsed;
                  return (
                    <tr key={r.sessionId} className="hover:bg-surface-2/60">
                      <Td>
                        <RowLink href={`/admin/attempts/${r.sessionId}`}>{r.userName}</RowLink>
                        <p className="text-[12px] text-muted">{r.userEmail}</p>
                      </Td>
                      <Td className="text-right">
                        <p className={cx("text-[16px] font-semibold tabular-nums", toneText(scoreTone(r.percent, passPercent)))}>{formatPercent(r.percent, 1)}</p>
                        <p className="text-[12px] text-muted tabular-nums">{formatScore(r.score, r.maxScore)}</p>
                      </Td>
                      <Td className="text-right text-muted tabular-nums">
                        {r.correct === null ? "—" : `${r.correct} · ${r.incorrect} · ${r.unanswered}`}
                      </Td>
                      <Td>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        {r.endReason && r.endReason !== "submitted" && r.status !== "active" && <p className="mt-1 text-[12px] text-muted">{END_REASON[r.endReason]}</p>}
                      </Td>
                      <Td>
                        <Badge tone={risk.tone}>{risk.label}</Badge>
                        <p className="mt-1 text-[12px] text-muted">{r.flagCount} flags</p>
                      </Td>
                      <Td className="whitespace-nowrap text-muted">{r.endedAt ? formatDateTime(r.endedAt) : "—"}</Td>
                      <Td className="text-right whitespace-nowrap text-muted tabular-nums">{r.durationMs === null ? "—" : formatDuration(r.durationMs)}</Td>
                      <Td className="text-right whitespace-nowrap">
                        <p className="text-[13px] tabular-nums">
                          #{r.attemptNo} · {Math.max(0, left)} left
                        </p>
                        <button
                          type="button"
                          onClick={() => void grant(r)}
                          disabled={granting !== null}
                          className="focus-ring mt-0.5 inline-flex items-center gap-1 rounded text-[12px] font-medium text-accent hover:underline disabled:opacity-40"
                        >
                          {granting === r.userId ? <Spinner className="size-3" /> : <PlusIcon size={12} />} Allow another
                        </button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Questions ───────────────────────────────────────────────────────────────

function QuestionsPanel({ exam, onSave }: { exam: AdminExamDetail; onSave: (questions: AdminExamDetail["questions"]) => Promise<boolean> }) {
  const [questions, setQuestions] = useState(exam.questions);
  const [saving, setSaving] = useState(false);
  const dirty = questions.some((q, i) => q.answer !== exam.questions[i]?.answer);

  return (
    <div className="max-w-[860px]">
      {exam.locked ? (
        <Notice tone="neutral" className="mb-4">
          Candidates have taken this exam, so questions and answers are locked to keep results consistent.
        </Notice>
      ) : (
        dirty && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-[14px] bg-accent-soft px-4 py-3">
            <p className="text-[14px] text-accent">You changed the answer key.</p>
            <div className="flex gap-2">
              <Button variant="plain" size="sm" onClick={() => setQuestions(exam.questions)} disabled={saving}>
                Discard
              </Button>
              <Button
                size="sm"
                disabled={saving}
                onClick={async () => {
                  setSaving(true);
                  await onSave(questions);
                  setSaving(false);
                }}
              >
                {saving && <Spinner />} Save answer key
              </Button>
            </div>
          </div>
        )
      )}
      <QuestionReview
        questions={questions}
        editable={!exam.locked}
        onSetAnswer={(index, key) => setQuestions((qs) => qs.map((q, i) => (i === index ? { ...q, answer: key } : q)))}
      />
    </div>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

function SettingsPanel({
  exam,
  busy,
  onSave,
  onArchive,
  onDelete,
}: {
  exam: AdminExamDetail;
  busy: boolean;
  onSave: (settings: ExamSettings) => Promise<boolean>;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState<ExamSettings>(() => settingsOf(exam));
  const [tried, setTried] = useState(false);
  const original = settingsOf(exam);
  const dirty = JSON.stringify(value) !== JSON.stringify(original);
  const hasErrors = Object.keys(settingsErrors(value)).length > 0;

  return (
    <div className="max-w-[720px] space-y-4">
      <ExamSettingsForm value={value} onChange={(patch) => setValue((v) => ({ ...v, ...patch }))} codeLocked={exam.locked} showErrors={tried} />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" disabled={!dirty || busy} onClick={() => setValue(original)}>
          Reset
        </Button>
        <Button
          disabled={!dirty || busy}
          onClick={() => {
            setTried(true);
            if (!hasErrors) void onSave(value);
          }}
        >
          {busy && <Spinner />} Save settings
        </Button>
      </div>
      <Card className="p-5">
        <p className="text-headline">Remove exam</p>
        <p className="mt-1 text-[14px] text-muted">
          Archiving hides the exam from candidates and keeps every result. Deleting is only possible before anyone has started it.
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" onClick={onArchive} disabled={busy || exam.status === "archived"}>
            Archive
          </Button>
          <Button variant="danger-plain" onClick={onDelete} disabled={busy || exam.locked}>
            Delete…
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── Attempts (access) ───────────────────────────────────────────────────────

function AccessPanel({ exam, onChanged }: { exam: AdminExamDetail; onChanged: (message: string) => void }) {
  const [allowances, setAllowances] = useState<Allowance[] | null>(null);
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<LmsUserLite[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ allowances: Allowance[] }>(`/api/admin/exams/${exam.id}/allowances`)
      .then((d) => setAllowances(d.allowances))
      .catch((e) => setError(errorMessage(e)));
  }, [exam.id]);

  const term = query.trim();
  const searchActive = term.length >= 2;
  useEffect(() => {
    if (!searchActive) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      setSearching(true);
      api<{ users: LmsUserLite[] }>(`/api/admin/users?q=${encodeURIComponent(term)}`)
        .then((d) => !cancelled && setUsers(d.users))
        .catch((e) => !cancelled && setError(errorMessage(e)))
        .finally(() => !cancelled && setSearching(false));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [term, searchActive]);
  const shownUsers = searchActive ? users : [];

  async function change(userId: string, body: { add: number } | { set: number }, message: string) {
    setBusy(userId);
    setError(null);
    try {
      const d = await api<{ allowances: Allowance[] }>(`/api/admin/exams/${exam.id}/allowances`, { method: "POST", json: { userId, ...body } });
      setAllowances(d.allowances);
      onChanged(message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section>
        <h2 className="text-headline mb-1 px-1">Allow more attempts</h2>
        <p className="mb-3 px-1 text-[13px] text-muted">
          Everyone gets {exam.maxAttempts} attempt{exam.maxAttempts === 1 ? "" : "s"}. Find a learner to give them another.
        </p>
        <Card className="p-4">
          <div className="relative">
            <SearchIcon size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle" />
            <Input className="pl-9" placeholder="Name or email" value={query} onChange={(e) => setQuery(e.target.value)} />
            {searchActive && searching && <Spinner className="absolute top-1/2 right-3 -translate-y-1/2 text-subtle" />}
          </div>
          {shownUsers.length > 0 && (
            <ul className="mt-3 divide-y divide-line">
              {shownUsers.map((u) => (
                <li key={u.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium">{u.name}</p>
                    <p className="truncate text-[12px] text-muted">
                      {u.email} · {u.role}
                    </p>
                  </div>
                  <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void change(u.id, { add: 1 }, `${u.name} can take the exam once more.`)}>
                    {busy === u.id ? <Spinner /> : <PlusIcon size={14} />} 1 attempt
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {searchActive && !searching && shownUsers.length === 0 && <p className="mt-3 text-[13px] text-muted">No active users match.</p>}
        </Card>
        {error && <Notice className="mt-3">{error}</Notice>}
      </section>

      <section>
        <h2 className="text-headline mb-1 px-1">Extra attempts granted</h2>
        <p className="mb-3 px-1 text-[13px] text-muted">On top of the exam&apos;s limit.</p>
        <Card className="overflow-hidden">
          {!allowances ? (
            <LoadingScreen />
          ) : allowances.length === 0 ? (
            <EmptyState title="None yet" body="Learners you give extra attempts to will be listed here." />
          ) : (
            <ul className="divide-y divide-line">
              {allowances.map((a) => (
                <li key={a.userId} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium">{a.userName}</p>
                    <p className="truncate text-[12px] text-muted">
                      {a.userEmail} · used {a.attemptsUsed} of {a.attemptsAllowed}
                    </p>
                  </div>
                  <Badge tone="accent">+{a.extraAttempts}</Badge>
                  <Button size="sm" variant="plain" disabled={busy !== null} onClick={() => void change(a.userId, { add: 1 }, `Added an attempt for ${a.userName}.`)}>
                    Add
                  </Button>
                  <Button
                    size="sm"
                    variant="danger-plain"
                    disabled={busy !== null || a.extraAttempts === 0}
                    onClick={() => void change(a.userId, { set: 0 }, `Removed extra attempts for ${a.userName}.`)}
                  >
                    Reset
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
