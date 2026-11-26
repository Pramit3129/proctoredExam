import type { NextRequest } from "next/server";

import { LIMITS } from "@/lib/proctor/protocol";
import { requireCandidateAttempt } from "@/lib/server/candidate";
import { assertSameOrigin, handler, json, readJson } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { ingestBatch } from "@/lib/server/sessions";

/** Hash-chained event batches (answers and proctoring signals); every batch is also a heartbeat. */
export const POST = handler(async (req: NextRequest) => {
  assertSameOrigin(req);
  const { session } = await requireCandidateAttempt(req);
  rateLimit(`events:${session.id}`, 4, 20);
  const body = await readJson(req, LIMITS.maxBatchBytes);
  return json(await ingestBatch(session, body));
});
