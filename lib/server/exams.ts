import "server-only";

import type {
  AdminExamDetail,
  AdminExamSummary,
  AdminQuestion,
  Availability,
  ExamSettings,
  ExamStatus,
  QuestionInput,
  StudentExam,
} from "@/lib/exam-types";
import type { SessionStatus } from "@/lib/proctor/protocol";

import { audit } from "./audit";
import type { AuthUser } from "./auth";
import { ms, msOrThrow, query, queryOne, tx, type Queryable } from "./db";
import {
  HttpError,
  isFiniteInt,
  isRecord,
  optionalBoolean,
  optionalString,
  optionalTimestamp,
  requireInt,
  requireString,
} from "./http";

export const EXAM_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,39}$/;
const STATUSES: ExamStatus[] = ["draft", "published", "closed", "archived"];
const OPTION_KEYS = "ABCDEFGH";

export interface ExamRow {
  id: string;
  code: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  instructions: string | null;
  status: ExamStatus;
  duration_minutes: number;
  max_attempts: number;
  pass_percent: number | null;
  shuffle_questions: boolean;
  shuffle_options: boolean;
  strict_focus: boolean;
  opens_at: Date | null;
  closes_at: Date | null;
  question_count: number;
  total_points: number;
  source: Record<string, unknown>;
  created_by: string;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface QuestionRow {
  id: string;
  exam_id: string;
  position: number;
  number: number;
  section: string | null;
  prompt: string;
  options: { key: string; text: string }[];
  correct_key: string;
  explanation: string | null;
  points: number;
}

// ── Validation ──────────────────────────────────────────────────────────────

export function validateQuestions(value: unknown): QuestionInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, "invalid_body", "An exam needs at least one question.");
  if (value.length > 500) throw new HttpError(400, "invalid_body", "An exam can have at most 500 questions.");
  return value.map((raw, i) => {
    const where = `Question ${i + 1}`;
    if (!isRecord(raw)) throw new HttpError(400, "invalid_body", `${where} is malformed.`);
    const number = isFiniteInt(raw.number) && raw.number >= 1 && raw.number <= 100_000 ? raw.number : i + 1;
    const prompt = requireString(raw, "prompt", { max: 4000 });
    const section = optionalString(raw, "section", 100);
    const explanation = optionalString(raw, "explanation", 4000);
    if (!Array.isArray(raw.options) || raw.options.length < 2 || raw.options.length > OPTION_KEYS.length) {
      throw new HttpError(400, "invalid_body", `${where} needs 2 to ${OPTION_KEYS.length} options.`);
    }
    const options = raw.options.map((o, j) => {
      if (!isRecord(o)) throw new HttpError(400, "invalid_body", `${where}, option ${j + 1} is malformed.`);
      const key = OPTION_KEYS[j]!;
      if (o.key !== key) throw new HttpError(400, "invalid_body", `${where}: options must be lettered A, B, C… in order.`);
      return { key, text: requireString(o, "text", { max: 1000 }) };
    });
    const answer = typeof raw.answer === "string" ? raw.answer.trim().toUpperCase() : "";
    if (!options.some((o) => o.key === answer)) {
      throw new HttpError(400, "invalid_body", `${where} (number ${number}) needs a correct answer that is one of its options.`);
    }
    let points = 1;
    if (raw.points !== undefined) {
      if (typeof raw.points !== "number" || !Number.isFinite(raw.points) || raw.points < 0.25 || raw.points > 100) {
        throw new HttpError(400, "invalid_body", `${where}: points must be between 0.25 and 100.`);
      }
      points = Math.round(raw.points * 100) / 100;
    }
    return { number, section, prompt, options, answer, explanation, points };
  });
}

