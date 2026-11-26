import type { NextRequest } from "next/server";

import { currentUser } from "@/lib/server/auth";
import { handler, json } from "@/lib/server/http";

export const GET = handler(async (req: NextRequest) => {
  const user = await currentUser(req);
  return json({ user: user ? { id: user.id, name: user.name, email: user.email, role: user.role, isAdmin: user.isAdmin } : null });
});
