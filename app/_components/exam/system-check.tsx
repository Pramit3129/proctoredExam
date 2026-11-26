"use client";

import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import { useEffect, useRef, useState } from "react";

import { AudioMonitor } from "@/lib/proctor/client/audio-monitor";
import type { StudentExam } from "@/lib/exam-types";
import { isFullscreen, releaseKeyboardLock, requestFullscreen } from "@/lib/proctor/client/environment-monitor";
import {
  acquireMedia,
  createAnalysisVideo,
  describeMediaError,
  hasMultipleDisplays,
  listDevices,
  stopMedia,
  waitForVideo,
  type AcquiredMedia,
  type DeviceLists,
} from "@/lib/proctor/client/media";
import { calibrate, loadFaceLandmarker, type Baseline } from "@/lib/proctor/client/vision";

import { CameraIcon, CheckIcon, ExpandIcon, MicIcon, WarningIcon } from "../icons";
import { Button, Card, Notice, Select, Spinner, cx, type Tone } from "../ui";
import { CameraPreview } from "./camera-preview";
import type { ReadyMedia } from "./exam-app";

type CheckState = "pending" | "running" | "pass" | "warn" | "fail";

interface Check {
  label: string;
  state: CheckState;
  detail: string;
}

interface Acquired {
  media: AcquiredMedia;
  video: HTMLVideoElement;
  audio: AudioMonitor;
}

function release(a: Acquired | null): void {
  if (!a) return;
  a.audio.stop();
  stopMedia(a.media);
  a.video.remove();
}

function environmentChecks(): Check[] {
  const browserOk =
    window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof WebAssembly === "object" &&
    !!crypto?.subtle &&
    (document.fullscreenEnabled || "webkitFullscreenEnabled" in document);
  const displays = hasMultipleDisplays();
  return [
    {
      label: "Browser",
      state: browserOk ? "pass" : "fail",
      detail: browserOk ? "Secure connection, camera, fullscreen and WebAssembly available." : "Use a current desktop Chrome, Edge, Firefox or Safari over HTTPS.",
    },
    {
      label: "Automation",
      state: navigator.webdriver ? "fail" : "pass",
      detail: navigator.webdriver ? "This browser is being controlled by automation software." : "No automation detected.",
    },
    {
      label: "Displays",
      state: displays === true ? "fail" : displays === null ? "warn" : "pass",
      detail:
        displays === true
          ? "More than one display is connected. Disconnect extra monitors, then re-check."
          : displays === null
            ? "This browser does not report connected displays; extra monitors will still be flagged if detected."
            : "Single display.",
    },
  ];
}

const STATE_TONE: Record<CheckState, Tone> = { pending: "neutral", running: "accent", pass: "ok", warn: "warn", fail: "danger" };

function StateIcon({ state }: { state: CheckState }) {
  if (state === "running") return <Spinner className="size-[18px] text-accent" />;
  const tone = STATE_TONE[state];
  return (
    <span
      className={cx(
        "flex size-[22px] items-center justify-center rounded-full",
        tone === "ok" && "bg-ok text-white",
        tone === "warn" && "bg-warn text-white",
        tone === "danger" && "bg-danger text-white",
        tone === "neutral" && "border-2 border-surface-3",
      )}
    >
      {state === "pass" && <CheckIcon size={14} strokeWidth={2.6} />}
      {(state === "warn" || state === "fail") && <span className="text-[13px] leading-none font-bold">!</span>}
    </span>
  );
}

