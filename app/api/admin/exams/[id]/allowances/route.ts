import type { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/server/auth";
import { assertSameOrigin, clientIp, handler, json, readJson, requireUuid } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { changeAllowance, listAllowances } from "@/lib/server/results";

export const GET = handler(async (req: NextRequest, ctx: RouteContext<"/api/admin/exams/[id]/allowances">) => {
  await requireAdmin(req);
  const id = requireUuid((await ctx.params).id, "exam");
  return json({ allowances: await listAllowances(id) });
});

/** Grant extra attempts: { userId, add: n } or { userId, set: n }. */
export const POST = handler(async (req: NextRequest, ctx: RouteContext<"/api/admin/exams/[id]/allowances">) => {
  assertSameOrigin(req);
  const admin = await requireAdmin(req);
  rateLimit(`admin-write:${admin.id}`, 1, 20);
  const id = requireUuid((await ctx.params).id, "exam");
  return json({ allowances: await changeAllowance(admin, id, await readJson(req, 4096), clientIp(req)) });
});
