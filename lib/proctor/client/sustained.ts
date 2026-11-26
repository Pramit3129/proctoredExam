/**
 * Tracks a boolean condition over time and fires once it has held for
 * `minMs`, then again (with the total duration) once it has been false for
 * `clearMs`. Debounces detector noise without losing how long it lasted.
 *
 * `graceMs` tolerates short dropouts *before* the condition is reported: a
 * noisy detector (head pose, gaze, face presence) often misses a frame or two
 * in the middle of a real event, and without this a single missed frame would
 * restart the timer so the event would never be reported.
 */
export class Sustained<T = void> {
  private since: number | null = null;
  private lastTrueAt: number | null = null;
  private clearSince: number | null = null;
  private active = false;
  private lastDetail: T | undefined;
  private readonly minMs: number;
  private readonly handlers: {
    start: (since: number, detail: T | undefined) => void;
    end: (durationMs: number, detail: T | undefined) => void;
  };
  private readonly clearMs: number;
  private readonly graceMs: number;

  constructor(
    minMs: number,
    handlers: {
      start: (since: number, detail: T | undefined) => void;
      end: (durationMs: number, detail: T | undefined) => void;
    },
    clearMs = 500,
    graceMs = 0,
  ) {
    this.minMs = minMs;
    this.handlers = handlers;
    this.clearMs = clearMs;
    this.graceMs = graceMs;
  }

  get isActive(): boolean {
    return this.active;
  }

  update(condition: boolean, now: number, detail?: T): void {
    if (condition) {
      this.clearSince = null;
      this.lastTrueAt = now;
      if (detail !== undefined) this.lastDetail = detail;
      if (this.since === null) this.since = now;
      if (!this.active && now - this.since >= this.minMs) {
        this.active = true;
        this.handlers.start(this.since, this.lastDetail);
      }
      return;
    }
    if (!this.active) {
      if (this.since !== null && now - (this.lastTrueAt ?? now) > this.graceMs) {
        this.since = null;
        this.lastTrueAt = null;
      }
      return;
    }
    if (this.clearSince === null) this.clearSince = now;
    if (now - this.clearSince >= this.clearMs) this.finish(this.clearSince);
  }

  /** Ends an active condition immediately (e.g. when monitoring stops). */
  flush(now: number): void {
    if (this.active) this.finish(now);
    this.since = null;
    this.lastTrueAt = null;
  }

  private finish(endedAt: number): void {
    const duration = Math.max(0, endedAt - (this.since ?? endedAt));
    this.active = false;
    this.since = null;
    this.lastTrueAt = null;
    this.clearSince = null;
    this.handlers.end(duration, this.lastDetail);
    this.lastDetail = undefined;
  }
}
