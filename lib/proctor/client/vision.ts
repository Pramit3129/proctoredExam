import type { Category, FaceLandmarker, FaceLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";

/**
 * MediaPipe Face Landmarker wrapper: model loading, timestamp management and
 * conversion of raw landmarks/blendshapes into head-pose and gaze metrics.
 */

let landmarkerPromise: Promise<FaceLandmarker> | null = null;
let lastTimestamp = 0;
let consoleFiltered = false;

/**
 * MediaPipe's WebAssembly runtime writes informational lines such as
 * "INFO: Created TensorFlow Lite XNNPACK delegate for CPU." to console.error,
 * which dev tooling then reports as errors. Drop only those INFO lines.
 */
function filterMediaPipeInfoLogs(): void {
  if (consoleFiltered) return;
  consoleFiltered = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && /^INFO: (Created TensorFlow Lite|Initialized TensorFlow Lite)/.test(args[0])) return;
    original(...args);
  };
}

export function loadFaceLandmarker(): Promise<FaceLandmarker> {
  filterMediaPipeInfoLogs();
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      const create = (delegate: "GPU" | "CPU") =>
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: "/models/face_landmarker.task", delegate },
          runningMode: "VIDEO",
          numFaces: 4,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
      try {
        return await create("GPU");
      } catch (error) {
        console.warn("[proctor] GPU delegate unavailable, falling back to CPU", error);
        return await create("CPU");
      }
    })();
    landmarkerPromise.catch(() => {
      landmarkerPromise = null;
    });
  }
  return landmarkerPromise;
}

/** detectForVideo requires strictly increasing timestamps across every call on the instance. */
export function detect(landmarker: FaceLandmarker, video: HTMLVideoElement): FaceLandmarkerResult | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return null;
  let ts = performance.now();
  if (ts <= lastTimestamp) ts = lastTimestamp + 1;
  lastTimestamp = ts;
  return landmarker.detectForVideo(video, ts);
}

export interface FaceMetrics {
  /** Head rotation in degrees from the facial transformation matrix (magnitude is reliable; sign is convention-dependent). */
  yaw: number;
  pitch: number;
  roll: number;
  /** Nose position between the cheeks (0.5 = frontal). Increases when the candidate turns to their left. */
  yawRatio: number;
  /** Nose position between forehead and chin. Increases when the candidate looks down. */
  pitchRatio: number;
  /** Eye gaze, positive toward the candidate's left. */
  gazeHorizontal: number;
  gazeDown: number;
  jawOpen: number;
  blink: number;
  box: { minX: number; minY: number; maxX: number; maxY: number };
  area: number;
}

const NOSE_TIP = 1;
const CHEEK_A = 234;
const CHEEK_B = 454;
const FOREHEAD = 10;
const CHIN = 152;

const RAD = 180 / Math.PI;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function blend(categories: Category[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of categories ?? []) out[c.categoryName] = c.score;
  return out;
}

function poseFromMatrix(data: number[] | undefined): { yaw: number; pitch: number; roll: number } | null {
  if (!data || data.length < 16) return null;
  // Column-major 4x4; normalise the rotation columns in case the matrix carries scale.
  const sx = Math.hypot(data[0], data[1], data[2]) || 1;
  const sy = Math.hypot(data[4], data[5], data[6]) || 1;
  const sz = Math.hypot(data[8], data[9], data[10]) || 1;
  const r00 = data[0] / sx;
  const r10 = data[1] / sx;
  const r20 = data[2] / sx;
  const r21 = data[6] / sy;
  const r22 = data[10] / sz;
  return {
    yaw: Math.asin(clamp(-r20, -1, 1)) * RAD,
    pitch: Math.atan2(r21, r22) * RAD,
    roll: Math.atan2(r10, r00) * RAD,
  };
}

