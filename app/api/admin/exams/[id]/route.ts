import type { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/server/auth";
import { deleteExam, getAdminExam, updateExam } from "@/lib/server/exams";
import { HttpError, assertSameOrigin, clientIp, handler, json, readJson, requireUuid } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";

export const GET = handler(async (req: NextRequest, ctx: RouteContext<"/api/admin/exams/[id]">) => {
  await requireAdmin(req);
  const id = requireUuid((await ctx.params).id, "exam");
  const exam = await getAdminExam(id);
  if (!exam) throw new HttpError(404, "not_found", "Exam not found.");
  return json({ exam });
});

export const PATCH = handler(async (req: NextRequest, ctx: RouteContext<"/api/admin/exams/[id]">) => {
  assertSameOrigin(req);
  const admin = await requireAdmin(req);
  rateLimit(`admin-write:${admin.id}`, 1, 20);
  const id = requireUuid((await ctx.params).id, "exam");
  await updateExam(admin, id, await readJson(req, 2 * 1024 * 1024), clientIp(req));
  return json({ exam: await getAdminExam(id) });
});

export const DELETE = handler(async (req: NextRequest, ctx: RouteContext<"/api/admin/exams/[id]">) => {
  assertSameOrigin(req);
  const admin = await requireAdmin(req);
  const id = requireUuid((await ctx.params).id, "exam");
  await deleteExam(admin, id, clientIp(req));
  return json({ ok: true });
});
