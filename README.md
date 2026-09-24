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
- Login gives explicit "Processing… please wait" feedback on the button
  itself while credentials are being verified, then moves straight into
  the real app shell, which shows a real "Loading Dashboard..." screen
  (with a real spinning-arrows icon, reusing the login button's own
  spinner) for the rest of the wait (fetching the account's own data) —
  never a static button with an unexplained pause.
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

At last verification: **1,205 backend tests and 1,054 frontend tests,
all passing** against a real PostgreSQL database — see
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
  ACC BALANCES tile into a new staff wallet subsystem, a Profile photo
  section (the same real uploaded avatar Update Details/Dashboard/the
  topbar already show, falling back to a placeholder silhouette when
  none is set yet), each detail field's label and value now sitting on
  the same line (a scoped `.detail-inline` layout, since the base
  label/value styling is shared with ~100 other, longer-labeled spots
  across the app) — both matching the reference layout — and a
  filter-driven Performance/Interactions/Staff Loans/Leaves & Payroll
  panel, the latter including a real Kenyan-statutory (NSSF/SHIF/PAYE)
  computed payslip.
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
  avatar, and the topbar avatar; plus a real Change Password form
  (Current/New/Confirm, each with a real eye-icon show/hide toggle)
  reusing the pre-existing `/api/auth/change-password` endpoint — this
  is now the one place a Loan Officer can set a new password, including
  typing in the one they set via the login page's own Forgot Password
  flow, since Leave & Attendance and Security & Login (see below) are
  no longer on their My Account menu.
- **Loan Officer's sidebar: active-state highlighting, auto-collapse,
  trimmed My Account menu** — complete: "Client Leads" and "Raised
  Ticket" no longer wrongly co-highlight their own quick-action-modal
  siblings ("Create a Lead", "Create a Ticket") just because they
  happened to share the same route section; clicking a real item in a
  different sidebar section now auto-collapses whichever other section
  was left open, with no manual close click needed; and "Leave &
  Attendance" / "Security & Login" are removed from this role's own My
  Account menu (every other role's menu is unaffected), with password
  changes now handled entirely by the Update Details page above.
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
  Disbursement column tracking the real 4-step approval chain, and real
  min/max HTML5 validation on Loan Amount tied to the selected product's
  own range, so an out-of-range value triggers the browser's own native
  validation message, matching the reference exactly. The matched-client
  confirmation banner that used to render below Client Id Number is
  gone, matching the reference's own cleaner layout. The weekly product
  previously misspelled "Ibuka" is now "Inuka" (its internal id is
  unchanged, since real loans/tests already reference it). Processing
  Fee now offers a real, temporary manual-entry fallback — type the
  amount and click Mark as Paid, reaching a new real backend endpoint
  that marks a real `loan_fee_payments` row Confirmed immediately (a
  clear `MANUAL` placeholder receipt, honestly distinguishable from a
  genuine Safaricom one) — skipping the phone/STK/receipt-code round
  trip, meant to be removed again once a real client-facing fee picker
  is enforced; a real already-Confirmed payment still shows read-only
  exactly as before. Saving shows the requested two-bar sequence: a real
  greenish "Processing... please wait" bar while the request is in
  flight, replaced by a real gray "success" bar, then a real redirect to
  Undisbursed Loans — both bars centered on the page, matching the real
  reference site's own centered messages.
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
- **App-wide: mobile filter-row/table scroll sync** — complete: on every
  page with a data table wide enough to need horizontal scrolling on a
  phone, the filter row above it (date pickers, dropdowns, the real "--
  Generate --" control) now scrolls in sync with the table itself,
  swiping either one moves both together — matching the reference
  design, where swiping right reveals the Generate button as the
  table's own rightmost columns come into view, rather than the filter
  row staying fixed in place while only the table underneath it
  scrolls. Wired generically for every real page at once
  (`wireFilterRowScrollSync()`, run after every render) by pairing each
  real `.table-wrap` with its own real preceding `.pill-row`, rather
  than needing a change in each individual page's own markup.
- **App-wide: mobile sidebar animation, layout, and topbar branding** —
  complete: opening the sidebar (hamburger) and closing it (tapping
  anywhere outside it) now genuinely slide/fade, rather than popping
  open or shut instantly — `toggleSidebar()`/`closeSidebar()` toggle a
  class directly on the real, already-existing sidebar/backdrop DOM
  nodes instead of going through the app's usual full rebuild, which
  gave a freshly re-created node no "from" state for its own real CSS
  transition to animate from. The separate ✕ close button is gone
  (tapping outside already closed it); "RHINOCASH LTD" now appears
  directly below the real logo in the sidebar's own profile card; the
  topbar's own "RHINOCASH LTD" text is now desktop-only, hidden on
  mobile where every other page already omitted it; and the green
  Online status dot now genuinely pulses (scaling in and out) instead
  of sitting static.
- **App-wide: shared loading indicator** — complete: every individual
  page/panel/table's own "Loading…" text placeholder (over 100 spots
  across the app) is now a real purple dots spinner (`loadingDotsHtml()`
  — an 8-dot ring, each with its own static position and a staggered
  pulse animation) matching the reference design, with no text. The one
  real exception is the initial, one-time screen shown right after
  login, before any page has data to render at all, which now reads
  "Loading Dashboard..." with a real spinning-arrows icon (the exact
  same real SVG/animation as the login button's own spinner, reused for
  visual consistency). This also fixed a real, related gap: the login
  button's own "Login successful… redirecting" state used to cover that
  same real wait while staying on the login screen —
  `session.authenticated` (new) now flips true immediately once
  credentials are verified, moving into the real app shell (and its own
  "Loading Dashboard..." screen) right away, while `session.loggedIn`
  itself still only flips true once the account's data has actually
  finished loading — preserving the existing safeguard where a stray,
  already-tolerated 401 from one of that data load's own many
  best-effort calls can never force a real logout mid-load.
- **Loan Officer's Payi Summary ("Daily Paybill Collection") — layout and
  demo-data fixes** — complete: the year/month filter row used to be
  nested inside the card's own title (a one-off layout only this page
  had), which put it in a different visible position than every other
  page's filter row and meant the app-wide filter/table scroll-sync
  above couldn't find or wire it; now a standalone row like everywhere
  else. Its own Monday..Sunday header, and the similar calendar on
  Loan Officer's Disbursements page, now use a shared light-blue
  weekday-bar style matching the reference design, in place of plain
  table-header styling (Disbursements) or none at all (Payi Summary).
  `seed.js --demo` now also creates a real, modest set of demo M-Pesa
  Paybill collections (weekdays only, up to today) — previously nothing
  in demo seeding ever created this data, so the calendar's own real
  amount/Print-button cells (which only render once a day's real total
  actually exists) had nothing to show on a freshly seeded database.
- **Loan Officer's Undisbursed Loans — real weekly installments, Edit,
  Print** — complete: every real `term_weeks` product (Starter, Jijenge,
  Inuka, Mavuno, Fly and their "Special" variants) now genuinely repays
  in real equal weekly installments — principal and interest both
  amortized across every real week, rounded to the nearest real
  shilling with the last week absorbing the remainder — replacing the
  old single lump-sum-at-term-end design end-to-end (schedule
  generation, the Schedule modal, the new Print page). A real Edit
  button appears next to "Waiting Manager" for a loan still at its
  first approval step, backed by a real `PATCH /api/loans/:id` that
  enforces the edit window server-side (only the loan's own Loan
  Officer, only before any real Manager decision) — gone the instant
  a Manager approves, rejects, or returns it.
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
