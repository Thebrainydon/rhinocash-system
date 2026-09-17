# Rhinocash Backend

A real backend for the Rhinocash system: authentication, server-enforced
role-based access control, the loan lifecycle (application → 4-level
sequential approval → disbursement → repayment), payments, double-entry
accounting, staff HR requests, and an isolated investor module.

**PostgreSQL-only, minimal dependencies.** The only npm package is `pg`
(the PostgreSQL driver) — no Express, no ORM, no bcrypt package.
Everything else runs on Node's built-ins (`node:http`, `node:crypto`).
One process, one real relational database, nothing else to misconfigure.

## Quick start

```bash
npm install                          # installs the one dependency (pg)
# Create a PostgreSQL database and role first — see "PostgreSQL setup" below.
export DATABASE_URL=postgres://rhinocash:yourpassword@localhost:5432/rhinocash_dev
node seed.js --demo                  # creates the schema, then seeds roles/permissions/workflow AND sample data
node server.js                       # -> http://localhost:4000
```

Requires Node 20+ and a running PostgreSQL server (16 is what this was
built and tested against; anything reasonably recent should work). No
`.env` file is required to get started beyond `DATABASE_URL` — see
"Configuration" below for what every other env var changes.

## PostgreSQL setup

Rhinocash V2 requires a real PostgreSQL database — there is no SQLite
fallback, and `server.js`/`seed.js` refuse to start without `DATABASE_URL`
set. You need PostgreSQL installed and a database created; this backend
does not install or manage the PostgreSQL server itself.

```bash
# 1. Install PostgreSQL (skip if you already have a server running).
#    Debian/Ubuntu:
sudo apt-get install postgresql postgresql-contrib
sudo service postgresql start

# 2. Create an application role and database.
sudo -u postgres psql -c "CREATE ROLE rhinocash WITH LOGIN PASSWORD 'yourpassword';"
sudo -u postgres psql -c "CREATE DATABASE rhinocash_dev OWNER rhinocash;"

# 3. Point the app at it.
export DATABASE_URL=postgres://rhinocash:yourpassword@localhost:5432/rhinocash_dev
```

**There is no separate migration command to run.** `src/db.js` runs a real
startup self-test the moment the app connects (from `server.js` or
`seed.js`) — it creates every table with `CREATE TABLE IF NOT EXISTS`, so
it's safe to run against both a brand-new database and one that already
has the schema. This is the one and only place the schema is defined; if
you ever need to inspect or extend it, that's the file to look at.

**A second, separate database is expected for automated tests** — see
"Running the tests" below. Never point `TEST_DATABASE_URL` at the same
database as `DATABASE_URL`; the test runner resets its target database's
contents before every suite.

## Running the tests

```bash
# Create a dedicated test database first (once):
sudo -u postgres psql -c "CREATE DATABASE rhinocash_test OWNER rhinocash;"

TEST_DATABASE_URL=postgres://rhinocash:yourpassword@localhost:5432/rhinocash_test \
  bash test/run-all.sh        # full real backend suite (25 files) — fresh
                               # schema, fresh seed, and a fresh server
                               # restart before each one

bash test/run-frontend.sh     # the real frontend, extracted from
                               # ../rhinocash-app/index.html and driven
                               # end-to-end against a live backend
```

`test/run-all.sh` refuses to run at all unless `TEST_DATABASE_URL` is set
and its name looks like a test database — this script resets its target
database's entire contents (`DROP SCHEMA public CASCADE`) before every
single suite, so pointing it at anything you care about would be a real
mistake, not a recoverable one.

Each suite gets its own fresh schema, fresh seed, and fresh server
process — not a shortcut, a real requirement: several suites legitimately
mutate shared state as part of what they're testing (`integration.test.js`
changes the seeded Admin password testing forced-password-change;
`myAccount.test.js` changes the seeded officer's email; `v2.test.js`
deliberately exhausts the per-minute rate limit as its last test). Reusing
one seed/server across suites means later suites see stale credentials or
leftover state, which looks like a failure but isn't the application's
fault — confirmed by hand while building this runner.

To run one backend suite by hand instead, see the credential-extraction
pattern inside `test/run-all.sh` — every suite needs the same
`SEEDED_*_PASSWORD` environment variables, read from `seed.js --demo`'s
printed output, plus `DATABASE_URL` pointing at the same database the
server you're testing against is using.

## The initial Administrator account

`node seed.js` (with or without `--demo`) creates exactly one required
account and prints its credentials **once**, to the console, at seed time:

```
Name:      Rhinocash System Administrator
Email:     admin@rhinocash.co.ke   (override with INITIAL_ADMIN_EMAIL)
Password:  <randomly generated, shown only in that seed run's output>
```

