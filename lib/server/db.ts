import "server-only";

import pg from "pg";

import { databaseSsl, databaseUrl } from "./config";

/**
 * Postgres access. The exam app only ever writes to the `proctor` schema; the
 * one LMS table it touches, public.users, is read-only from here (see
 * lms-users.ts and auth.ts).
 *
 * The pool is small on purpose: the database is shared with the LMS.
 */

// Return BIGINT/COUNT(*) as numbers (all our values fit comfortably).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// NUMERIC (scores, percentages) as numbers.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

const globalForDb = globalThis as unknown as { __proctorPool?: pg.Pool };

export function pool(): pg.Pool {
  if (!globalForDb.__proctorPool) {
    const p = new pg.Pool({
      connectionString: databaseUrl(),
      ssl: databaseSsl(),
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: "exam-proctoring",
      // A runaway query must never hold LMS resources for long.
      statement_timeout: 15_000,
    });
    p.on("error", (error) => console.error("[proctor] idle database client error", error));
    globalForDb.__proctorPool = p;
  }
  return globalForDb.__proctorPool;
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Queryable = pool(),
): Promise<T[]> {
  const result = await client.query<T>(sql, params);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Queryable = pool(),
): Promise<T | null> {
  const rows = await query<T>(sql, params, client);
  return rows[0] ?? null;
}

/** Runs `fn` in a transaction on one connection; rolls back on any error. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Epoch milliseconds from a timestamptz column (pg returns Date). */
export function ms(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  const t = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

export function msOrThrow(value: Date | string | number): number {
  const t = ms(value);
  if (t === null) throw new Error("Invalid timestamp from database.");
  return t;
}
