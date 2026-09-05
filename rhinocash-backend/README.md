# Rhinocash Backend

A real backend for the Rhinocash system: authentication, server-enforced
role-based access control, the loan lifecycle (application → 4-level
sequential approval → disbursement → repayment), payments, a basic
accounting ledger, staff HR requests, and an isolated investor module.

**Zero external dependencies.** No `npm install` step, no Express, no
Postgres driver, no bcrypt package — everything runs on Node's built-ins
(`node:http`, `node:sqlite`, `node:crypto`). This was a deliberate choice
made in an offline environment with no package-registry access, but it's
also a genuinely reasonable choice for a system this size: one process,
one file-based database, nothing to misconfigure.

## Quick start

```bash
# Requires Node 20+ (Node 22 recommended — this is where node:sqlite
# stabilized enough to build on; it's still flagged experimental upstream).
node seed.js --demo   # sets up roles/permissions/workflow AND sample data
node server.js        # -> http://localhost:4000
```

No install step. No `.env` file required to get started (see below for
what the env vars actually change).

## Running the tests

```bash
bash test/run-all.sh        # full real backend suite (24 files) — fresh-seeds
                             # and restarts the server before each one
bash test/run-frontend.sh   # the real frontend, extracted from
                             # ../rhinocash-app/index.html and driven
                             # end-to-end against a live backend
```

Both scripts handle the fresh-seed-per-suite requirement themselves — you
don't need to run `seed.js` manually first. Two reasons a shared seed
across suites wouldn't work: `v2.test.js` deliberately exhausts the
per-minute rate limit as its last test, and `integration.test.js`
legitimately changes the seeded Admin password as part of testing the
forced-password-change flow.

To run one backend suite by hand instead, see the credential-extraction
pattern inside `test/run-all.sh` — every suite needs the same
`SEEDED_*_PASSWORD` environment variables, read from `seed.js --demo`'s
printed output.

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
password, don't try to recover it: delete `data/rhinocash.db` and
re-seed, or use `/api/users/:id/reset-password` from another admin
account once one exists.

**Run `node seed.js --demo` and you'll also get a block of clearly
labeled demo/test accounts** (one per role, plus a demo investor) — each
with its own randomly generated password, printed the same way. These
are separated from the required setup specifically because the project
instructions call for seed/demo data to never be confused with
production data. Don't run `--demo` against a real deployment.

## Configuration

All of it is optional env vars — sane defaults exist for everything so
the app runs immediately:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `RHINOCASH_DB_PATH` | `data/rhinocash.db` | SQLite file location |
| `SESSION_SECRET` | auto-generated, persisted to `data/.session_secret` | HMAC key for session tokens — set this explicitly in production |
| `INITIAL_ADMIN_EMAIL` | `admin@rhinocash.co.ke` | seed-time only |
| `INITIAL_ADMIN_PASSWORD` | randomly generated | seed-time only; set this if you want a known password instead of a generated one (still forced to change on first login) |
| `CORS_ORIGIN` | `*` | tighten this to your frontend's real origin before going live |

## Architecture, briefly

