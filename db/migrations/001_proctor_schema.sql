-- Exam proctoring: everything lives in its own schema so the LMS tables in
-- `public` are never altered. LMS users are referenced by id only, with no
-- foreign keys, so nothing here can block or cascade into LMS writes.

CREATE SCHEMA IF NOT EXISTS proctor;

-- ── Exams ─────────────────────────────────────────────────────────────────

CREATE TABLE proctor.exams (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{2,39}$'),
  title              text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  subtitle           text CHECK (char_length(subtitle) <= 200),
  description        text CHECK (char_length(description) <= 4000),
  instructions       text CHECK (char_length(instructions) <= 4000),
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'archived')),
  duration_minutes   integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 600),
  max_attempts       integer NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 20),
  pass_percent       numeric(5, 2) CHECK (pass_percent BETWEEN 0 AND 100),
  shuffle_questions  boolean NOT NULL DEFAULT false,
  shuffle_options    boolean NOT NULL DEFAULT false,
  -- Also submit when the page is hidden (another tab or app), not only on fullscreen exit.
  strict_focus       boolean NOT NULL DEFAULT true,
  opens_at           timestamptz,
  closes_at          timestamptz,
  question_count     integer NOT NULL DEFAULT 0,
  total_points       numeric(10, 2) NOT NULL DEFAULT 0,
  source             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by         uuid NOT NULL,
  created_by_name    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at)
);

CREATE TABLE proctor.questions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id      uuid NOT NULL REFERENCES proctor.exams (id) ON DELETE CASCADE,
  position     integer NOT NULL,
  number       integer NOT NULL,
  section      text,
  prompt       text NOT NULL,
  options      jsonb NOT NULL CHECK (jsonb_typeof(options) = 'array'),
  correct_key  text NOT NULL CHECK (correct_key ~ '^[A-H]$'),
  explanation  text,
  points       numeric(6, 2) NOT NULL DEFAULT 1 CHECK (points > 0),
  UNIQUE (exam_id, position)
);
CREATE INDEX questions_exam ON proctor.questions (exam_id, position);

-- Extra attempts granted by an admin on top of exams.max_attempts.
CREATE TABLE proctor.attempt_allowances (
  exam_id         uuid NOT NULL REFERENCES proctor.exams (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  extra_attempts  integer NOT NULL DEFAULT 0 CHECK (extra_attempts BETWEEN 0 AND 50),
  note            text,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (exam_id, user_id)
);

-- ── Attempts (proctored sessions) ─────────────────────────────────────────

CREATE TABLE proctor.sessions (
  id                text PRIMARY KEY,
  exam_id           uuid NOT NULL REFERENCES proctor.exams (id),
  user_id           uuid NOT NULL,
  user_email        text NOT NULL,
  user_name         text NOT NULL,
  attempt_no        integer NOT NULL CHECK (attempt_no >= 1),
  status            text NOT NULL CHECK (status IN ('active', 'submitted', 'auto_submitted', 'expired', 'terminated')),
  end_reason        text,
  started_at        timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  ended_at          timestamptz,
  last_seen_at      timestamptz NOT NULL,
  -- Event-chain state (see lib/proctor/protocol.ts).
  chain_key         text NOT NULL,
  last_seq          integer NOT NULL DEFAULT 0,
  last_hash         text NOT NULL,
  ack_token         text NOT NULL,
  prev_ack_token    text,
  prev_batch_count  integer NOT NULL DEFAULT 0,
  clock_offset_ms   bigint,
  stall_count       integer NOT NULL DEFAULT 0,
  resync_count      integer NOT NULL DEFAULT 0,
  risk_score        integer NOT NULL DEFAULT 0,
  flag_count        integer NOT NULL DEFAULT 0,
  question_order    uuid[] NOT NULL,
  option_order      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip                text,
  user_agent        text,
  client_info       jsonb,
  -- Result, computed on the server when the attempt closes. Never sent to candidates.
  score             numeric(10, 2),
  max_score         numeric(10, 2),
  correct_count     integer,
  incorrect_count   integer,
  unanswered_count  integer,
  percent           numeric(5, 2),
  passed            boolean,
  graded_at         timestamptz,
  UNIQUE (exam_id, user_id, attempt_no)
);
CREATE UNIQUE INDEX sessions_one_active ON proctor.sessions (exam_id, user_id) WHERE status = 'active';
CREATE INDEX sessions_exam ON proctor.sessions (exam_id, started_at DESC);
CREATE INDEX sessions_user ON proctor.sessions (user_id, exam_id);
CREATE INDEX sessions_open ON proctor.sessions (last_seen_at) WHERE status = 'active';

CREATE TABLE proctor.answers (
  session_id   text NOT NULL REFERENCES proctor.sessions (id) ON DELETE CASCADE,
  question_id  uuid NOT NULL REFERENCES proctor.questions (id) ON DELETE CASCADE,
  option_key   text NOT NULL CHECK (option_key ~ '^[A-H]$'),
  answered_at  timestamptz NOT NULL,
  changes      integer NOT NULL DEFAULT 1,
  PRIMARY KEY (session_id, question_id)
);

-- Every interaction and proctoring signal, with client and server timestamps.
CREATE TABLE proctor.events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id   text NOT NULL REFERENCES proctor.sessions (id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN ('client', 'server')),
  seq          integer,
  type         text NOT NULL,
  category     text NOT NULL,
  severity     text NOT NULL CHECK (severity IN ('info', 'low', 'medium', 'high', 'critical')),
  phase        text CHECK (phase IN ('start', 'end')),
  client_ts    bigint,
  server_ts    timestamptz NOT NULL,
  duration_ms  integer,
  data         jsonb NOT NULL,
  hash         text,
  risk_points  integer NOT NULL DEFAULT 0
);
CREATE INDEX events_session ON proctor.events (session_id, id);
CREATE UNIQUE INDEX events_session_seq ON proctor.events (session_id, seq) WHERE seq IS NOT NULL;
CREATE INDEX events_flags ON proctor.events (session_id, id) WHERE severity IN ('medium', 'high', 'critical');

-- ── Sign-in sessions and audit ────────────────────────────────────────────

-- Opaque cookie tokens are stored hashed; a database leak does not reveal live tokens.
CREATE TABLE proctor.auth_sessions (
  token_hash    text PRIMARY KEY,
  user_id       uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_used_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  ip            text,
  user_agent    text
);
CREATE INDEX auth_sessions_user ON proctor.auth_sessions (user_id);
CREATE INDEX auth_sessions_expiry ON proctor.auth_sessions (expires_at);

CREATE TABLE proctor.audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id     uuid,
  actor_email  text,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_created ON proctor.audit_log (created_at DESC);

-- ── Lock the schema down ──────────────────────────────────────────────────
-- Only the server (connecting as the schema owner) may touch these tables.
-- Supabase's API roles get nothing, and RLS with no policies is a second wall
-- in case a grant is ever added by mistake.

ALTER TABLE proctor.exams              ENABLE ROW LEVEL SECURITY;
ALTER TABLE proctor.questions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE proctor.attempt_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE proctor.sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE proctor.answers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE proctor.events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE proctor.auth_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE proctor.audit_log          ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA proctor FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA proctor FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA proctor FROM PUBLIC;

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA proctor FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA proctor FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA proctor FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA proctor REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA proctor REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END $$;
