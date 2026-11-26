import "server-only";

import { randomInt } from "node:crypto";

import type pg from "pg";

import { EVENT_CATALOG, SEVERITY_RANK, isClientEventType, riskContribution, type EventType } from "@/lib/proctor/catalog";
import {
  DEFAULT_DETECTION_CONFIG,
  END_REASONS,
  LIMITS,
  PROTOCOL_VERSION,
  TIMING,
  chainInput,
  resyncMessage,
  type BatchResponse,
  type ClientInfo,
  type EndReason,
  type EndResponse,
  type ExamQuestionPublic,
  type Heartbeat,
  type SessionBootstrap,
  type SessionStatus,
  type WireEvent,
} from "@/lib/proctor/protocol";

import { audit } from "./audit";
import type { AuthUser } from "./auth";
import { hmacHex, randomHex, randomToken, safeEqual, signValue, verifySignedValue } from "./crypto";
import { msOrThrow, query, queryOne, tx } from "./db";
import { EXAM_CODE_RE, attemptCounts, questionIndex, type ExamRow, type QuestionRow } from "./exams";
import { HttpError, isFiniteInt, isRecord, isUuid } from "./http";

export interface SessionRow {
  id: string;
  exam_id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  attempt_no: number;
  status: SessionStatus;
  end_reason: EndReason | null;
  started_at: Date;
  ends_at: Date;
  ended_at: Date | null;
  last_seen_at: Date;
  chain_key: string;
  last_seq: number;
  last_hash: string;
  ack_token: string;
  prev_ack_token: string | null;
  prev_batch_count: number;
  clock_offset_ms: number | null;
  stall_count: number;
  resync_count: number;
  risk_score: number;
  flag_count: number;
  question_order: string[];
  option_order: Record<string, string[]>;
}

interface RequestMeta {
  ip: string;
  userAgent: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const OPTION_KEY = /^[A-H]$/;

// ── Cookie binding ──────────────────────────────────────────────────────────

export function sessionCookieValue(sessionId: string): string {
  return signValue(`attempt:${sessionId}`);
}

export function sessionIdFromCookie(cookieValue: string | undefined): string | null {
  const value = verifySignedValue(cookieValue);
  return value?.startsWith("attempt:") ? value.slice("attempt:".length) : null;
}

/** Loads the attempt bound to the cookie, and checks it belongs to the signed-in user. */
export async function ownedSession(user: AuthUser, cookieValue: string | undefined): Promise<SessionRow> {
  const id = sessionIdFromCookie(cookieValue);
  if (!id) throw new HttpError(401, "no_session", "No exam in progress in this window.");
  const row = await queryOne<SessionRow>("SELECT * FROM proctor.sessions WHERE id = $1", [id]);
  if (!row || row.user_id !== user.id) throw new HttpError(401, "no_session", "No exam in progress in this window.");
  return row;
}

// ── Event recording ─────────────────────────────────────────────────────────

interface StoredEvent {
  source: "client" | "server";
  seq: number | null;
  type: EventType;
  phase: "start" | "end" | null;
  clientTs: number | null;
  serverTs: number;
  durationMs: number | null;
  data: Record<string, unknown>;
  hash: string | null;
}

/** Inserts events and adds their risk to the attempt. Caller holds the row lock. */
async function insertEvents(client: pg.PoolClient, sessionId: string, events: StoredEvent[]): Promise<void> {
  if (events.length === 0) return;
  let risk = 0;
  let flags = 0;
  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const e of events) {
    const spec = EVENT_CATALOG[e.type];
    const points = riskContribution(e.type, e.phase ?? undefined, e.durationMs);
    if (SEVERITY_RANK[spec.severity] >= SEVERITY_RANK.medium && e.phase !== "end") flags += 1;
    risk += points;
    const base = values.length;
    values.push(
      sessionId,
      e.source,
      e.seq,
      e.type,
      spec.category,
      spec.severity,
      e.phase,
      e.clientTs,
      e.serverTs,
      e.durationMs,
      JSON.stringify(e.data),
      e.hash,
      points,
    );
    const p = (i: number) => `$${base + i}`;
    tuples.push(
      `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, to_timestamp(${p(9)} / 1000.0), ${p(10)}, ${p(11)}, ${p(12)}, ${p(13)})`,
    );
  }
  await client.query(
    `INSERT INTO proctor.events (session_id, source, seq, type, category, severity, phase, client_ts, server_ts, duration_ms, data, hash, risk_points)
     VALUES ${tuples.join(", ")}`,
    values,
  );
  if (risk > 0 || flags > 0) {
    await client.query("UPDATE proctor.sessions SET risk_score = risk_score + $2, flag_count = flag_count + $3 WHERE id = $1", [
      sessionId,
      risk,
      flags,
    ]);
  }
}

