/** Shapes returned by the exam and admin APIs (shared by server and UI). */

import type { EventType } from "./proctor/catalog";
import type { ClientInfo, EndReason, SessionStatus } from "./proctor/protocol";

export type ExamStatus = "draft" | "published" | "closed" | "archived";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: string;
  isAdmin: boolean;
}

// ── Student side (never contains answers or scores) ─────────────────────────

export type Availability = "available" | "upcoming" | "closed" | "in_progress" | "no_attempts";

export interface StudentExam {
  code: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  instructions: string | null;
  durationMinutes: number;
  questionCount: number;
  opensAt: number | null;
  closesAt: number | null;
  strictFocus: boolean;
  attemptsUsed: number;
  attemptsAllowed: number;
  availability: Availability;
  lastAttempt: { status: SessionStatus; endedAt: number | null; startedAt: number } | null;
}

// ── Admin side ──────────────────────────────────────────────────────────────

export interface QuestionInput {
  number: number;
  section: string | null;
  prompt: string;
  options: { key: string; text: string }[];
  answer: string;
  explanation: string | null;
  points?: number;
}

export interface AdminQuestion extends QuestionInput {
  id: string;
  position: number;
  points: number;
}

export interface ExamSettings {
  code: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  instructions: string | null;
  status: ExamStatus;
  durationMinutes: number;
  maxAttempts: number;
  passPercent: number | null;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  strictFocus: boolean;
  opensAt: number | null;
  closesAt: number | null;
}

export interface AdminExamSummary extends ExamSettings {
  id: string;
  questionCount: number;
  totalPoints: number;
  createdAt: number;
  updatedAt: number;
  createdByName: string | null;
  stats: {
    attempts: number;
    candidates: number;
    completed: number;
    active: number;
    flagged: number;
    averagePercent: number | null;
    passRate: number | null;
  };
}

export interface AdminExamDetail extends AdminExamSummary {
  questions: AdminQuestion[];
  source: { questionsFile?: string; answersFile?: string; questionsSha256?: string; answersSha256?: string };
  locked: boolean;
}

export interface ResultRow {
  sessionId: string;
  userId: string;
  userName: string;
  userEmail: string;
  attemptNo: number;
  attemptsAllowed: number;
  attemptsUsed: number;
  status: SessionStatus;
  endReason: EndReason | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  score: number | null;
  maxScore: number | null;
  percent: number | null;
  correct: number | null;
  incorrect: number | null;
  unanswered: number | null;
  passed: boolean | null;
  riskScore: number;
  flagCount: number;
}

export interface AttemptAnswer {
  questionId: string;
  number: number;
  section: string | null;
  prompt: string;
  options: { key: string; text: string }[];
  correctKey: string;
  chosenKey: string | null;
  isCorrect: boolean;
  points: number;
  changes: number;
  answeredAt: number | null;
}

export interface AttemptEvent {
  id: number;
  source: "client" | "server";
  seq: number | null;
  type: EventType;
  category: string;
  severity: string;
  phase: string | null;
  clientTs: number | null;
  serverTs: number;
  durationMs: number | null;
  data: Record<string, unknown>;
  riskPoints: number;
}

export interface AttemptDetail {
  attempt: ResultRow & {
    examId: string;
    examCode: string;
    examTitle: string;
    endsAt: number;
    lastSeenAt: number;
    ip: string | null;
    userAgent: string | null;
    clientInfo: ClientInfo | null;
    resyncCount: number;
    lastSeq: number;
  };
  answers: AttemptAnswer[];
  events: AttemptEvent[];
  flagSummary: { type: EventType; count: number; totalMs: number }[];
}

export interface LmsUserLite {
  id: string;
  name: string;
  email: string;
  role: string;
}

export interface Allowance {
  userId: string;
  userName: string;
  userEmail: string;
  extraAttempts: number;
  attemptsUsed: number;
  attemptsAllowed: number;
  note: string | null;
  updatedAt: number;
}

export interface ParsePreview {
  title: string | null;
  subtitle: string | null;
  description: string | null;
  questions: (Omit<QuestionInput, "answer"> & { answer: string | null })[];
  errors: { number?: number; message: string }[];
  warnings: { number?: number; message: string }[];
  stats: { questionCount: number; answeredCount: number; explanationCount: number; sections: string[] };
  source: { questionsFile: string; answersFile: string; questionsSha256: string; answersSha256: string; questionPages: number; answerPages: number };
}
