import "server-only";

import type { Allowance, AttemptDetail, LmsUserLite, ResultRow } from "@/lib/exam-types";
import { EVENT_CATALOG, SEVERITY_RANK, isEventType, type EventType } from "@/lib/proctor/catalog";
import type { ClientInfo, EndReason, SessionStatus } from "@/lib/proctor/protocol";

import { audit } from "./audit";
import type { AuthUser } from "./auth";
import { ms, msOrThrow, query, queryOne, tx } from "./db";
import { HttpError, isRecord, isUuid, optionalString } from "./http";

interface ResultSqlRow {
  id: string;
  exam_id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  attempt_no: number;
  status: SessionStatus;
  end_reason: EndReason | null;
  started_at: Date;
  ended_at: Date | null;
  score: number | null;
  max_score: number | null;
  percent: number | null;
  correct_count: number | null;
  incorrect_count: number | null;
  unanswered_count: number | null;
  passed: boolean | null;
  risk_score: number;
  flag_count: number;
  attempts_used: number;
  attempts_allowed: number;
}

const RESULT_COLUMNS = `
  s.id, s.exam_id, s.user_id, s.user_name, s.user_email, s.attempt_no, s.status, s.end_reason, s.started_at, s.ended_at,
  s.score, s.max_score, s.percent, s.correct_count, s.incorrect_count, s.unanswered_count, s.passed, s.risk_score, s.flag_count,
  (SELECT count(*)::int FROM proctor.sessions x WHERE x.exam_id = s.exam_id AND x.user_id = s.user_id) AS attempts_used,
  (e.max_attempts + coalesce((SELECT a.extra_attempts FROM proctor.attempt_allowances a WHERE a.exam_id = s.exam_id AND a.user_id = s.user_id), 0))::int AS attempts_allowed`;

function resultFrom(r: ResultSqlRow): ResultRow {
  const startedAt = msOrThrow(r.started_at);
  const endedAt = ms(r.ended_at);
  return {
    sessionId: r.id,
    userId: r.user_id,
    userName: r.user_name,
    userEmail: r.user_email,
    attemptNo: r.attempt_no,
    attemptsAllowed: r.attempts_allowed,
    attemptsUsed: r.attempts_used,
    status: r.status,
    endReason: r.end_reason,
    startedAt,
    endedAt,
    durationMs: endedAt === null ? null : endedAt - startedAt,
    score: r.score,
    maxScore: r.max_score,
    percent: r.percent,
    correct: r.correct_count,
    incorrect: r.incorrect_count,
    unanswered: r.unanswered_count,
    passed: r.passed,
    riskScore: Math.min(100, r.risk_score),
    flagCount: r.flag_count,
  };
}

export async function examResults(examId: string): Promise<ResultRow[]> {
  const rows = await query<ResultSqlRow>(
    `SELECT ${RESULT_COLUMNS}
       FROM proctor.sessions s JOIN proctor.exams e ON e.id = s.exam_id
      WHERE s.exam_id = $1
      ORDER BY s.started_at DESC
      LIMIT 5000`,
    [examId],
  );
  return rows.map(resultFrom);
}

export async function liveAttempts(): Promise<(ResultRow & { examTitle: string; examCode: string; endsAt: number; lastSeenAt: number })[]> {
  const rows = await query<ResultSqlRow & { exam_title: string; exam_code: string; ends_at: Date; last_seen_at: Date }>(
    `SELECT ${RESULT_COLUMNS}, e.title AS exam_title, e.code AS exam_code, s.ends_at, s.last_seen_at
       FROM proctor.sessions s JOIN proctor.exams e ON e.id = s.exam_id
      WHERE s.status = 'active'
      ORDER BY s.started_at DESC LIMIT 500`,
  );
  return rows.map((r) => ({
    ...resultFrom(r),
    examTitle: r.exam_title,
    examCode: r.exam_code,
    endsAt: msOrThrow(r.ends_at),
    lastSeenAt: msOrThrow(r.last_seen_at),
  }));
}

