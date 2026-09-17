# Rhinocash Microfinance System

A role-aware microfinance management system: full LoanBook module across every
role, financial accounting, M-Pesa integration, staff/branch management, and a
comprehensive automated regression suite.

## Structure

- `rhinocash-app/index.html` — the entire frontend (single-file app: HTML,
  CSS, and the client-side JS embedded in one `<script>` tag). This file is
  the single source of truth for the frontend; nothing else needs to be
  committed alongside it.
- `rhinocash-backend/` — the Node.js/Express API server:
  - `src/db.js` — the entire data layer (schema + connection). Every other
    module talks to the database only through this file's exported helpers.
  - `src/routes/` — route handlers, one file per domain (loans, collections,
    clients, payments, accounting, staff, branches, investors, M-Pesa, etc).
  - `src/rbac.js` — role-based access control and branch/region scoping.
  - `src/middleware.js`, `src/audit.js`, `src/crypto.js` — auth middleware,
    audit logging, and password/token hashing.
  - `seed.js` — creates the initial admin account and (with `--demo`) a full
    set of demo staff, branches, clients, and loans for testing.
  - `test/` — the full regression suite (24 backend suites + a frontend
    integration harness).

## Running the backend

```bash
cd rhinocash-backend
npm install
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

- Login gives explicit "Processing… please wait" / "Login successful…
  redirecting" feedback as soon as each phase actually happens, instead of
  a static button and an unexplained pause.
- JSON API responses are gzip-compressed (`src/router.js`, using only
  `node:zlib`) when the client supports it — a large reduction in bytes
  transferred for the bulk LoanBook/Collections endpoints, which matters
  most on slow mobile connections.

## Database notes

The backend uses Node's built-in `node:sqlite` (`DatabaseSync`) — no external
database dependency. `src/db.js` explicitly:

- Verifies the data directory is writable at startup (fails loudly with an
  actionable message if not, rather than failing silently later).
- Runs in **WAL journal mode** rather than SQLite's default rollback-journal
  mode, which is the standard, correct fix for "attempt to write a readonly
  database" errors on constrained/FUSE-backed filesystems (this matters in
  particular for Termux/Android deployments — see `src/db.js` for the full
  explanation in comments).
- Runs a real write self-test immediately after opening the connection, so a
  genuinely unwritable database is caught at boot, not on a user's first
  login.

If you ever see a "readonly database" error despite this, it means the
filesystem backing your data directory doesn't support WAL either (rare) —
point `RHINOCASH_DB_PATH` at a location on truly local/internal storage.

## Running the test suite

Backend suites (each expects the server running, and seeded account passwords
passed in as environment variables — see each test file for its exact
variable names):

```bash
node test/integration.test.js
node test/v2.test.js
# ...and so on for every file in test/
```

The frontend regression suite is assembled from three parts and then run
against a live server:

```bash
# From rhinocash-app/, extract the <script> contents of index.html into extracted.js,
# then from rhinocash-backend/:
cat test/frontend-harness-prefix.js ../rhinocash-app/extracted.js test/frontend-integration-suffix.js > test/frontend-integration.combined.js
node test/frontend-integration.combined.js
```

At last verification: **776 backend tests + 609 frontend tests, all passing.**

## Security

See `rhinocash-backend/docs/SECURITY_CHECKLIST.md` for the itemized
pre-production checklist, and `rhinocash-backend/docs/RBAC.md` for how
the permission and branch/region scoping model actually works.

## Configuration

Copy `rhinocash-backend/.env.example` to `rhinocash-backend/.env` for
production configuration — nothing there is required for local
development (see the file's own comments for what each variable does).
No secrets, credentials, or local databases are committed to this
repository — see `.gitignore` and `rhinocash-backend/.gitignore`.

## Current functional state

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
  `index.html`. Regenerate it with the command shown above; `index.html`
  alone is authoritative.
- `rhinocash-backend/test/frontend-integration.combined.js` — assembled from
  `frontend-harness-prefix.js` + the frontend's extracted script +
  `frontend-integration-suffix.js`. Regenerate as shown above.
- `rhinocash-backend/data/` — the SQLite database, session secret, and
  encryption key are all generated at seed/first-run time and gitignored;
  never commit them.
