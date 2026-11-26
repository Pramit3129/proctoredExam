import type { ExamStatus } from "@/lib/exam-types";
import type { EndReason, SessionStatus } from "@/lib/proctor/protocol";

import type { Tone } from "../ui";

export const EXAM_STATUS: Record<ExamStatus, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  published: { label: "Published", tone: "ok" },
  closed: { label: "Closed", tone: "warn" },
  archived: { label: "Archived", tone: "neutral" },
};

export const ATTEMPT_STATUS: Record<SessionStatus, { label: string; tone: Tone }> = {
  active: { label: "In progress", tone: "accent" },
  submitted: { label: "Submitted", tone: "ok" },
  auto_submitted: { label: "Auto-submitted", tone: "warn" },
  expired: { label: "Time up", tone: "neutral" },
  terminated: { label: "Terminated", tone: "danger" },
};

export const END_REASON: Record<EndReason, string> = {
  submitted: "Submitted by candidate",
  time_up: "Time ran out",
  fullscreen_exit: "Left full screen",
  tab_hidden: "Switched tab or app",
  page_left: "Closed or reloaded page",
  abandoned: "Connection lost",
  terminated: "Ended by admin",
};

export function scoreTone(percent: number | null, passPercent: number | null): Tone {
  if (percent === null) return "neutral";
  if (passPercent !== null) return percent >= passPercent ? "ok" : "danger";
  return percent >= 70 ? "ok" : percent >= 40 ? "warn" : "danger";
}

export function riskLabel(score: number): { label: string; tone: Tone } {
  if (score >= 50) return { label: "High", tone: "danger" };
  if (score >= 20) return { label: "Medium", tone: "warn" };
  return { label: "Low", tone: "ok" };
}
