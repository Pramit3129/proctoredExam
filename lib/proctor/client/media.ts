import type { ClientInfo } from "../protocol";

/**
 * Software cameras that can feed arbitrary video (pre-recorded clips, a
 * still photo, another person's screen) instead of the candidate.
 */
const VIRTUAL_CAMERA_PATTERNS: [RegExp, string][] = [
  [/obs/i, "OBS Virtual Camera"],
  [/manycam/i, "ManyCam"],
  [/snap ?camera/i, "Snap Camera"],
  [/xsplit/i, "XSplit VCam"],
  [/camtwist/i, "CamTwist"],
  [/mmhmm/i, "mmhmm"],
  [/e2esoft|vcam/i, "e2eSoft VCam"],
  [/splitcam/i, "SplitCam"],
  [/youcam/i, "CyberLink YouCam"],
  [/droidcam/i, "DroidCam"],
  [/epoccam/i, "EpocCam"],
  [/iriun/i, "Iriun Webcam"],
  [/nvidia broadcast/i, "NVIDIA Broadcast"],
  [/chromacam/i, "ChromaCam"],
  [/webcamoid/i, "Webcamoid"],
  [/avatarify/i, "Avatarify"],
  [/virtual/i, "Virtual camera"],
  [/fake|dummy/i, "Fake capture device"],
];

export function detectVirtualCamera(label: string): string | null {
  for (const [pattern, name] of VIRTUAL_CAMERA_PATTERNS) if (pattern.test(label)) return name;
  return null;
}

export interface AcquiredMedia {
  stream: MediaStream;
  camera: MediaStreamTrack;
  microphone: MediaStreamTrack | null;
  virtualCamera: string | null;
}

export interface DeviceLists {
  cameras: { id: string; label: string }[];
  microphones: { id: string; label: string }[];
}

export async function listDevices(): Promise<DeviceLists> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const map = (kind: MediaDeviceKind, fallback: string) =>
    devices
      .filter((d) => d.kind === kind && d.deviceId)
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
  return { cameras: map("videoinput", "Camera"), microphones: map("audioinput", "Microphone") };
}

export function assertMediaSupport(): void {
  if (!window.isSecureContext) {
    throw new Error("The exam must be opened over HTTPS (or http://localhost) to access the camera.");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser cannot access a camera. Use a current version of Chrome, Edge, Firefox, or Safari.");
  }
}

export async function acquireMedia(cameraId?: string, microphoneId?: string): Promise<AcquiredMedia> {
  assertMediaSupport();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: cameraId ? { exact: cameraId } : undefined,
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30, max: 30 },
      facingMode: cameraId ? undefined : "user",
    },
    audio: {
      deviceId: microphoneId ? { exact: microphoneId } : undefined,
      echoCancellation: true,
      // Suppresses stationary noise (fans, hum) so voice detection keys on speech.
      noiseSuppression: true,
      autoGainControl: false,
    },
  });
  const camera = stream.getVideoTracks()[0];
  if (!camera) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("No camera track was returned by the browser.");
  }
  return {
    stream,
    camera,
    microphone: stream.getAudioTracks()[0] ?? null,
    virtualCamera: detectVirtualCamera(camera.label),
  };
}

export function stopMedia(media: AcquiredMedia | null): void {
  media?.stream.getTracks().forEach((t) => t.stop());
}

export function hasMultipleDisplays(): boolean | null {
  const extended = (screen as Screen & { isExtended?: boolean }).isExtended;
  return typeof extended === "boolean" ? extended : null;
}

export function collectClientInfo(media: AcquiredMedia): ClientInfo {
  const settings = media.camera.getSettings();
  return {
    userAgent: navigator.userAgent.slice(0, 400),
    platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: { width: screen.width, height: screen.height, dpr: window.devicePixelRatio, extended: hasMultipleDisplays() },
    camera: {
      label: media.camera.label.slice(0, 120),
      width: settings.width ?? null,
      height: settings.height ?? null,
      frameRate: settings.frameRate ? Math.round(settings.frameRate) : null,
    },
    microphone: media.microphone ? { label: media.microphone.label.slice(0, 120) } : null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
  };
}

/**
 * Video element owned by the proctoring engine (not by React), so analysis
 * keeps running regardless of what the UI renders. It stays inside the
 * viewport at a tiny size because browsers may pause off-screen video.
 */
export function createAnalysisVideo(stream: MediaStream): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-hidden", "true");
  video.dataset.proctorOwned = "true";
  Object.assign(video.style, {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "2px",
    height: "2px",
    opacity: "0.01",
    pointerEvents: "none",
    // Above the page, never covered: some browsers stop updating occluded video.
    zIndex: "2147483647",
  });
  video.srcObject = stream;
  document.body.appendChild(video);
  return video;
}

export async function waitForVideo(video: HTMLVideoElement): Promise<void> {
  await video.play();
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Camera did not deliver any frames.")), 8_000);
    const done = () => {
      if (video.videoWidth > 0) {
        window.clearTimeout(timeout);
        video.removeEventListener("loadeddata", done);
        video.removeEventListener("resize", done);
        resolve();
      }
    };
    video.addEventListener("loadeddata", done);
    video.addEventListener("resize", done);
  });
}

/** JPEG frame from the camera for evidence and snapshot challenges. */
export function captureFrame(video: HTMLVideoElement, width = 480): Promise<Blob | null> {
  if (!video.videoWidth) return Promise.resolve(null);
  const height = Math.round((video.videoHeight / video.videoWidth) * width);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(video, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.72));
}

export function describeMediaError(error: unknown): string {
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
        return "Camera or microphone permission was denied. Allow both for this site in the browser (and for the browser in your operating system's privacy settings), then try again.";
      case "NotFoundError":
        return "No camera or microphone was found.";
      case "NotReadableError":
        return "The camera or microphone is in use by another application. Close it and try again.";
      case "OverconstrainedError":
        return "The selected device is unavailable. Pick another camera or microphone.";
    }
  }
  return error instanceof Error ? error.message : String(error);
}
