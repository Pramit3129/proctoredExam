/**
 * Wire protocol shared by the browser engine and the API routes.
 *
 * Integrity model
 * ───────────────
 * - The server owns the attempt. It issues a per-attempt HMAC key, a random
 *   genesis hash and a one-time "ack" token. The key lives only in the exam
 *   page's memory, never in storage.
 * - Every client event gets a strictly increasing `seq` and a hash
 *   h[n] = HMAC(key, h[n-1] + "\n" + canonical(event[n])). The server
 *   recomputes the chain, so dropped, reordered, replayed or edited events
 *   are detected and logged as CHAIN_INTEGRITY_FAILURE.
 * - Answers travel in the same chain (ANSWER_SELECTED / ANSWER_CLEARED), so
 *   the server holds every answer as it is given, in order, with timestamps.
 *   Submitting does not upload answers; the server grades what it has.
 * - Each accepted batch rotates the ack token. A copied cookie used from a
 *   second browser desynchronises the chain and is detected.
 * - Batches double as heartbeats. Silence is itself evidence.
 * - Leaving fullscreen (or the page) ends the attempt on the server, even if
 *   the page never calls /end.
 */

import type { EventType } from "./catalog";

export const PROTOCOL_VERSION = 2;

export const LIMITS = {
  maxEventsPerBatch: 100,
  maxEventDataBytes: 2048,
  maxBatchBytes: 256 * 1024,
  maxIdLength: 64,
} as const;

export const TIMING = {
  /** Client flushes pending events at least this often. */
  flushIntervalMs: 2_000,
  /** Client sends a heartbeat even with nothing to report. */
  heartbeatIntervalMs: 5_000,
  /** Server logs HEARTBEAT_GAP when silent for longer than this. */
  heartbeatGapMs: 20_000,
  /** Answers received this long after the deadline (in flight at time-up) still count. */
  answerGraceMs: 15_000,
  /** The server closes an attempt this long after its deadline. */
  closeGraceMs: 30_000,
  /** An attempt silent for this long is treated as abandoned and closed. */
  abandonAfterMs: 5 * 60_000,
  /** Allowed drift of the client clock offset before CLOCK_TAMPER. */
  clockDriftToleranceMs: 60_000,
} as const;

/** Thresholds for client-side detectors. Served by the server so they can be tuned centrally. */
export interface DetectionConfig {
  analysisIntervalMs: number;
  noFaceMs: number;
  multipleFacesMs: number;
  headYawDeg: number;
  headPitchDownDeg: number;
  headPitchUpDeg: number;
  headTurnMs: number;
  gazeHorizontal: number;
  gazeDown: number;
  gazeMs: number;
  lipStdDev: number;
  lipMs: number;
  noBlinkMs: number;
  minFaceWidth: number;
  edgeMargin: number;
  cameraDarkLuma: number;
  cameraUniformStdDev: number;
  cameraBlockedMs: number;
  cameraFrozenMs: number;
  voiceDbAboveFloor: number;
  voiceMs: number;
  tabHiddenEvidenceDelayMs: number;
  evidenceCooldownMs: number;
}

export const DEFAULT_DETECTION_CONFIG: DetectionConfig = {
  analysisIntervalMs: 150,
  noFaceMs: 2_000,
  multipleFacesMs: 1_000,
  headYawDeg: 24,
  headPitchDownDeg: 16,
  headPitchUpDeg: 20,
  headTurnMs: 1_500,
  gazeHorizontal: 0.38,
  gazeDown: 0.38,
  gazeMs: 1_800,
  lipStdDev: 0.05,
  lipMs: 2_000,
  noBlinkMs: 45_000,
  minFaceWidth: 0.12,
  edgeMargin: 0.01,
  cameraDarkLuma: 18,
  cameraUniformStdDev: 6,
  cameraBlockedMs: 3_000,
  cameraFrozenMs: 6_000,
  voiceDbAboveFloor: 15,
  voiceMs: 1_500,
  tabHiddenEvidenceDelayMs: 0,
  evidenceCooldownMs: 15_000,
};

