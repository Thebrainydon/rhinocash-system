# Moving from SQLite (dev) to PostgreSQL (production)

## Current state, honestly

`src/db.js` is SQLite (Node's built-in `node:sqlite`). Every route file
talks to the database **only** through `db.all()` / `db.get()` / `db.run()`
— no route file imports `node:sqlite` directly, and no route file contains
raw SQLite-only syntax **except** three specific patterns, all isolated and
listed below. This was a deliberate architectural choice so the swap is
mechanical, but it has **not been executed or tested against a real
Postgres instance** in this environment (no network access to install
`pg` or connect to a Postgres server). Don't take "designed to be
portable" as "verified portable" — treat the steps below as a concrete,
scoped plan, not a completed migration.

## What has to change

### 1. `src/db.js` — the only file that knows the engine
Replace the `node:sqlite` `DatabaseSync` with a `pg` `Pool`, and rewrite
`all()/get()/run()` to use it:

```js
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function all(sql, params = []) { return (await pool.query(sql, params)).rows; }
async function get(sql, params = []) { return (await pool.query(sql, params)).rows[0]; }
async function run(sql, params = []) { const r = await pool.query(sql, params); return { changes: r.rowCount }; }
```

Every call site (`all(...)`, `get(...)`, `run(...)`) is currently used
**synchronously without `await`** everywhere in the codebase — correctly,
because `node:sqlite`'s `DatabaseSync` really is synchronous. A `pg`-based
`db.js` would return promises instead, so **every single call site** (not
just a handful) needs an `await` added, and every route handler wrapping
one needs to be `async` (most already are declared `async` or use
arrow-function handlers that can trivially become `async`, so this is
mechanical but touches all ~150 call sites across every route file). Do
this file-by-file and re-run the test suites after each — a missed
`await` shows up immediately as an unhandled-promise/undefined-result
error, not a silent bug.

### 2. Schema DDL differences
- `?` placeholders → Postgres uses `$1, $2, ...`. Either switch every
  query string (mechanical but tedious across ~150 call sites) or use a
  small query-rewriting shim in the new `db.js` that converts `?` to
  `$n` positionally — the latter keeps every route file completely
  unchanged, which is the recommended approach.
- `TEXT PRIMARY KEY` — fine as-is in Postgres.
- `INTEGER PRIMARY KEY AUTOINCREMENT` (used for `journal_entries`,
  `login_attempts`, `audit_logs`, `notifications`) → Postgres:
  `SERIAL PRIMARY KEY` or `GENERATED ALWAYS AS IDENTITY`.
- `INSERT OR IGNORE` (used throughout `seed.js` for idempotent setup, plus
  one spot in `users.js` for module-access rows) → Postgres:
  `INSERT ... ON CONFLICT DO NOTHING`.
- `ON CONFLICT(a,b) DO UPDATE SET x = excluded.x` (used for permission
  overrides) → **this syntax is already Postgres-compatible as written**
  — SQLite's upsert syntax was deliberately written to match Postgres
  here, so these specific lines need no change.
- `datetime('now')` — still used inline in a number of UPDATE statements
  across `auth.js`, `branches.js`, `investors.js`, and `users.js` (session
  revocation, login timestamps, proposal decisions, payout marking — run
  `grep -rn "datetime(" src/` to see every call site before starting).
  Postgres equivalent: `NOW()`. A few spots also use SQLite's relative-date
  arithmetic, `datetime('now','-15 minutes')` (failed-login lockout
  window, `auth.js`) and `datetime('now','-2 minutes')` (duplicate-payment
  window, `payments.js`) — Postgres equivalent: `NOW() - INTERVAL '15
  minutes'` / `NOW() - INTERVAL '2 minutes'`.
- `strftime('%Y-%m', col)` for month-key grouping — used in
  `src/routes/dashboard.js`, `src/routes/branches.js`, and
  `src/routes/investors.js` (5 call sites total; run `grep -rn strftime
  src/` to find them all before starting). Postgres equivalent:
  `to_char(col, 'YYYY-MM')`.
- SQLite has no native boolean type (booleans are stored as
  `INTEGER 0/1` throughout — `allowed`, `read`, `active`, `processed`,
  `must_change_password`). Postgres has a real `BOOLEAN` type; either
  convert these columns to `BOOLEAN` (cleaner, small migration script
  needed to cast existing `0/1` data) or keep them as `INTEGER` and keep
  comparing `= 1` — both work, `BOOLEAN` is the better long-term choice.

### 3. Migrations
There is no migration runner yet — `seed.js` just runs `CREATE TABLE IF
NOT EXISTS` against whatever `db.js` gives it, which is fine for SQLite's
single-file model but not how you want to manage schema changes against
a shared Postgres database over time. Recommended: add
[`node-pg-migrate`](https://www.npmjs.com/package/node-pg-migrate) (pure
JS, no native bindings) once real network access is available, and move
the `CREATE TABLE` statements in `src/db.js` into numbered migration
files under `migrations/`. Until then, the existing `CREATE TABLE IF NOT
EXISTS` statements can be run once against a fresh Postgres database
as a manual bootstrap — they're valid Postgres DDL as written (aside
from the `AUTOINCREMENT`/`SERIAL` point above).

### 4. Connection & pooling
Use `DATABASE_URL` (see `.env.example`). For serverless/edge deployment
targets, prefer a pooler (Supabase/Neon's built-in pooler, or PgBouncer)
over a direct connection — `node:http`'s single-process model here means
one long-lived pool is fine for a traditional VM/container deployment,
less fine if you later split into multiple stateless instances (see the
rate-limiter note below).

### 5. Things that become multi-instance concerns once you're on Postgres with >1 app instance
- `src/rateLimit.js` — currently an in-memory per-process Map. Fine for
  one instance; with N instances behind a load balancer, move the
  counters into Postgres (a simple `rate_limit_hits` table) or Redis.
- `data/uploads/` — currently local disk. Move to S3/GCS/equivalent
  object storage and store the returned URL in `file_path` instead of a
  local path; `client_documents.file_path` and `users.avatar_path`
  already just store a string, so this is a storage-layer swap, not a
  schema change.
- `data/.session_secret` — set `SESSION_SECRET` explicitly via your
  platform's secret manager so every instance shares the same value
  (already documented in `.env.example`).

## Suggested order of work

1. Stand up a real Postgres instance (Supabase/Neon/RDS/local Docker).
2. Rewrite `src/db.js` per section 1+2 above (this is the only file that
   needs to change conceptually).
3. Make every route handler `async` and `await` its db calls — do this
   incrementally, one route file at a time, running
   `node test/integration.test.js && node test/v2.test.js && node
   test/branchExpansion.test.js` after each file. The existing test
   suites are the regression net for this migration; nothing here should
   be considered done until they pass against the Postgres-backed server.
4. Swap `seed.js`'s `INSERT OR IGNORE` lines and the handful of
   `datetime('now')` / `strftime` call sites per section 2.
5. Add a real migration tool once you're past the initial bootstrap.