function boundingBox(landmarks: NormalizedLandmark[]) {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const p of landmarks) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function faceMetrics(result: FaceLandmarkerResult, index: number): FaceMetrics {
  const lm = result.faceLandmarks[index]!;
  const box = boundingBox(lm);
  const nose = lm[NOSE_TIP]!;
  const a = lm[CHEEK_A]!;
  const b = lm[CHEEK_B]!;
  const left = Math.min(a.x, b.x);
  const width = Math.abs(b.x - a.x) || 1e-6;
  const top = lm[FOREHEAD]!;
  const chin = lm[CHIN]!;
  const height = chin.y - top.y || 1e-6;
  const yawRatio = (nose.x - left) / width;
  const pitchRatio = (nose.y - top.y) / height;

  const bs = blend(result.faceBlendshapes[index]?.categories);
  const v = (name: string) => bs[name] ?? 0;
  // *Left / *Right refer to the candidate's own eyes.
  const towardLeft = (v("eyeLookOutLeft") + v("eyeLookInRight")) / 2;
  const towardRight = (v("eyeLookInLeft") + v("eyeLookOutRight")) / 2;

  const matrixPose = poseFromMatrix(result.facialTransformationMatrixes[index]?.data);
  // Geometric fallback when the matrix is unavailable: nose offset ≈ 0.57·tan(yaw), 0.17·tan(pitch).
  const pose = matrixPose ?? {
    yaw: Math.atan((yawRatio - 0.5) / 0.57) * RAD,
    pitch: Math.atan((pitchRatio - 0.55) / 0.17) * RAD,
    roll: 0,
  };

  return {
    ...pose,
    yawRatio,
    pitchRatio,
    gazeHorizontal: towardLeft - towardRight,
    gazeDown: (v("eyeLookDownLeft") + v("eyeLookDownRight")) / 2,
    jawOpen: v("jawOpen"),
    blink: (v("eyeBlinkLeft") + v("eyeBlinkRight")) / 2,
    box,
    area: (box.maxX - box.minX) * (box.maxY - box.minY),
  };
}

/** Index of the largest face (the candidate, normally closest to the camera). */
export function primaryFaceIndex(result: FaceLandmarkerResult): number {
  let best = 0;
  let bestArea = -1;
  result.faceLandmarks.forEach((lm, i) => {
    const box = boundingBox(lm);
    const area = (box.maxX - box.minX) * (box.maxY - box.minY);
    if (area > bestArea) {
      bestArea = area;
      best = i;
    }
  });
  return best;
}

export interface Baseline {
  yaw: number;
  pitch: number;
  yawRatio: number;
  pitchRatio: number;
  gazeHorizontal: number;
  gazeDown: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface CalibrationProgress {
  progress: number;
  faceCount: number;
  message: string;
}

/**
 * Records the candidate's neutral pose while they look at the centre of the
 * screen. Later deviations are measured against this, which tolerates
 * off-centre webcams and laptop screens tilted at any angle.
 */
export async function calibrate(
  landmarker: FaceLandmarker,
  video: HTMLVideoElement,
  onProgress: (p: CalibrationProgress) => void,
  { samples = 20, intervalMs = 120, timeoutMs = 20_000 } = {},
): Promise<Baseline> {
  const collected: FaceMetrics[] = [];
  const started = performance.now();
  while (collected.length < samples) {
    if (performance.now() - started > timeoutMs) {
      throw new Error("Calibration timed out. Make sure only your face is visible and well lit, then try again.");
    }
    const result = detect(landmarker, video);
    const count = result?.faceLandmarks.length ?? 0;
    if (result && count === 1) {
      const m = faceMetrics(result, 0);
      // Only accept roughly frontal frames as the baseline.
      if (Math.abs(m.yawRatio - 0.5) < 0.2) collected.push(m);
    } else if (count > 1) {
      collected.length = 0;
    }
    onProgress({
      progress: collected.length / samples,
      faceCount: count,
      message:
        count === 0
          ? "No face detected — sit in front of the camera."
          : count > 1
            ? "More than one face detected — only you may be in view."
            : "Hold still and look at the centre of the screen…",
    });
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const pick = (k: keyof Baseline) => median(collected.map((m) => m[k]));
  return {
    yaw: pick("yaw"),
    pitch: pick("pitch"),
    yawRatio: pick("yawRatio"),
    pitchRatio: pick("pitchRatio"),
    gazeHorizontal: pick("gazeHorizontal"),
    gazeDown: pick("gazeDown"),
  };
}