function serverEvent(type: EventType, data: Record<string, unknown>, now: number, durationMs: number | null = null): StoredEvent {
  return { source: "server", seq: null, type, phase: null, clientTs: null, serverTs: now, durationMs, data, hash: null };
}

// ── Grading and closing ─────────────────────────────────────────────────────

async function lockSession(client: pg.PoolClient, id: string, skipLocked = false): Promise<SessionRow | null> {
  const { rows } = await client.query<SessionRow>(
    `SELECT * FROM proctor.sessions WHERE id = $1 FOR UPDATE${skipLocked ? " SKIP LOCKED" : ""}`,
    [id],
  );
  return rows[0] ?? null;
}

function statusFor(reason: EndReason): SessionStatus {
  if (reason === "submitted") return "submitted";
  if (reason === "time_up") return "expired";
  if (reason === "terminated") return "terminated";
  return "auto_submitted";
}

/**
 * Closes an active attempt and grades it from the answers the server holds.
 * The caller must hold the row lock. Results are stored, never returned to the candidate.
 */
async function closeAttempt(
  client: pg.PoolClient,
  session: SessionRow,
  reason: EndReason,
  now: number,
  detail: Record<string, unknown> = {},
): Promise<SessionStatus> {
  const status = statusFor(reason);
  const { rows } = await client.query<{ correct_key: string; points: number; option_key: string | null }>(
    `SELECT q.correct_key, q.points, a.option_key
       FROM proctor.questions q
       LEFT JOIN proctor.answers a ON a.question_id = q.id AND a.session_id = $1
      WHERE q.exam_id = $2`,
    [session.id, session.exam_id],
  );
  let score = 0;
  let max = 0;
  let correct = 0;
  let incorrect = 0;
  let unanswered = 0;
  for (const r of rows) {
    max += r.points;
    if (r.option_key === null) unanswered += 1;
    else if (r.option_key === r.correct_key) {
      correct += 1;
      score += r.points;
    } else incorrect += 1;
  }
  const percent = max > 0 ? Math.round((score / max) * 10_000) / 100 : 0;
  const exam = await queryOne<{ pass_percent: number | null }>("SELECT pass_percent FROM proctor.exams WHERE id = $1", [session.exam_id], client);
  const passed = exam?.pass_percent === null || exam?.pass_percent === undefined ? null : percent >= exam.pass_percent;

  await client.query(
    `UPDATE proctor.sessions
        SET status = $2, end_reason = $3, ended_at = to_timestamp($4 / 1000.0),
            score = $5, max_score = $6, correct_count = $7, incorrect_count = $8, unanswered_count = $9,
            percent = $10, passed = $11, graded_at = to_timestamp($4 / 1000.0)
      WHERE id = $1`,
    [session.id, status, reason, now, score, max, correct, incorrect, unanswered, percent, passed],
  );
  const type: EventType =
    reason === "submitted" ? "SESSION_ENDED" : reason === "time_up" ? "SESSION_EXPIRED" : reason === "terminated" ? "SESSION_TERMINATED" : "AUTO_SUBMITTED";
  await insertEvents(client, session.id, [
    serverEvent(type, { reason, remainingMs: Math.max(0, session.ends_at.getTime() - now), answered: correct + incorrect, ...detail }, now),
  ]);
  session.status = status;
  session.end_reason = reason;
  return status;
}

