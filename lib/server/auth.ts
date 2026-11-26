import "server-only";

import bcrypt from "bcryptjs";
import type { NextRequest, NextResponse } from "next/server";

import { audit } from "./audit";
import { AUTH_COOKIE, AUTH_TTL_MS, adminRoles, requireVerifiedEmail, secureCookies } from "./config";
import { randomToken, sha256Hex } from "./crypto";
import { query, queryOne } from "./db";
import { HttpError } from "./http";

/**
 * Sign-in uses the LMS accounts directly (public.users, bcrypt hashes), so
 * students and admins use the same email and password everywhere. The LMS
 * table is only ever read. Our own sign-in sessions live in
 * proctor.auth_sessions and are re-validated against public.users on every
 * request, so deactivating or deleting a user in the LMS locks them out here
 * immediately.
 */

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  role: string;
  isAdmin: boolean;
}

interface UserRow {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: string;
}

// Compared against when the email is unknown, so response time does not reveal
// which emails have accounts. Cost 10 matches the LMS hashes.
let dummyHash: string | null = null;
function getDummyHash(): string {
  dummyHash ??= bcrypt.hashSync(randomToken(16), 10);
  return dummyHash;
}

function toAuthUser(row: UserRow): AuthUser {
  const firstName = row.first_name?.trim() ?? "";
  const lastName = row.last_name?.trim() ?? "";
  return {
    id: row.id,
    email: row.email,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim() || row.email,
    role: row.role,
    isAdmin: adminRoles().includes(row.role.toLowerCase()),
  };
}

export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

export async function login(
  emailInput: string,
  password: string,
  meta: { ip: string; userAgent: string },
): Promise<{ token: string; user: AuthUser; expiresAt: number }> {
  const email = normaliseEmail(emailInput);
  const row = await queryOne<
    UserRow & { password: string; is_active: boolean; deleted_at: Date | null; email_verified_at: Date | null }
  >(
    `SELECT id, email, first_name, last_name, role, password, is_active, deleted_at, email_verified_at
       FROM public.users WHERE lower(email) = $1 LIMIT 1`,
    [email],
  );
  const realHash = typeof row?.password === "string" && /^\$2[aby]\$\d{2}\$/.test(row.password) ? row.password : null;
  const matches = await bcrypt.compare(password, realHash ?? getDummyHash());
  const allowed =
    !!row && matches && realHash !== null && row.is_active && row.deleted_at === null && (!requireVerifiedEmail || row.email_verified_at !== null);

  if (!allowed) {
    await audit(row ? { id: row.id, email: row.email } : null, "auth.login_failed", {}, { email: email.slice(0, 254) }, meta.ip);
    throw new HttpError(401, "invalid_credentials", "That email and password don't match an active account.");
  }

  const token = randomToken(32);
  const expiresAt = Date.now() + AUTH_TTL_MS;
  await query(
    `INSERT INTO proctor.auth_sessions (token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5)`,
    [sha256Hex(token), row.id, expiresAt, meta.ip, meta.userAgent.slice(0, 512)],
  );
  // Housekeeping: drop long-expired sign-ins for this user.
  await query("DELETE FROM proctor.auth_sessions WHERE user_id = $1 AND expires_at < now() - interval '7 days'", [row.id]);
  const user = toAuthUser(row);
  await audit({ id: user.id, email: user.email }, "auth.login", {}, { role: user.role }, meta.ip);
  return { token, user, expiresAt };
}

export async function logout(req: NextRequest): Promise<void> {
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  if (!token || token.length > 128) return;
  await query("UPDATE proctor.auth_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [sha256Hex(token)]);
}

export async function currentUser(req: NextRequest): Promise<AuthUser | null> {
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  if (!token || token.length > 128) return null;
  const row = await queryOne<UserRow & { stale: boolean }>(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.role,
            s.last_used_at < now() - interval '5 minutes' AS stale
       FROM proctor.auth_sessions s
       JOIN public.users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.is_active
        AND u.deleted_at IS NULL
        ${requireVerifiedEmail ? "AND u.email_verified_at IS NOT NULL" : ""}`,
    [sha256Hex(token)],
  );
  if (!row) return null;
  if (row.stale) {
    // Sliding expiry while in use (so a long exam never outlives its sign-in), capped at 24 h from sign-in.
    await query(
      `UPDATE proctor.auth_sessions
          SET last_used_at = now(),
              expires_at = LEAST(created_at + interval '24 hours', GREATEST(expires_at, now() + interval '11 hours'))
        WHERE token_hash = $1`,
      [sha256Hex(token)],
    );
  }
  return toAuthUser(row);
}

export async function requireUser(req: NextRequest): Promise<AuthUser> {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, "unauthenticated", "Please sign in again.");
  return user;
}

export async function requireAdmin(req: NextRequest): Promise<AuthUser> {
  const user = await requireUser(req);
  if (!user.isAdmin) throw new HttpError(403, "forbidden", "This area is for administrators.");
  return user;
}

export function setAuthCookie(res: NextResponse, token: string, expiresAt: number): void {
  res.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies,
    // Lax so links from the LMS arrive signed in; every state change also checks Origin.
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearAuthCookie(res: NextResponse): void {
  res.cookies.set(AUTH_COOKIE, "", { httpOnly: true, secure: secureCookies, sameSite: "lax", path: "/", maxAge: 0 });
}
