#!/usr/bin/env node
/**
 * LOCAL DEVELOPMENT ONLY. Creates a stand-in for the LMS `public.users` table
 * (same columns the exam app reads) and a few test accounts, so the app can be
 * exercised end to end without real LMS credentials.
 *
 *   DATABASE_URL=postgresql://postgres@localhost:55432/lms_dev node scripts/seed-dev.mjs
 *
 * Refuses to run against anything but localhost, so it can never write to the
 * shared LMS database.
 *
 * Test accounts (all share the password below):
 *   admin@example.test     role admin
 *   student1@example.test  role student
 *   student2@example.test  role student
 *   inactive@example.test  role student, is_active = false (login must fail)
 */
import bcrypt from "bcryptjs";
import pg from "pg";

const TEST_PASSWORD = "Exam-Dev-Password-1";

const url = process.env.DATABASE_URL ?? "";
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
})();
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
  console.error(`Refusing to seed ${host || "an unknown host"}: this script only runs against a local database.`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS public.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name text NOT NULL,
    last_name text NOT NULL,
    email text NOT NULL,
    password text NOT NULL,
    phone text,
    role text NOT NULL DEFAULT 'student',
    is_active boolean NOT NULL DEFAULT true,
    refresh_token text,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    email_verified_at timestamptz
  )`);
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON public.users (lower(email))");
  const hash = bcrypt.hashSync(TEST_PASSWORD, 10);
  const users = [
    ["Ada", "Admin", "admin@example.test", "admin", true],
    ["Sam", "Student", "student1@example.test", "student", true],
    ["Riya", "Sharma", "student2@example.test", "student", true],
    ["Ivan", "Inactive", "inactive@example.test", "student", false],
  ];
  for (const [first, last, email, role, active] of users) {
    await client.query(
      `INSERT INTO public.users (first_name, last_name, email, password, role, is_active, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (lower(email)) DO UPDATE SET password = EXCLUDED.password, role = EXCLUDED.role, is_active = EXCLUDED.is_active`,
      [first, last, email, hash, role, active],
    );
  }
  console.log(`Seeded ${users.length} local test users.`);
} finally {
  await client.end();
}
