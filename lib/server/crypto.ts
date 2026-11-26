import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { serverSecret } from "./config";

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString("hex");
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacHex(key: Buffer, message: string): string {
  return createHmac("sha256", key).update(message, "utf8").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function signature(value: string): string {
  return createHmac("sha256", serverSecret()).update(value, "utf8").digest("base64url");
}

/** Returns `value.signature`. */
export function signValue(value: string): string {
  return `${value}.${signature(value)}`;
}

/** Returns the original value if the signature is valid, otherwise null. */
export function verifySignedValue(signed: string | undefined | null): string | null {
  if (!signed) return null;
  const dot = signed.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  return safeEqual(sig, signature(value)) ? value : null;
}
