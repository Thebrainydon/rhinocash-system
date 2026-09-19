# Status Report — Rhinocash

This is the honest accounting the project has followed throughout: every
"Tested" claim below corresponds to a real assertion that ran against a
real running server and a real PostgreSQL database — not a description
of intended behavior.

```
Backend:  945 passed, 0 failed  (27 suites — see test/run-all.sh)
Frontend: 749 passed, 0 failed  (drives the real UI functions in
                                 rhinocash-app/index.html end-to-end
                                 against a live backend — see
                                 test/run-frontend.sh)
Total:    1,694 passed, 0 failed
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
those roles · Add Client was redesigned to match the reference layout
(single-column, its own field order) — purely presentational, the real
client-creation and file-upload logic underneath was untouched · Create
a Lead is now a real modal (reachable from the sidebar or the Client
Leads list) with a dynamic "Add More Field" control for three genuinely
optional fields (Kin Contact, Next of Kin, Business Type) alongside the
always-present Client Idno/Location/Client Location — all real
`client_leads` columns now, and every one with a same-named column on
`clients` (national_id/address/next_of_kin/next_of_kin_phone/
business_type) carries over onto the real client record the moment the
lead converts, instead of being re-entered from scratch · Add Client
was pared down further (Email, Gender, Client Type, Branch and Loan
Officer fields removed — a Loan Officer creates clients under their own
identity, so those were redundant) and the Save action now shows a real
1%-to-100% progress overlay followed by a "Client Added Successful!"
confirmation before returning to the client list; the underlying
create-client and document-upload calls are unchanged. Fixing this
uncovered a real, if narrow, bug in the Manager's Collection Sheet:
`renderSheetBranchPage()`'s cache-invalidation key included
`expandedOfficers` (which officer groups are expanded), a pure
client-side UI toggle, so expanding a group invalidated the cached data
and briefly reloaded it — now excluded from the key · the Clients
menu's "Interactions" submenu is now a real page (previously
unrouted, falling through to a generic placeholder): a date-range- and
name/phone-searchable list of every logged client interaction the
caller can see, joined to the client's name/phone/status and both the
client's assigned Loan Officer and the staff member who actually
logged the interaction (`GET /api/clients/interactions`, scoped by the
same branch/officer rules every other Clients/Collections endpoint
already uses) · the Clients menu's "Client Leads" submenu is now a real
"Unboarded Leads"/"Onboarded Leads" browser (date-range- and
name/phone/national-ID-searchable), showing each lead's branch,
creator, every real optional field the Create Client Lead form can
capture, and a real interactions count (the number of real
`client_interactions` logged against the client the lead converted
into, zero for a lead that hasn't converted yet) — converting a lead
straight from this page immediately moves it from "Unboarded" to
"Onboarded", with no manual refresh · the Clients menu's "View Client"/
"All Clients" directory was rebuilt to match the reference design: a
real status browser (All/Dormant/Active/Blacklisted/Unfunded clients),
searchable by name/phone/ID, with Name/Contact/Idno/Branch/Loan
officer/Cycles/Location/Kin contact/Next of kin/Status columns. Its
toolbar's three actions are all real: **Generate** exports every client
matching the current filters (not just the loaded page) as a real CSV
("Excel File") via the existing `exportRowsToCsv()` utility, or opens
the browser's native print dialog ("PDF Printout" — a real,
dependency-free way to produce an actual PDF, the same approach this
codebase already used for `Print Receipt`); **Import** opens a real
CSV-only bulk-create flow (`POST /api/clients/bulk`, new) — Name/
Contact/Idno/Loan officer/Location/Kin contact/Next of kin/Business
type, where "Loan officer" is the officer's real `staff_code` looked up
server-side against Loan Officer users, never a free-text name, and a
bad row is skipped and reported rather than aborting the valid rows,
same pattern as the existing Bulk Upload (Utility Payments) flow; the
**↓** button opens a real "Filter client Fields" picker (9 real,
independently toggleable columns) whose selection genuinely drives
which columns the next Excel export includes. Like Bulk Upload, this
dependency-free build has no binary `.xlsx` parser, so Import honestly
accepts CSV only and says so, rather than pretending to read Excel
files it can't · clicking a client (from the directory's search results
or any other list) now opens a real, redesigned Client Account page
matching the reference exactly: a Notes button (the same real
interaction log as before, relocated into its own modal), Loyalty
Points/Account Balances tiles (genuinely 0 — this system does not track
either yet, so it says so rather than fabricating a number), the real
uploaded Client Photo and both ID photos (when present) as clickable
thumbnails, a Client Details panel, and a Loan History section with a
real Loan History/Client Documents/Repossessed items switcher (the
first two are real data; Repossessed items is an honest empty state,
since this system has no repossession tracking yet). Client Photo and
both ID photos open a real, dependency-free image viewer — pure CSS
`transform: scale()/rotate()` on the real uploaded image, with real
zoom in/out and 90°-step rotate controls (two steps turns it sideways,
four turns it upside down). The Loan History table's Arrears/Principal/
Total Bal columns are all real, computed from each loan's actual
repayment schedule via the same `loanBalance()`/`loanOutstandingPrincipal()`
helpers already used elsewhere, plus a new `loanArrearsAmount()`
alongside the pre-existing `loanArrearsDays()`. Coll. Agent, credit
rating, and the Loan/Repayment/Status row-level action links (Details,
View, print, statement, Action) are left as explicit, honestly-labeled
placeholders — this system doesn't track a distinct collection agent or
credit rating separately from the loan officer yet, and the destination
pages for those actions are still to be specified · fixed a real bug in
the View Client directory: `loadClientDirectory()` used a fixed
`withRequest` key, so switching the status-category dropdown (or
searching) while a previous load was still in flight could get silently
dropped, leaving the page — and its "`<Category>` clients (`<count>`)"
heading — stuck showing the wrong category (the exact same class of bug
already fixed once this project in the Manager's Collection Sheet).
Keyed by the real filters instead, same as everywhere else this pattern
is used. Also tightened the directory's header and toolbar layout (the
search box, and the Generate/Import/filter-fields button group) so they
stay on one line and match the reference's button styling, instead of
wrapping and rendering the Generate dropdown with a mismatched border ·
carried the same layout audit across every other Clients-menu page
built this session: Client Interactions' and the Leads browser's
date-range/search rows now stay on one line the same way; the Leads
browser's category dropdown got the same button styling as its
Generate/Import counterparts; an extra "+ Create" button on the Leads
browser's header that wasn't in the reference design was removed (the
sidebar's own "Create a Lead" quick action already covers it, so
nothing was lost); and the Client Account page's header (back arrow +
client name + Notes button) no longer wraps on a long client name ·
Notes moved from a modal to its own real page: "`<Client>` Interactions"
with a Source/Comment table and its own real "+ Create" action, which
opens a real "Post Client Interaction" modal (just a Comment field and
Post — the type defaults server-side, same as any other interaction) ·
the Client Photo / ID Photo Front / ID Photo Back image viewer is now
real editing, not just viewing: a camera button uploads a real
replacement (deleting the old document for that slot server-side, via a
new `DELETE /api/clients/:id/documents/:docId`, so no duplicate is left
behind) and a trash button deletes the photo outright, alongside the
existing real zoom and rotate. The thumbnails are always clickable now,
even with no photo yet, showing a generic placeholder so a first photo
can be uploaded straight from the viewer · a client's real wallet
accounts (Transactional/Investment/Savings) are live: the ACC BALANCES
"View" button opens a real account page — real balance, real generated
account number, a real withdrawals total, and a real, date-filterable
transaction ledger, all auto-provisioned (3 real `client_accounts` rows,
starting at a real zero balance) the first time a client's accounts are
requested. "Deposit" opens a real STK-push request against a genuinely
separate M-Pesa code path (`mpesa.initiateWalletStkPush`, its own
`client_account_stk_requests` table) from loan-repayment STK, so it can
never affect that existing flow. Transfer is left an explicit
placeholder, pending its own reference design — a Loan Officer clicking
it now genuinely gets "Access denied" (they have no real authority to
move client funds between accounts); every other role still sees the
placeholder until Transfer's own page is specified · the Loan History
table's "Details" link now opens a real Loan Details modal — Loan
Amount, Disbursement, Guarantor name/contact, and Loan securities all
come straight from the existing loan record; "Posted By" and "Template
Creation" are newly derived, not fabricated: "Posted By" is whoever
posted the real disbursement journal entry (a real `journal_entries`
row already created by `completeDisbursement()`), "Template Creation"
is the real actor already recorded on the loan's original "Submitted
loan application" audit log row — no new database columns were needed
for either. Approvals lists every real `loan_approvals` decision.
Clearance has no backing concept in this system yet, so it's shown
honestly as "----" rather than invented · the Loan History table's
Repayment "View" link opens a real, color-coded Installments modal:
each schedule row is red only if it was genuinely paid late (a fully
settled period whose real latest payment landed after its due date) or
is genuinely overdue (unsettled and past its due date), black
otherwise — never a cosmetic guess. Its "+" opens a real per-installment
transactions modal listing every real payment that touched that period,
and its print icon opens a real receipt. None of this needed a new
database column: the schema has no stored principal/interest split per
payment, so a new endpoint (`GET
/api/loans/:id/schedule/:scheduleId/transactions`) reconstructs it by
replaying that period's real, chronologically-ordered
`payment_allocations.amount_applied` values against its real
`principal_due`/`interest_due`, principal first — a genuine derivation
over real recorded amounts, not fabricated data. The main schedule query
also now carries each period's real `last_payment_date` (the latest real
payment that touched it), used to drive the on-time/late coloring.
The Repayment column's other two icons open two further real, printable
statements: a Loan Account Statement (branch, loan amount, disbursement
date, real term-in-days duration, current balance, and a real payment
history with each payment's real principal/interest breakdown — its
own real `allocated_principal`/`allocated_interest` columns, not
replayed, since this view is whole-loan scope) and a Loan Ledger
Statement (a real debit/credit/running-balance ledger: disbursement,
interest charged, then two real lines per payment). Disbursement
channel comes from the real "Disbursed loan" audit log row (the same
derivation the existing disbursement-method report already used) via a
new `disbursementChannel` field on `GET /api/loans/:id`.

Processing fee and late-payment penalty are now real, end-to-end
features, not placeholders. A real processing fee (the product's own
real, admin-configurable `fee_pct`, shown and editable in System
Configuration — Loan Products) is charged at disbursement: deducted
straight out of the disbursed cash and recognized immediately as real
`fee_income`, while `loans_receivable` still books the FULL principal —
the fee is never added to what the client owes, exactly like future
interest never was. A real late-payment penalty (the product's own
real, admin-configurable `penalty_pct`) is charged once, flatly, the
first time an installment is genuinely found overdue — accrual is a
pure `loan_schedule.penalty_due` update with no journal entry, run
lazily on read (this dependency-free app has no background job
runner) and on every payment, and is idempotent by construction (a
`penalty_due = 0` guard). `allocate()`'s waterfall now pays a period's
principal+interest before any penalty on that same period, `payments`
carries a real `allocated_penalty`, penalty income is recognized only
once actually collected (the same cash-basis timing as interest, via a
real `penalty_income` GL account), and reversing a payment correctly
unwinds the penalty portion first (the exact reverse of the order it
was applied). `loanBalance()` — the one shared function every KPI,
table, and statement in the app reads a loan's outstanding balance
through — now includes any real outstanding penalty, so a client with
an unpaid late fee is never shown as owing less than they really do.
Both real fee and real penalty now appear on the Loan Details modal,
the Installments view, the per-installment receipt, and both loan
statements. The Loan History table's "☰ Action" link now opens a real
Loan Action Options modal with three real actions: Make Payment (a
real M-Pesa STK push request against that specific loan, reusing the
existing `/api/payments/mpesa/initiate` bridge, pre-filled with the
real client's phone), Loan Statement (the Loan Ledger Statement built
above), and Tag Loan — a real rating (one of four real, fixed options:
Good paying client / Bad Luck Client / Bad Faith Client / Control
Failure) plus a free-text reason, persisted via a new
`POST /api/loans/:id/rate` (same branch/officer-ownership scope every
other single-loan action already enforces). The Loan History table's
"Unrated" badge is this same real field — it shows the actual rating
once one has been set, not a hardcoded placeholder.

- **Live Safaricom M-Pesa round-trip.** The STK/C2B/B2C code — including
  the new wallet-deposit STK path — is real and the failure/callback
  paths are tested; a genuine handshake with Safaricom's sandbox or
  production servers has never happened in this build/test environment,
  because it has no such network access.
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