// ── Housekeeping ────────────────────────────────────────────────────────────

const globalForSweep = globalThis as unknown as { __proctorLastSweep?: number };

/**
 * Closes attempts that are past their deadline or have gone silent. Runs
 * opportunistically from API calls (at most every 15 s per server process),
 * so no background worker is needed.
 */
export async function sweepStaleSessions(force = false): Promise<number> {
  const now = Date.now();
  if (!force && now - (globalForSweep.__proctorLastSweep ?? 0) < 15_000) return 0;
  globalForSweep.__proctorLastSweep = now;
  const stale = await query<{ id: string }>(
    `SELECT id FROM proctor.sessions
      WHERE status = 'active'
        AND (ends_at < to_timestamp($1 / 1000.0) OR last_seen_at < to_timestamp($2 / 1000.0))
      LIMIT 200`,
    [now - TIMING.closeGraceMs, now - TIMING.abandonAfterMs],
  );
  let closed = 0;
  for (const { id } of stale) {
    await tx(async (client) => {
      const s = await lockSession(client, id, true);
      if (!s || s.status !== "active") return;
      const overdue = now > s.ends_at.getTime() + TIMING.closeGraceMs;
      await closeAttempt(client, s, overdue ? "time_up" : "abandoned", now, overdue ? {} : { silentForMs: now - s.last_seen_at.getTime() });
      closed += 1;
    });
  }
  return closed;
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

async function bootstrapFor(client: pg.PoolClient, session: SessionRow, exam: ExamRow, user: AuthUser): Promise<SessionBootstrap> {
  const { rows: questions } = await client.query<QuestionRow>("SELECT * FROM proctor.questions WHERE exam_id = $1", [exam.id]);
  const byId = new Map(questions.map((q) => [q.id, q]));
  const ordered: ExamQuestionPublic[] = session.question_order.flatMap((id) => {
    const q = byId.get(id);
    if (!q) return [];
    const order = session.option_order[id];
    const options = order ? order.flatMap((key) => q.options.filter((o) => o.key === key)) : q.options;
    // Never include correct_key or explanation here.
    return [{ id: q.id, number: q.number, section: q.section, prompt: q.prompt, options: options.map((o) => ({ key: o.key, text: o.text })) }];
  });
  const { rows: answers } = await client.query<{ question_id: string; option_key: string }>(
    "SELECT question_id, option_key FROM proctor.answers WHERE session_id = $1",
    [session.id],
  );
  return {
    sessionId: session.id,
    user: { name: user.name, email: user.email },
    chainKey: session.chain_key,
    lastHash: session.last_hash,
    lastSeq: session.last_seq,
    ack: session.ack_token,
    serverTime: Date.now(),
    attemptNo: session.attempt_no,
    exam: {
      code: exam.code,
      title: exam.title,
      startedAt: msOrThrow(session.started_at),
      endsAt: msOrThrow(session.ends_at),
      strictFocus: exam.strict_focus,
      questions: ordered,
    },
    answers: Object.fromEntries(answers.map((a) => [a.question_id, a.option_key])),
    config: DEFAULT_DETECTION_CONFIG,
  };
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function parseClientInfo(value: unknown): ClientInfo {
  if (!isRecord(value)) throw new HttpError(400, "invalid_body", "Client information is required.");
  if (JSON.stringify(value).length > 4096) throw new HttpError(400, "invalid_body", "Client information is too large.");
  return value as unknown as ClientInfo;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export async function startSession(
  user: AuthUser,
  body: unknown,
  meta: RequestMeta,
): Promise<{ bootstrap: SessionBootstrap; cookie: string; endsAt: number }> {
  if (!isRecord(body)) throw new HttpError(400, "invalid_body", "Expected an object.");
  const code = typeof body.examCode === "string" ? body.examCode.trim().toUpperCase() : "";
  if (!EXAM_CODE_RE.test(code)) throw new HttpError(404, "unknown_exam", "No exam exists with that code.");
  const client = parseClientInfo(body.client);
  await sweepStaleSessions();

  const result = await tx<{ ok: { bootstrap: SessionBootstrap; endsAt: number } } | { refused: HttpError }>(async (db) => {
    const exam = await queryOne<ExamRow>("SELECT * FROM proctor.exams WHERE code = $1 FOR SHARE", [code], db);
    if (!exam || (exam.status !== "published" && exam.status !== "closed")) {
      throw new HttpError(404, "unknown_exam", "No exam exists with that code.");
    }
    // One start at a time per candidate and exam.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7340201))", [`${exam.id}:${user.id}`]);

    const now = Date.now();
    if (exam.status !== "published") throw new HttpError(403, "exam_closed", "This exam is closed.");
    if (exam.opens_at && exam.opens_at.getTime() > now) throw new HttpError(403, "exam_not_open", "This exam has not opened yet.");
    if (exam.closes_at && exam.closes_at.getTime() <= now) throw new HttpError(403, "exam_closed", "This exam is closed.");

    // Opening the exam again means the previous exam page was left: that attempt ends now.
    // This must be committed even if the new start is refused below.
    const { rows: open } = await db.query<SessionRow>(
      "SELECT * FROM proctor.sessions WHERE exam_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE",
      [exam.id, user.id],
    );
    for (const s of open) await closeAttempt(db, s, "page_left", now, { detectedBy: "restart" });
    try {
      return { ok: await createAttempt(db, exam, now) };
    } catch (error) {
      if (error instanceof HttpError && open.length > 0) return { refused: error };
      throw error;
    }
  });
  if ("refused" in result) throw result.refused;
  return { ...result.ok, cookie: sessionCookieValue(result.ok.bootstrap.sessionId) };

  async function createAttempt(db: pg.PoolClient, exam: ExamRow, now: number): Promise<{ bootstrap: SessionBootstrap; endsAt: number }> {
    const { used, allowed } = await attemptCounts(exam.id, user.id, db);
    if (used >= allowed) {
      throw new HttpError(403, "no_attempts", "You have no attempts left for this exam. Contact your administrator if you need another attempt.");
    }

    const { rows: qs } = await db.query<{ id: string; options: { key: string }[] }>(
      "SELECT id, options FROM proctor.questions WHERE exam_id = $1 ORDER BY position",
      [exam.id],
    );
    if (qs.length === 0) throw new HttpError(409, "exam_empty", "This exam has no questions yet.");
    const order = exam.shuffle_questions ? shuffle(qs) : qs;
    const optionOrder = exam.shuffle_options ? Object.fromEntries(qs.map((q) => [q.id, shuffle(q.options.map((o) => o.key))])) : {};

    let endsAt = now + exam.duration_minutes * 60_000;
    if (exam.closes_at) endsAt = Math.min(endsAt, exam.closes_at.getTime());
    if (endsAt - now < 60_000) throw new HttpError(403, "exam_closed", "This exam closes in less than a minute.");

    const id = randomToken(18);
    const { rows } = await db.query<SessionRow>(
      `INSERT INTO proctor.sessions (id, exam_id, user_id, user_email, user_name, attempt_no, status, started_at, ends_at, last_seen_at,
          chain_key, last_seq, last_hash, ack_token, question_order, option_order, ip, user_agent, client_info)
       VALUES ($1, $2, $3, $4, $5, $6, 'active', to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0), to_timestamp($7 / 1000.0),
          $9, 0, $10, $11, $12::uuid[], $13, $14, $15, $16)
       RETURNING *`,
      [
        id,
        exam.id,
        user.id,
        user.email,
        user.name,
        used + 1,
        now,
        endsAt,
        randomToken(32),
        randomHex(32),
        randomToken(24),
        order.map((q) => q.id),
        JSON.stringify(optionOrder),
        meta.ip,
        meta.userAgent.slice(0, 512),
        JSON.stringify(client),
      ],
    );
    const session = rows[0]!;
    await insertEvents(db, id, [
      serverEvent(
        "SESSION_STARTED",
        {
          attempt: used + 1,
          attemptsAllowed: allowed,
          ip: meta.ip,
          camera: client.camera?.label ?? null,
          microphone: client.microphone?.label ?? null,
          screen: client.screen ?? null,
        },
        now,
      ),
    ]);
    return { bootstrap: await bootstrapFor(db, session, exam, user), endsAt };
  }
}

/**
 * Re-synchronises the event chain after the server rejected a batch. Only the
 * original exam page can do this: it must prove it holds the chain key, which
 * is never stored, so a reloaded or copied page cannot resume an attempt.
 */
export async function resyncSession(user: AuthUser, session: SessionRow, body: unknown, meta: RequestMeta): Promise<SessionBootstrap> {
  const proof = isRecord(body) && typeof body.proof === "string" ? body.proof : "";
  const key = Buffer.from(session.chain_key, "base64url");
  if (!HASH_PATTERN.test(proof) || !safeEqual(proof, hmacHex(key, resyncMessage(session.id)))) {
    throw new HttpError(403, "bad_proof", "This exam can only continue in the window where it started.");
  }
  return tx(async (db) => {
    const s = await lockSession(db, session.id);
    if (!s || s.status !== "active") throw new HttpError(410, "session_closed", "This exam has been submitted.");
    const now = Date.now();
    const { rows } = await db.query<SessionRow>(
      `UPDATE proctor.sessions SET ack_token = $2, prev_ack_token = NULL, prev_batch_count = 0,
          resync_count = resync_count + 1, last_seen_at = to_timestamp($3 / 1000.0)
        WHERE id = $1 RETURNING *`,
      [s.id, randomToken(24), now],
    );
    await insertEvents(db, s.id, [
      serverEvent(
        "SESSION_RESUMED",
        { reason: "resync", silentForMs: now - s.last_seen_at.getTime(), ip: meta.ip, userAgentChanged: false },
        now,
      ),
    ]);
    const exam = (await queryOne<ExamRow>("SELECT * FROM proctor.exams WHERE id = $1", [s.exam_id], db))!;
    return bootstrapFor(db, rows[0]!, exam, user);
  });
}

export async function endSession(session: SessionRow, body: unknown): Promise<EndResponse> {
  const requested = isRecord(body) && typeof body.reason === "string" ? body.reason : "submitted";
  // The candidate may end their own attempt for any of these reasons; none of them helps them.
  const reason: EndReason =
    END_REASONS.includes(requested as EndReason) && requested !== "terminated" && requested !== "abandoned"
      ? (requested as EndReason)
      : "submitted";
  return tx(async (db) => {
    const s = await lockSession(db, session.id);
    if (!s) throw new HttpError(401, "no_session", "No exam in progress in this window.");
    if (s.status !== "active") return { status: s.status, endReason: s.end_reason };
    const status = await closeAttempt(db, s, reason, Date.now(), { by: "candidate" });
    return { status, endReason: reason };
  });
}

export async function terminateSession(admin: AuthUser, id: string, ip: string): Promise<SessionStatus> {
  return tx(async (db) => {
    const s = await lockSession(db, id);
    if (!s) throw new HttpError(404, "not_found", "Attempt not found.");
    if (s.status !== "active") return s.status;
    const status = await closeAttempt(db, s, "terminated", Date.now(), { by: admin.email });
    await audit(admin, "attempt.terminate", { type: "session", id }, { user: s.user_email }, ip, db);
    return status;
  });
}

// ── Batch ingestion ─────────────────────────────────────────────────────────

interface ParsedEvent extends WireEvent {
  phase: "start" | "end" | null;
  data: Record<string, unknown>;
}

interface ParsedBatch {
  ack: string;
  sentAt: number;
  hb: Heartbeat;
  events: ParsedEvent[];
}

function parseBatch(body: unknown): ParsedBatch {
  if (!isRecord(body)) throw new HttpError(400, "invalid_body", "Expected an object.");
  if (body.v !== PROTOCOL_VERSION) throw new HttpError(400, "bad_version", "Unsupported protocol version. Reload the page.");
  if (typeof body.ack !== "string" || body.ack.length > 64) throw new HttpError(400, "invalid_body", "Bad ack.");
  if (!isFiniteInt(body.sentAt)) throw new HttpError(400, "invalid_body", "Bad sentAt.");
  const hb = body.hb;
  if (
    !isRecord(hb) ||
    !isFiniteInt(hb.faceCount) ||
    !isFiniteInt(hb.framesAnalyzed) ||
    typeof hb.visible !== "boolean" ||
    typeof hb.focused !== "boolean" ||
    typeof hb.fullscreen !== "boolean" ||
    typeof hb.cameraLive !== "boolean" ||
    typeof hb.micLive !== "boolean"
  ) {
    throw new HttpError(400, "invalid_body", "Bad heartbeat.");
  }
  if (!Array.isArray(body.events) || body.events.length > LIMITS.maxEventsPerBatch) {
    throw new HttpError(400, "invalid_body", "Bad events array.");
  }
  const events: ParsedEvent[] = body.events.map((raw, i) => {
    if (!isRecord(raw)) throw new HttpError(400, "invalid_body", `Event ${i} is not an object.`);
    const { seq, type, ts, dur, d, h } = raw;
    if (!isFiniteInt(seq) || seq < 1) throw new HttpError(400, "invalid_body", `Event ${i}: bad seq.`);
    if (!isClientEventType(type)) throw new HttpError(400, "invalid_body", `Event ${i}: type not allowed.`);
    if (!isFiniteInt(ts)) throw new HttpError(400, "invalid_body", `Event ${i}: bad ts.`);
    if (dur !== undefined && (!isFiniteInt(dur) || dur < 0 || dur > 24 * 3_600_000)) {
      throw new HttpError(400, "invalid_body", `Event ${i}: bad dur.`);
    }
    if (typeof d !== "string" || Buffer.byteLength(d) > LIMITS.maxEventDataBytes) {
      throw new HttpError(400, "invalid_body", `Event ${i}: bad data.`);
    }
    let data: unknown;
    try {
      data = JSON.parse(d);
    } catch {
      throw new HttpError(400, "invalid_body", `Event ${i}: data is not JSON.`);
    }
    if (!isRecord(data)) throw new HttpError(400, "invalid_body", `Event ${i}: data must be an object.`);
    if (typeof h !== "string" || !HASH_PATTERN.test(h)) throw new HttpError(400, "invalid_body", `Event ${i}: bad hash.`);
    const phase = data.phase === "start" || data.phase === "end" ? data.phase : null;
    return { seq, type, ts, dur: dur as number | undefined, d, h, phase, data };
  });
  return { ack: body.ack, sentAt: body.sentAt, hb: hb as unknown as Heartbeat, events };
}

/** Which client events end the attempt on the server. */
function closingReason(e: ParsedEvent, strictFocus: boolean): EndReason | null {
  if (e.type === "FULLSCREEN_EXIT" && e.phase === "start") return "fullscreen_exit";
  if (e.type === "PAGE_HIDE") return "page_left";
  if (strictFocus && e.type === "TAB_HIDDEN" && e.phase === "start") return "tab_hidden";
  return null;
}

type IngestOutcome = { kind: "ok"; response: BatchResponse } | { kind: "chain"; reason: string; detail: Record<string, unknown> };

export async function ingestBatch(session: SessionRow, body: unknown): Promise<BatchResponse> {
  const batch = parseBatch(body);
  const validKeys = await questionIndex(session.exam_id);
  const strict = await queryOne<{ strict_focus: boolean }>("SELECT strict_focus FROM proctor.exams WHERE id = $1", [session.exam_id]);
  const strictFocus = strict?.strict_focus ?? true;

  const outcome = await tx<IngestOutcome>(async (db) => {
    const now = Date.now();
    const s = await lockSession(db, session.id);
    if (!s) throw new HttpError(401, "no_session", "No exam in progress in this window.");
    const closed = (): IngestOutcome => ({
      kind: "ok",
      response: { ack: "", serverTime: now, status: s.status, endReason: s.end_reason, lastSeq: s.last_seq },
    });
    if (s.status !== "active") return closed();
    if (now > s.ends_at.getTime() + TIMING.closeGraceMs) {
      await closeAttempt(db, s, "time_up", now);
      return closed();
    }

    // 1. Ack token: proves this batch follows the last one we accepted.
    if (!safeEqual(batch.ack, s.ack_token)) {
      const isRetryOfLastBatch =
        s.prev_ack_token !== null &&
        safeEqual(batch.ack, s.prev_ack_token) &&
        (batch.events.length === 0
          ? s.prev_batch_count === 0
          : batch.events.at(-1)!.seq === s.last_seq && safeEqual(batch.events.at(-1)!.h, s.last_hash));
      if (isRetryOfLastBatch) {
        // The previous response was lost in transit; the client retried the same batch.
        return { kind: "ok", response: { ack: s.ack_token, serverTime: now, status: "active", endReason: null, lastSeq: s.last_seq } };
      }
      return { kind: "chain", reason: "ack_mismatch", detail: { batchSize: batch.events.length } };
    }

    // 2. Hash chain: contiguous sequence numbers and valid HMAC links.
    const key = Buffer.from(s.chain_key, "base64url");
    let prevHash = s.last_hash;
    let prevSeq = s.last_seq;
    for (const e of batch.events) {
      if (e.seq !== prevSeq + 1) return { kind: "chain", reason: "sequence_gap", detail: { expected: prevSeq + 1, received: e.seq } };
      if (!safeEqual(hmacHex(key, chainInput(prevHash, e)), e.h)) {
        return { kind: "chain", reason: "bad_signature", detail: { seq: e.seq, type: e.type } };
      }
      prevHash = e.h;
      prevSeq = e.seq;
    }

    const stored: StoredEvent[] = [];
    const silentFor = now - s.last_seen_at.getTime();
    let closeWith: { reason: EndReason; detail: Record<string, unknown> } | null = null;

    // 3. Silence since the last batch is itself evidence.
    if (silentFor > TIMING.heartbeatGapMs) {
      stored.push(serverEvent("HEARTBEAT_GAP", { gapMs: silentFor, lastSeenAt: s.last_seen_at.getTime() }, now, silentFor));
    }
    if (silentFor > TIMING.abandonAfterMs) closeWith = { reason: "abandoned", detail: { silentForMs: silentFor } };

    // 4. Client events in order: answers are applied while the attempt is open;
    //    a closing event ends it, and anything after is kept only as evidence.
    const answerDeadline = s.ends_at.getTime() + TIMING.answerGraceMs;
    for (const e of batch.events) {
      stored.push({
        source: "client",
        seq: e.seq,
        type: e.type,
        phase: e.phase,
        clientTs: e.ts,
        serverTs: now,
        durationMs: e.dur ?? null,
        data: e.data,
        hash: e.h,
      });
      if (closeWith) continue;

      if (e.type === "ANSWER_SELECTED" || e.type === "ANSWER_CLEARED") {
        const q = e.data.q;
        const o = e.data.o;
        const valid =
          isUuid(q) && validKeys.has(q) && (e.type === "ANSWER_CLEARED" || (typeof o === "string" && OPTION_KEY.test(o) && validKeys.get(q)!.has(o)));
        if (!valid || now > answerDeadline) {
          stored.push(serverEvent("ANSWER_REJECTED", { seq: e.seq, question: String(q).slice(0, 40), option: String(o).slice(0, 4), late: valid }, now));
          continue;
        }
        if (e.type === "ANSWER_SELECTED") {
          await db.query(
            `INSERT INTO proctor.answers (session_id, question_id, option_key, answered_at)
             VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
             ON CONFLICT (session_id, question_id)
             DO UPDATE SET option_key = EXCLUDED.option_key, answered_at = EXCLUDED.answered_at, changes = proctor.answers.changes + 1`,
            [s.id, q, o, now],
          );
        } else {
          await db.query("DELETE FROM proctor.answers WHERE session_id = $1 AND question_id = $2", [s.id, q]);
        }
        continue;
      }

      const reason = closingReason(e, strictFocus);
      if (reason) closeWith = { reason, detail: { trigger: e.type, seq: e.seq } };
    }

    // 5. The heartbeat must agree: an open attempt is always fullscreen and visible.
    if (!closeWith && !batch.hb.fullscreen) closeWith = { reason: "fullscreen_exit", detail: { detectedBy: "heartbeat" } };
    if (!closeWith && strictFocus && !batch.hb.visible) closeWith = { reason: "tab_hidden", detail: { detectedBy: "heartbeat" } };

    // 6. Clock manipulation: the client clock offset should stay stable.
    const offset = now - batch.sentAt;
    let clockOffset = s.clock_offset_ms;
    if (clockOffset === null) clockOffset = offset;
    else if (Math.abs(offset - clockOffset) > TIMING.clockDriftToleranceMs) {
      stored.push(serverEvent("CLOCK_TAMPER", { previousOffsetMs: clockOffset, offsetMs: offset }, now));
      clockOffset = offset;
    }

    // 7. Detector liveness: a visible, live camera must produce analysed frames.
    //    stall_count holds how long (ms) the detector has produced nothing.
    let stallCount = s.stall_count;
    const stalled = batch.hb.cameraLive && batch.hb.visible && batch.hb.framesAnalyzed === 0;
    const previousStall = stallCount;
    stallCount = stalled ? Math.min(stallCount + silentFor, 2_000_000_000) : 0;
    if (previousStall < 10_000 && stallCount >= 10_000) {
      stored.push(serverEvent("DETECTOR_STALLED", { stalledForMs: stallCount, heartbeat: { ...batch.hb, pose: undefined } }, now));
    }
    if (process.env.PROCTOR_DEBUG_HEARTBEATS === "1") {
      const p = batch.hb.pose;
      console.log(
        `[proctor] hb ${s.id.slice(0, 6)} frames=${batch.hb.framesAnalyzed} faces=${batch.hb.faceCount} fs=${batch.hb.fullscreen} vis=${batch.hb.visible}` +
          (p ? ` yaw=${p.yaw} pitch=${p.pitch} gaze=${p.gaze} gazeDown=${p.gazeDown}` : " pose=none") +
          ` events=${batch.events.map((e) => e.type).join(",") || "-"}`,
      );
    }

    await insertEvents(db, s.id, stored);
    const ack = randomToken(24);
    await db.query(
      `UPDATE proctor.sessions SET
         last_seq = $2, last_hash = $3, prev_ack_token = ack_token, ack_token = $4, prev_batch_count = $5,
         last_seen_at = to_timestamp($6 / 1000.0), clock_offset_ms = $7, stall_count = $8
       WHERE id = $1`,
      [s.id, prevSeq, prevHash, ack, batch.events.length, now, clockOffset, stallCount],
    );
    s.last_seq = prevSeq;

    if (!closeWith && now > answerDeadline) closeWith = { reason: "time_up", detail: {} };
    if (closeWith) {
      await closeAttempt(db, s, closeWith.reason, now, closeWith.detail);
      return closed();
    }
    return { kind: "ok", response: { ack, serverTime: now, status: "active", endReason: null, lastSeq: prevSeq } };
  });

  if (outcome.kind === "chain") {
    await tx(async (db) => {
      await insertEvents(db, session.id, [serverEvent("CHAIN_INTEGRITY_FAILURE", { reason: outcome.reason, ...outcome.detail }, Date.now())]);
    });
    throw new HttpError(409, "chain_broken", "Event log failed verification. Re-synchronise the session.");
  }
  return outcome.response;
}
