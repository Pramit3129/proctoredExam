import "server-only";

import { unstable_rethrow } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";

import { allowedOrigins, trustProxy } from "./config";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const NO_STORE = { "cache-control": "no-store, max-age=0" };

export function json<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status, headers: NO_STORE });
}

export function errorResponse(error: unknown): NextResponse {
  if (error instanceof HttpError) {
    return json({ error: error.code, message: error.message }, error.status);
  }
  const pgCode = (error as { code?: unknown } | null)?.code;
  if (pgCode === "23505") return json({ error: "conflict", message: "That record already exists." }, 409);
  console.error("[proctor] unhandled API error", error);
  return json({ error: "internal_error", message: "Unexpected server error." }, 500);
}

/** Wrap a route handler so HttpErrors become JSON responses. */
export function handler<A extends unknown[]>(
  fn: (...args: A) => Promise<Response> | Response,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (error) {
      // Let Next.js control-flow errors (e.g. prerender bail-out on request.cookies) propagate.
      unstable_rethrow(error);
      return errorResponse(error);
    }
  };
}

/**
 * CSRF defence for state-changing requests: the browser-supplied Origin must
 * match this host (or an explicitly allowed origin). Cookies are also
 * SameSite=Strict, so this is a second, independent layer.
 */
export function assertSameOrigin(req: NextRequest): void {
  const origin = req.headers.get("origin");
  if (!origin) throw new HttpError(403, "bad_origin", "Missing Origin header.");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, "bad_origin", "Malformed Origin header.");
  }
  const host = req.headers.get("x-forwarded-host") && trustProxy
    ? req.headers.get("x-forwarded-host")
    : req.headers.get("host");
  if (originHost === host) return;
  if (allowedOrigins().includes(origin)) return;
  throw new HttpError(403, "bad_origin", "Cross-origin request rejected.");
}

async function readBodyBytes(req: NextRequest, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new HttpError(413, "too_large", "Request body too large.");
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "too_large", "Request body too large.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function readJson(req: NextRequest, maxBytes: number): Promise<unknown> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Expected application/json.");
  }
  const bytes = await readBodyBytes(req, maxBytes);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "bad_json", "Malformed JSON body.");
  }
}

export async function readBinary(req: NextRequest, maxBytes: number): Promise<Uint8Array> {
  return readBodyBytes(req, maxBytes);
}

/** Reads a multipart/form-data body with a hard size cap (enforced while streaming). */
export async function readForm(req: NextRequest, maxBytes: number): Promise<FormData> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) {
    throw new HttpError(415, "unsupported_media_type", "Expected multipart/form-data.");
  }
  const bytes = await readBodyBytes(req, maxBytes);
  try {
    return await new Response(bytes as BodyInit, { headers: { "content-type": type } }).formData();
  } catch {
    throw new HttpError(400, "bad_form", "Malformed form upload.");
  }
}

export function clientIp(req: NextRequest): string {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",")[0]!.trim();
    const real = req.headers.get("x-real-ip");
    if (real) return real;
  }
  return "direct";
}

// ── Small validation helpers (no schema library dependency) ─────────────────

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function requireString(
  obj: Record<string, unknown>,
  key: string,
  { max, min = 1, pattern }: { max: number; min?: number; pattern?: RegExp },
): string {
  const value = obj[key];
  if (typeof value !== "string") throw new HttpError(400, "invalid_body", `${key} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw new HttpError(400, "invalid_body", `${key} must be ${min}-${max} characters.`);
  }
  if (pattern && !pattern.test(trimmed)) {
    throw new HttpError(400, "invalid_body", `${key} has an invalid format.`);
  }
  return trimmed;
}

export function isFiniteInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

/** Optional trimmed string; empty becomes null. */
export function optionalString(obj: Record<string, unknown>, key: string, max: number): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "invalid_body", `${key} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, "invalid_body", `${key} must be at most ${max} characters.`);
  return trimmed || null;
}

export function requireInt(obj: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = obj[key];
  if (!isFiniteInt(value) || value < min || value > max) {
    throw new HttpError(400, "invalid_body", `${key} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

export function optionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, "invalid_body", `${key} must be true or false.`);
  return value;
}

/** Optional ISO date-time or epoch ms; returns epoch ms or null. */
export function optionalTimestamp(obj: Record<string, unknown>, key: string): number | null {
  const value = obj[key];
  if (value === undefined || value === null || value === "") return null;
  const t = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) throw new HttpError(400, "invalid_body", `${key} must be a date and time.`);
  return t;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function requireUuid(value: unknown, what = "id"): string {
  if (!isUuid(value)) throw new HttpError(404, "not_found", `Unknown ${what}.`);
  return value.toLowerCase();
}
