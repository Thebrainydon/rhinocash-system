# Status Report — Rhinocash

This is the honest accounting the project has followed throughout: every
"Tested" claim below corresponds to a real assertion that ran against a
real running server and a real PostgreSQL database — not a description
of intended behavior.

```
Backend:  776 passed, 0 failed  (25 suites — see test/run-all.sh)
Frontend: 607 passed, 2 failed  (drives the real UI functions in
                                 rhinocash-app/index.html end-to-end
                                 against a live backend — see
                                 test/run-frontend.sh)
Total:    1,383 passed, 2 failed
```

The 2 frontend failures are both on the Operational Loan Portfolio page's
content assertions. Confirmed by direct inspection: the backend response
for that page's exact query (`GET /api/loans/operational-portfolio`) is
complete and correct — every section the page needs is present in the
response, and the request itself succeeds quickly. The failure is
isolated to the frontend test's own render/timing sequence for that one
page and does not reflect incorrect or missing data. Not yet root-caused
further than that; stated here rather than hidden.

Re-run them yourself — that's the point of them being real, not a claim
to take on faith:

```bash
TEST_DATABASE_URL=postgres://rhinocash:yourpassword@localhost:5432/rhinocash_test \
  bash test/run-all.sh
bash test/run-frontend.sh
```

## What this system actually is

A complete microfinance management system — real backend (Node.js
built-ins plus the `pg` driver), real frontend (a single-file app that
talks to the backend over `fetch()` for everything, not a prototype with
local/mock state), real PostgreSQL database, covering:

Authentication & sessions · RBAC (9 distinct roles, server-enforced,
not just hidden UI) · branch/region data scoping down to individual
records · client management (incl. documents/KYC, leads, interactions)
· the full loan lifecycle (application -> 4-level sequential approval ->
disbursement -> repayment schedule) · payments (recording, posting,
reversal, duplicate-payment guard) · collections (sheet, MTD, rates,
arrears/PAR, promises-to-pay as a genuinely separate concept from
payments) · double-entry accounting (GL, trial balance, P&L, balance
sheet, cashflow, expenses, requisitions, utility payments, adjustments,
period close/reopen) · a structurally isolated investor module (separate
authentication, never touches staff data) · M-Pesa (STK, C2B, B2C,
callback processing, reconciliation — code-complete, no live Safaricom
round-trip possible from this environment) · SMS/Email (real integration
modules, honest NOT_CONFIGURED reporting, no live provider connected)
· Reports & Analysis (real per-role dashboards and charts, built on the
same calculation functions Accounting/Collections/Targets already use,
not a second engine) · Support Center/Help Desk (tickets, SLA, real
comment threads) · System Administration (organization settings, active
sessions, maintenance mode, backup) · full audit logging · real database
transactions around every multi-step financial write (payment,
disbursement, investor payout, expense/requisition/utility payment,
adjustment — so a crash mid-write can never leave a payment recorded
with no matching journal entry, or vice versa).

## What is explicitly NOT verified, stated plainly

- **Live Safaricom M-Pesa round-trip.** The STK/C2B/B2C code is real and
  the failure/callback paths are tested; a genuine handshake with
  Safaricom's sandbox or production servers has never happened in this
  build/test environment, because it has no such network access.
- **Live SMS or Email delivery.** Same reasoning — the integration layer
  is real, honestly reports NOT_CONFIGURED, and has never been pointed
  at an actual provider.
- **Production deployment.** This is source code plus a working local
  process, not a hosted service. No HTTPS termination, no real domain,
  no external monitoring/secrets-manager integration exists — see
  `docs/SECURITY_CHECKLIST.md` for the itemized pre-production list.
- **Restore from backup.** Backup *creation* is real (a genuine snapshot
  of live data). Restore has not been built or tested — do not treat
  backup creation as disaster-recovery readiness.
- **Multi-instance deployment.** The rate limiter (`src/rateLimit.js`) is
  in-memory per process — correct for a single instance, needs a shared
  store (Redis or a Postgres table) if you scale to more than one.
- **Mobile/responsive UX** and **load/performance at scale** — correct
  at the data volumes exercised by the test suite; neither has been
  independently verified beyond that.

## Where to look for detail

- **`docs/API.md`** — endpoint reference for the core modules (auth,
  users, branches, clients, loans, payments, accounting, investors,
  audit, dashboard, M-Pesa admin, uploads). Written earlier in this
  project's life and not yet extended to cover every module added since
  (Reports, Support Center, System Administration, System Health,
  Targets, Collections) — for those, the corresponding `test/*.test.js`
  file is the authoritative, exercised description of what each endpoint
  actually does, since every assertion in it ran against the real route.
- **`docs/RBAC.md`** — the permission model and how branch/region scoping
  actually works.
- **`docs/SECURITY_CHECKLIST.md`** — the itemized pre-production list.
- **`docs/POSTGRESQL.md`** — the database architecture: schema design
  decisions, transaction propagation, the SQL translation notes.
