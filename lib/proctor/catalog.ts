/**
 * Single source of truth for every proctoring event the system can record.
 *
 * Shared by the browser (to label and prioritise events) and the server (to
 * validate incoming events and compute the risk score). The server never
 * trusts a client-supplied severity or weight: it always looks them up here.
 */

export type Severity = "info" | "low" | "medium" | "high" | "critical";

/** Who is allowed to produce the event. Clients may never submit "server" events. */
export type EventSource = "client" | "server";

export type EventCategory =
  | "lifecycle"
  | "interaction"
  | "face"
  | "media"
  | "browser"
  | "integrity"
  | "network";

export interface EventSpec {
  label: string;
  description: string;
  severity: Severity;
  /** Risk points added when the event starts (or for one-off events). */
  weight: number;
  source: EventSource;
  category: EventCategory;
  /** Message shown to the candidate while the condition is active. */
  candidateWarning?: string;
}

export const EVENT_CATALOG = {
  // ── Lifecycle ────────────────────────────────────────────────────────────
  SESSION_STARTED: {
    label: "Session started",
    description: "Candidate passed system checks and the exam began.",
    severity: "info",
    weight: 0,
    source: "server",
    category: "lifecycle",
  },
  SESSION_RESUMED: {
    label: "Event log re-synchronised",
    description:
      "The exam page re-synchronised its event log with the server after a rejected batch (for example a duplicate tab or a lost response).",
    severity: "medium",
    weight: 5,
    source: "server",
    category: "lifecycle",
  },
  SESSION_ENDED: {
    label: "Exam submitted",
    description: "Candidate submitted the exam.",
    severity: "info",
    weight: 0,
    source: "server",
    category: "lifecycle",
  },
  AUTO_SUBMITTED: {
    label: "Submitted automatically",
    description:
      "The server closed the attempt because the candidate left fullscreen, switched away, closed the page, or stopped reporting. Answers given up to that point were graded.",
    severity: "info",
    weight: 0,
    source: "server",
    category: "lifecycle",
  },
  SESSION_EXPIRED: {
    label: "Time expired",
    description: "The exam time limit elapsed.",
    severity: "info",
    weight: 0,
    source: "server",
    category: "lifecycle",
  },
  SESSION_TERMINATED: {
    label: "Terminated by proctor",
    description: "A reviewer terminated the session.",
    severity: "critical",
    weight: 0,
    source: "server",
    category: "lifecycle",
  },
  CALIBRATED: {
    label: "Calibration complete",
    description: "Baseline head pose and gaze recorded while the candidate looked at the screen.",
    severity: "info",
    weight: 0,
    source: "client",
    category: "lifecycle",
  },

  // ── Face / behaviour ─────────────────────────────────────────────────────
  NO_FACE: {
    label: "Face not visible",
    description: "No face was detected in the webcam feed.",
    severity: "high",
    weight: 8,
    source: "client",
    category: "face",
    candidateWarning: "Your face is not visible. Stay in front of the camera.",
  },
  MULTIPLE_FACES: {
    label: "Multiple people",
    description: "More than one face was detected in the webcam feed.",
    severity: "critical",
    weight: 15,
    source: "client",
    category: "face",
    candidateWarning: "More than one person detected. Only you may be in view.",
  },
  HEAD_TURNED: {
    label: "Looking away",
    description: "Head turned sideways away from the screen.",
    severity: "medium",
    weight: 4,
    source: "client",
    category: "face",
    candidateWarning: "Please face the screen.",
  },
  LOOKING_DOWN: {
    label: "Looking down",
    description: "Head or eyes directed below the screen (phone, notes, desk).",
    severity: "medium",
    weight: 4,
    source: "client",
    category: "face",
    candidateWarning: "Please keep your eyes on the screen.",
  },
  LOOKING_UP: {
    label: "Looking up",
    description: "Head tilted up away from the screen.",
    severity: "low",
    weight: 2,
    source: "client",
    category: "face",
  },
  GAZE_AWAY: {
    label: "Eyes off screen",
    description: "Eyes looking sideways while the head stayed facing the screen.",
    severity: "low",
    weight: 2,
    source: "client",
    category: "face",
  },
  LIP_MOVEMENT: {
    label: "Talking (lips)",
    description: "Sustained mouth movement consistent with speaking.",
    severity: "medium",
    weight: 3,
    source: "client",
    category: "face",
  },
  FACE_PARTIALLY_VISIBLE: {
    label: "Face at frame edge",
    description: "Face is cut off by the edge of the camera frame.",
    severity: "low",
    weight: 1,
    source: "client",
    category: "face",
    candidateWarning: "Move to the centre of the camera frame.",
  },
  FACE_TOO_FAR: {
    label: "Too far from camera",
    description: "Face is very small in the frame.",
    severity: "low",
    weight: 1,
    source: "client",
    category: "face",
    candidateWarning: "Move closer to the camera.",
  },
  NO_BLINK: {
    label: "No blinking",
    description:
      "No blink detected for an extended period. Possible photo, mask, or replayed video in front of the camera.",
    severity: "medium",
    weight: 5,
    source: "client",
    category: "face",
  },

  // ── Camera / microphone ──────────────────────────────────────────────────
  CAMERA_BLOCKED: {
    label: "Camera blocked",
    description: "Camera image is dark or uniform (covered lens or switched-off light).",
    severity: "high",
    weight: 10,
    source: "client",
    category: "media",
    candidateWarning: "Your camera appears to be covered or too dark.",
  },
  CAMERA_FROZEN: {
    label: "Camera frozen",
    description:
      "Camera frames are pixel-identical or stopped advancing. Typical of a static image fed through a virtual camera.",
    severity: "critical",
    weight: 20,
    source: "client",
    category: "media",
  },
  CAMERA_LOST: {
    label: "Camera disconnected",
    description: "The camera track ended or was muted (permission revoked, unplugged, or taken by another app).",
    severity: "critical",
    weight: 15,
    source: "client",
    category: "media",
    candidateWarning: "Camera disconnected. Reconnect it to continue.",
  },
  VIRTUAL_CAMERA: {
    label: "Virtual camera",
    description: "The selected camera is a known virtual/software camera (OBS, ManyCam, etc.).",
    severity: "critical",
    weight: 25,
    source: "client",
    category: "media",
  },
  VOICE_DETECTED: {
    label: "Voice detected",
    description: "Sustained speech-band audio picked up by the microphone.",
    severity: "medium",
    weight: 4,
    source: "client",
    category: "media",
    candidateWarning: "Talking is not allowed during the exam.",
  },
  MIC_LOST: {
    label: "Microphone disconnected",
    description: "The microphone track ended or was muted.",
    severity: "high",
    weight: 10,
    source: "client",
    category: "media",
    candidateWarning: "Microphone disconnected. Reconnect it to continue.",
  },
  MEDIA_DEVICES_CHANGED: {
    label: "Devices changed",
    description: "A camera, microphone, or audio device was plugged in or removed.",
    severity: "medium",
    weight: 3,
    source: "client",
    category: "media",
  },
  DETECTOR_ERROR: {
    label: "Detector error",
    description: "The face detector threw an error while analysing frames.",
    severity: "high",
    weight: 5,
    source: "client",
    category: "integrity",
  },

  // ── Interactions (not violations; the full answer history) ────────────────
  QUESTION_VIEWED: {
    label: "Viewed question",
    description: "The candidate opened a question.",
    severity: "info",
    weight: 0,
    source: "client",
    category: "interaction",
  },
  ANSWER_SELECTED: {
    label: "Answer selected",
    description: "The candidate chose an option. The server stores the latest choice per question.",
    severity: "info",
    weight: 0,
    source: "client",
    category: "interaction",
  },
  ANSWER_CLEARED: {
    label: "Answer cleared",
    description: "The candidate removed their answer to a question.",
    severity: "info",
    weight: 0,
    source: "client",
    category: "interaction",
  },
  QUESTION_MARKED: {
    label: "Marked for review",
    description: "The candidate flagged or unflagged a question to revisit.",
    severity: "info",
    weight: 0,
    source: "client",
    category: "interaction",
  },

  // ── Browser behaviour ────────────────────────────────────────────────────
  TAB_HIDDEN: {
    label: "Left exam tab",
    description: "The exam tab was hidden (switched tab, minimised, or another app covered it).",
    severity: "high",
    weight: 10,
    source: "client",
    category: "browser",
  },
  WINDOW_BLUR: {
    label: "Window lost focus",
    description:
      "Keyboard focus left the exam window (another app, another monitor, a detached DevTools window, or a system dialog).",
    severity: "medium",
    weight: 6,
    source: "client",
    category: "browser",
    candidateWarning: "Stay on the exam window.",
  },
  FULLSCREEN_EXIT: {
    label: "Exited fullscreen",
    description: "The exam left fullscreen mode. This ends the attempt.",
    severity: "high",
    weight: 8,
    source: "client",
    category: "browser",
  },
  MULTIPLE_DISPLAYS: {
    label: "Multiple displays",
    description: "The operating system reports more than one connected display.",
    severity: "high",
    weight: 15,
    source: "client",
    category: "browser",
    candidateWarning: "Disconnect additional monitors.",
  },
  WINDOW_RESIZED: {
    label: "Window resized",
    description: "Browser window shrunk well below screen size (split screen or side-by-side apps).",
    severity: "low",
    weight: 2,
    source: "client",
    category: "browser",
  },
  CLIPBOARD_BLOCKED: {
    label: "Copy/paste attempt",
    description: "Copy, cut, paste, or drag-and-drop was attempted and blocked.",
    severity: "medium",
    weight: 4,
    source: "client",
    category: "browser",
  },
  CONTEXT_MENU_BLOCKED: {
    label: "Right-click attempt",
    description: "The context menu was requested and blocked.",
    severity: "low",
    weight: 1,
    source: "client",
    category: "browser",
  },
  SHORTCUT_BLOCKED: {
    label: "Blocked shortcut",
    description: "A restricted keyboard shortcut was pressed (devtools, save, print, find, view source, screenshot).",
    severity: "low",
    weight: 2,
    source: "client",
    category: "browser",
  },
  PRINT_ATTEMPT: {
    label: "Print attempt",
    description: "The browser print dialog was triggered.",
    severity: "medium",
    weight: 5,
    source: "client",
    category: "browser",
  },
  DEVTOOLS_SUSPECTED: {
    label: "DevTools open",
    description: "Viewport geometry is consistent with docked browser developer tools.",
    severity: "critical",
    weight: 20,
    source: "client",
    category: "integrity",
  },
  PAGE_HIDE: {
    label: "Page closed",
    description: "The exam page was closed, reloaded, or navigated away from.",
    severity: "medium",
    weight: 5,
    source: "client",
    category: "browser",
  },
  NETWORK_OFFLINE: {
    label: "Went offline",
    description: "The browser reported a loss of network connectivity.",
    severity: "medium",
    weight: 3,
    source: "client",
    category: "network",
  },

  // ── Integrity / anti-tamper ──────────────────────────────────────────────
  AUTOMATION_DETECTED: {
    label: "Browser automation",
    description: "The browser reports it is controlled by automation (WebDriver, Puppeteer, Playwright).",
    severity: "critical",
    weight: 40,
    source: "client",
    category: "integrity",
  },
  API_TAMPERING: {
    label: "Browser API tampering",
    description:
      "A browser API used for proctoring was overridden by a script or extension (e.g. 'always active window' extensions).",
    severity: "critical",
    weight: 30,
    source: "client",
    category: "integrity",
  },
  VISIBILITY_SPOOF: {
    label: "Visibility spoofing",
    description:
      "The page reported itself as visible while the rendering pipeline was paused, i.e. tab-switch detection is being suppressed.",
    severity: "critical",
    weight: 30,
    source: "client",
    category: "integrity",
  },
  DOM_INJECTION: {
    label: "Injected content",
    description: "An unknown element or frame was injected into the exam page, typically by a browser extension.",
    severity: "high",
    weight: 10,
    source: "client",
    category: "integrity",
  },

  // ── Server-side detections (client cannot forge or suppress these) ──────
  HEARTBEAT_GAP: {
    label: "Monitoring gap",
    description:
      "The server received no proctoring data for longer than allowed. Monitoring was blocked, the tab was throttled in the background, or the network dropped.",
    severity: "high",
    weight: 10,
    source: "server",
    category: "network",
  },
  CHAIN_INTEGRITY_FAILURE: {
    label: "Event log tampered",
    description:
      "An event batch failed sequence or signature verification (dropped, reordered, replayed, or forged events, or the session was used from two places).",
    severity: "critical",
    weight: 40,
    source: "server",
    category: "integrity",
  },
  ANSWER_REJECTED: {
    label: "Invalid answer rejected",
    description:
      "The page sent an answer for a question or option that is not part of this exam, or after time was up. The page was likely modified.",
    severity: "high",
    weight: 15,
    source: "server",
    category: "integrity",
  },
  CLOCK_TAMPER: {
    label: "Clock manipulation",
    description: "The candidate's device clock jumped relative to the server clock during the exam.",
    severity: "high",
    weight: 10,
    source: "server",
    category: "integrity",
  },
  DETECTOR_STALLED: {
    label: "Detector stalled",
    description:
      "The client reported a live, visible camera but analysed no frames. The detection loop was stopped or patched out.",
    severity: "high",
    weight: 10,
    source: "server",
    category: "integrity",
  },
} as const satisfies Record<string, EventSpec>;

