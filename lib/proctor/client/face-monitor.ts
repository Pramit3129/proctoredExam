import type { FaceLandmarker } from "@mediapipe/tasks-vision";

import type { EventType } from "../catalog";
import type { DetectionConfig } from "../protocol";
import { Sustained } from "./sustained";
import { detect, faceMetrics, primaryFaceIndex, type Baseline } from "./vision";

export interface EmitOptions {
  phase?: "start" | "end";
  durationMs?: number;
  /** Override the event timestamp (epoch ms), e.g. when a condition began. */
  at?: number;
}

export type Emit = (type: EventType, data: Record<string, unknown>, options?: EmitOptions) => void;

type Detail = Record<string, unknown>;

/** Smallest signed difference between two angles in degrees. */
function angleDelta(a: number, b: number): number {
  return ((((a - b + 180) % 360) + 360) % 360) - 180;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

const round = (v: number, digits = 1) => Number(v.toFixed(digits));

/**
 * Runs the face landmarker on a timer (not requestAnimationFrame, which stops
 * entirely in background tabs) and turns per-frame metrics into sustained
 * behavioural events.
 */
export class FaceMonitor {
  private timer: number | null = null;
  private healthTimer: number | null = null;
  private running = false;
  private framesSinceTake = 0;
  private lastBlinkAt = Date.now();
  private jawHistory: number[] = [];
  private lastErrorAt = 0;
  private consecutiveErrors = 0;

  // Camera-health state
  private healthCanvas: HTMLCanvasElement | null = null;
  private previousPixels: Uint8ClampedArray | null = null;
  private lastVideoTime = -1;
  private lastVideoTimeChangeAt = Date.now();
  private identicalSince: number | null = null;

  faceCount = 0;

  private readonly noFace: Sustained<Detail>;
  private readonly multipleFaces: Sustained<Detail>;
  private readonly headTurned: Sustained<Detail>;
  private readonly lookingDown: Sustained<Detail>;
  private readonly lookingUp: Sustained<Detail>;
  private readonly gazeAway: Sustained<Detail>;
  private readonly lips: Sustained<Detail>;
  private readonly partial: Sustained<Detail>;
  private readonly tooFar: Sustained<Detail>;
  private readonly noBlink: Sustained<Detail>;
  private readonly blocked: Sustained<Detail>;
  private readonly frozen: Sustained<Detail>;

  constructor(
    private readonly landmarker: FaceLandmarker,
    private readonly video: HTMLVideoElement,
    private readonly config: DetectionConfig,
    private readonly baseline: Baseline,
    private readonly emit: Emit,
    private readonly onFrame: (faceCount: number) => void,
  ) {
    const track = (type: EventType, minMs: number, clearMs = 800) =>
      new Sustained<Detail>(
        minMs,
        {
          start: (since, detail) => this.emit(type, { ...detail }, { phase: "start", at: Date.now() - (performance.now() - since) }),
          end: (durationMs, detail) => this.emit(type, { ...detail }, { phase: "end", durationMs }),
        },
        clearMs,
      );
    this.noFace = track("NO_FACE", config.noFaceMs);
    this.multipleFaces = track("MULTIPLE_FACES", config.multipleFacesMs, 1_500);
    this.headTurned = track("HEAD_TURNED", config.headTurnMs);
    this.lookingDown = track("LOOKING_DOWN", config.headTurnMs);
    this.lookingUp = track("LOOKING_UP", config.headTurnMs);
    this.gazeAway = track("GAZE_AWAY", config.gazeMs);
    this.lips = track("LIP_MOVEMENT", config.lipMs, 1_500);
    this.partial = track("FACE_PARTIALLY_VISIBLE", 2_000);
    this.tooFar = track("FACE_TOO_FAR", 3_000);
    this.noBlink = track("NO_BLINK", 0, 0);
    this.blocked = track("CAMERA_BLOCKED", config.cameraBlockedMs, 1_000);
    this.frozen = track("CAMERA_FROZEN", 0, 0);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastBlinkAt = performance.now();
    this.lastVideoTimeChangeAt = performance.now();
    this.scheduleNext(0);
    this.healthTimer = window.setInterval(() => this.checkCameraHealth(), 1_000);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.healthTimer !== null) window.clearInterval(this.healthTimer);
    this.timer = null;
    this.healthTimer = null;
    const now = performance.now();
    for (const s of this.all()) s.flush(now);
  }

  /** Frames analysed since the previous call (reported in heartbeats). */
  takeFrameCount(): number {
    const n = this.framesSinceTake;
    this.framesSinceTake = 0;
    return n;
  }

  get activeConditions(): EventType[] {
    const pairs: [Sustained<Detail>, EventType][] = [
      [this.noFace, "NO_FACE"],
      [this.multipleFaces, "MULTIPLE_FACES"],
      [this.headTurned, "HEAD_TURNED"],
      [this.lookingDown, "LOOKING_DOWN"],
      [this.partial, "FACE_PARTIALLY_VISIBLE"],
      [this.tooFar, "FACE_TOO_FAR"],
      [this.blocked, "CAMERA_BLOCKED"],
    ];
    return pairs.filter(([s]) => s.isActive).map(([, t]) => t);
  }

  private all(): Sustained<Detail>[] {
    return [
      this.noFace,
      this.multipleFaces,
      this.headTurned,
      this.lookingDown,
      this.lookingUp,
      this.gazeAway,
      this.lips,
      this.partial,
      this.tooFar,
      this.noBlink,
      this.blocked,
      this.frozen,
    ];
  }

  private scheduleNext(delay: number): void {
    if (!this.running) return;
    this.timer = window.setTimeout(() => this.tick(), delay);
  }

  private tick(): void {
    const started = performance.now();
    try {
      this.analyse();
      this.consecutiveErrors = 0;
    } catch (error) {
      this.consecutiveErrors++;
      if (started - this.lastErrorAt > 30_000) {
        this.lastErrorAt = started;
        this.emit("DETECTOR_ERROR", { message: String((error as Error)?.message ?? error).slice(0, 200) });
      }
    }
    const elapsed = performance.now() - started;
    this.scheduleNext(Math.max(0, this.config.analysisIntervalMs - elapsed));
  }

  private analyse(): void {
    const result = detect(this.landmarker, this.video);
    if (!result) return;
    const now = performance.now();
    this.framesSinceTake++;
    const count = result.faceLandmarks.length;
    this.faceCount = count;
    this.onFrame(count);

    // While the camera is blocked, "no face" is a consequence, not a separate violation.
    this.noFace.update(count === 0 && !this.blocked.isActive, now, {});
    this.multipleFaces.update(count > 1, now, { faces: count });

    if (count === 0) {
      for (const s of [this.headTurned, this.lookingDown, this.lookingUp, this.gazeAway, this.lips, this.partial, this.tooFar]) {
        s.update(false, now);
      }
      this.jawHistory = [];
      this.lastBlinkAt = now;
      this.noBlink.update(false, now);
      return;
    }

    const m = faceMetrics(result, primaryFaceIndex(result));
    const c = this.config;
    const b = this.baseline;

    const yawDelta = angleDelta(m.yaw, b.yaw);
    const pitchDelta = angleDelta(m.pitch, b.pitch);
    const yawRatioDelta = m.yawRatio - b.yawRatio;
    const pitchRatioDelta = m.pitchRatio - b.pitchRatio;

    // Magnitude from the 3D pose; direction from 2D landmark geometry, which has an unambiguous sign.
    const yawDir = Math.abs(yawRatioDelta) > 0.02 ? (yawRatioDelta > 0 ? "left" : "right") : yawDelta > 0 ? "left" : "right";
    const pitchDown = Math.abs(pitchRatioDelta) > 0.012 ? pitchRatioDelta > 0 : pitchDelta > 0;

    const turned = Math.abs(yawDelta) > c.headYawDeg;
    this.headTurned.update(turned, now, { direction: yawDir, yawDeg: round(Math.abs(yawDelta)) });

    const gazeDownDelta = m.gazeDown - b.gazeDown;
    const headDown = Math.abs(pitchDelta) > c.headPitchDownDeg && pitchDown;
    const eyesDown = gazeDownDelta > c.gazeDown;
    this.lookingDown.update(headDown || eyesDown, now, {
      source: headDown ? "head" : "eyes",
      pitchDeg: round(Math.abs(pitchDelta)),
      eyesDown: round(gazeDownDelta, 2),
    });
    this.lookingUp.update(Math.abs(pitchDelta) > c.headPitchUpDeg && !pitchDown, now, { pitchDeg: round(Math.abs(pitchDelta)) });

    const gazeDelta = m.gazeHorizontal - b.gazeHorizontal;
    this.gazeAway.update(Math.abs(gazeDelta) > c.gazeHorizontal && !turned, now, {
      direction: gazeDelta > 0 ? "left" : "right",
      strength: round(Math.abs(gazeDelta), 2),
    });

    this.jawHistory.push(m.jawOpen);
    const historySize = Math.max(6, Math.round(2_000 / c.analysisIntervalMs));
    if (this.jawHistory.length > historySize) this.jawHistory.splice(0, this.jawHistory.length - historySize);
    const jawStd = stdDev(this.jawHistory);
    this.lips.update(this.jawHistory.length >= historySize && jawStd > c.lipStdDev, now, { variability: round(jawStd, 3) });

    const margin = c.edgeMargin;
    const atEdge = m.box.minX < margin || m.box.minY < margin || m.box.maxX > 1 - margin || m.box.maxY > 1 - margin;
    this.partial.update(atEdge, now, {});
    this.tooFar.update(m.box.maxX - m.box.minX < c.minFaceWidth, now, { faceWidth: round(m.box.maxX - m.box.minX, 3) });

    if (m.blink > 0.45) this.lastBlinkAt = now;
    this.noBlink.update(now - this.lastBlinkAt > c.noBlinkMs, now, { secondsWithoutBlink: Math.round((now - this.lastBlinkAt) / 1000) });
  }

  /**
   * 1 Hz check on a tiny downscaled frame:
   * - dark or uniform image → lens covered / lights off
   * - pixel-identical frames, or a video clock that stops → frozen or static virtual feed
   *   (real sensors always produce noise between frames)
   */
  private checkCameraHealth(): void {
    const video = this.video;
    if (!video.videoWidth) return;
    const now = performance.now();
    const w = 48;
    const h = 36;
    this.healthCanvas ??= Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = this.healthCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h).data;

    let sum = 0;
    let sumSq = 0;
    let identical = this.previousPixels !== null;
    for (let i = 0; i < pixels.length; i += 4) {
      const luma = 0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]!;
      sum += luma;
      sumSq += luma * luma;
      if (identical && (pixels[i] !== this.previousPixels![i] || pixels[i + 1] !== this.previousPixels![i + 1])) {
        identical = false;
      }
    }
    const n = pixels.length / 4;
    const mean = sum / n;
    const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    this.previousPixels = new Uint8ClampedArray(pixels);

    const isBlocked = mean < this.config.cameraDarkLuma || std < this.config.cameraUniformStdDev;
    this.blocked.update(isBlocked, now, { brightness: Math.round(mean), contrast: round(std) });

    if (video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = video.currentTime;
      this.lastVideoTimeChangeAt = now;
    }
    if (identical) this.identicalSince ??= now;
    else this.identicalSince = null;
    const identicalFor = this.identicalSince === null ? 0 : now - this.identicalSince;
    const stalledFor = now - this.lastVideoTimeChangeAt;
    // Background tabs may legitimately stop delivering frames; TAB_HIDDEN covers that case.
    const visible = document.visibilityState === "visible";
    const isFrozen = visible && !isBlocked && (identicalFor >= this.config.cameraFrozenMs || stalledFor >= this.config.cameraFrozenMs);
    this.frozen.update(isFrozen, now, {
      reason: stalledFor >= this.config.cameraFrozenMs ? "video_clock_stopped" : "identical_frames",
    });
  }
}
