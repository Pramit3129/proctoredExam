#!/usr/bin/env node
/**
 * Applies db/migrations/*.sql to the `proctor` schema, in order, once each.
 *
 *   npm run db:migrate            apply pending migrations
 *   npm run db:migrate -- --status list applied and pending migrations
 *
 * Bookkeeping lives in proctor.schema_migrations, never in public.schema_migrations
 * (that table belongs to the LMS's own migration tool). Each file runs in its own
 * transaction under an advisory lock, so two deploys cannot apply it twice.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir = path.join(root, "db", "migrations");
const statusOnly = process.argv.includes("--status");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Run with: node --env-file=.env.local scripts/migrate.mjs");
  process.exit(1);
}

function sslConfig() {
  if (process.env.DATABASE_SSL === "disable") return false;
  const ca = process.env.DATABASE_CA_CERT;
  if (ca) return { ca: ca.includes("BEGIN CERTIFICATE") ? ca : fs.readFileSync(ca, "utf8"), rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

const client = new pg.Client({ connectionString: url, ssl: sslConfig(), application_name: "exam-proctoring-migrate" });
const LOCK_KEY = 7_340_201; // arbitrary, constant advisory-lock key for this app's migrations

const files = fs
  .readdirSync(dir)
  .filter((f) => /^\d+_[a-z0-9_]+\.sql$/.test(f))
  .sort();

await client.connect();
try {
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  await client.query("CREATE SCHEMA IF NOT EXISTS proctor");
  await client.query(`CREATE TABLE IF NOT EXISTS proctor.schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  await client.query("ALTER TABLE proctor.schema_migrations ENABLE ROW LEVEL SECURITY");
  await client.query("REVOKE ALL ON proctor.schema_migrations FROM PUBLIC");

  const { rows } = await client.query("SELECT version FROM proctor.schema_migrations");
  const applied = new Set(rows.map((r) => r.version));
  const pending = files.filter((f) => !applied.has(f));

  if (statusOnly) {
    for (const f of files) console.log(`${applied.has(f) ? "applied" : "pending"}  ${f}`);
  } else if (pending.length === 0) {
    console.log("Database is up to date.");
  } else {
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      process.stdout.write(`Applying ${file} … `);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO proctor.schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log("done");
      } catch (error) {
        await client.query("ROLLBACK");
        console.log("failed");
        throw error;
      }
    }
  }
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
  await client.end();
}