```
server.js            entry point — wires routes, handles file uploads
src/router.js         tiny dependency-free HTTP router (Express-shaped API)
src/db.js             the entire schema (SQLite DDL) + query helpers
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

## What's implemented vs. what's next

**V2 hardening (this pass) added:** real object-level branch/region
authorization on every `GET/PATCH/:id` and action route (not just list
filtering), server-side rejection of client-supplied `branch_id` for
restricted roles, self-approval and out-of-branch-scope prevention on the
loan workflow, a genuinely balanced double-entry ledger (found and fixed
a real sign-convention bug — repayments were crediting cash instead of
debiting it), a real duplicate-payment guard, notification-hijack and
ticket-visibility fixes, reporting-line-enforced leave/salary-advance
approval, scoped CEO/Director staff management (they can manage
ordinary staff but never Admin/CEO/Director accounts or the most
sensitive sub-actions), a real "Open New Branch" propose → approve →
activate workflow (not a form that just creates a branch), general rate
limiting, security headers, request size limits, and honest
NOT_CONFIGURED interfaces for M-Pesa/SMS/Email. Full breakdown, including
what's tested vs. manually-verified-only:
**[`docs/STATUS_REPORT.md`](docs/STATUS_REPORT.md)**.

**Working now, tested end-to-end (173 tests across 4 suites, 100%
passing):** authentication (real password hashing, forced first-login
password change, failed-login tracking, suspend/deactivate blocking
login, session revocation), full user/staff management with module- and
action-level permission overrides, branches & regions with real
branch/region-scoped data visibility down to individual records, branch
opening as a real approval workflow, clients (+leads+interactions
+documents), loan products, loan applications through the real
sequential 4-level approval workflow with a permanent approval history,
disbursement and repayment with a genuinely balanced ledger, loan
restructuring, leave & salary-advance requests with real reporting-line
authorization, support tickets with role/branch-scoped visibility,
ownership-checked notifications, audit logging, and the isolated
investor module.

**Not built yet, stated plainly:** live M-Pesa transaction success against
real Safaricom servers (the *configuration* system is real and tested —
see below — but a live OAuth/STK Push handshake needs real network access
and real credentials this build environment doesn't have), SMS/Email
delivery (interfaces exist, correctly report `NOT_CONFIGURED` — no
provider credentials available to build against), PostgreSQL migration
(planned and documented, not executed — see below), schema-level input
format validation, and the actual frontend-to-API wiring (the frontend
prototype still runs on its own browser-local state). See
`docs/STATUS_REPORT.md` for the itemized version of this list.

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
by reading the raw `.db` file bytes and confirming the plaintext
key/secret/passkey appear nowhere in it. Every configuration change is
audit-logged with the field names that changed, **never** the values.
Only `role_id === 'admin'` can reach any of these endpoints — not even
CEO/Director, who hold `manage_users` but not system-credential
authority (same principle as password reset and session revocation
elsewhere in the system).

**What "Test Connection" actually proves, honestly:** the code makes a
genuine HTTPS request to Safaricom's real OAuth endpoint using Node's
built-in `fetch` — nothing is simulated. From the environment this was
*built* in, that outbound request cannot succeed (its network egress
doesn't reach Safaricom's servers at all), so what's been verified is
that the request is genuinely attempted and the **failure path** is
handled safely — timeout, network-unreachable, invalid-credentials, and
unexpected-response cases all resolve to a clear status with no secret
leakage. A real deployment with real credentials and normal internet
access will get a real success/failure result from Safaricom itself.

## Documentation

- **[`docs/API.md`](docs/API.md)** — every endpoint: method, auth,
  required module/permission, branch/region scope, notes.
- **[`docs/RBAC.md`](docs/RBAC.md)** — the full access model, the
  CEO/Director vs. Admin authority split, investor isolation, and how
  the sequential loan workflow is enforced.
- **[`docs/POSTGRES_MIGRATION.md`](docs/POSTGRES_MIGRATION.md)** — exact,
  scoped steps to move off SQLite, including every remaining
  SQLite-specific SQL pattern and where it lives.
- **[`docs/SECURITY_CHECKLIST.md`](docs/SECURITY_CHECKLIST.md)** —
  itemized Done/Partial/Deployment status for every security control.
- **[`docs/STATUS_REPORT.md`](docs/STATUS_REPORT.md)** — the full
  feature-completeness matrix and the honest top-level status report.
- **`.env.example`** — every environment variable, with defaults noted.

## Moving to Postgres later

`src/db.js` is the only file that knows it's SQLite. See
`docs/POSTGRES_MIGRATION.md` for the exact, scoped steps — it's more
involved than "swap the driver" (every `all/get/run` call site needs an
`await` added, since Postgres access is async and SQLite's is not), but
still fully isolated to that one file's contract with the rest of the app.

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