function validateSettings(body: Record<string, unknown>, current?: ExamSettings): ExamSettings {
  const pick = <K extends keyof ExamSettings>(key: K, read: () => ExamSettings[K]): ExamSettings[K] =>
    current && body[key] === undefined ? current[key] : read();

  const code = pick("code", () => requireString(body, "code", { max: 40, min: 3 }).toUpperCase());
  if (!EXAM_CODE_RE.test(code)) {
    throw new HttpError(400, "invalid_body", "Exam code must be 3–40 letters, digits or dashes, starting with a letter or digit.");
  }
  const status = pick("status", () => {
    const s = body.status ?? "draft";
    if (typeof s !== "string" || !STATUSES.includes(s as ExamStatus)) throw new HttpError(400, "invalid_body", "Unknown status.");
    return s as ExamStatus;
  });
  const passPercent = pick("passPercent", () => {
    const v = body.passPercent;
    if (v === null || v === undefined || v === "") return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
      throw new HttpError(400, "invalid_body", "Pass mark must be between 0 and 100%.");
    }
    return Math.round(v * 100) / 100;
  });
  const settings: ExamSettings = {
    code,
    title: pick("title", () => requireString(body, "title", { max: 200 })),
    subtitle: pick("subtitle", () => optionalString(body, "subtitle", 200)),
    description: pick("description", () => optionalString(body, "description", 4000)),
    instructions: pick("instructions", () => optionalString(body, "instructions", 4000)),
    status,
    durationMinutes: pick("durationMinutes", () => requireInt(body, "durationMinutes", 1, 600)),
    maxAttempts: pick("maxAttempts", () => requireInt(body, "maxAttempts", 1, 20)),
    passPercent,
    shuffleQuestions: pick("shuffleQuestions", () => optionalBoolean(body, "shuffleQuestions") ?? false),
    shuffleOptions: pick("shuffleOptions", () => optionalBoolean(body, "shuffleOptions") ?? false),
    strictFocus: pick("strictFocus", () => optionalBoolean(body, "strictFocus") ?? true),
    opensAt: pick("opensAt", () => optionalTimestamp(body, "opensAt")),
    closesAt: pick("closesAt", () => optionalTimestamp(body, "closesAt")),
  };
  if (settings.opensAt !== null && settings.closesAt !== null && settings.closesAt <= settings.opensAt) {
    throw new HttpError(400, "invalid_body", "The closing time must be after the opening time.");
  }
  return settings;
}

function validateSource(value: unknown): Record<string, string | number> {
  if (!isRecord(value)) return {};
  const out: Record<string, string | number> = {};
  for (const key of ["questionsFile", "answersFile", "questionsSha256", "answersSha256"] as const) {
    if (typeof value[key] === "string") out[key] = (value[key] as string).slice(0, 200);
  }
  return out;
}

// ── Row mapping ─────────────────────────────────────────────────────────────

function settingsFrom(row: ExamRow): ExamSettings {
  return {
    code: row.code,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    instructions: row.instructions,
    status: row.status,
    durationMinutes: row.duration_minutes,
    maxAttempts: row.max_attempts,
    passPercent: row.pass_percent,
    shuffleQuestions: row.shuffle_questions,
    shuffleOptions: row.shuffle_options,
    strictFocus: row.strict_focus,
    opensAt: ms(row.opens_at),
    closesAt: ms(row.closes_at),
  };
}

type StatsRow = ExamRow & {
  attempts: number;
  candidates: number;
  completed: number;
  active: number;
  flagged: number;
  avg_percent: number | null;
  pass_rate: number | null;
};

function summaryFrom(row: StatsRow): AdminExamSummary {
  return {
    id: row.id,
    ...settingsFrom(row),
    questionCount: row.question_count,
    totalPoints: row.total_points,
    createdAt: msOrThrow(row.created_at),
    updatedAt: msOrThrow(row.updated_at),
    createdByName: row.created_by_name,
    stats: {
      attempts: row.attempts,
      candidates: row.candidates,
      completed: row.completed,
      active: row.active,
      flagged: row.flagged,
      averagePercent: row.avg_percent === null ? null : Math.round(row.avg_percent * 10) / 10,
      passRate: row.pass_rate === null ? null : Math.round(row.pass_rate * 1000) / 10,
    },
  };
}

const STATS_SQL = `
  SELECT e.*,
         count(s.id)::int                                             AS attempts,
         count(DISTINCT s.user_id)::int                               AS candidates,
         count(s.id) FILTER (WHERE s.status <> 'active')::int         AS completed,
         count(s.id) FILTER (WHERE s.status = 'active')::int          AS active,
         count(s.id) FILTER (WHERE s.flag_count > 0)::int             AS flagged,
         avg(s.percent) FILTER (WHERE s.status <> 'active')           AS avg_percent,
         avg(CASE WHEN s.passed THEN 1.0 WHEN s.passed = false THEN 0.0 END) AS pass_rate
    FROM proctor.exams e
    LEFT JOIN proctor.sessions s ON s.exam_id = e.id`;

