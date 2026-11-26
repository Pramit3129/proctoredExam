import type { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/server/auth";
import { createExam, listAdminExams } from "@/lib/server/exams";
import { assertSameOrigin, clientIp, handler, json, readJson } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";

export const GET = handler(async (req: NextRequest) => {
  await requireAdmin(req);
  const archived = req.nextUrl.searchParams.get("archived") === "1";
  return json({ exams: await listAdminExams(archived) });
});

export const POST = handler(async (req: NextRequest) => {
  assertSameOrigin(req);
  const admin = await requireAdmin(req);
  rateLimit(`admin-write:${admin.id}`, 1, 20);
  const body = await readJson(req, 2 * 1024 * 1024);
  return json(await createExam(admin, body, clientIp(req)), 201);
});