export type EventType = keyof typeof EVENT_CATALOG;

export const EVENT_TYPES = Object.keys(EVENT_CATALOG) as EventType[];

export const CLIENT_EVENT_TYPES = EVENT_TYPES.filter(
  (t) => EVENT_CATALOG[t].source === "client",
);

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && Object.hasOwn(EVENT_CATALOG, value);
}

export function isClientEventType(value: unknown): value is EventType {
  return isEventType(value) && EVENT_CATALOG[value].source === "client";
}

export function specOf(type: EventType): EventSpec {
  return EVENT_CATALOG[type];
}

export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export type RiskLevel = "low" | "medium" | "high";

export function riskLevel(score: number): RiskLevel {
  if (score >= 50) return "high";
  if (score >= 20) return "medium";
  return "low";
}

/**
 * Risk contribution of one stored event.
 *
 * Sustained conditions are recorded twice: a "start" event (scored with the
 * base weight) and an "end" event carrying the duration (scored with a bonus
 * of a quarter of the weight per 10 seconds, capped at 3x the base weight).
 */
export function riskContribution(
  type: EventType,
  phase: string | undefined,
  durationMs: number | null | undefined,
): number {
  const { weight } = EVENT_CATALOG[type];
  if (weight === 0) return 0;
  if (phase === "end") {
    const tens = Math.floor((durationMs ?? 0) / 10_000);
    return Math.min(weight * 3, tens * Math.ceil(weight / 4));
  }
  return weight;
}