export function SystemCheck({
  exam,
  onBack,
  onStart,
}: {
  exam: StudentExam;
  onBack: () => void;
  onStart: (ready: ReadyMedia) => Promise<void>;
}) {
  const [env, setEnv] = useState<Check[]>(environmentChecks);
  const [landmarker, setLandmarker] = useState<FaceLandmarker | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [acquired, setAcquired] = useState<Acquired | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceLists | null>(null);
  const [level, setLevel] = useState(0);
  const [calibration, setCalibration] = useState<{ state: CheckState; progress: number; message: string; baseline: Baseline | null }>({
    state: "pending",
    progress: 0,
    message: "Enable your camera first.",
    baseline: null,
  });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const acquiredRef = useRef<Acquired | null>(null);
  const handedOff = useRef(false);

  useEffect(() => {
    let cancelled = false;
    loadFaceLandmarker().then(
      (l) => !cancelled && setLandmarker(l),
      (e: unknown) => !cancelled && setModelError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Release camera/mic if the candidate leaves this step without starting.
  useEffect(
    () => () => {
      if (!handedOff.current) release(acquiredRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!acquired) return;
    const id = window.setInterval(() => setLevel(acquired.audio.level), 100);
    return () => window.clearInterval(id);
  }, [acquired]);

  async function enableMedia(cameraId?: string, microphoneId?: string) {
    setMediaBusy(true);
    setMediaError(null);
    release(acquiredRef.current);
    acquiredRef.current = null;
    setAcquired(null);
    setCalibration({ state: "pending", progress: 0, message: "Starting camera…", baseline: null });
    try {
      const media = await acquireMedia(cameraId, microphoneId);
      const video = createAnalysisVideo(media.stream);
      const audio = new AudioMonitor(media.stream, null, null);
      const next = { media, video, audio };
      acquiredRef.current = next;
      await waitForVideo(video);
      await audio.start();
      setAcquired(next);
      setDevices(await listDevices());
      setCalibration({ state: "pending", progress: 0, message: "Look at the centre of the screen, then calibrate.", baseline: null });
    } catch (e) {
      release(acquiredRef.current);
      acquiredRef.current = null;
      setMediaError(describeMediaError(e));
      setCalibration({ state: "pending", progress: 0, message: "Enable your camera first.", baseline: null });
    } finally {
      setMediaBusy(false);
    }
  }

  async function runCalibration() {
    const a = acquiredRef.current;
    if (!a || !landmarker) return;
    setCalibration({ state: "running", progress: 0, message: "Hold still and look at the centre of the screen…", baseline: null });
    try {
      const baseline = await calibrate(landmarker, a.video, (p) =>
        setCalibration((c) => ({ ...c, progress: p.progress, message: p.message })),
      );
      setCalibration({ state: "pass", progress: 1, message: "Calibrated to your normal sitting position.", baseline });
    } catch (e) {
      setCalibration({ state: "fail", progress: 0, message: e instanceof Error ? e.message : String(e), baseline: null });
    }
  }

  async function start() {
    const a = acquiredRef.current;
    if (!a || !landmarker || !calibration.baseline) return;
    // Must be requested synchronously inside the click.
    const fullscreen = requestFullscreen();
    setStarting(true);
    setStartError(null);
    handedOff.current = true;
    try {
      await fullscreen.catch(() => {
        throw new Error("Full screen was blocked. Allow full screen for this site, then try again.");
      });
      // The exam must never start outside full screen: leaving it ends the attempt.
      await new Promise((r) => setTimeout(r, 150));
      if (!isFullscreen()) throw new Error("The exam needs full screen. Allow full screen for this site, then try again.");
      await onStart({ media: a.media, video: a.video, landmarker, baseline: calibration.baseline });
      a.audio.stop();
    } catch (e) {
      handedOff.current = false;
      setStartError(e instanceof Error ? e.message : String(e));
      setStarting(false);
      releaseKeyboardLock();
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    }
  }

  const virtual = acquired?.media.virtualCamera ?? null;
  const cameraCheck: Check = acquired
    ? virtual
      ? { label: "Camera", state: "fail", detail: `${virtual} detected. Select your physical webcam.` }
      : { label: "Camera", state: "pass", detail: acquired.media.camera.label || "Camera connected." }
    : mediaError
      ? { label: "Camera", state: "fail", detail: mediaError }
      : { label: "Camera", state: mediaBusy ? "running" : "pending", detail: "Camera access is required." };
  const micCheck: Check = acquired
    ? acquired.media.microphone
      ? { label: "Microphone", state: "pass", detail: acquired.media.microphone.label || "Microphone connected." }
      : { label: "Microphone", state: "fail", detail: "No microphone track. Connect a microphone." }
    : { label: "Microphone", state: mediaBusy ? "running" : "pending", detail: "Microphone access is required." };
  const modelCheck: Check = landmarker
    ? { label: "Proctoring model", state: "pass", detail: "Face analysis model loaded on this device." }
    : modelError
      ? { label: "Proctoring model", state: "fail", detail: modelError }
      : { label: "Proctoring model", state: "running", detail: "Loading face analysis model…" };
  const calibrationCheck: Check = { label: "Calibration", state: calibration.state, detail: calibration.message };

  const checks = [...env, cameraCheck, micCheck, modelCheck, calibrationCheck];
  const ready = checks.every((c) => c.state === "pass" || c.state === "warn");

  const passed = checks.filter((c) => c.state === "pass" || c.state === "warn").length;

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-10 pb-16 sm:px-6">
      <button type="button" className="focus-ring rounded text-[14px] text-accent hover:underline disabled:opacity-40" onClick={onBack} disabled={starting}>
        ‹ Back
      </button>
      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_1.05fr]">
        <section className="animate-enter space-y-4">
          <div>
            <h1 className="text-title">System check</h1>
            <p className="mt-1 text-[15px] text-muted">
              {exam.title} · {passed} of {checks.length} ready
            </p>
          </div>

          {acquired ? (
            <CameraPreview stream={acquired.media.stream} className="rounded-[18px] shadow-[var(--shadow-md)]">
              <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div
                  className={cx(
                    "h-[62%] w-[38%] rounded-[50%] border-2 border-dashed transition-colors duration-200",
                    calibration.state === "pass" ? "border-[#34c759]" : calibration.state === "running" ? "border-white" : "border-white/50",
                  )}
                />
              </div>
              {calibration.state === "running" && (
                <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
                  <div className="h-full bg-white transition-[width] duration-150" style={{ width: `${Math.round(calibration.progress * 100)}%` }} />
                </div>
              )}
            </CameraPreview>
          ) : (
            <Card className="flex aspect-[4/3] flex-col items-center justify-center gap-4 p-6 text-center">
              <span className="flex size-14 items-center justify-center rounded-full bg-accent-soft text-accent">
                <CameraIcon size={26} />
              </span>
              <p className="max-w-xs text-[14px] text-muted text-pretty">
                Your browser will ask for camera and microphone access. Choose your built-in or USB webcam, not a virtual camera.
              </p>
              <Button onClick={() => void enableMedia()} disabled={mediaBusy}>
                {mediaBusy && <Spinner />} Turn on camera and microphone
              </Button>
            </Card>
          )}

          {acquired && (
            <Card className="space-y-4 p-4">
              <div className="flex items-center gap-3">
                <MicIcon size={18} className="shrink-0 text-muted" />
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full rounded-full bg-[#34c759] transition-[width] duration-100" style={{ width: `${Math.round(level * 100)}%` }} />
                </div>
              </div>
              {devices && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-[12px] font-medium text-muted">Camera</span>
                    <Select
                      value={acquired.media.camera.getSettings().deviceId ?? ""}
                      onChange={(e) => void enableMedia(e.target.value, acquired.media.microphone?.getSettings().deviceId)}
                      disabled={mediaBusy || calibration.state === "running"}
                    >
                      {devices.cameras.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[12px] font-medium text-muted">Microphone</span>
                    <Select
                      value={acquired.media.microphone?.getSettings().deviceId ?? ""}
                      onChange={(e) => void enableMedia(acquired.media.camera.getSettings().deviceId, e.target.value)}
                      disabled={mediaBusy || calibration.state === "running"}
                    >
                      {devices.microphones.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.label}
                        </option>
                      ))}
                    </Select>
                  </label>
                </div>
              )}
            </Card>
          )}
        </section>

        <section className="animate-enter space-y-4" style={{ animationDelay: "60ms" }}>
          <Card>
            <ul className="divide-y divide-line">
              {checks.map((c) => (
                <li key={c.label} className="flex items-start gap-3.5 px-5 py-3.5">
                  <span className="mt-0.5">
                    <StateIcon state={c.state} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-medium">{c.label}</p>
                    <p className={cx("mt-0.5 text-[13px] text-pretty break-words", c.state === "fail" ? "text-danger" : "text-muted")}>{c.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setEnv(environmentChecks())}>
              Check again
            </Button>
            <Button
              variant="secondary"
              onClick={() => void runCalibration()}
              disabled={!acquired || !landmarker || !!virtual || calibration.state === "running"}
            >
              {calibration.state === "running" && <Spinner />}
              {calibration.state === "pass" ? "Recalibrate" : "Calibrate"}
            </Button>
          </div>

          <Card className="p-5">
            <div className="flex gap-3">
              <WarningIcon size={20} className="mt-0.5 shrink-0 text-danger" />
              <p className="text-[14px] text-pretty">
                The exam opens in full screen. <strong className="font-semibold">Leaving full screen submits it immediately</strong>
                {exam.strictFocus ? ", and so does switching to another tab or app." : "."}
              </p>
            </div>
            <Button size="lg" className="mt-4 w-full" onClick={() => void start()} disabled={!ready || starting}>
              {starting ? <Spinner /> : <ExpandIcon size={18} />} Start exam in full screen
            </Button>
            {startError && <Notice className="mt-3">{startError}</Notice>}
          </Card>
        </section>
      </div>
    </main>
  );
}
