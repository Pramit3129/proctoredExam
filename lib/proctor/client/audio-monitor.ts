import type { DetectionConfig } from "../protocol";
import type { Emit } from "./face-monitor";
import { Sustained } from "./sustained";

const SPEECH_LOW_HZ = 300;
const SPEECH_HIGH_HZ = 3_400;

/**
 * Voice-activity detection on the microphone: speech-band energy compared
 * with an adaptive noise floor. Also exposes a 0..1 level for the UI meter.
 */
export class AudioMonitor {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private timer: number | null = null;
  private bins: Float32Array<ArrayBuffer> | null = null;
  private floorDb: number | null = null;
  private peakDb = -Infinity;
  private readonly voice: Sustained<Record<string, unknown>> | null;

  level = 0;

  constructor(
    private readonly stream: MediaStream,
    config: DetectionConfig | null,
    emit: Emit | null,
  ) {
    this.voice =
      config && emit
        ? new Sustained(
            config.voiceMs,
            {
              start: (since) => {
                this.peakDb = -Infinity;
                emit("VOICE_DETECTED", {}, { phase: "start", at: Date.now() - (performance.now() - since) });
              },
              end: (durationMs) =>
                emit("VOICE_DETECTED", { peakDbAboveFloor: Math.round(this.peakDb) }, { phase: "end", durationMs }),
            },
            1_000,
          )
        : null;
    this.threshold = config?.voiceDbAboveFloor ?? 15;
  }

  private readonly threshold: number;

  /** Must be called from a user gesture (or after one) so the AudioContext can run. */
  async start(): Promise<void> {
    if (this.context || this.stream.getAudioTracks().length === 0) return;
    const context = new AudioContext();
    if (context.state === "suspended") await context.resume().catch(() => undefined);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    const source = context.createMediaStreamSource(this.stream);
    source.connect(analyser);
    this.context = context;
    this.analyser = analyser;
    this.source = source;
    this.bins = new Float32Array(analyser.frequencyBinCount);
    this.timer = window.setInterval(() => this.sample(), 100);
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.voice?.flush(performance.now());
    this.source?.disconnect();
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.analyser = null;
    this.source = null;
  }

  private sample(): void {
    const analyser = this.analyser;
    const bins = this.bins;
    const context = this.context;
    if (!analyser || !bins || !context) return;
    analyser.getFloatFrequencyData(bins);
    const hzPerBin = context.sampleRate / analyser.fftSize;
    const lo = Math.floor(SPEECH_LOW_HZ / hzPerBin);
    const hi = Math.min(bins.length - 1, Math.ceil(SPEECH_HIGH_HZ / hzPerBin));
    let power = 0;
    for (let i = lo; i <= hi; i++) power += 10 ** (bins[i]! / 10);
    const db = 10 * Math.log10(power / (hi - lo + 1) + 1e-12);

    if (this.floorDb === null) this.floorDb = db;
    // Fall quickly to quieter levels, rise slowly so sustained speech is not absorbed into the floor.
    if (db < this.floorDb) this.floorDb = this.floorDb * 0.7 + db * 0.3;
    else if (db < this.floorDb + 6) this.floorDb = this.floorDb * 0.995 + db * 0.005;

    const above = db - this.floorDb;
    this.level = Math.max(0, Math.min(1, (db + 90) / 60));
    const speaking = above > this.threshold && db > -75;
    if (speaking) this.peakDb = Math.max(this.peakDb, above);
    this.voice?.update(speaking, performance.now());
  }
}
