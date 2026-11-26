/**
 * Tracks a boolean condition over time and fires once it has held for
 * `minMs`, then again (with the total duration) once it has been false for
 * `clearMs`. Debounces detector noise without losing how long it lasted.
 */
export class Sustained<T = void> {
  private since: number | null = null;
  private clearSince: number | null = null;
  private active = false;
  private lastDetail: T | undefined;

  constructor(
    private readonly minMs: number,
    private readonly handlers: {
      start: (since: number, detail: T | undefined) => void;
      end: (durationMs: number, detail: T | undefined) => void;
    },
    private readonly clearMs = 500,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  update(condition: boolean, now: number, detail?: T): void {
    if (condition) {
      this.clearSince = null;
      if (detail !== undefined) this.lastDetail = detail;
      if (this.since === null) this.since = now;
      if (!this.active && now - this.since >= this.minMs) {
        this.active = true;
        this.handlers.start(this.since, this.lastDetail);
      }
      return;
    }
    if (!this.active) {
      this.since = null;
      return;
    }
    if (this.clearSince === null) this.clearSince = now;
    if (now - this.clearSince >= this.clearMs) this.finish(this.clearSince);
  }

  /** Ends an active condition immediately (e.g. when monitoring stops). */
  flush(now: number): void {
    if (this.active) this.finish(now);
    this.since = null;
  }

  private finish(endedAt: number): void {
    const duration = Math.max(0, endedAt - (this.since ?? endedAt));
    this.active = false;
    this.since = null;
    this.clearSince = null;
    this.handlers.end(duration, this.lastDetail);
    this.lastDetail = undefined;
  }
}
