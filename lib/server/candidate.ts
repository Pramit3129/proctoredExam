import "server-only";

import type { NextRequest, NextResponse } from "next/server";

import { requireUser, type AuthUser } from "./auth";
import { SESSION_COOKIE, secureCookies } from "./config";
import { ownedSession, type SessionRow } from "./sessions";

/** The signed-in candidate and the attempt bound to this browser. */
export async function requireCandidateAttempt(req: NextRequest): Promise<{ user: AuthUser; session: SessionRow }> {
  const user = await requireUser(req);
  const session = await ownedSession(user, req.cookies.get(SESSION_COOKIE)?.value);
  return { user, session };
}

export function setSessionCookie(res: NextResponse, value: string, endsAt: number): void {
  res.cookies.set(SESSION_COOKIE, value, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "strict",
    path: "/",
    expires: new Date(endsAt + 60 * 60_000),
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: secureCookies, sameSite: "strict", path: "/", maxAge: 0 });
}

export function requestMeta(req: NextRequest, ip: string): { ip: string; userAgent: string } {
  return { ip, userAgent: req.headers.get("user-agent") ?? "" };
}
