import { EVENT_CATALOG, SEVERITY_RANK, type EventType } from "../catalog";
import {
  LIMITS,
  PROTOCOL_VERSION,
  TIMING,
  resyncMessage,
  type BatchRequest,
  type BatchResponse,
  type EndReason,
  type Heartbeat,
  type SessionBootstrap,
  type SessionStatus,
  type WireEvent,
} from "../protocol";
import { EventChain } from "./chain";

export interface PendingEvent {
  type: EventType;
  ts: number;
  dur?: number;
  d: string;
}

export type ConnectionState = "online" | "retrying" | "offline";

export type ClosedStatus = Exclude<SessionStatus, "active"> | "lost";

export interface TransportCallbacks {
  heartbeat(): Heartbeat;
  onClosed(status: ClosedStatus, reason: EndReason | null): void;
  onConnection(state: ConnectionState): void;
  /** Events the server has stored. */
  onDelivered(events: PendingEvent[]): void;
}

interface Inflight {
  ack: string;
  pending: PendingEvent[];
  events: WireEvent[];
  lastSeq: number;
  lastHash: string;
}

const HEADERS = { "content-type": "application/json" };

/**
 * Delivers events in order with at-least-once semantics. A batch is frozen
 * once built and retried byte-for-byte until the server acknowledges it, so
 * a lost response never forks the hash chain.
 */
export class Transport {
  private queue: PendingEvent[] = [];
  private inflight: Inflight | null = null;
  private head: { seq: number; hash: string };
  private ack: string;
  private timer: number | null = null;
  private sending = false;
  private stopped = false;
  private urgent = false;
  private lastSentAt = 0;
  private retryAt = 0;
  private failures = 0;
  private connection: ConnectionState = "online";

  private constructor(
    private readonly chain: EventChain,
    private readonly sessionId: string,
    boot: SessionBootstrap,
    private readonly cb: TransportCallbacks,
  ) {
    this.head = { seq: boot.lastSeq, hash: boot.lastHash };
    this.ack = boot.ack;
  }

  static async create(boot: SessionBootstrap, cb: TransportCallbacks): Promise<Transport> {
    return new Transport(await EventChain.create(boot.chainKey), boot.sessionId, boot, cb);
  }

