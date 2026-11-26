import type { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/server/auth";
import { HttpError, assertSameOrigin, clientIp, handler, json } from "@/lib/server/http";
import { terminateSession } from "@/lib/server/sessions";

export const POST = handler(async (req: NextRequest, ctx: RouteContext<"/api/admin/attempts/[id]/terminate">) => {
  assertSameOrigin(req);
  const admin = await requireAdmin(req);
  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new HttpError(404, "not_found", "Attempt not found.");
  return json({ status: await terminateSession(admin, id, clientIp(req)) });
});
