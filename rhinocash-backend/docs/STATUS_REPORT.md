# Status Report — Rhinocash

This is the honest accounting the project has followed throughout: every
"Tested" claim below corresponds to a real assertion that ran against a
real running server and a real PostgreSQL database — not a description
of intended behavior.

```
Backend:  1,097 passed, 0 failed  (29 suites — see test/run-all.sh)
Frontend: 857 passed, 0 failed  (drives the real UI functions in
                                 rhinocash-app/index.html end-to-end
                                 against a live backend — see
                                 test/run-frontend.sh)
Total:    1,954 passed, 0 failed
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

LoanBook's Create Application (Loan Officer view) is now backed by a
real, admin-configurable short-term loan product catalog — Starter,
Jijenge, Ibuka, Mavuno and Fly, each with a real 4-week tier and a real
6-week "Special" tier at a real flat rate (20%/30%) over the loan's
whole term, repaid once rather than in monthly installments. A new
`loan_products.term_weeks` column (only set on this catalog; every
pre-existing monthly product is untouched) drives this: `buildSchedule()`
builds exactly one real installment due `term_weeks` real days after
disbursement instead of the usual monthly series, and `POST /api/loans`
treats the product as authoritative for term (a client-sent term_months
is never trusted for these). Client Id Number does a real backend
lookup by national ID (pre-existing, confirmed still correct); Loan
Amount/Duration auto-fill from the real selected product. Type of Loan
(New Loan / Repeat Loan) is real and backend-enforced, not a frontend
convenience: a Repeat Loan application is rejected unless the client
genuinely has a prior loan on record (and inherits that prior loan's
real guarantor when none is supplied), and a New Loan application is
rejected without a real guarantor name and contact — both server-side,
so a direct API call can't bypass either rule the way a frontend
`required` attribute could be. The Loan Officer's Create Application
page is now genuinely chrome-free — no LoanBook subtab bar and no
explanatory paragraph above the form — matching the reference design,
which shows only the application itself.

Saving now redirects to the real Loan Applications page with its
"Undisbursed loans" category pre-selected — matching the reference
design precisely: Undisbursed Loans is a real filtered *view* of the
existing Loan Applications submenu, not a separate submenu of its own (an
earlier pass in this same round briefly built it as a standalone
submenu; corrected once the reference screenshots showed it as a
category dropdown — All templates / Disbursed loans / Undisbursed loans
/ Pended loans / Declined loans — sitting above the one real table). What
counts as "undisbursed" is a single shared definition,
`isUndisbursedLoan()` — every loan whose status isn't one of a fixed set
of terminal outcomes (Active, Disbursed, Completed, Rejected, Written
Off, Cancelled) — used consistently by both the Dashboard's "Undisbursed
Loans" card and this category, so a loan still working through the
approval chain (e.g. "Waiting Regional Manager") genuinely appears here,
not just loans already fully approved for disbursement (the other three
categories reuse the same real status groupings the backend's own
`/api/loans/applications-overview` "category" filter already defines,
for consistency). The table's columns match the reference layout — a
real row number, Application (real submission date and time), Client
(resolved name, not an ID), Loan product (with a real "Schedule" link),
Loan officer, Amount/duration, Guarantor name/contact, Loan securities,
Charges, a real Approvals column, and Disbursement — plus real month/day
filter dropdowns alongside the category selector and search box, matching
a further reference screenshot showing "All templates" with 300+ real
rows. Approvals now shows the *whole* real approval chain stacked (each
approver's name and decision, in the real order they happened), not just
the most recent one — `GET /api/loans` now runs one bulk query per
request (still no N+1) returning every `loan_approvals` row per loan,
alongside the pre-existing `last_approval` field kept for backward
compatibility. Disbursement shows the loan's real most-recent event
timestamp — its real `disbursedAt` once disbursed, otherwise its latest
real approval's timestamp, otherwise its own real submission time —
replacing the earlier build's fixed "Waiting for X" status text once the
reference showed a populated date/time in that column for every row,
disbursed or not. Clicking "Schedule" on a loan that hasn't been
disbursed yet — so has no real stored installment schedule — shows a
clearly labeled *projected* preview computed with the exact same math
`buildSchedule()` will use at disbursement, never a fabricated or
hardcoded schedule.

No loan application for this weekly catalog can be created without its
real, required, upfront processing fee (a real flat `loan_products.
processing_fee_amount`, KES 600 by default, admin-editable per product,
legacy monthly products untouched) — this is now genuinely enforced by
`POST /api/loans`, not merely a frontend convenience. The Processing Fee
section appears automatically on Create Application once a real client
is matched and a fee-requiring product is selected, titled with the
client's own real name, exactly as requested. It offers two real paths
to collect it, both landing on the same real `loan_fee_payments` record:
a real STK push attempt (`POST /api/loans/processing-fee/initiate`,
reusing the exact same real Daraja OAuth/STK plumbing every other M-Pesa
feature in this codebase uses — it will genuinely attempt a Safaricom
call and honestly report NOT_CONFIGURED/FAILED in this environment,
which has no outbound network access, exactly like the STK/B2C features
documented as untested-live below), and a real manual confirmation
(`POST /api/loans/processing-fee/:id/confirm`) where the officer types in
the real M-Pesa receipt code the client read them — validated against
Safaricom's real 10-character receipt format, never accepted as free
text. This mirrors this codebase's own pre-existing C2B manual-
reconciliation pattern, since there is no real public webhook endpoint in
this environment for Safaricom's own callback to land on. Once Confirmed,
that exact payment (scoped to its one real client + product, before the
loan even exists) can be spent on exactly one loan application — reusing
it, or using it for a different client/product, is refused server-side —
and its real receipt code and amount land on the created loan itself, so
the Charges column genuinely shows a real M-Pesa-style receipt code above
the real KES amount, matching the reference exactly, with nothing
fabricated: the receipt shown is always one a human actually entered
and the backend actually validated and recorded.

Fixing this exposed a real, genuine bug in already-existing disbursement
code: `completeDisbursement()` unconditionally recomputed and overwrote
`loans.processing_fee` from the product's legacy `fee_pct` (0 for every
weekly-catalog product) at the moment of disbursement, silently
clobbering the real, already-confirmed upfront fee back to 0 the instant
a loan was disbursed. Fixed by skipping that recomputation entirely for
a product that carries a real `processing_fee_amount` — its
`processing_fee`/`processing_fee_receipt` are set once, for real, at
application time, and disbursement never touches them again. A real
regression test (in `integration.test.js`) now asserts the fee and
receipt survive disbursement unchanged, so this can't silently regress
again.

LoanBook's Collection MTD (Loan Officer view) is now the real Progressive
Disbursements page: real loans genuinely disbursed within a real,
officer-adjustable date range (defaulting to real month-to-date),
grouped by officer, backed by a new dedicated endpoint
(`GET /api/collections/progressive-disbursements`) rather than the
existing MTD engine, which answers a different real question ("what's
due in this window") — this page answers "how are the loans that
originated in this window actually progressing," a real, distinct
metric. Loan+Charges is the real principal + the real total scheduled
interest + the real confirmed upfront processing fee (0 when a loan's
product doesn't carry one); Paid is the real lifetime `paid_amount`
across the whole real schedule, not restricted to the date range, since
it tracks ongoing real recovery on loans that originated in this window,
however long that takes; Arrears is the real outstanding balance on
periods genuinely past their real due date; GC% is real Paid divided by
real Loan+Charges. Chrome-free like every other real Loan Officer
submenu page built in this flow, with a real "Totals" row that is a real
sum of the real per-officer rows, never a separately fabricated figure.

The topbar now shows "RHINOCASH LTD" at the top-left, next to the icon
row, on every real page — matching the requested reference branding. The
sidebar's upper profile block now uses Claude's own terracotta/orange as
its background, and the lower menu/submenu block is a blue-to-green
gradient, replacing solid navy across both.

LoanBook's Disbursements submenu (Loan Officer view) is now the real
Daily Disbursements calendar, replacing the old shared KPI-tile
Disbursements Overview page for this role specifically (Manager/
Regional Manager/Operational Manager still see that page, untouched,
since only the Loan Officer's own view was in scope here). A new
dedicated endpoint (`GET /api/loans/daily-disbursements`) returns real
loans genuinely disbursed on each real calendar day of a real, selected
year/month — optionally filtered by a real loan product — grouped by
real branch per day. Chrome-free, matching the reference exactly: a
Year selector, a Month selector, a Loan Product filter, and a real
Monday-to-Sunday calendar grid where each day that genuinely had a
disbursement shows its real branch name and real disbursed amount; a day
with nothing real to show is left blank, never filled with a
placeholder. This also fixes the layout the Loan Officer reported as
"behaving funny" on their own device — the old page's subtab bar and KPI
tiles are exactly what's gone now, and the replacement carries no
subtabs, no KPI grid, and no chart canvases to misbehave.

A real, small layout bug was also caught and fixed this round: the
"← <title>" pattern used on the Progressive Disbursements and Loan
Applications page headers put the arrow and title into the same real
flex container as `card-title`'s existing `justify-content:
space-between`, which is designed for a "title ... count" pair. With
three real flex items (arrow, title text, count), space-between shoved
the arrow to the far left and the title to the far right — exactly the
misplacement reported. Both headers now wrap the arrow and title
together into one flex-start-aligned group.

LoanBook's Collection Sheet submenu (Loan Officer view) is now a real,
single-day due-installment sheet — chrome-free, matching the reference
design: "Collection sheet for <date>", with Month/Day selectors that
compose the real selected date, a real Portfolio filter, a real
Installment filter, and a Generate (CSV) button. Backed by a new
dedicated endpoint (`GET /api/collections/sheet-day`), replacing the old
paginated multi-day sheet page for this role specifically (Manager/
Regional Manager/Operational Manager keep their own existing
`renderSheetBranchPage()`, untouched). "Portfolio" is the loan's own real
guarantor name — the only real per-loan "portfolio" concept this system
has; inventing a separate grouping concept that isn't modeled anywhere
else would have been fabrication. "Installment" is the real period
number out of the loan's real total number of periods (e.g. "1/4").
"Accumulated" is the real unpaid balance carried over from this loan's
earlier real periods — due before the selected date and still not fully
paid — a genuine, computed arrears figure, not a placeholder (every
loan shown in the reference happened to have 0 there; this build
computes a real, non-zero value the moment a real prior period is
genuinely unpaid). "Paid" is the real amount already paid against that
exact real installment. The real "Totals" row sums the real Amount/
Accumulated/Paid columns across the real filtered rows.

The login screen has been redesigned to match a supplied reference: a
dark navy/purple background, lime-green accents on the "Account Login"
title, the input borders' focus ring, the "▸ Login" button, and the
"Forgot Password?" link — all scoped to the `.login-screen` selector
alone (a local `--lime`/`--lime-dark` CSS custom property pair), so
none of it leaks into the shared `--navy`/`--rust-soft` variables used
elsewhere in the app. The old logo — a large embedded raster PNG that
read as a photograph rather than a mark — has been replaced everywhere
it appears (the login screen and the sidebar profile card) with a
compact, self-contained vector SVG: a simple line-art rhino silhouette
plus a "RHINOCASH LIMITED" wordmark, on its own white rounded card so it
reads correctly against both the dark login background and the
sidebar's terracotta panel. It replaced roughly 500KB of base64-encoded
PNG with about 1.2KB of inline vector markup.

"Forgot Password?" now opens a real Password Recovery screen (matching
the second supplied reference exactly: heading, "Enter your email
address linked to the account", an email field, and a "✔ Confirm"
button) wired to a new, genuinely public, unauthenticated endpoint,
`POST /api/auth/forgot-password`. A request for an email that matches a
real, Active account does exactly what the existing Admin-triggered
reset already does — a real new temporary password via the same
`generateTempPassword()`/`hashPassword()` path, `must_change_password`
forced on, every one of that user's existing sessions genuinely revoked
— and then attempts real delivery through the existing (but previously
unused) `password_reset` email template in `src/integrations/email.js`.
Consistent with this project's standing rule against fabricating
integration success: with no real `EMAIL_PROVIDER`/`EMAIL_API_KEY`/
`EMAIL_FROM_ADDRESS` configured, that attempt honestly reports
`NOT_CONFIGURED` rather than claiming an email was sent — wiring in a
real provider there is a config change, not a code change. Whether the
email matched a real account or not, the endpoint always returns the
identical generic response ("If that email is registered, password
reset instructions have been sent.") — a request for a non-existent or
Suspended account is genuinely indistinguishable from the outside, and
a Suspended account's password is verified (by hash comparison) to be
left completely untouched.

LoanBook's Collection Report submenu (Loan Officer view), right after
Collection Sheet, is now a real, chrome-free, per-client summary over a
real date range — backed by a new dedicated endpoint,
`GET /api/collections/client-report`. "Portfolio" here is deliberately
the loan's real assigned officer (`loans.officer_id`), not guarantor:
for a per-client range report, guarantor would show identical text for
unrelated clients purely from free-text data-entry coincidence (exactly
the symptom the reference screenshot showed, every row reading the same
name) — the assigned officer is the loan's actual real staff
relationship, so for a Loan Officer's own report it naturally shows
their own name on every row, matching the reference exactly. "Arrears"
reuses the identical carried-over-unpaid-balance definition as the
Collection Sheet's "Accumulated" column (periods due before the range
starts, still unpaid); "Balance" is real Collection minus real Paid for
the range itself, kept as its own column rather than folding arrears
in. The percentage badge above the table is always TODAY's real
collection percentage, never a value derived from whatever date range
happens to be selected — it calls the exact same `computeStats().
todayPct` formula the Dashboard already uses, so the two figures can
never diverge (verified directly in the frontend suite by comparing
both rendered values in the same test run). It is colored red below
24%, light purple from 24% up to (not including) 50%, and green at 50%
and above, exactly as requested. Both date inputs cap future selection
at exactly 3 real days ahead of today (enforced both as the HTML5
`max` attribute and as a real 400 on the backend for anything further
out); back dates are never restricted in either direction.

A real naming collision was caught and fixed before this shipped: an
existing, unrelated `/api/collections/report` endpoint and an existing
`loadCollectionReport()`/`DB.collectionReport` pair already existed,
backing the generic (unbuilt-list-item-turned-real) "Collection
Reports" page other roles see in their own Reports section. Reusing
those exact names silently shadowed the pre-existing function (JavaScript's last-declaration-wins
behavior for duplicate function names in the same scope) and caused a
real infinite reload loop the first time this was tested end-to-end.
Fixed by giving every new symbol a distinct name
(`/api/collections/client-report`, `loadOfficerCollectionReport()`,
`DB.officerCollectionReport`) and by keying the sidebar route through a
Loan-Officer-scoped `ROLE_ROUTE_OVERRIDES` entry rather than the global
label map, since "Collection Report" (singular) is also an existing,
not-yet-built placeholder label in Manager/Regional/Operational
Manager's own Reports section — a global route-map entry would have
hijacked their sidebar item too.

LoanBook's Collection Rates submenu (Loan Officer view) is now a real,
chrome-free, single-month, per-officer summary — backed by a new
dedicated endpoint, `GET /api/collections/officer-rates`. The label
"Collection Rates" already existed and was already reachable for every
role, unconditionally showing the generic Manager/Regional/Operational
Manager branch page (`renderCollectionRatesBranchPage()`, a due-
installment/Strong-Normal-Needs-Attention classification view, entirely
different in shape from this reference design); it now splits at the
dispatch level exactly like every other Loan-Officer-specific page in
this flow, with no new label or route-map entry needed since nothing
else claims this exact label for Loan Officer specifically. Four of
this page's eleven columns already had real, established definitions
elsewhere in the codebase and were reused verbatim rather than
recomputed: "Disbursed Loan," "Loan+Charges" (principal + the loan's
full lifetime scheduled interest + its actual confirmed processing fee),
"Arrears," and "GC%" (Paid ÷ Loan+Charges) are the exact same figures
Progressive Disbursements already established for the identical "loans
disbursed within a window" cohort — cross-checked directly in the test
suite against that endpoint's own output for the same loan, so the two
pages can never silently disagree. The remaining four columns (OTC, OC,
DD7, CG7) had no prior definition anywhere in this codebase — this is a
new reference design with no visible backend of its own to copy, so
they were inferred as real, computable, industry-standard MFI figures
rather than fabricated placeholders: OTC (On Time Collection) is the
real amount collected against installments genuinely due within the
selected month; OC (Overall Collection) is the real total cash
collected that month regardless of which installment it was applied to
(so OC only exceeds OTC when a client catches up on older arrears in
the same month); DD7 is the real slice of Arrears overdue by 7 or more
real days (a PAR7-style ageing bucket); CG7 is the real amount collected
in the last 7 real days. OTC% and OC% divide by the same Loan+Charges
denominator GC% already uses, so every percentage column on the page
sits on one consistent scale.

LoanBook's Loan Arrears submenu (Loan Officer view) is now a real,
chrome-free, per-loan arrears sheet filtered by a real "Fall Date"
window — backed by a new dedicated endpoint,
`GET /api/loans/arrears-sheet`, matching the reference design's own
column set exactly: Client / Contact / Loan / Disbursement / Cycles /
P.Arrears / Accumulated / Installment / Fall Date / Days / T.Bal. "Fall
Date" is the due date of the loan's real CURRENT (most recent, not
oldest) overdue-and-unpaid period — the installment the client is
presently behind on; "P.Arrears" is that single real period's own real
shortfall, while "Accumulated" is the real sum of every real
overdue-and-unpaid period (the same carried-over-arrears concept the
Collection Sheet already established); "Days" counts the Fall Date
itself as day 1 (today − fallDate + 1), matching the reference design's
own counting exactly; "T.Bal" is the loan's real total outstanding
balance across every real period — past, current, and not yet due,
including real unpaid penalties — the same definition the frontend's
own `loanBalance()` helper already uses; "Cycles" is the real count of
this client's own real disbursed loans (their real loan cycle number),
genuinely independent of this specific loan's own installment count.
This replaces the old KPI-bucket "Ageing Summary" page for this role
specifically — `renderArrears()`/`loadArrears()`/`GET /api/loans/arrears`
are untouched and still real and independently tested, just no longer
wired to this particular submenu.

The same submenu's "Filter Loans" dropdown offers a real two-mode split,
added after a follow-up request: "Overdue Loans" (the default, and the
sheet described above unchanged) versus "Running Loans" — every loan with
no real overdue-and-unpaid period at all, i.e. genuinely on track today,
listed instead by real disbursement date within the selected window (Fall
Date has no meaning for a loan that isn't behind, so P.Arrears/Accumulated
read real zero and Days reads zero for that mode). The page title switches
accordingly ("Loan Arrears from…" vs. "Running Loans disbursed…"), and the
backend endpoint echoes back which mode actually ran (`status: "overdue"`
or `"running"`) so the two can never be silently confused.

LoanBook's View Loans submenu (Loan Officer view) — the last item in this
role's LoanBook menu — is now a real, chrome-free loan listing reusing the
existing, already-comprehensive `GET /api/loans/view` endpoint rather than
building a parallel one: every filter on the reference design (category,
loan product, rating, cycles, a date-range/order-by/search row) maps onto
real query parameters that endpoint already accepted, extended only where
a real gap existed. Three categories reuse real, pre-existing actions
verbatim rather than inventing new state: "Rescheduled Loans" is the real
`Restructured` status set by the existing loan-restructuring action,
"WrittenOff Loans" is the real `Written Off` status set by the existing
write-off action, and "Overdue Loans"/"Non Performing" are the real
`Active`/`Disbursed` loans post-filtered by real days-past-due (`dpd>0` and
`dpd>=90` respectively) — the same DPD figure computed elsewhere in this
codebase, not a new definition. A real, previously-missing gap was fixed
along the way: the "All Loans" category's own status list had never
included `Restructured`, so a restructured loan silently dropped out of
the one category that's supposed to show everything. The Rating filter
reuses the real, existing Tag/Rate Client Loan feature
(`POST /api/loans/:id/rate`, `LOAN_RATINGS`) directly — the dropdown's
shorter reference-style labels ("Good Payer," "Bad Luck," etc.) are purely
a display mapping over the same real stored values, plus a real
`unrated`/"Untagged" filter for loans with no rating set at all. Two new
per-row fields were added to the endpoint's response: `maturityDate` (the
loan's own real final schedule period due date, computed independent of
array ordering) and `displayStatus` — a finer-grained Active / Overdue /
InDues Today / In Arrears classification distinct from the pre-existing
`liveStatus` field (left untouched for backward compatibility), where
"Overdue" specifically means the loan's own maturity date has passed while
still carrying a balance, and "In Arrears" means it has a real
overdue-and-unpaid period but hasn't yet reached maturity — the two are
genuinely different states and were cross-checked against separate
fixtures rather than assumed. The table's Status badge and Maturity dot
colors are driven directly by `displayStatus`. Four new sort keys
(`balanceasc/desc`, `amountasc/desc`, `disbursementasc/desc`,
`maturityasc/desc`) were added alongside the endpoint's existing sort
options, which were left untouched.

Two cleanup items shipped in the same pass, both at the user's explicit
request: the Loan Officer LoanBook sidebar is trimmed so View Loans is
genuinely the last submenu (Regional Loan Portfolio, Regional Loan
Portfolio Quality, Loan Approval Monitoring, and Loan Maturity Pipeline —
none of them Loan-Officer-specific pages to begin with — no longer appear
there); and the duplicate "Collection Reports" (plural) entry, a
generic-branch-page holdover that still showed its own subtabs bar and had
no genuine Loan Officer-specific purpose, was removed along with its
now-orphaned `renderCollectionReports()`/`exportCollectionReportsCSV()`
functions. This is a distinct label from the real, still-live "Collection
Report" (singular) submenu built earlier — the two were never meant to
coexist for this role.

LoanBook's page for the Payments menu isn't the only place this shows: the
Payments menu's own "Unposted Payments" submenu (Loan Officer view) is now
a real, chrome-free page, reusing — deliberately, not coincidentally — the
exact same real state, loader, and cache
(`session.c2bPaymentsState`/`loadC2bPaymentsBrowser()`/
`DB.c2bPaymentsBrowser`) as the pre-existing topbar cash-icon "Payments"
panel, over the real, pre-existing `GET /api/mpesa/c2b/transactions`
endpoint. The reference design shows this submenu as literally the same
page reached via that icon, so giving each its own separate state would
risk the two silently drifting apart (one showing stale totals the other
already refreshed); sharing one real state makes that impossible by
construction, and a dedicated frontend assertion opens both back to back
and confirms the second reuses the first's cached data rather than
re-fetching. Inspecting the existing topbar panel against the reference
surfaced one real, narrow mismatch — its header and Amount column used the
app's general "KES 1,234" formatting instead of the reference's own "Ksh
1,234" convention — fixed in both places (the topbar panel and the new
submenu) without touching the shared `fmt()` helper used everywhere else
in the app, the same "match this one reference page's own convention, not
the app's general one" approach already used for Collection Report's
purple/red accent colors and Loan Arrears' Fall Date. The Manager/
Accountant-only "Assign to loan" control on the topbar panel (`canAssign`)
is untouched and simply doesn't apply to the Loan Officer's new page, since
Loan Officers were never eligible for it to begin with.

The Payments menu's second submenu, "Processed Payments" (Loan Officer
view), is now a real, chrome-free, date-windowed page merging two
genuinely distinct real cash-collection streams: real posted loan-schedule
payments (the existing `GET /api/payments`, `status=Posted`) and real
confirmed processing-fee collections (a new, dedicated
`GET /api/loans/processing-fee/confirmed`, added specifically for this).
These are real, separate financial events in this system — a loan
installment payment and an upfront product processing fee — so they are
merged client-side into one sorted, paginated list rather than fabricating
a single combined backend row shape that doesn't exist; merging server-side
into the shared `/api/payments` endpoint was deliberately avoided since
that endpoint's row shape and totals are also used once per login to prime
dashboard aggregate math, and quietly changing what it returns there would
have been a real, hard-to-notice risk. The new confirmed-fee endpoint
reuses the exact same real scoping as every other Loan Officer list in
this codebase (a Loan Officer sees only fee payments they themselves
initiated; other roles see their real branch/region scope), and had to be
registered *before* the pre-existing `GET /api/loans/processing-fee/:id`
route — Express would otherwise match the literal path segment
"confirmed" as that route's `:id` parameter, a real routing bug caught
during this build's own visual verification (it surfaced as a repeating
"Processing fee payment not found" toast) and fixed before it shipped.
`GET /api/payments` also gained two small, purely additive fields on each
row (`client_name`, `client_phone`, from the join it already performs for
scoping) — nothing existing reads or asserts an exact row shape, so this
was safe to extend directly rather than duplicating the query. The Payment
Details column bullets each non-zero real bucket
(Principal/Interest/Penalty from `payments`, or a single "Processing fee"
line from a fee row) rather than a fixed set, matching the reference
design's own selective bullet style; bullet order is fixed
(Principal/Interest/Penalty) rather than reflecting the real
per-installment application order recorded in `payment_allocations`, a
minor, deliberate simplification since the real totals are identical
either way. The Approval column shows a real staff name when one exists
(`recorded_by` for a payment, always set for a manually-confirmed fee) or
"System" only when it's genuinely null (an auto-matched M-Pesa payment) —
shown honestly rather than forcing every row to read "System" to match the
reference screenshot's own (evidently more automated) sample data. Adding
this submenu required a small fix to two pre-existing frontend test
assertions that called `goTo('payments','Processed Payments')` while
logged in as a Loan Officer and then polled for `DB.paymentsPages.processed`
to populate — that dispatch now correctly routes a Loan Officer to this
new page instead, so the generic page's own loader never fires that way
any more; both were changed to load the generic renderer's data directly,
which is what they actually needed.

The Payments menu's third submenu, "Prepayments" (Loan Officer view), is
now a real, chrome-free, PER-LOAN aggregate view — deliberately a
different shape from the generic per-payment Prepayments page (which
stays untouched for every other role): it reuses the exact same real
`classifyPayment()`/`futureAmount` data (the real amount of a payment
applied to an installment not yet due) already established for that
generic page, just summed per loan rather than listed per payment,
matching the reference design's own single "Prepayment" total column per
row. A loan appears here only when its real accumulated future-allocated
amount is greater than zero — computed by fetching this officer's own
posted payments (already scoped server-side) and grouping their real
`classification.futureAmount` by `loan_id` client-side, then joining
against the already-loaded `DB.loans` for the real Branch/Product/Officer/
Disbursement columns. No new backend endpoint was needed for this one —
every field it needs was already real and already being returned.

Building this and the two submenus before it also surfaced a subtler
correctness issue worth recording: two pre-existing frontend tests for
"Prepayments" itself had the identical `goTo(...)` + poll-loop hang
pattern already fixed for Processed Payments, and were fixed the same way
(loading the generic renderer's data directly) for the same reason — a
Loan Officer now genuinely gets a different real page under that label,
so the dispatch a test relied on to trigger the generic page's own loader
no longer does that for this role.

The Payments menu's fourth submenu, "Overpayments" (Loan Officer view), is
now a real, chrome-free page over the exact same existing
`GET /api/payments` endpoint, filtered to `status=Overpayment` — no new
listing endpoint was needed. The real "Overpay" column is the genuine
residual left over after allocation (`amount` minus whatever was actually
applied to principal/interest/penalty) — the identical real figure
`POST /api/payments/:id/reverse` already computes when unwinding a
payment, not a separately invented number; it's now also returned as a
real `totals.overpay` aggregate (summed in SQL over the full filtered set,
the same "never just this page" convention every other total in this
codebase already follows) so the page header's Ksh figure is always
correct regardless of pagination. Two small, purely additive backend
changes made this possible: `GET /api/payments` now also returns each
row's real `client_national_id` (from the join it already performs), and
gained a dedicated `idno` filter (`c.national_id LIKE ?`) — kept separate
from the existing general-purpose `q` search since the reference design's
own search box is explicitly scoped to a client's ID number, not a
free-text name/phone/reference search. Deliberately excluded: a real
"processing fee overpayment" row, unlike the earlier Processed Payments
merge — a processing fee's amount is fixed by the server at initiation,
never a client-supplied figure that could exceed it, so no such real event
exists in this system to show here, and the user's own explicit
instruction ("all data must be real and come from the real backend and
database") ruled out fabricating one just to visually match every row
type the reference screenshot happened to show.

The Payments menu's fifth submenu, "Receipts" (Loan Officer view), is now
a real, chrome-free, two-level browser: a per-day summary for a selected
Year/Month (real posted/overpaid loan payments merged with real confirmed
processing-fee collections, the same real merge already established for
Processed Payments and Payment Receipts), and a per-day receipt-slip grid
(Client Name/Client IDNO/Loan Officer, a Description/Transaction/Total
breakdown per real allocated bucket, a TOTALS row, and real Confirmed
By/Posting Status fields) reached via "View." There is no real
"printed"/"unprinted" tracking anywhere in this system, so the Unprinted
column always shows the same real count as Receipts — never a fabricated
partial figure. This app has no PDF-generation library and no other
printable page in it has ever needed one — the existing single-receipt
detail page already relies on `window.print()` for its own "Print
Receipt" button — so "Download"/"Download All" follow that exact same
established convention: they render the real receipt-slip grid and
immediately trigger the browser's own print dialog, letting the user's
own "Save as PDF" produce the actual file, rather than inventing a new
mechanism for this one page.

A real, genuine, pre-existing bug was found and fixed while building this:
`goTo()` never cleared `session.selectedReceiptId`, so once any role
opened a specific receipt (via the "Receipt" action from Processed
Payments, Overpayments, or the Receipts list itself) and later navigated
back to the Receipts tab through the sidebar rather than that receipt's
own "← Back to Receipts" button, they'd see the same old receipt forever,
never able to reach the list again through normal navigation. This had
been latent in every role since before this round — it only became
directly observable now because the Loan Officer's own new default (list)
view made the gap visible. Fixed by having `goTo()` itself always clear
`selectedReceiptId`; `openReceipt()` re-sets it immediately afterward on
the one real call path that genuinely wants a specific receipt shown, so
existing click-through behavior for every role is unchanged.

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