// ── Admin: queries ──────────────────────────────────────────────────────────

export async function listAdminExams(includeArchived = false): Promise<AdminExamSummary[]> {
  const rows = await query<StatsRow>(
    `${STATS_SQL} WHERE ($1 OR e.status <> 'archived') GROUP BY e.id ORDER BY e.created_at DESC`,
    [includeArchived],
  );
  return rows.map(summaryFrom);
}

export async function getAdminExam(id: string): Promise<AdminExamDetail | null> {
  const row = await queryOne<StatsRow>(`${STATS_SQL} WHERE e.id = $1 GROUP BY e.id`, [id]);
  if (!row) return null;
  const questions = await query<QuestionRow>("SELECT * FROM proctor.questions WHERE exam_id = $1 ORDER BY position", [id]);
  return {
    ...summaryFrom(row),
    questions: questions.map(adminQuestionFrom),
    source: row.source as AdminExamDetail["source"],
    locked: row.attempts > 0,
  };
}

function adminQuestionFrom(q: QuestionRow): AdminQuestion {
  return {
    id: q.id,
    position: q.position,
    number: q.number,
    section: q.section,
    prompt: q.prompt,
    options: q.options,
    answer: q.correct_key,
    explanation: q.explanation,
    points: q.points,
  };
}

export async function examCodeTaken(code: string, exceptId?: string): Promise<boolean> {
  const row = await queryOne("SELECT 1 FROM proctor.exams WHERE code = $1 AND ($2::uuid IS NULL OR id <> $2)", [code, exceptId ?? null]);
  return row !== null;
}

// ── Admin: mutations ────────────────────────────────────────────────────────

async function insertQuestions(client: Queryable, examId: string, questions: QuestionInput[]): Promise<{ count: number; points: number }> {
  let points = 0;
  for (const [position, q] of questions.entries()) {
    points += q.points ?? 1;
    await query(
      `INSERT INTO proctor.questions (exam_id, position, number, section, prompt, options, correct_key, explanation, points)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [examId, position, q.number, q.section, q.prompt, JSON.stringify(q.options), q.answer, q.explanation, q.points ?? 1],
      client,
    );
  }
  return { count: questions.length, points };
}

export async function createExam(admin: AuthUser, body: unknown, ip: string): Promise<{ id: string }> {
  if (!isRecord(body)) throw new HttpError(400, "invalid_body", "Expected an object.");
  const settings = validateSettings(body);
  const questions = validateQuestions(body.questions);
  if (await examCodeTaken(settings.code)) throw new HttpError(409, "code_taken", "Another exam already uses that code.");
  const source = validateSource(body.source);

  const id = await tx(async (client) => {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO proctor.exams (code, title, subtitle, description, instructions, status, duration_minutes, max_attempts,
          pass_percent, shuffle_questions, shuffle_options, strict_focus, opens_at, closes_at, source, created_by, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, to_timestamp($13 / 1000.0), to_timestamp($14 / 1000.0), $15, $16, $17)
       RETURNING id`,
      [
        settings.code,
        settings.title,
        settings.subtitle,
        settings.description,
        settings.instructions,
        settings.status,
        settings.durationMinutes,
        settings.maxAttempts,
        settings.passPercent,
        settings.shuffleQuestions,
        settings.shuffleOptions,
        settings.strictFocus,
        settings.opensAt,
        settings.closesAt,
        JSON.stringify(source),
        admin.id,
        admin.name,
      ],
      client,
    );
    const examId = row!.id;
    const totals = await insertQuestions(client, examId, questions);
    await query("UPDATE proctor.exams SET question_count = $2, total_points = $3 WHERE id = $1", [examId, totals.count, totals.points], client);
    await audit(admin, "exam.create", { type: "exam", id: examId }, { code: settings.code, questions: totals.count, status: settings.status }, ip, client);
    return examId;
  });
  return { id };
}