  start(): void {
    this.timer = window.setInterval(() => void this.tick(), 250);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Queues an event. Answers and serious violations are sent immediately. */
  enqueue(type: EventType, data: Record<string, unknown>, ts: number, durationMs?: number, urgent = false): void {
    if (this.stopped) return;
    this.queue.push({ type, ts: Math.round(ts), dur: durationMs === undefined ? undefined : Math.round(durationMs), d: JSON.stringify(data) });
    if (urgent || (data.phase !== "end" && SEVERITY_RANK[EVENT_CATALOG[type].severity] >= SEVERITY_RANK.high)) {
      this.urgent = true;
      void this.tick();
    }
  }

  /** Sends everything queued; used before submitting the exam. */
  async drain(timeoutMs = 8_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while ((this.queue.length > 0 || this.inflight) && Date.now() < deadline && !this.stopped) {
      if (!this.sending) {
        this.retryAt = 0;
        await this.send();
      } else {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return this.queue.length === 0 && this.inflight === null;
  }

  /** Best-effort delivery while the page is being hidden or unloaded. */
  flushOnHide(): void {
    this.urgent = true;
    void this.tick(true);
  }

  private async tick(keepalive = false): Promise<void> {
    if (this.sending || this.stopped) return;
    const now = Date.now();
    if (now < this.retryAt) return;
    const sinceLast = now - this.lastSentAt;
    const due =
      this.inflight !== null ||
      (this.urgent && this.queue.length > 0) ||
      (this.queue.length > 0 && sinceLast >= TIMING.flushIntervalMs) ||
      sinceLast >= TIMING.heartbeatIntervalMs;
    if (due) await this.send(keepalive);
  }

  private async build(): Promise<Inflight> {
    const pending = this.queue.splice(0, LIMITS.maxEventsPerBatch);
    let seq = this.head.seq;
    let hash = this.head.hash;
    const events: WireEvent[] = [];
    for (const p of pending) {
      seq += 1;
      const base = { seq, type: p.type, ts: p.ts, dur: p.dur, d: p.d };
      hash = await this.chain.link(hash, base);
      events.push({ ...base, h: hash });
    }
    return { ack: this.ack, pending, events, lastSeq: seq, lastHash: hash };
  }

  private setConnection(state: ConnectionState): void {
    if (state === this.connection) return;
    this.connection = state;
    this.cb.onConnection(state);
  }

  private backoff(): void {
    this.failures += 1;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(this.failures, 5));
    this.retryAt = Date.now() + delay;
    this.setConnection(navigator.onLine ? "retrying" : "offline");
  }

  private close(status: ClosedStatus, reason: EndReason | null): void {
    this.stop();
    this.cb.onClosed(status, reason);
  }

  private async send(keepalive = false): Promise<void> {
    this.sending = true;
    try {
      this.urgent = false;
      this.inflight ??= await this.build();
      const batch = this.inflight;
      const body: BatchRequest = { v: PROTOCOL_VERSION, ack: batch.ack, sentAt: Date.now(), hb: this.cb.heartbeat(), events: batch.events };
      const payload = JSON.stringify(body);
      const res = await fetch("/api/proctor/events", {
        method: "POST",
        headers: HEADERS,
        body: payload,
        credentials: "same-origin",
        cache: "no-store",
        keepalive: keepalive && payload.length < 60_000,
      });
      this.lastSentAt = Date.now();

      if (res.ok) {
        const data = (await res.json()) as BatchResponse;
        this.head = { seq: batch.lastSeq, hash: batch.lastHash };
        this.inflight = null;
        this.failures = 0;
        this.setConnection("online");
        if (batch.pending.length > 0) this.cb.onDelivered(batch.pending);
        if (data.status !== "active") {
          this.close(data.status, data.endReason);
          return;
        }
        this.ack = data.ack;
        if (this.queue.length > 0) this.urgent = true;
        return;
      }

      if (res.status === 409) {
        await this.resync();
        return;
      }
      if (res.status === 401 || res.status === 403) {
        this.close("lost", null);
        return;
      }
      if (res.status === 410) {
        this.close("submitted", null);
        return;
      }
      if (res.status === 400 || res.status === 413) {
        // Malformed batch (client bug). Drop it rather than block monitoring;
        // the chain head is unchanged so the next batch still links correctly.
        console.error("[proctor] batch rejected", res.status, await res.text().catch(() => ""));
        this.inflight = null;
        return;
      }
      this.backoff();
    } catch {
      this.backoff();
    } finally {
      this.sending = false;
    }
  }

  /**
   * The server rejected the chain (e.g. a duplicate tab or a lost response).
   * Prove this is the original page, take the authoritative head, and re-sign
   * undelivered events on top of it. The server records both the failure and
   * the re-sync, so this cannot hide anything.
   */
  private async resync(): Promise<void> {
    try {
      const proof = await this.chain.sign(resyncMessage(this.sessionId));
      const res = await fetch("/api/proctor/session", {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ action: "resync", proof }),
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.status === 410) return this.close("submitted", null);
      if (res.status === 401 || res.status === 403) return this.close("lost", null);
      if (!res.ok) return this.backoff();
      const boot = (await res.json()) as SessionBootstrap;
      if (this.inflight) this.queue.unshift(...this.inflight.pending);
      this.inflight = null;
      this.head = { seq: boot.lastSeq, hash: boot.lastHash };
      this.ack = boot.ack;
      this.urgent = this.queue.length > 0;
    } catch {
      this.backoff();
    }
  }
}