export interface ClientInfo {
  userAgent: string;
  platform: string;
  language: string;
  timezone: string;
  screen: { width: number; height: number; dpr: number; extended: boolean | null };
  camera: { label: string; width: number | null; height: number | null; frameRate: number | null };
  microphone: { label: string } | null;
  hardwareConcurrency: number | null;
}

export interface StartSessionRequest {
  action: "start";
  examCode: string;
  client: ClientInfo;
}

export interface ExamOptionPublic {
  /** Original option letter from the paper; what the server stores. */
  key: string;
  text: string;
}

export interface ExamQuestionPublic {
  id: string;
  /** Number printed on the original paper. */
  number: number;
  section: string | null;
  prompt: string;
  /** In display order (shuffled when the exam asks for it). */
  options: ExamOptionPublic[];
}

export interface SessionBootstrap {
  sessionId: string;
  user: { name: string; email: string };
  /** base64url HMAC key for the event chain. */
  chainKey: string;
  lastHash: string;
  lastSeq: number;
  ack: string;
  serverTime: number;
  attemptNo: number;
  exam: {
    code: string;
    title: string;
    startedAt: number;
    endsAt: number;
    strictFocus: boolean;
    questions: ExamQuestionPublic[];
  };
  /** Answers the server already holds (question id → option key), for re-sync. */
  answers: Record<string, string>;
  config: DetectionConfig;
}

export interface Heartbeat {
  faceCount: number;
  visible: boolean;
  focused: boolean;
  fullscreen: boolean;
  /** Frames analysed since the previous batch. */
  framesAnalyzed: number;
  cameraLive: boolean;
  micLive: boolean;
}

export interface WireEvent {
  seq: number;
  type: EventType;
  /** Client epoch milliseconds when the event happened. */
  ts: number;
  /** Duration in ms, for "end" events of sustained conditions. */
  dur?: number;
  /** JSON-encoded data object (sent pre-serialised so both sides hash identical bytes). */
  d: string;
  /** Chain hash (hex). */
  h: string;
}

export interface BatchRequest {
  v: number;
  ack: string;
  sentAt: number;
  hb: Heartbeat;
  events: WireEvent[];
}

export type SessionStatus = "active" | "submitted" | "auto_submitted" | "expired" | "terminated";

/** Why an attempt ended. Candidates see a plain-language version; admins see this code. */
export type EndReason =
  | "submitted"
  | "time_up"
  | "fullscreen_exit"
  | "tab_hidden"
  | "page_left"
  | "abandoned"
  | "terminated";

export const END_REASONS: readonly EndReason[] = [
  "submitted",
  "time_up",
  "fullscreen_exit",
  "tab_hidden",
  "page_left",
  "abandoned",
  "terminated",
];

export interface BatchResponse {
  ack: string;
  serverTime: number;
  status: SessionStatus;
  endReason: EndReason | null;
  /** Highest event seq the server has stored (answers up to here are safe). */
  lastSeq: number;
}

export interface EndResponse {
  status: SessionStatus;
  endReason: EndReason | null;
}

export interface ApiError {
  error: string;
  message: string;
}

export function canonicalEvent(e: Pick<WireEvent, "seq" | "type" | "ts" | "dur" | "d">): string {
  return `${e.seq}|${e.type}|${e.ts}|${e.dur ?? ""}|${e.d}`;
}

export function chainInput(prevHash: string, e: Pick<WireEvent, "seq" | "type" | "ts" | "dur" | "d">): string {
  return `${prevHash}\n${canonicalEvent(e)}`;
}

/** Message signed with the chain key to prove a re-sync comes from the original exam page. */
export function resyncMessage(sessionId: string): string {
  return `resync\n${sessionId}`;
}