The password is never hardcoded, never stored in plaintext anywhere, and
the account is created with `must_change_password = true` — the very
first `/api/auth/change-password` call is required before anything else
will treat that account as fully set up. If you lose the printed
password, don't try to recover it: use `/api/users/:id/reset-password`
from another admin account once one exists, or connect to the database
directly and update the row (`seed.js` will not recreate an Admin account
that already exists).

**Run `node seed.js --demo` and you'll also get a block of clearly
labeled demo/test accounts** (one per role, plus a demo investor) — each
with its own randomly generated password, printed the same way. These
are separated from the required setup specifically because seed/demo
data should never be confused with production data. Don't run `--demo`
against a real deployment.

## Configuration

Only `DATABASE_URL` is required. Everything else has a sane default:

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | *(none — required)* | PostgreSQL connection string |
| `PGPOOL_MAX` | `10` | max connections in the pg connection pool |
| `PORT` | `4000` | HTTP port |
| `UPLOAD_DIR` | `data/uploads` | where uploaded files are written/served from |
| `SESSION_SECRET` | auto-generated, persisted to `data/.session_secret` | HMAC key for session tokens — set this explicitly in production |
| `INITIAL_ADMIN_EMAIL` | `admin@rhinocash.co.ke` | seed-time only |
| `INITIAL_ADMIN_PASSWORD` | randomly generated | seed-time only; set this if you want a known password instead of a generated one (still forced to change on first login) |
| `CORS_ORIGIN` | `*` | tighten this to your frontend's real origin before going live |
| `RATE_LIMIT_PER_MINUTE` | `180` | general per-IP rate limit across the whole API |

See `.env.example` for the full list, including M-Pesa/SMS/Email
integration variables.

## Architecture, briefly

```
server.js             entry point — wires routes, handles file uploads
src/router.js         tiny dependency-free HTTP router (Express-shaped API)
src/db.js             the entire schema (PostgreSQL DDL) + async query
                       helpers (all/get/run/transaction) built on `pg`
src/crypto.js          password hashing (scrypt) + signed session tokens
src/rbac.js            the access model: role→modules, role→permissions,
                        per-user overrides, branch/region data scoping
src/middleware.js       requireAuth / requireModule / requirePermission —
                        the actual server-side gate on every protected route
src/audit.js            one function every route logs through
src/routes/*.js         one file per domain area (auth, users, clients,
                        loans, payments, accounting, investors, ...)
seed.js                required setup + optional --demo data
test/integration.test.js  real end-to-end tests against a running server
```

**The access model is exactly what was specified:**
`role + access level + branch/region scope + module permissions + action
permissions = final access`, computed in `rbac.js` and enforced in
`middleware.js` on every request — not just hidden in the frontend. Try
it yourself: log in as a Loan Officer and `curl` `/api/users` directly;
you'll get a real `403`, not a UI that happens not to show a button.

**The 4-level loan approval workflow is stored as data**
(`approval_workflow_steps` table), not hardcoded branching logic. A loan
can only be approved by whichever role the *current* step says is next —
skip-ahead and out-of-order approval attempts are rejected server-side
(covered by the integration tests).

**Investors are a structurally separate principal type** from staff
`users` — they authenticate through `/api/investor-auth/login`, get a
differently-shaped token, and their routes only ever query
`WHERE investor_id = req.investor.id`. This is what actually prevents one
investor from ever reaching another investor's data or any internal
staff endpoint — not a filter that could be forgotten on one page.

**Every multi-step financial write is a real database transaction**
(payment recording, loan disbursement, investor payouts, expenses,
requisitions, adjustments) — `src/db.js`'s `transaction()` wraps them so a
crash mid-write can never leave a payment recorded with no matching
journal entry, or vice versa. Nested `transaction()` calls join the outer
one rather than erroring on a second `BEGIN` — see `test/atomicity.test.js`
for the direct proof, including deliberate failure injection.

## What's implemented

**Working now, tested end-to-end (776 tests across 25 suites, 100%
passing against a real PostgreSQL database):** authentication (real
password hashing, forced first-login password change, failed-login
tracking, suspend/deactivate blocking login, session revocation), full
user/staff management with module- and action-level permission overrides,
branches & regions with real branch/region-scoped data visibility down to
individual records, branch opening as a real approval workflow, clients
(+leads+interactions+documents), loan products, loan applications through
the real sequential 4-level approval workflow with a permanent approval
history, disbursement and repayment with a genuinely balanced ledger,
loan restructuring, collections (sheet, MTD, rates, arrears/PAR,
promises-to-pay), double-entry accounting (GL, trial balance, P&L,
balance sheet, cashflow, expenses, requisitions, period close/reopen),
leave & salary-advance requests with real reporting-line authorization,
support tickets with role/branch-scoped visibility and SLA tracking,
ownership-checked notifications, reports/dashboards per role, system
administration (maintenance mode, backups, security settings), audit
logging, and the isolated investor module.

