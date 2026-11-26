-- OPTIONAL hardening. Run once as an administrator AFTER `npm run db:migrate`,
-- then point DATABASE_URL at this role instead of `postgres`.
--
-- With this role the exam app physically cannot change any LMS table: it can
-- read only the columns of public.users it needs for sign-in, and can only
-- read/write rows in the `proctor` schema (no DDL). Migrations keep running
-- as the schema owner.
--
-- Replace the password before running, and store it only in your secret manager.

CREATE ROLE exam_app LOGIN PASSWORD 'CHANGE-ME-to-a-long-random-password' NOINHERIT;

GRANT USAGE ON SCHEMA proctor TO exam_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA proctor TO exam_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA proctor TO exam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA proctor GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO exam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA proctor GRANT USAGE, SELECT ON SEQUENCES TO exam_app;

-- Row-level security is enabled on the proctor tables (with no policies) to keep
-- Supabase's API roles out. Give only this role a policy that lets it through.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'proctor' LOOP
    EXECUTE format('CREATE POLICY exam_app_all ON proctor.%I TO exam_app USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Read-only access to exactly the LMS user columns used for sign-in and lookups.
GRANT USAGE ON SCHEMA public TO exam_app;
GRANT SELECT (id, email, first_name, last_name, password, role, is_active, deleted_at, email_verified_at)
  ON public.users TO exam_app;