export async function recentAttempts(limit = 20): Promise<(ResultRow & { examTitle: string; examId: string })[]> {
  const rows = await query<ResultSqlRow & { exam_title: string }>(
    `SELECT ${RESULT_COLUMNS}, e.title AS exam_title
       FROM proctor.sessions s JOIN proctor.exams e ON e.id = s.exam_id
      WHERE s.status <> 'active'
      ORDER BY s.ended_at DESC NULLS LAST LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ ...resultFrom(r), examTitle: r.exam_title, examId: r.exam_id }));
}

export async function attemptDetail(sessionId: string): Promise<AttemptDetail | null> {
  const row = await queryOne<
    ResultSqlRow & {
      exam_code: string;
      exam_title: string;
      ends_at: Date;
      last_seen_at: Date;
      ip: string | null;
      user_agent: string | null;
      client_info: ClientInfo | null;
      resync_count: number;
      last_seq: number;
    }
  >(
    `SELECT ${RESULT_COLUMNS}, e.code AS exam_code, e.title AS exam_title, s.ends_at, s.last_seen_at, s.ip, s.user_agent,
            s.client_info, s.resync_count, s.last_seq
       FROM proctor.sessions s JOIN proctor.exams e ON e.id = s.exam_id
      WHERE s.id = $1`,
    [sessionId],
  );
  if (!row) return null;

  const answers = await query<{
    id: string;
    number: number;
    section: string | null;
    prompt: string;
    options: { key: string; text: string }[];
    correct_key: string;
    points: number;
    option_key: string | null;
    changes: number | null;
    answered_at: Date | null;
  }>(
    `SELECT q.id, q.number, q.section, q.prompt, q.options, q.correct_key, q.points, a.option_key, a.changes, a.answered_at
       FROM proctor.questions q
       LEFT JOIN proctor.answers a ON a.question_id = q.id AND a.session_id = $1
      WHERE q.exam_id = $2
      ORDER BY q.position`,
    [sessionId, row.exam_id],
  );

  const events = await query<{
    id: number;
    source: "client" | "server";
    seq: number | null;
    type: string;
    category: string;
    severity: string;
    phase: string | null;
    client_ts: number | null;
    server_ts: Date;
    duration_ms: number | null;
    data: Record<string, unknown>;
    risk_points: number;
  }>(
    `SELECT id, source, seq, type, category, severity, phase, client_ts, server_ts, duration_ms, data, risk_points
       FROM proctor.events WHERE session_id = $1 ORDER BY id ASC LIMIT 20000`,
    [sessionId],
  );

  const summary = new Map<EventType, { count: number; totalMs: number }>();
  for (const e of events) {
    if (!isEventType(e.type)) continue;
    const spec = EVENT_CATALOG[e.type];
    if (SEVERITY_RANK[spec.severity] < SEVERITY_RANK.low) continue;
    const entry = summary.get(e.type) ?? { count: 0, totalMs: 0 };
    if (e.phase !== "end") entry.count += 1;
    if (e.phase === "end" && e.duration_ms) entry.totalMs += e.duration_ms;
    summary.set(e.type, entry);
  }

  return {
    attempt: {
      ...resultFrom(row),
      examId: row.exam_id,
      examCode: row.exam_code,
      examTitle: row.exam_title,
      endsAt: msOrThrow(row.ends_at),
      lastSeenAt: msOrThrow(row.last_seen_at),
      ip: row.ip,
      userAgent: row.user_agent,
      clientInfo: row.client_info,
      resyncCount: row.resync_count,
      lastSeq: row.last_seq,
    },
    answers: answers.map((a) => ({
      questionId: a.id,
      number: a.number,
      section: a.section,
      prompt: a.prompt,
      options: a.options,
      correctKey: a.correct_key,
      chosenKey: a.option_key,
      isCorrect: a.option_key === a.correct_key,
      points: a.points,
      changes: a.changes ?? 0,
      answeredAt: ms(a.answered_at),
    })),
    events: events
      .filter((e) => isEventType(e.type))
      .map((e) => ({
        id: e.id,
        source: e.source,
        seq: e.seq,
        type: e.type as EventType,
        category: e.category,
        severity: e.severity,
        phase: e.phase,
        clientTs: e.client_ts,
        serverTs: msOrThrow(e.server_ts),
        durationMs: e.duration_ms,
        data: e.data,
        riskPoints: e.risk_points,
      })),
    flagSummary: [...summary]
      .map(([type, v]) => ({ type, ...v }))
      .sort((a, b) => SEVERITY_RANK[EVENT_CATALOG[b.type].severity] - SEVERITY_RANK[EVENT_CATALOG[a.type].severity] || b.count - a.count),
  };
}

// ── CSV export ──────────────────────────────────────────────────────────────

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function resultsCsv(rows: ResultRow[]): string {
  const header = [
    "Name",
    "Email",
    "Attempt",
    "Status",
    "End reason",
    "Started (UTC)",
    "Ended (UTC)",
    "Duration (min)",
    "Score",
    "Max score",
    "Percent",
    "Correct",
    "Incorrect",
    "Unanswered",
    "Passed",
    "Flags",
    "Risk score",
  ];
  const lines = rows.map((r) =>
    [
      r.userName,
      r.userEmail,
      r.attemptNo,
      r.status,
      r.endReason,
      new Date(r.startedAt).toISOString(),
      r.endedAt ? new Date(r.endedAt).toISOString() : "",
      r.durationMs === null ? "" : (r.durationMs / 60_000).toFixed(1),
      r.score,
      r.maxScore,
      r.percent,
      r.correct,
      r.incorrect,
      r.unanswered,
      r.passed === null ? "" : r.passed ? "yes" : "no",
      r.flagCount,
      r.riskScore,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}

// ── LMS users (read-only) and attempt allowances ───────────────────────────

export async function searchLmsUsers(q: string): Promise<LmsUserLite[]> {
  const term = q.trim().toLowerCase().slice(0, 100);
  if (term.length < 2) return [];
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await query<{ id: string; first_name: string; last_name: string; email: string; role: string }>(
    `SELECT id, first_name, last_name, email, role FROM public.users
      WHERE deleted_at IS NULL AND is_active
        AND (lower(email) LIKE $1 OR lower(first_name || ' ' || last_name) LIKE $1)
      ORDER BY lower(email) LIMIT 20`,
    [like],
  );
  return rows.map((r) => ({ id: r.id, name: `${r.first_name} ${r.last_name}`.trim() || r.email, email: r.email, role: r.role }));
}

export async function listAllowances(examId: string): Promise<Allowance[]> {
  const rows = await query<{
    user_id: string;
    extra_attempts: number;
    note: string | null;
    updated_at: Date;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    used: number;
    max_attempts: number;
  }>(
    `SELECT a.user_id, a.extra_attempts, a.note, a.updated_at, u.first_name, u.last_name, u.email, e.max_attempts,
            (SELECT count(*)::int FROM proctor.sessions s WHERE s.exam_id = a.exam_id AND s.user_id = a.user_id) AS used
       FROM proctor.attempt_allowances a
       JOIN proctor.exams e ON e.id = a.exam_id
       LEFT JOIN public.users u ON u.id = a.user_id
      WHERE a.exam_id = $1
      ORDER BY a.updated_at DESC`,
    [examId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    userName: `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || r.email || "Deleted user",
    userEmail: r.email ?? "",
    extraAttempts: r.extra_attempts,
    attemptsUsed: r.used,
    attemptsAllowed: r.max_attempts + r.extra_attempts,
    note: r.note,
    updatedAt: msOrThrow(r.updated_at),
  }));
}

