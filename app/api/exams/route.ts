import type { NextRequest } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { listStudentExams } from "@/lib/server/exams";
import { handler, json } from "@/lib/server/http";
import { sweepStaleSessions } from "@/lib/server/sessions";

/** Exams the signed-in user can see, with their attempt counts. Never includes scores. */
export const GET = handler(async (req: NextRequest) => {
  const user = await requireUser(req);
  await sweepStaleSessions();
  return json({ exams: await listStudentExams(user), serverTime: Date.now() });
});
