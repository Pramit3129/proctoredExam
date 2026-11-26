import type { NextRequest } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { requestMeta, requireCandidateAttempt, setSessionCookie } from "@/lib/server/candidate";
import { HttpError, assertSameOrigin, clientIp, handler, isRecord, json, readJson } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { resyncSession, startSession } from "@/lib/server/sessions";

/** Start an attempt, or re-synchronise the one running in this exam page. */
export const POST = handler(async (req: NextRequest) => {
  assertSameOrigin(req);
  const ip = clientIp(req);
  const body = await readJson(req, 16 * 1024);
  if (!isRecord(body)) throw new HttpError(400, "invalid_body", "Expected an object.");

  if (body.action === "resync") {
    const { user, session } = await requireCandidateAttempt(req);
    rateLimit(`resync:${session.id}`, 0.2, 5);
    return json(await resyncSession(user, session, body, requestMeta(req, ip)));
  }

  if (body.action === "start") {
    const user = await requireUser(req);
    rateLimit(`start:${user.id}`, 0.1, 5);
    const { bootstrap, cookie, endsAt } = await startSession(user, body, requestMeta(req, ip));
    const res = json(bootstrap, 201);
    setSessionCookie(res, cookie, endsAt);
    return res;
  }

  throw new HttpError(400, "invalid_body", "Unknown action.");
});
