import "server-only";

import { query, type Queryable } from "./db";

export interface Actor {
  id: string;
  email: string;
}

/** Append-only record of administrative actions and sign-ins. */
export async function audit(
  actor: Actor | null,
  action: string,
  target: { type?: string; id?: string } = {},
  details: Record<string, unknown> = {},
  ip: string | null = null,
  client?: Queryable,
): Promise<void> {
  await query(
    `INSERT INTO proctor.audit_log (actor_id, actor_email, action, target_type, target_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor?.id ?? null, actor?.email ?? null, action, target.type ?? null, target.id ?? null, JSON.stringify(details), ip],
    client,
  );
}