export async function updateExam(admin: AuthUser, id: string, body: unknown, ip: string): Promise<void> {
  if (!isRecord(body)) throw new HttpError(400, "invalid_body", "Expected an object.");
  await tx(async (client) => {
    const row = await queryOne<ExamRow>("SELECT * FROM proctor.exams WHERE id = $1 FOR UPDATE", [id], client);
    if (!row) throw new HttpError(404, "not_found", "Exam not found.");
    const settings = validateSettings(body, settingsFrom(row));
    if (settings.code !== row.code) {
      const taken = await queryOne("SELECT 1 FROM proctor.exams WHERE code = $1 AND id <> $2", [settings.code, id], client);
      if (taken) throw new HttpError(409, "code_taken", "Another exam already uses that code.");
    }
    const { n: attempts } = (await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM proctor.sessions WHERE exam_id = $1", [id], client))!;
    if (attempts > 0 && settings.code !== row.code) {
      throw new HttpError(409, "exam_locked", "The exam code cannot change after candidates have started.");
    }

    let questionCount = row.question_count;
    if (body.questions !== undefined) {
      if (attempts > 0) {
        throw new HttpError(409, "exam_locked", "Questions cannot change after candidates have started. Duplicate the exam instead.");
      }
      const questions = validateQuestions(body.questions);
      await query("DELETE FROM proctor.questions WHERE exam_id = $1", [id], client);
      const totals = await insertQuestions(client, id, questions);
      questionCount = totals.count;
      await query("UPDATE proctor.exams SET question_count = $2, total_points = $3 WHERE id = $1", [id, totals.count, totals.points], client);
      if (body.source !== undefined) {
        await query("UPDATE proctor.exams SET source = $2 WHERE id = $1", [id, JSON.stringify(validateSource(body.source))], client);
      }
    }
    if (settings.status === "published" && questionCount === 0) {
      throw new HttpError(400, "invalid_body", "Add questions before publishing.");
    }

    await query(
      `UPDATE proctor.exams SET code = $2, title = $3, subtitle = $4, description = $5, instructions = $6, status = $7,
          duration_minutes = $8, max_attempts = $9, pass_percent = $10, shuffle_questions = $11, shuffle_options = $12,
          strict_focus = $13, opens_at = to_timestamp($14 / 1000.0), closes_at = to_timestamp($15 / 1000.0), updated_at = now()
        WHERE id = $1`,
      [
        id,
        settings.code,
        settings.title,
        settings.subtitle,
        settings.description,
        settings.instructions,
        settings.status,
        settings.durationMinutes,
        settings.maxAttempts,
        settings.passPercent,
        settings.shuffleQuestions,
        settings.shuffleOptions,
        settings.strictFocus,
        settings.opensAt,
        settings.closesAt,
      ],
      client,
    );
    const changed = Object.keys(body).filter((k) => k !== "questions" && k !== "source");
    await audit(admin, "exam.update", { type: "exam", id }, { fields: changed, questionsReplaced: body.questions !== undefined, status: settings.status }, ip, client);
  });
  questionIndexCache.delete(id);
}

export async function deleteExam(admin: AuthUser, id: string, ip: string): Promise<void> {
  await tx(async (client) => {
    const row = await queryOne<{ code: string }>("SELECT code FROM proctor.exams WHERE id = $1 FOR UPDATE", [id], client);
    if (!row) throw new HttpError(404, "not_found", "Exam not found.");
    const used = await queryOne("SELECT 1 FROM proctor.sessions WHERE exam_id = $1 LIMIT 1", [id], client);
    if (used) throw new HttpError(409, "exam_locked", "This exam has attempts on record. Archive it instead of deleting.");
    await query("DELETE FROM proctor.exams WHERE id = $1", [id], client);
    await audit(admin, "exam.delete", { type: "exam", id }, { code: row.code }, ip, client);
  });
  questionIndexCache.delete(id);
}

// ── Attempts allowed ───────────────────────────────────────────────────────

export async function attemptCounts(examId: string, userId: string, client?: Queryable): Promise<{ used: number; allowed: number }> {
  const row = await queryOne<{ used: number; allowed: number }>(
    `SELECT (SELECT count(*)::int FROM proctor.sessions WHERE exam_id = e.id AND user_id = $2) AS used,
            e.max_attempts + coalesce((SELECT extra_attempts FROM proctor.attempt_allowances WHERE exam_id = e.id AND user_id = $2), 0) AS allowed
       FROM proctor.exams e WHERE e.id = $1`,
    [examId, userId],
    client,
  );
  return row ?? { used: 0, allowed: 0 };
}

// ── Student side ───────────────────────────────────────────────────────────

type StudentRow = ExamRow & {
  used: number;
  allowed: number;
  last_status: SessionStatus | null;
  last_started_at: Date | null;
  last_ended_at: Date | null;
};

const STUDENT_SQL = `
  SELECT e.*,
         coalesce(u.used, 0)::int AS used,
         (e.max_attempts + coalesce(a.extra_attempts, 0))::int AS allowed,
         l.status AS last_status, l.started_at AS last_started_at, l.ended_at AS last_ended_at
    FROM proctor.exams e
    LEFT JOIN proctor.attempt_allowances a ON a.exam_id = e.id AND a.user_id = $1
    LEFT JOIN LATERAL (SELECT count(*) AS used FROM proctor.sessions s WHERE s.exam_id = e.id AND s.user_id = $1) u ON true
    LEFT JOIN LATERAL (
      SELECT status, started_at, ended_at FROM proctor.sessions s
       WHERE s.exam_id = e.id AND s.user_id = $1 ORDER BY attempt_no DESC LIMIT 1
    ) l ON true`;

function availability(row: StudentRow, now: number): Availability {
  if (row.last_status === "active") return "in_progress";
  if (row.used >= row.allowed) return "no_attempts";
  if (row.status !== "published") return "closed";
  if (row.closes_at && row.closes_at.getTime() <= now) return "closed";
  if (row.opens_at && row.opens_at.getTime() > now) return "upcoming";
  return "available";
}

function studentExamFrom(row: StudentRow, now: number): StudentExam {
  return {
    code: row.code,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    instructions: row.instructions,
    durationMinutes: row.duration_minutes,
    questionCount: row.question_count,
    opensAt: ms(row.opens_at),
    closesAt: ms(row.closes_at),
    strictFocus: row.strict_focus,
    attemptsUsed: row.used,
    attemptsAllowed: row.allowed,
    availability: availability(row, now),
    lastAttempt: row.last_status
      ? { status: row.last_status, startedAt: msOrThrow(row.last_started_at!), endedAt: ms(row.last_ended_at) }
      : null,
  };
}

/** Published exams, plus closed ones the student has attempted. Never includes answers or scores. */
export async function listStudentExams(user: AuthUser): Promise<StudentExam[]> {
  const rows = await query<StudentRow>(
    `${STUDENT_SQL}
      WHERE e.status = 'published' OR (e.status = 'closed' AND coalesce(u.used, 0) > 0)
      ORDER BY (e.status = 'published') DESC, e.opens_at NULLS FIRST, e.created_at DESC`,
    [user.id],
  );
  const now = Date.now();
  return rows.map((r) => studentExamFrom(r, now));
}

export async function getStudentExam(user: AuthUser, code: string): Promise<StudentExam | null> {
  if (!EXAM_CODE_RE.test(code)) return null;
  const row = await queryOne<StudentRow>(`${STUDENT_SQL} WHERE e.code = $2 AND e.status IN ('published', 'closed')`, [user.id, code]);
  return row ? studentExamFrom(row, Date.now()) : null;
}

// ── Question index for answer validation during the exam ───────────────────

interface QuestionIndex {
  keys: Map<string, Set<string>>;
  loadedAt: number;
}

const globalForIndex = globalThis as unknown as { __proctorQuestionIndex?: Map<string, QuestionIndex> };
const questionIndexCache = (globalForIndex.__proctorQuestionIndex ??= new Map<string, QuestionIndex>());

/** Valid option keys per question id. Questions are immutable once an attempt exists, so caching is safe. */
export async function questionIndex(examId: string, client?: Queryable): Promise<Map<string, Set<string>>> {
  const cached = questionIndexCache.get(examId);
  if (cached && Date.now() - cached.loadedAt < 10 * 60_000) return cached.keys;
  const rows = await query<{ id: string; options: { key: string }[] }>(
    "SELECT id, options FROM proctor.questions WHERE exam_id = $1",
    [examId],
    client,
  );
  const keys = new Map(rows.map((r) => [r.id, new Set(r.options.map((o) => o.key))]));
  questionIndexCache.set(examId, { keys, loadedAt: Date.now() });
  return keys;
}
