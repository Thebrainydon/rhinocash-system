# Status Report — Rhinocash

This is the honest accounting the project has followed throughout: every
"Tested" claim below corresponds to a real assertion that ran against a
real running server and a real PostgreSQL database — not a description
of intended behavior.

```
Backend:  857 passed, 0 failed  (26 suites — see test/run-all.sh)
Frontend: 651 passed, 0 failed  (drives the real UI functions in
                                 rhinocash-app/index.html end-to-end
                                 against a live backend — see
                                 test/run-frontend.sh)
Total:    1,508 passed, 0 failed
```

Previously (through the initial Postgres migration) 2 of the frontend
assertions failed intermittently on the Operational Loan Portfolio page.
Root-caused and fixed: `loadOperationalPortfolio()` in
`rhinocash-app/index.html` is triggered as a side effect of rendering the
page whenever the cached data's filter state doesn't match the current
one. Navigating to the page (which loads with default filters) and then
immediately changing filters — the exact sequence the test performs —
fired a second, differently-filtered request while the first was still in
flight; whichever of the two HTTP responses happened to arrive *last*
overwrote the shared `DB.operationalPortfolio` variable, regardless of
which request was actually the more recent one. Depending on response
timing, that could leave the page showing the wrong (or a mid-reload
"Loading…") state at the moment it was inspected. Fixed by stamping each
request with a sequence number and discarding any response whose sequence
number has since been superseded by a newer request — so a stale response
can never overwrite a fresher one, however the network resolves them.
Verified with two independent full re-runs after the fix, both 609/609.
This was a real, if narrow and self-correcting, frontend race condition —
not a backend or data defect, and not present in any other currently
tested page.

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
with no matching journal entry, or vice versa) · a Loan Status Browser
(topbar calendar-check icon) filtering a user's real, role-scoped loan
applications by outcome category (All templates/Disbursed/Undisbursed/
Pended/Declined) and by month/day, reusing the same
`/api/loans/applications-overview` endpoint and scoping as the existing
Applications Overview page · a Pending Payments browser (topbar copy/
duplicate icon) over the existing, real Unposted-payments status,
reusing `/api/payments` and its own existing search/scoping exactly
as-is · a Tickets browser (topbar chat-bubble icon) over the existing
Support Ticket system, reusing its already-tested `ticketVisibleTo()`
role scoping exactly as-is (a Loan Officer sees only tickets they
created; every other role sees what that same table already grants
them) · a Notifications panel (topbar bell icon) over the existing
`/api/notifications` — building it surfaced and fixed a real,
previously-silent bug: `markRead()`/`markAllRead()` only ever flipped
the local in-memory flag and never told the server, so a notification
marked read came back unread on the next login. Both now genuinely
persist server-side · a Payments panel (topbar cash icon) over the
existing M-Pesa C2B/Paybill transaction data, showing both matched and
unmatched payments together (so a payment recorded against a wrong/
mistyped account reference is genuinely visible, not silently hidden in
an Admin-only screen) — reused `mpesa_c2b_transactions` and the existing
manual-match bridge. Real, deliberate RBAC extension made here: Managers
can now assign/match an unmatched payment to a loan themselves (a
narrow addition scoped to exactly that action, not the broader
`post_accounting_entries` permission it previously required — a
Manager's other accounting authority is unchanged) · the Accounting
page's tab bar is now derived per-role instead of one hardcoded 14-tab
bar shown to everyone (`accountingTabsForRole()`): a role sees exactly
the accounting pages its own sidebar actually links to (e.g. a Loan
Officer sees only Requisitions/Utility Payments/Cashflow, not all 14),
while Admin/Accountant (who hold `post_accounting_entries`) keep full
access, including the pages with no sidebar entry yet · Requisitions
were rebuilt into a real multi-line-item workflow: a submission is now
one or more `{description, category, qty, unit_cost}` rows (the
requisition's amount is the genuine sum, not a single manually-typed
figure), charged against a real, granular Expense account chosen from
the chart of accounts (~30 seeded categories — Audit Fees, Bank
Charges, Rent, Salary & Wages, etc.), and gated by a real short-lived
OTP sent to the submitting officer's own phone (`POST
/api/requisitions/request-otp` → `POST /api/requisitions` with
`otp_code`; each code is single-use and expires in 5 minutes). Where
SMS delivery is NOT_CONFIGURED (this environment), the real generated
code is returned directly in the response instead of being silently
unreachable — the same honest-disclosure convention already used
elsewhere. `POST /api/requisitions/:id/pay` was also fixed to debit the
real expense account the officer chose at submission, instead of
always hardcoding the generic Operating Expenses account regardless of
what the requisition was actually for · Vendor/Utility Payments was
rebuilt from a single fixed-utility_type form into a real, OTP-confirmed
Vendor Payment Form (Mpesa B2C/Paybill B2B/BuyGoods, one or more real
line items each postable to any real GL account — not restricted to
Expense-type, since a vendor payment can legitimately settle a
liability too), plus a real Bulk Upload/CSV-import path sharing the
same OTP confirmation and per-row validation, never silently dropping a
bad row nor letting one bad row block the rows that were valid ·
a Loan Officer's own "Cashflow" submenu is now a real Expected Cashflow
projection — month/week/day-scoped totals (loan count, principal,
interest due) computed from real, still-outstanding `loan_schedule`
rows (`GET /api/collections/expected-cashflow`, reusing the exact same
branch/officer scoping and "outstanding" definition — `status != 'Paid'`
— every other collections endpoint already uses), independently
recomputed and matched exactly in its test. Every other role keeps the
existing ledger-based Cashflow (opening/closing balance) report
unchanged, since that is a genuinely different, still-valid concept for
those roles.

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
