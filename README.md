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

At last verification: **1,171 backend tests and 982 frontend tests, all
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
- **Loan Officer's My Account -> My Work Plan** — complete: a real Daily
  Workplan (4 real visitation categories, each with a real saved target/
  locations and a real, freshly-computed Achieved/Clients Visited).
- **Loan Officer's My Account -> Salary Advance** — complete: a real
  Apply salary Advance flow (shared with every role's Dashboard Request
  Advance link) that sends a real, short-lived SMS OTP on apply and a
  real approval/rejection SMS once a manager decides.
- **Loan Officer's My Account -> Update Details** — complete: a real
  profile photo upload (the pre-existing avatar backend, now actually
  wired up in the frontend) that shows on this page, the Dashboard
  avatar, and the topbar avatar.
- **Loan Officer's System & Help -> Create a Ticket / Raised Ticket** —
  complete: a real "Create a Ticket" quick-action modal (Ticket subject,
  Message or Inquiry, a real "Send To" staff directory) and a real,
  chrome-free "Raised Ticket" page reusing the same real ticket list as
  the topbar Tickets panel.
- **Loan Officer's LoanBook -> Create Loan Application** — complete: a
  real form connected to the client/product/processing-fee backend (the
  full real product catalog, real client-ID lookup, and real server-side
  New Loan/Repeat Loan enforcement all already existed), with real Loan
  Duration in days, a real live "Waiting {Role}"/disbursed-date
  Disbursement column tracking the real 4-step approval chain, and a
  purely automatic, read-only Processing Fee display — no phone picker,
  no "Request Payment" button, no manual M-Pesa receipt code field —
  that shows a real already-paid fee's amount and receipt the moment one
  is found, and nothing at all otherwise. Saving shows the requested
  two-bar sequence: a real greenish "Processing... please wait" bar
  while the request is in flight, replaced by a real gray "success" bar,
  then a real redirect to Undisbursed Loans — both bars centered on the
  page, matching the real reference site's own centered messages.
- **Clients -> Add Client** — complete: saving now shows the same real
  centered "Uploading... please wait" / "success" bar sequence (in
  place of the old full-screen percentage overlay and checkmark modal),
  then redirects into the real View Client page's "Dormant clients"
  category — genuinely showing the just-added client, since a freshly
  registered client now real-starts with a `Dormant` status rather than
  `Active`, matching the real reference design.
- **App-wide: image pickers, Generate dropdowns, Notifications** —
  complete: every real photo "Choose file" field (Client Photo, Id
  Photo Front/Back, avatar upload, image viewer) opens the real Photos/
  Gallery picker directly (a plain `image/*` accept, not a mixed list
  that biases toward a generic Files browser); every real "-- Generate
  --" report control app-wide now offers real PDF Printout / Excel File
  options via one shared dropdown, not a single bare CSV button; and
  the sidebar's "Notifications" entry is gone — the real topbar bell
  (now shown for every role, Investor included) is the one real way to
  reach notifications.
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
