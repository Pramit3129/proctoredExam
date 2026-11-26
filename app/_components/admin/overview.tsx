"use client";

import Link from "next/link";

import { formatCountdown, formatPercent, formatRelative } from "@/lib/format";
import type { AdminExamSummary, ResultRow } from "@/lib/exam-types";

import { usePoll } from "../hooks/use-poll";
import { DocIcon, PlusIcon, UsersIcon } from "../icons";
import { Badge, Card, Dot, EmptyState, LoadingScreen, Notice, SectionHeader, Stat, buttonClasses, cx, toneText } from "../ui";
import { AdminPage } from "./admin-shell";
import { ATTEMPT_STATUS, END_REASON, EXAM_STATUS, riskLabel, scoreTone } from "./labels";

type Live = ResultRow & { examTitle: string; examCode: string; endsAt: number; lastSeenAt: number };
type Recent = ResultRow & { examTitle: string; examId: string };

interface Overview {
  exams: AdminExamSummary[];
  live: Live[];
  recent: Recent[];
  serverTime: number;
}

export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={cx("px-4 py-2.5 text-left text-[12px] font-medium whitespace-nowrap text-muted first:pl-5 last:pr-5", className)}>{children}</th>;
}

export function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <td className={cx("px-4 py-3 text-[14px] first:pl-5 last:pr-5", className)}>{children}</td>;
}

export function RowLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={cx("focus-ring rounded font-medium text-foreground hover:text-accent", className)}>
      {children}
    </Link>
  );
}

export function AdminOverview() {
  const { data, error } = usePoll<Overview>("/api/admin/overview", 10_000);

  const actions = (
    <Link href="/admin/exams/new" className={buttonClasses("primary")}>
      <PlusIcon size={17} /> New exam
    </Link>
  );

  if (!data) {
    return (
      <AdminPage title="Overview" actions={actions}>
        {error ? <Notice>{error}</Notice> : <LoadingScreen />}
      </AdminPage>
    );
  }

  const published = data.exams.filter((e) => e.status === "published").length;
  const attempts = data.exams.reduce((n, e) => n + e.stats.attempts, 0);
  const flagged = data.exams.reduce((n, e) => n + e.stats.flagged, 0);
  const completed = data.exams.reduce((n, e) => n + e.stats.completed, 0);
  const weighted = data.exams.reduce((n, e) => n + (e.stats.averagePercent ?? 0) * e.stats.completed, 0);

  return (
    <AdminPage title="Overview" subtitle="Exams, live attempts and recent results." actions={actions}>
      {error && <Notice className="mb-4">{error}</Notice>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Published exams" value={published} detail={`${data.exams.length} in total`} />
        <Stat label="In progress now" value={data.live.length} tone={data.live.length > 0 ? "accent" : undefined} detail="Live attempts" />
        <Stat label="Average score" value={completed > 0 ? formatPercent(weighted / completed) : "—"} detail={`${completed} completed attempts`} />
        <Stat label="Flagged attempts" value={flagged} tone={flagged > 0 ? "warn" : undefined} detail={`of ${attempts} attempts`} />
      </div>

      <section className="mt-10">
        <SectionHeader title="Live now" detail="Refreshes every 10 seconds." />
        <Card className="overflow-hidden">
          {data.live.length === 0 ? (
            <EmptyState icon={<UsersIcon size={22} />} title="No one is taking an exam" body="Attempts in progress will appear here." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px]">
                <thead className="border-b border-line">
                  <tr>
                    <Th>Candidate</Th>
                    <Th>Exam</Th>
                    <Th>Started</Th>
                    <Th>Time left</Th>
                    <Th>Flags</Th>
                    <Th>Risk</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {data.live.map((r) => {
                    const risk = riskLabel(r.riskScore);
                    const silent = data.serverTime - r.lastSeenAt > 20_000;
                    return (
                      <tr key={r.sessionId} className="hover:bg-surface-2/60">
                        <Td>
                          <div className="flex items-center gap-2.5">
                            <Dot tone={silent ? "warn" : "ok"} pulse={!silent} />
                            <div className="min-w-0">
                              <RowLink href={`/admin/attempts/${r.sessionId}`}>{r.userName}</RowLink>
                              <p className="truncate text-[12px] text-muted">{r.userEmail}</p>
                            </div>
                          </div>
                        </Td>
                        <Td className="text-muted">{r.examTitle}</Td>
                        <Td className="text-muted">{formatRelative(r.startedAt, data.serverTime)}</Td>
                        <Td className="font-mono tabular-nums">{formatCountdown(r.endsAt - data.serverTime)}</Td>
                        <Td>{r.flagCount > 0 ? <Badge tone="warn">{r.flagCount}</Badge> : <span className="text-subtle">0</span>}</Td>
                        <Td>
                          <Badge tone={risk.tone}>{risk.label}</Badge>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>

      <div className="mt-10 grid gap-8 xl:grid-cols-[1.4fr_1fr]">
        <section>
          <SectionHeader title="Recent submissions" />
          <Card className="overflow-hidden">
            {data.recent.length === 0 ? (
              <EmptyState title="No submissions yet" body="Completed attempts and their scores will show here." />
            ) : (
              <ul className="divide-y divide-line">
                {data.recent.map((r) => {
                  const status = ATTEMPT_STATUS[r.status];
                  return (
                    <li key={r.sessionId} className="flex items-center gap-4 px-5 py-3 hover:bg-surface-2/60">
                      <div className="min-w-0 flex-1">
                        <RowLink href={`/admin/attempts/${r.sessionId}`}>{r.userName}</RowLink>
                        <p className="truncate text-[12px] text-muted">
                          {r.examTitle} · {r.endedAt ? formatRelative(r.endedAt, data.serverTime) : ""}
                          {r.endReason && r.endReason !== "submitted" ? ` · ${END_REASON[r.endReason]}` : ""}
                        </p>
                      </div>
                      {r.flagCount > 0 && <Badge tone="warn">{r.flagCount} flags</Badge>}
                      <Badge tone={status.tone} className="hidden sm:inline-flex">
                        {status.label}
                      </Badge>
                      <span className={cx("w-14 text-right text-[15px] font-semibold tabular-nums", toneText(r.passed === null ? scoreTone(r.percent, null) : r.passed ? "ok" : "danger"))}>
                        {formatPercent(r.percent)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </section>

        <section>
          <SectionHeader
            title="Exams"
            action={
              <Link href="/admin/exams" className="focus-ring rounded text-[14px] text-accent hover:underline">
                See all
              </Link>
            }
          />
          <Card className="overflow-hidden">
            {data.exams.length === 0 ? (
              <EmptyState
                icon={<DocIcon size={22} />}
                title="No exams yet"
                body="Upload a question paper and its answer key to create one."
                action={
                  <Link href="/admin/exams/new" className={buttonClasses("primary", "sm")}>
                    Create exam
                  </Link>
                }
              />
            ) : (
              <ul className="divide-y divide-line">
                {data.exams.slice(0, 8).map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/60">
                    <div className="min-w-0 flex-1">
                      <RowLink href={`/admin/exams/${e.id}`} className="block truncate">
                        {e.title}
                      </RowLink>
                      <p className="text-[12px] text-muted">
                        {e.stats.completed} completed · avg {formatPercent(e.stats.averagePercent)}
                      </p>
                    </div>
                    <Badge tone={EXAM_STATUS[e.status].tone}>{EXAM_STATUS[e.status].label}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>
    </AdminPage>
  );
}