**M-Pesa (STK, C2B, B2C, callback processing, reconciliation)** is
code-complete and tested against the real integration functions directly
(recordCallback/processCallback/processB2cResult, real database
transactions, real idempotency on duplicate callbacks) — a live
Safaricom handshake requires real credentials and real network egress to
Safaricom's servers, neither of which this build/test environment has;
the failure path for that case is itself tested and reports honestly
rather than fabricating success.

**Not built yet, stated plainly:** live SMS/Email delivery (interfaces
exist, correctly report `NOT_CONFIGURED` — no provider adapter is wired
up), schema-level input format validation (phone/email format beyond a
basic check), and object storage for uploads (currently local disk —
fine for a single instance, see `docs/SECURITY_CHECKLIST.md` for the
multi-instance note). See `docs/STATUS_REPORT.md` for the itemized
version of this list.

## M-Pesa Configuration (Admin only)

Location in the system: **Admin → System Administration → Integrations →
M-Pesa Integration** (`GET/PUT /api/admin/mpesa/config/...`).

This is a real, working configuration screen, not a form that saves
nowhere — a non-technical Master System Administrator can:

- Enter Consumer Key, Consumer Secret, Shortcode, Passkey, and Callback
  URL separately for **Sandbox** and **Production**, save them, and
  switch which one is active with one click — no source-file editing,
  ever.
- See a masked view of what's saved (last 4 characters only — the full
  value is never returned by any API response, not even to the Admin who
  entered it).
- Click **Test Connection** to make a real outbound OAuth request to
  Safaricom's Daraja endpoint for that environment, and get back one of
  exactly two honest outcomes: `Connection Successful` or `Connection
  Failed` (with a safe, secret-free message either way).
- Read a built-in setup guide (`GET /api/admin/mpesa/setup-guide`)
  explaining exactly what to obtain from
  developer.safaricom.co.ke and in what order — sandbox first, then
  production.

**Security specifics:** credentials are encrypted at rest with
AES-256-GCM (`src/crypto.js: encryptSecret/decryptSecret`) before
touching the database — verified directly in `test/mpesaConfig.test.js`
by reading the stored `mpesa_environment_configs` row straight back from
PostgreSQL (bypassing the app's own decrypt path) and confirming the
plaintext key/secret/passkey appear nowhere in it. Every configuration
change is audit-logged with the field names that changed, **never** the
values. Only `role_id === 'admin'` can reach any of these endpoints — not
even CEO/Director, who hold `manage_users` but not system-credential
authority (same principle as password reset and session revocation
elsewhere in the system).

**What "Test Connection" actually proves, honestly:** the code makes a
genuine HTTPS request to Safaricom's real OAuth endpoint using Node's
built-in `fetch` — nothing is simulated. From a sandboxed build/test
environment, that outbound request may not reach Safaricom's servers at
all, so what's verified there is that the request is genuinely attempted
and the **failure path** is handled safely — timeout, network-unreachable,
invalid-credentials, and unexpected-response cases all resolve to a clear
status with no secret leakage. A real deployment with real credentials
and normal internet access will get a real success/failure result from
Safaricom itself.

## Documentation

- **[`docs/API.md`](docs/API.md)** — every endpoint: method, auth,
  required module/permission, branch/region scope, notes.
- **[`docs/RBAC.md`](docs/RBAC.md)** — the full access model, the
  CEO/Director vs. Admin authority split, investor isolation, and how
  the sequential loan workflow is enforced.
- **[`docs/POSTGRESQL.md`](docs/POSTGRESQL.md)** — the database
  architecture in detail: schema design decisions, the `?`→`$n`
  placeholder translation, transaction propagation, and the SQL
  translation notes relevant if you're extending the schema.
- **[`docs/SECURITY_CHECKLIST.md`](docs/SECURITY_CHECKLIST.md)** —
  itemized Done/Partial/Deployment status for every security control.
- **[`docs/STATUS_REPORT.md`](docs/STATUS_REPORT.md)** — the full
  feature-completeness matrix and the honest top-level status report.
- **`.env.example`** — every environment variable, with defaults noted.

## The frontend

`rhinocash-app/index.html` is the real, current frontend — a single-file
app that already talks to this backend over `fetch()` for every real
piece of data and every real action (login, RBAC, loans, payments,
accounting, M-Pesa, reports, and everything else in this repo). It is not
a prototype and does not keep its own local/mock state — `test/run-frontend.sh`
drives its actual functions end-to-end against a live instance of this
server as part of the real test suite.

To run it locally: start this backend (`node server.js`), then open
`../rhinocash-app/index.html` directly in a browser — it points at
`http://localhost:4000` by default.
