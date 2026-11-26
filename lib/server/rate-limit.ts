import "server-only";

import { HttpError } from "./http";

/**
 * In-process token bucket. Good enough for a single instance; replace with a
 * shared store (Redis) when running several instances.
 */
interface Bucket {
  tokens: number;
  updatedAt: number;
}

const globalForLimits = globalThis as unknown as { __proctorBuckets?: Map<string, Bucket> };
const buckets = (globalForLimits.__proctorBuckets ??= new Map<string, Bucket>());

export function rateLimit(key: string, perSecond: number, burst: number): void {
  const now = Date.now();
  if (buckets.size > 50_000) {
    for (const [k, b] of buckets) if (now - b.updatedAt > 10 * 60_000) buckets.delete(k);
  }
  const bucket = buckets.get(key) ?? { tokens: burst, updatedAt: now };
  bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.updatedAt) / 1000) * perSecond);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    throw new HttpError(429, "rate_limited", "Too many requests. Slow down.");
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
}