/**
 * Grants a user more attempts on an exam. `add` increments the current extra
 * attempts; `set` replaces them (0 removes the grant).
 */
export async function changeAllowance(admin: AuthUser, examId: string, body: unknown, ip: string): Promise<Allowance[]> {
  if (!isRecord(body) || !isUuid(body.userId)) throw new HttpError(400, "invalid_body", "Choose a user.");
  const userId = body.userId.toLowerCase();
  const note = optionalString(body, "note", 300);
  const add = typeof body.add === "number" && Number.isInteger(body.add) ? body.add : null;
  const set = typeof body.set === "number" && Number.isInteger(body.set) ? body.set : null;
  if ((add === null) === (set === null)) throw new HttpError(400, "invalid_body", "Send either add or set.");
  if (add !== null && (add < 1 || add > 10)) throw new HttpError(400, "invalid_body", "Add between 1 and 10 attempts at a time.");
  if (set !== null && (set < 0 || set > 50)) throw new HttpError(400, "invalid_body", "Extra attempts must be between 0 and 50.");

  await tx(async (db) => {
    const exam = await queryOne("SELECT 1 FROM proctor.exams WHERE id = $1", [examId], db);
    if (!exam) throw new HttpError(404, "not_found", "Exam not found.");
    const user = await queryOne<{ email: string }>("SELECT email FROM public.users WHERE id = $1 AND deleted_at IS NULL", [userId], db);
    if (!user) throw new HttpError(404, "not_found", "That user does not exist in the LMS.");
    const row = await queryOne<{ extra_attempts: number }>(
      `INSERT INTO proctor.attempt_allowances (exam_id, user_id, extra_attempts, note, updated_by, updated_at)
       VALUES ($1, $2, LEAST(50, $3), $4, $5, now())
       ON CONFLICT (exam_id, user_id) DO UPDATE SET
         extra_attempts = LEAST(50, CASE WHEN $6 THEN proctor.attempt_allowances.extra_attempts + $3 ELSE $3 END),
         note = coalesce($4, proctor.attempt_allowances.note), updated_by = $5, updated_at = now()
       RETURNING extra_attempts`,
      [examId, userId, add ?? set, note, admin.id, add !== null],
      db,
    );
    await audit(admin, "attempts.grant", { type: "exam", id: examId }, { user: user.email, add, set, extraAttempts: row?.extra_attempts, note }, ip, db);
  });
  return listAllowances(examId);
}
