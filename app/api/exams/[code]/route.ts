import type { NextRequest } from "next/server";

import { requireUser } from "@/lib/server/auth";
import { getStudentExam } from "@/lib/server/exams";
import { HttpError, handler, json } from "@/lib/server/http";
import { sweepStaleSessions } from "@/lib/server/sessions";

export const GET = handler(async (req: NextRequest, ctx: RouteContext<"/api/exams/[code]">) => {
  const user = await requireUser(req);
  const { code } = await ctx.params;
  await sweepStaleSessions();
  const exam = await getStudentExam(user, code.toUpperCase());
  if (!exam) throw new HttpError(404, "not_found", "This exam doesn't exist or isn't available.");
  return json({ exam, user: { name: user.name, email: user.email }, serverTime: Date.now() });
});
