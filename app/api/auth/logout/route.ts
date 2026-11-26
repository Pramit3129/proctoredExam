import type { NextRequest } from "next/server";

import { clearAuthCookie, logout } from "@/lib/server/auth";
import { clearSessionCookie } from "@/lib/server/candidate";
import { assertSameOrigin, handler, json } from "@/lib/server/http";

export const POST = handler(async (req: NextRequest) => {
  assertSameOrigin(req);
  await logout(req);
  const res = json({ ok: true });
  clearAuthCookie(res);
  clearSessionCookie(res);
  return res;
});
