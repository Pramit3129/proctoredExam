# Exams

Proctored online exams on Next.js 16, sharing users and the database with the LMS.

- **Students** sign in with their LMS email and password, see published exams, and take them in a locked, full-screen, camera-monitored room. When they finish they see a thank-you page, never a score.
- **Admins** (LMS `role = 'admin'`) create exams by uploading a question-paper PDF and its answer-key PDF, review the parsed result, publish, watch live attempts, read results and the proctoring timeline for every attempt, export CSV, and grant extra attempts.

| Area | URL |
| --- | --- |
| Sign in | `/login` |
| Student home | `/` |
| Take an exam | `/exam/<CODE>` |
| Admin dashboard | `/admin` |

## Setup

```bash
cp .env.example .env.local      # set DATABASE_URL and PROCTOR_SECRET
npm install
npm run db:migrate              # creates the `proctor` schema (idempotent)
npm run dev
```

Requires Node 22.13+.

## The database is shared with the LMS

Everything this app stores lives in its own **`proctor`** schema. It never alters or writes LMS tables:

- `public.users` is **read only**, for sign-in (bcrypt hashes) and the admin's user search. Deactivating or deleting a user in the LMS locks them out here on their next request.
- Nothing in `proctor` has a foreign key to LMS tables, so it can never block or cascade into LMS writes.
- Migrations are tracked in `proctor.schema_migrations`, separate from the LMS's own `public.schema_migrations`.
- Row-level security is enabled on every `proctor` table and Supabase's `anon` / `authenticated` / `service_role` have no grants, so the Supabase Data API cannot reach exam data or answer keys.
- For defence in depth, run `db/least-privilege.sql` to create an `exam_app` role that can only read those `public.users` columns and read/write `proctor` rows. Then use it in `DATABASE_URL`.

| Table | Holds |
| --- | --- |
| `exams`, `questions` | Exam settings and questions (answer key and explanations included; never sent to students) |
| `sessions` | One row per attempt: status, end reason, timing, device info, and the server-computed result |
| `answers` | Latest answer per question per attempt, with change count and time |
| `events` | Every interaction and proctoring signal, with client and server timestamps, severity and risk points |
| `attempt_allowances` | Extra attempts an admin granted to a user |
| `auth_sessions`, `audit_log` | Hashed sign-in tokens; sign-ins and admin actions |

## Question paper and answer key format

The parser (`lib/exam-import/parse.ts`) reads text and indentation from the PDFs. It matches the CPH sample layout and the common variants:

**Question paper**: `1.` / `1)` / `Q1.` numbered questions whose text may wrap; `A.` `B.` `C.` `D.` options (also `A)`, `(a)`, or several on one line), up to H; Roman-numeral statements (`I.`, `II.`…) kept as lines; `Set 1` / `Section A` / `Part 2` headings; optional `Answer: C` lines. Running headers, footers and page numbers are removed. The largest text before question 1 becomes the title; the next short line is the subtitle.

**Answer key**: a grid (`1. C 2. D 3. B …`), explanations (`1. C - Because…`, wrapping allowed), or both, in which case they are cross-checked. `1-C`, `1: C` and `1) (C)` also work.

Nothing is saved until the admin reviews the preview. Errors (missing answers, an answer that isn't an option, a grid/explanation mismatch, a question with fewer than 2 options) are shown per question, and the admin can click an option to set the correct answer. Scanned (image-only) PDFs are rejected with a clear message.

## Exam rules (enforced on the server)

- **One attempt** per student unless the exam allows more or an admin grants extra (Exam → Attempts, or "Allow another" on a result row). Starting is serialised per user, so double-clicks cannot create two attempts.
- **Full screen is mandatory.** The exam starts only once full screen is active. Leaving it (Esc, or switching tabs, which exits full screen) **submits immediately** and uses up the attempt. In Chrome/Edge a single Esc tap is captured by the Keyboard Lock API; holding Esc still exits.
- **Strict focus** (on by default, per exam): hiding the page (another app, minimising, locking the screen) also submits.
- **Closing or reloading** the page submits. Reopening the exam later closes the old attempt as "Closed or reloaded page"; it cannot be resumed.
- **Answers save as they are chosen.** They travel in the signed event chain, so the server holds every answer the moment it is acknowledged, and submitting uploads nothing new. The server grades only what it holds.
- The server enforces these rules on its own, not just the page: a `FULLSCREEN_EXIT`, `TAB_HIDDEN` or `PAGE_HIDE` event, or a heartbeat that reports leaving full screen, closes the attempt. Attempts past their deadline, or silent for 5 minutes, are closed and graded automatically.
- **Results are admin-only.** No student endpoint returns scores, correct answers or explanations.

## Integrity model

The proctoring engine (`lib/proctor/client/*`) runs face, gaze, voice, camera, browser and tamper detection on the device. Video and audio are never uploaded: only timestamped events are stored.

1. **Server-owned attempts.** HttpOnly, SameSite cookies, Origin checks on every state change, attempts bound to the signed-in user.
2. **Hash-chained events.** Every event, answers included, carries `HMAC(key, prevHash + event)`. Dropped, reordered, replayed or forged events are rejected and logged as `CHAIN_INTEGRITY_FAILURE`. Re-sync requires a proof signed with the in-memory key, so a reloaded or copied page cannot resume.
3. **Silence is evidence.** Missing heartbeats produce `HEARTBEAT_GAP`; a stalled detector produces `DETECTOR_STALLED`.
4. **Server-side scoring** of both risk (from `lib/proctor/catalog.ts`) and marks.

Limits: a modified browser, a hardware capture device or a second device out of camera view can still defeat any browser-only proctor. Flagged attempts deserve human review, and high-stakes exams should use a locked-down browser.

## Scripts

| Command | |
| --- | --- |
| `npm run db:migrate` / `npm run db:status` | Apply or list `proctor` migrations |
| `npm test` | Parser tests |
| `npm run typecheck`, `npm run lint`, `npm run build` | Checks |
| `npm run db:seed-dev` | **Local only.** Creates a stand-in `public.users` with test accounts (passwords in the script). Refuses non-localhost databases. |

## Production checklist

- `DATABASE_URL` pointing at the least-privilege role, plus `DATABASE_CA_CERT` so the database certificate is verified.
- `PROCTOR_SECRET` (32+ chars). Serve over HTTPS (camera access and `Secure` cookies require it). Behind a proxy, set `PROCTOR_TRUST_PROXY=1` so rate limits are per client.
- The rate limiter is in-memory: fine for one instance. For several instances, move `lib/server/rate-limit.ts` to Redis. Everything else is already in Postgres.
- Decide a retention period for `proctor.events` (behavioural data) and say so in your privacy notice.
