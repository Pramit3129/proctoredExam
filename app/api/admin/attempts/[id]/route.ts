import type { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/server/auth";
import { HttpError, handler, json } from "@/lib/server/http";
import { attemptDetail } from "@/lib/server/results";
import { sweepStaleSessions } from "@/lib/server/sessions";

export const GET = handler(async (req: NextRequest, ctx: RouteContext<"/api/admin/attempts/[id]">) => {
  await requireAdmin(req);
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new HttpError(404, "not_found", "Attempt not found.");
  await sweepStaleSessions();
  const detail = await attemptDetail(id);
  if (!detail) throw new HttpError(404, "not_found", "Attempt not found.");
  return json({ ...detail, serverTime: Date.now() });
});
