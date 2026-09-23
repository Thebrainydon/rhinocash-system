# Rhinocash Microfinance System

A role-aware microfinance management system: full LoanBook module across every
role, financial accounting, M-Pesa integration, staff/branch management, and a
comprehensive automated regression suite.

## Structure

- `rhinocash-app/index.html` — the entire frontend (single-file app: HTML,
  CSS, and the client-side JS embedded in one `<script>` tag). This file is
  the single source of truth for the frontend; nothing else needs to be
  committed alongside it.
- `rhinocash-backend/` — the Node.js API server (a small dependency-free
  HTTP router, not Express — see `src/router.js`):
  - `src/db.js` — the entire data layer (PostgreSQL schema + async
    connection/query helpers). Every other module talks to the database
    only through this file's exported helpers.
  - `src/routes/` — route handlers, one file per domain (loans, collections,
    clients, payments, accounting, staff, branches, investors, M-Pesa, etc).
  - `src/rbac.js` — role-based access control and branch/region scoping.
  - `src/middleware.js`, `src/audit.js`, `src/crypto.js` — auth middleware,
    audit logging, and password/token hashing.
  - `seed.js` — creates the initial admin account and (with `--demo`) a full
    set of demo staff, branches, clients, and loans for testing.
  - `test/` — the full regression suite (25 backend suites + a frontend
    integration harness).

## Running the backend

Requires a running PostgreSQL server and a database already created —
see `rhinocash-backend/README.md` → "PostgreSQL setup" for exact commands
if you don't have one yet.

```bash
cd rhinocash-backend
npm install
export DATABASE_URL=postgres://rhinocash:yourpassword@localhost:5432/rhinocash_dev
node seed.js --demo
node server.js
```

The seed script prints the generated admin and demo-account passwords to the
console on first run. To set a specific admin password instead of a random
one:

```bash
INITIAL_ADMIN_PASSWORD='YourPasswordHere' node seed.js --demo
```

## Recent improvements

- Migrated the database layer from SQLite to PostgreSQL — see
  `rhinocash-backend/docs/POSTGRESQL.md` for the architecture and
  `rhinocash-backend/docs/STATUS_REPORT.md` for current test status.
- Login gives explicit "Processing… please wait" / "Login successful…
  redirecting" feedback as soon as each phase actually happens, instead of
  a static button and an unexplained pause.
- JSON API responses are gzip-compressed (`src/router.js`, using only
  `node:zlib`) when the client supports it — a large reduction in bytes
  transferred for the bulk LoanBook/Collections endpoints, which matters
  most on slow mobile connections.

## Database

PostgreSQL is required — there is no SQLite fallback, and the server
refuses to start without `DATABASE_URL` set. `src/db.js` runs a real
startup self-test the moment the app connects (creating the schema with
`CREATE TABLE IF NOT EXISTS` if it isn't there yet), so there's no
separate migration command to run. See `rhinocash-backend/README.md` →
"PostgreSQL setup" for creating a database, and
`rhinocash-backend/docs/POSTGRESQL.md` for the schema design decisions,
transaction handling, and SQL translation notes.

## Running with Docker

`docker-compose.yml` at the repo root runs PostgreSQL and the backend
together — the frontend is a static file, served separately (see
"Structure" above):

```bash
docker compose up -d
docker compose exec api node seed.js --demo
```

Then open `rhinocash-app/index.html` in a browser, or serve it with any
static host. Set `window.RHINOCASH_API_BASE` if the API isn't reachable
at `http://localhost:4000`. See `Dockerfile` and `docker-compose.yml` for
the exact configuration, and `.env.example` for what to change for a real
deployment (`SESSION_SECRET`, `CORS_ORIGIN`, `MPESA_ENCRYPTION_KEY`).

## Running the test suite

Backend suites need a dedicated PostgreSQL test database (never the same
one your dev server uses) and run through `test/run-all.sh`, which
resets that database to a fresh schema, seeds it, and starts/stops the
server automatically before and after every suite:

```bash
cd rhinocash-backend
TEST_DATABASE_URL=postgres://rhinocash:yourpassword@localhost:5432/rhinocash_test \
  bash test/run-all.sh
```

The frontend regression suite extracts the `<script>` contents of
`index.html`, combines it with a small test harness, and runs the result
against a live, freshly-seeded server — also via its own script, for the
same reset-before-run reasons:

```bash
TEST_DATABASE_URL=postgres://rhinocash:yourpassword@localhost:5432/rhinocash_test \
  bash test/run-frontend.sh
```

At last verification: **1,137 backend tests and 905 frontend tests, all
passing** against a real PostgreSQL database — see
`rhinocash-backend/docs/STATUS_REPORT.md` for the full test history.

## Security

See `rhinocash-backend/docs/SECURITY_CHECKLIST.md` for the itemized
pre-production checklist, and `rhinocash-backend/docs/RBAC.md` for how
the permission and branch/region scoping model actually works.

## Configuration

Copy `rhinocash-backend/.env.example` to `rhinocash-backend/.env` for
production configuration — only `DATABASE_URL` is required to get
started (see the file's own comments for what each other variable does).
No secrets, credentials, or local databases are committed to this
repository — see `.gitignore` and `rhinocash-backend/.gitignore`.

## Current functional state

- **Loan Officer's My Account -> View Details** — complete: a real
  ACC BALANCES tile into a new staff wallet subsystem, and a filter-driven
  Performance/Interactions/Staff Loans/Leaves & Payroll panel, the latter
  including a real Kenyan-statutory (NSSF/SHIF/PAYE) computed payslip.
- **Loan Officer's Payments menu** — complete, all 8 submenus.
- **Regional Manager LoanBook** — complete, 13 submenus.
- **Operational Manager LoanBook** — complete, 15 submenus (company-wide
  scope, including Approved Loans, Active Loans, Operational Loan Portfolio,
  Loan Portfolio Quality, and Loan Exceptions & Escalations).
- **Accountant's Loan Accounting menu** — still on its prior submenu set
  (Loan Applications, Pending Loan Approvals, Loan Receivables, Principal,
  Interest Income, Loan Fees, Penalties, Write-offs, Recoveries, Provisions,
  Loan Financial Verification, Loan Approval History); new specs for this
  role have not yet been received/implemented.
- Every other role (Admin, Manager, Loan Officer, CEO, Director, Investor)
  and every other module (Clients, Payments, Accounting, M-Pesa, Staff,
  Branches, Reports, Support) is present and passes the full regression
  suite, though it was not the active focus of the most recent work.

## Generated files (intentionally not included)

- `rhinocash-app/extracted.js` — the raw extracted `<script>` contents of
  `index.html`. Regenerated automatically by `test/run-frontend.sh`;
  `index.html` alone is authoritative.
- `rhinocash-backend/test/frontend-integration.combined.js` — assembled from
  `frontend-harness-prefix.js` + the frontend's extracted script +
  `frontend-integration-suffix.js`. Regenerated automatically as above.
- `rhinocash-backend/data/` — the session secret and M-Pesa encryption key
  are generated at first-run time and gitignored; never commit them. The
  application database itself lives in PostgreSQL, not in this directory.
