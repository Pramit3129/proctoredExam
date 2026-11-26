import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/server/auth";
import { getAdminExam } from "@/lib/server/exams";
import { HttpError, handler, json, requireUuid } from "@/lib/server/http";
import { examResults, resultsCsv } from "@/lib/server/results";
import { sweepStaleSessions } from "@/lib/server/sessions";

export const GET = handler(async (req: NextRequest, ctx: RouteContext<"/api/admin/exams/[id]/results">) => {
  await requireAdmin(req);
  const id = requireUuid((await ctx.params).id, "exam");
  await sweepStaleSessions();
  const results = await examResults(id);
  if (req.nextUrl.searchParams.get("format") === "csv") {
    const exam = await getAdminExam(id);
    if (!exam) throw new HttpError(404, "not_found", "Exam not found.");
    return new NextResponse(resultsCsv(results), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${exam.code}-results.csv"`,
        "cache-control": "no-store",
      },
    });
  }
  return json({ results, serverTime: Date.now() });
});
