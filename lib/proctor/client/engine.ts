import type { FaceLandmarker } from "@mediapipe/tasks-vision";

import { specOf, type EventType } from "../catalog";
import type { EndReason, EndResponse, Heartbeat, SessionBootstrap } from "../protocol";
import { AudioMonitor } from "./audio-monitor";
import { EnvironmentMonitor, isFullscreen, releaseKeyboardLock, type EnvironmentState } from "./environment-monitor";
import { FaceMonitor, type Emit, type EmitOptions } from "./face-monitor";
import { IntegrityMonitor } from "./integrity-monitor";
import type { AcquiredMedia } from "./media";
import { Store } from "./store";
import { Sustained } from "./sustained";
import { Transport, type ClosedStatus, type ConnectionState, type PendingEvent } from "./transport";
import type { Baseline } from "./vision";

export type EngineStatus = "running" | ClosedStatus;

export interface EngineState {
  status: EngineStatus;
  endReason: EndReason | null;
  faceCount: number;
  connection: ConnectionState;
  env: EnvironmentState;
  cameraLive: boolean;
  micLive: boolean;
  /** Messages for conditions the candidate should correct right now. */
  warnings: { type: EventType; message: string }[];
  /** Answer changes not yet stored by the server. */
  unsavedAnswers: number;
}

function trackLive(track: MediaStreamTrack | null): boolean {
  return !!track && track.readyState === "live" && !track.muted && track.enabled;
}

const ANSWER_EVENTS = new Set<EventType>(["ANSWER_SELECTED", "ANSWER_CLEARED"]);

export interface EngineOptions {
  boot: SessionBootstrap;
  media: AcquiredMedia;
  video: HTMLVideoElement;
  landmarker: FaceLandmarker;
  baseline: Baseline;
}

/**
 * Orchestrates all monitors for one attempt and streams their events, and the
 * candidate's answers, to the server. The UI only reads `store` and calls the
 * interaction methods; it cannot alter what monitors report.
 */
export class ProctorEngine {
  readonly store: Store<EngineState>;
  private transport!: Transport;
  private face!: FaceMonitor;
  private audio!: AudioMonitor;
  private environment!: EnvironmentMonitor;
  private integrity!: IntegrityMonitor;
  private readonly cleanup: (() => void)[] = [];
  private readonly activeWarnings = new Map<EventType, string>();
  private stopped = false;
  private readonly cameraLost: Sustained<Record<string, unknown>>;
  private readonly micLost: Sustained<Record<string, unknown>>;

  private constructor(private readonly opts: EngineOptions) {
    this.store = new Store<EngineState>({
      status: "running",
      endReason: null,
      faceCount: 0,
      connection: "online",
      env: { visible: true, focused: true, fullscreen: isFullscreen(), online: navigator.onLine },
      cameraLive: trackLive(opts.media.camera),
      micLive: trackLive(opts.media.microphone),
      warnings: [],
      unsavedAnswers: 0,
    });
    const lost = (type: EventType) =>
      new Sustained<Record<string, unknown>>(
        0,
        {
          start: (_since, detail) => this.emit(type, { ...detail }, { phase: "start" }),
          end: (durationMs, detail) => this.emit(type, { ...detail }, { phase: "end", durationMs }),
        },
        0,
      );
    this.cameraLost = lost("CAMERA_LOST");
    this.micLost = lost("MIC_LOST");
  }

  static async start(opts: EngineOptions): Promise<ProctorEngine> {
    const engine = new ProctorEngine(opts);
    await engine.init();
    return engine;
  }

  private async init(): Promise<void> {
    const { boot, media, video, landmarker, baseline } = this.opts;
    const config = boot.config;

    this.transport = await Transport.create(boot, {
      heartbeat: () => this.heartbeat(),
      onClosed: (status, reason) => this.handleClosed(status, reason),
      onConnection: (connection) => this.store.set({ connection }),
      onDelivered: (events) => this.handleDelivered(events),
    });

    this.face = new FaceMonitor(landmarker, video, config, baseline, this.emit, (faceCount) => this.store.set({ faceCount }));
    this.audio = new AudioMonitor(media.stream, config, this.emit);
    this.environment = new EnvironmentMonitor(this.emit, (env) => this.store.set({ env }));
    this.integrity = new IntegrityMonitor(this.emit);

    this.transport.start();
    this.emit("CALIBRATED", {
      yawDeg: Math.round(baseline.yaw),
      pitchDeg: Math.round(baseline.pitch),
      camera: media.camera.label.slice(0, 80),
    });
    if (media.virtualCamera) this.emit("VIRTUAL_CAMERA", { camera: media.camera.label.slice(0, 80), match: media.virtualCamera });

    this.face.start();
    await this.audio.start();
    this.environment.start();
    this.integrity.start();
    this.watchTracks();
    this.watchPage();
  }

  /** Records an event and updates candidate-facing warnings. */
  readonly emit: Emit = (type, data, options: EmitOptions = {}) => {
    if (this.stopped) return;
    const spec = specOf(type);
    const at = options.at ?? Date.now();
    const payload: Record<string, unknown> = { ...data };
    if (options.phase) payload.phase = options.phase;
    this.transport.enqueue(type, payload, at, options.durationMs);

    if (spec.candidateWarning) {
      if (options.phase === "start") this.activeWarnings.set(type, spec.candidateWarning);
      if (options.phase === "end") this.activeWarnings.delete(type);
      this.store.set({ warnings: [...this.activeWarnings].map(([t, message]) => ({ type: t, message })) });
    }
  };

