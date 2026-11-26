import "server-only";

import { randomBytes } from "node:crypto";
import fs from "node:fs";

const isProd = process.env.NODE_ENV === "production";

let devSecret: string | null = null;

/** Secret used to sign the exam-session cookie. */
export function serverSecret(): string {
  const secret = process.env.PROCTOR_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (isProd) {
    throw new Error("PROCTOR_SECRET must be set to at least 32 characters in production.");
  }
  if (!devSecret) {
    devSecret = randomBytes(32).toString("hex");
    console.warn(
      "[proctor] PROCTOR_SECRET is not set; using a random development secret. Exam sessions will not survive a server restart.",
    );
  }
  return devSecret;
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  return url;
}

/**
 * TLS for the database connection. Supabase serves its own CA; set
 * DATABASE_CA_CERT (PEM text or a file path) to verify the server certificate.
 * Without it the connection is still encrypted but not authenticated.
 */
export function databaseSsl(): false | { ca?: string; rejectUnauthorized: boolean } {
  if (process.env.DATABASE_SSL === "disable") return false;
  const ca = process.env.DATABASE_CA_CERT;
  if (ca) return { ca: ca.includes("BEGIN CERTIFICATE") ? ca : fs.readFileSync(ca, "utf8"), rejectUnauthorized: true };
  if (isProd) console.warn("[proctor] DATABASE_CA_CERT is not set; the database certificate is not verified.");
  return { rejectUnauthorized: false };
}

/** LMS roles (public.users.role) allowed into the admin dashboard. */
export function adminRoles(): string[] {
  const roles = (process.env.PROCTOR_ADMIN_ROLES ?? "admin")
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  return roles.length > 0 ? roles : ["admin"];
}

/** Require public.users.email_verified_at before a user may sign in. */
export const requireVerifiedEmail = process.env.PROCTOR_REQUIRE_VERIFIED_EMAIL === "1";

/** Cookies are Secure unless explicitly running over plain http. */
export const secureCookies = isProd && process.env.PROCTOR_INSECURE_COOKIES !== "1";

/** Signed-in user (opaque token, stored hashed in proctor.auth_sessions). */
export const AUTH_COOKIE = secureCookies ? "__Host-exam_auth" : "exam_auth";
/** The proctored attempt bound to this browser tab. */
export const SESSION_COOKIE = secureCookies ? "__Host-proctor_sid" : "proctor_sid";

export const AUTH_TTL_MS = 12 * 60 * 60_000;

/**
 * Extra origins allowed to call the API (comma separated), e.g. when the app
 * sits behind a proxy that rewrites the Host header.
 */
export function allowedOrigins(): string[] {
  return (process.env.PROCTOR_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Trust X-Forwarded-For only when explicitly told the app is behind a proxy. */
export const trustProxy = process.env.PROCTOR_TRUST_PROXY === "1";
