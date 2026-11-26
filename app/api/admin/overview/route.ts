import type { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/server/auth";
import { listAdminExams } from "@/lib/server/exams";
import { handler, json } from "@/lib/server/http";
import { liveAttempts, recentAttempts } from "@/lib/server/results";
import { sweepStaleSessions } from "@/lib/server/sessions";

export const GET = handler(async (req: NextRequest) => {
  await requireAdmin(req);
  await sweepStaleSessions();
  const [exams, live, recent] = await Promise.all([listAdminExams(), liveAttempts(), recentAttempts(12)]);
  return json({ exams, live, recent, serverTime: Date.now() });
});
