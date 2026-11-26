import type { NextRequest } from "next/server";

import { login, normaliseEmail, setAuthCookie } from "@/lib/server/auth";
import { HttpError, assertSameOrigin, clientIp, handler, isRecord, json, readJson } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";

/** Sign in with LMS credentials. */
export const POST = handler(async (req: NextRequest) => {
  assertSameOrigin(req);
  const ip = clientIp(req);
  const body = await readJson(req, 4 * 1024);
  if (!isRecord(body) || typeof body.email !== "string" || typeof body.password !== "string") {
    throw new HttpError(400, "invalid_body", "Enter your email and password.");
  }
  const email = normaliseEmail(body.email);
  if (email.length < 3 || email.length > 254 || !email.includes("@") || body.password.length === 0 || body.password.length > 200) {
    throw new HttpError(400, "invalid_body", "Enter a valid email and password.");
  }
  // Brute-force protection per account, and per client address when it is known.
  rateLimit(`login:email:${email}`, 1 / 30, 6);
  if (ip !== "direct") rateLimit(`login:ip:${ip}`, 1 / 6, 20);

  const { token, user, expiresAt } = await login(email, body.password, { ip, userAgent: req.headers.get("user-agent") ?? "" });
  const res = json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, isAdmin: user.isAdmin } });
  setAuthCookie(res, token, expiresAt);
  return res;
});
