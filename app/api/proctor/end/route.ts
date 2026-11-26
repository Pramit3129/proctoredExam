import type { NextRequest } from "next/server";

import { clearSessionCookie, requireCandidateAttempt } from "@/lib/server/candidate";
import { assertSameOrigin, handler, json, readJson } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { endSession } from "@/lib/server/sessions";

/** Close the attempt. The server grades the answers it already holds; the result is not returned. */
export const POST = handler(async (req: NextRequest) => {
  assertSameOrigin(req);
  const { session } = await requireCandidateAttempt(req);
  rateLimit(`end:${session.id}`, 0.5, 5);
  const body = await readJson(req, 1024);
  const res = json(await endSession(session, body));
  clearSessionCookie(res);
  return res;
});