  // ── Interactions (recorded in the signed event log) ───────────────────────

  /** Chooses (or with `key === null` clears) an answer. Sent to the server immediately. */
  answer(questionId: string, key: string | null): void {
    if (this.stopped || this.transport.isStopped) return;
    if (key === null) this.transport.enqueue("ANSWER_CLEARED", { q: questionId }, Date.now(), undefined, true);
    else this.transport.enqueue("ANSWER_SELECTED", { q: questionId, o: key }, Date.now(), undefined, true);
    this.store.set((s) => ({ unsavedAnswers: s.unsavedAnswers + 1 }));
  }

  viewQuestion(questionId: string, index: number): void {
    if (this.stopped) return;
    this.transport.enqueue("QUESTION_VIEWED", { q: questionId, i: index }, Date.now());
  }

  markQuestion(questionId: string, marked: boolean): void {
    if (this.stopped) return;
    this.transport.enqueue("QUESTION_MARKED", { q: questionId, on: marked }, Date.now());
  }

  private handleDelivered(events: PendingEvent[]): void {
    const answers = events.filter((e) => ANSWER_EVENTS.has(e.type)).length;
    if (answers > 0) this.store.set((s) => ({ unsavedAnswers: Math.max(0, s.unsavedAnswers - answers) }));
  }

  private heartbeat(): Heartbeat {
    const env = this.environment?.state;
    return {
      faceCount: this.face?.faceCount ?? 0,
      visible: env?.visible ?? document.visibilityState === "visible",
      focused: env?.focused ?? document.hasFocus(),
      fullscreen: env?.fullscreen ?? isFullscreen(),
      framesAnalyzed: this.face?.takeFrameCount() ?? 0,
      cameraLive: trackLive(this.opts.media.camera),
      micLive: trackLive(this.opts.media.microphone),
    };
  }

  private watchTracks(): void {
    const { camera, microphone } = this.opts.media;
    const update = () => {
      const now = performance.now();
      const cameraLive = trackLive(camera);
      const micLive = trackLive(microphone);
      this.cameraLost.update(!cameraLive, now, { state: camera.readyState, muted: camera.muted });
      if (microphone) this.micLost.update(!micLive, now, { state: microphone.readyState, muted: microphone.muted });
      this.store.set({ cameraLive, micLive });
    };
    for (const track of [camera, microphone]) {
      if (!track) continue;
      for (const type of ["ended", "mute", "unmute"] as const) {
        track.addEventListener(type, update);
        this.cleanup.push(() => track.removeEventListener(type, update));
      }
    }
    const poll = window.setInterval(update, 2_000);
    this.cleanup.push(() => window.clearInterval(poll));

    let deviceTimer: number | null = null;
    const onDeviceChange = () => {
      if (deviceTimer !== null) window.clearTimeout(deviceTimer);
      deviceTimer = window.setTimeout(async () => {
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        this.emit("MEDIA_DEVICES_CHANGED", {
          cameras: devices.filter((d) => d.kind === "videoinput").map((d) => d.label.slice(0, 60)),
          microphones: devices.filter((d) => d.kind === "audioinput").length,
        });
      }, 1_000);
    };
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);
    this.cleanup.push(() => navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange));
  }

  private watchPage(): void {
    const onPageHide = (e: PageTransitionEvent) => {
      this.emit("PAGE_HIDE", { persisted: e.persisted });
      this.transport.flushOnHide();
    };
    // Ask before closing or reloading: leaving the page submits the exam.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    this.cleanup.push(() => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    });
  }

  private handleClosed(status: ClosedStatus, reason: EndReason | null): void {
    this.shutdownMonitors();
    this.store.set({ status, endReason: reason });
  }

  private shutdownMonitors(): void {
    if (this.stopped) return;
    const now = performance.now();
    // Flush first so open conditions are closed with their durations.
    this.face?.stop();
    this.audio?.stop();
    this.environment?.stop();
    this.integrity?.stop();
    this.cameraLost.flush(now);
    this.micLost.flush(now);
    this.stopped = true;
    for (const fn of this.cleanup.splice(0)) fn();
    releaseKeyboardLock();
  }

  /**
   * Ends the attempt: closes open conditions, delivers every queued event
   * (answers included), then tells the server why. The server grades what it
   * holds; the score is never returned.
   */
  async submit(reason: EndReason): Promise<EndResponse> {
    this.shutdownMonitors();
    await this.transport.drain();
    this.transport.stop();
    const current = this.store.get();
    if (current.status !== "running" && current.status !== "lost") {
      return { status: current.status, endReason: current.endReason };
    }
    const res = await fetch("/api/proctor/end", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
      credentials: "same-origin",
      cache: "no-store",
      keepalive: true,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message ?? `Submission failed (${res.status}).`);
    }
    const result = (await res.json()) as EndResponse;
    this.store.set({ status: result.status === "active" ? "submitted" : result.status, endReason: result.endReason });
    return result;
  }

  /** Stop everything without submitting (e.g. component unmount). */
  dispose(): void {
    this.shutdownMonitors();
    this.transport?.stop();
  }
}
