import type { NextRequest } from "next/server";

import { requireAdmin } from "@/lib/server/auth";
import { handler, json } from "@/lib/server/http";
import { rateLimit } from "@/lib/server/rate-limit";
import { searchLmsUsers } from "@/lib/server/results";

/** Look up LMS users by name or email (read-only). */
export const GET = handler(async (req: NextRequest) => {
  const admin = await requireAdmin(req);
  rateLimit(`admin-search:${admin.id}`, 3, 15);
  return json({ users: await searchLmsUsers(req.nextUrl.searchParams.get("q") ?? "") });
});
