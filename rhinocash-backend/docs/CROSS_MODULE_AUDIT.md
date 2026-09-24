# Rhinocash — Loan Officer Cross-Module Data, Calculation & Dependency Audit

**Scope:** Complete architectural/data-integrity audit of the finished Loan Officer
role — Accounting, Clients, LoanBook, Payments, My Account, System & Help,
Dashboard — performed before starting Manager-role development, per the explicit
gating requirement that the Loan Officer foundation be verified as one coherent,
interconnected system first.

**Method:** Direct code reading (frontend `rhinocash-app/index.html`, backend
`rhinocash-backend/src/routes/*.js`) plus four focused research passes covering
Collection MTD/Rate sources, New/Repeat Loan definitions, Arrears/DPD/PAR/
Outstanding sources, and Payment allocation + Accounting integration. Every
finding below is anchored to an exact file:line citation. Nothing here was
fabricated or assumed — every figure, table and endpoint named was read directly
from the real source.

---

## A. Module Dependency Map

```
Clients ──┬─→ LoanBook (loan.client_id; a loan cannot exist without a client)
          └─→ Dashboard (totalClients/activeClients/dormantClients derived from
                          Clients × LoanBook loan activity, not Clients alone)

LoanBook ─┬─→ Payments (payments.loan_id; a payment cannot exist without a loan)
          ├─→ Accounting (disbursement posts journal_entries; loan_schedule
          │               drives Cashflow/P&L/Balance Sheet indirectly)
          ├─→ Collections (all Collection* submenu pages read loans+loan_schedule)
          └─→ Dashboard (computeStats() consumes DB.loans directly)

Payments ─┬─→ LoanBook (payment allocation writes loan_schedule.paid_amount,
          │              which is what "balance"/"arrears"/"DPD" everywhere read)
          ├─→ Accounting (every posted/reversed payment writes journal_entries)
          └─→ Dashboard (computeStats() consumes DB.payments directly)

Accounting ┬─→ (reads live from journal_entries; does not feed LoanBook/
           │    Payments/Dashboard back — one-directional consumer)
           └─→ Requisitions/Utility Payments feed Accounting's ledger only,
                never the Dashboard directly (confirmed, see E.6)

My Account ──→ reads GET /api/users/me/performance (targets.js), a THIRD,
               independent calculation of New/Repeat Loans — see E.2

System & Help ─→ standalone (tickets/FAQ), no financial dependency
```

Key structural fact confirmed by direct reading: almost everything in LoanBook,
Payments and the Dashboard ultimately reduces to two real, shared tables —
`payments` and `loan_schedule` — updated by exactly one allocation function
(`allocate()`, `payments.js:38-86`). Accounting reads the same ground truth a
third way, via `journal_entries`, posted from the same disbursement/payment
code paths. This is fundamentally sound architecture; the problems found below
are about *which read path* each screen uses on top of that shared ground
truth, not about the ground truth itself being duplicated.

---

## B. Data Dependency Map

| Record created | Immediately feeds |
|---|---|
| `clients` row created | LoanBook client picker; Dashboard `totalClients` |
| `loans` row created (`POST /api/loans`) | Loan Applications list; `loan_category` validated against prior loans (loans.js:2165-2186) |
| Loan approved through 4-step workflow (`manager→regional_manager→operational_manager→accountant`, `approval_workflow_steps`) | `loans.status` progression; Disbursement eligibility |
| Loan disbursed (`completeDisbursement()`, loans.js:90-152) | `loans.status='Active'`, `disbursed_at` set; `loan_schedule` built; 2-3 `journal_entries` rows (receivable debit, funding credit, fee income credit); **client `status` promoted Dormant→Active (new, see F.1)** |
| Payment posted (`POST /api/payments`, `POST /api/payments/:id/post`) | `allocate()` (payments.js:38-86) writes `payment_allocations` rows + updates `loan_schedule.paid_amount`/`status` per installment (oldest-due-first, P+I pro-rata then penalty) → this is the SAME update every balance/arrears/collection calculation in the app ultimately reads |
| Payment reversed (payments.js:391-419) | Same schedule rows decremented back out, penalty-then-P&I mirror order; `payments.status='Reversed'` |
| Branch closed (`POST /api/branches/:id/close`, branches.js:189-197, blocked if any Active/Disbursed loan exists) | `branches.status='Closed'` — now correctly excluded from Dashboard's Active Branches tile (F.3) |

---

## C. Calculation Dependency Map

| Calculation | Authoritative source | Reused correctly by |
|---|---|---|
| Outstanding balance | `total_due − paid_amount` summed over `loan_schedule` rows (frontend `loanBalance()`, index.html:1349-1351; backend independently re-derives the same formula in several places — see E.4) | Dashboard, Loan Arrears sheet (loans.js:1837, byte-identical), Collection Rates arrears figure |
| DPD / arrears days | Oldest unpaid schedule row's due date vs today (frontend `loanArrearsDays()`, index.html:1360-ish) | Dashboard `performingLoans`/`arrearsAmt`/`par`; `/api/loans/arrears` (loans.js:1768, same rule) |
| Payment allocation | `allocate()`, payments.js:38-86 — the ONLY real allocation implementation in the codebase (confirmed no duplicate; one display-only reconstruction exists, see E.5) | Every payment-posting code path; every balance/arrears figure downstream |
| Cashflow / P&L / Balance Sheet | Live aggregation over `journal_entries` via `ledgerBalance()` (accounting.js:15) — no stored running balance anywhere | Requisitions, Utility Payments, disbursement fee income, payment interest income all post into this one ledger |
| Client Active/Dormant (Dashboard) | Derived from real loan activity: a client with any loan in `activeScope` (`["Active","Disbursed"]`) is Active (`computeStats()`, index.html:2413-2415) | Dashboard tiles only |
| Client Active/Dormant (View Clients) | Stored `clients.status` column, previously never auto-transitioned — now promoted at disbursement time (F.1) | View Clients filter, Client Account |

---

## D. Dashboard Data Map

Every KPI/tile/chart on the Loan Officer Dashboard is rendered from ONE function
call, `computeStats(me.id)` (index.html:2686), whose full internals are listed
below. No Dashboard tile calls a separate backend aggregation endpoint — the
real, fully-implemented `GET /api/dashboard/summary` (dashboard.js:1-57) is
dead code, confirmed unreachable (see E.1).

| Tile / chart | Field | Calculation | Source data |
|---|---|---|---|
| Disbursement MTD | `st.disbursedMTD`, `st.loansMTDCount` | Sum of `principal` / count, loans with `disbursedAt` in current calendar month | `DB.loans` (client-side, from `GET /api/loans`) |
| "{month} OTC" | `st.otcPct`, `st.collectionsMTD` | `collectionsMTD ÷ dueMTD × 100`, capped 150% | `DB.payments` (status ≠ Unposted/Reversed) ÷ `DB.loans[].schedule` due this month |
| Disbursement YTD | `st.disbursedYTD`, `st.loansYTDCount` | Same as MTD, year-to-date | `DB.loans` |
| "{prevMonth} COLLECTION" | `st.collPctPrev`, `st.collectionsPrev` | Same formula, previous calendar month | `DB.payments` / `DB.loans[].schedule` |
| Undisbursed Loans | `st.undisbursedCount`, `st.undisbursedAmt` | `isUndisbursedLoan()` — status not in `LOAN_TERMINAL_STATUSES` | `DB.loans` |
| Total Clients | `st.totalClients` | Distinct clients with ≥1 loan owned by this officer | `DB.clients` × `DB.loans` |
| Active Clients | `st.activeClients` | Distinct clients with a loan in `["Active","Disbursed"]` | `DB.loans` |
| Dormant Clients | `st.dormantClients` | `totalClients − activeClients` | derived |
| Performing | `st.performingLoans` | Active-scope loans with `loanArrearsDays()===0` | `DB.loans` |
| Loan Arrears banner | `st.arrearsAmt`, `st.par`, `st.portfolioOutstanding` | `Σ loanBalance()` over arrears loans; PAR = arrears ÷ outstanding | `DB.loans` |
| Active Branches | `DB.branches.filter(b=>b.status==='Active').length` | **Fixed this audit** — was unfiltered `DB.branches.length` (F.3) | `GET /api/branches` |
| Active Staff | `DB.staff.filter(s.status==='Active').length` | count | `GET /api/users` |
| New/Repeat Loans (Performance Indicators table) | `st.newLoans`/`st.repeatLoans` | Client's first-ever loan with a `disbursedAt` earlier than this one ⇒ Repeat, else New | `DB.loans`, all history |
| Loan Cycle pie / Products Distribution / Client Loans Analysis | derived from `activeScope`/loan history, same `computeStats()` scope | `DB.loans` |

No Dashboard tile independently re-queries the backend for a figure that
`computeStats()` already produces — this is confirmed correct, single-source
architecture on the frontend side. The divergence problem in this system is
not "Dashboard vs. backend disagree" but "different LoanBook/Payments/My
Account SCREENS disagree with the Dashboard and with each other" — detailed
in E below.

---

## E. Duplication / Conflict Report

### E.1 — Dead code: `GET /api/dashboard/summary` (dashboard.js:1-57)
Fully implemented, computes `outstandingPortfolio`/`arrearsAmount`/`par`/
`disbursedMTD`/`collectionsMTD`/`activeLoans`/`activeClients` via direct SQL —
using its own third, independent formula. Grep-confirmed: zero calls to
`dashboard/summary` anywhere in `rhinocash-app/index.html`. **Not removed**
this round (removing working-but-unused code has no functional benefit and
carries a small risk of breaking something not yet discovered to depend on
it); documented here as a latent trap — if anyone ever wires it up later, it
will silently disagree with `computeStats()` on penalty inclusion and
Reversed-payment handling. **Recommendation for Manager phase:** either wire
it up as the real Manager branch-scope aggregation endpoint (reconciling its
formula with `computeStats()` first) or delete it.

### E.2 — Three-way New/Repeat Loan definition conflict (real, user-visible)
- **Dashboard** (`computeStats()`, index.html:2423-2428): New iff the client
  has zero prior loans with `disbursedAt` earlier than this loan's.
- **Backend loan_category validation** (`POST`/`PATCH /api/loans`,
  loans.js:2165-2186, 2251-2264): "Repeat" only requires *any* prior loan row
  of *any* status (rejected/pending loans count); "New" is never checked
  against actual history, only used for guarantor-requirement logic.
- **My Account → View Details → Performance panel** (`GET
  /api/users/me/performance`, targets.js:344-351): trusts the stored,
  officer-picked, optional `loan_category` column directly — a loan left
  with `loan_category = NULL` (the common case) is counted in **neither**
  bucket here, while `computeStats()` would still classify it.
Net effect: the Dashboard's Performance Indicators table and the My Account
Performance panel can show genuinely different New/Repeat counts for the same
officer/month. **Not corrected this round** — fixing `targets.js` to
recompute from disbursement history instead of trusting `loan_category` is a
real behavior change to a displayed historical panel, and risks shifting
numbers Loan Officers have already seen for past months without a clear,
scoped way to validate the change against real historical data in this
session. Flagged as the top follow-up item for the next round (see H).

### E.3 — Collection MTD / Collection Rate: four genuinely different formulas share overlapping names
- `computeStats().collectionsMTD` (Dashboard): real cash payments dated in
  the *current calendar month*.
- "Collection MTD" submenu (`renderCollectionMTD()` → `GET
  /api/collections/progressive-disbursements`, collections.js:497-540):
  despite its label, this is **lifetime** repayment (`paid ÷
  loanPlusCharges`) for loans **disbursed** in a user-editable range — a
  disbursement-cohort lifetime metric, not "cash collected this month."
- "Collection Rates" submenu (`GET /api/collections/officer-rates`,
  collections.js:566-629): OTC%/OC%/GC% divide by lifetime
  `loanPlusCharges` for loans disbursed in the selected month — a third,
  different denominator and cohort.
- Manager's branch-level "Collection MTD" (`GET
  /api/collections/mtd-branch`, collections.js:344-393): `collected ÷
  expected`, both from schedule rows due this month — closest in spirit to
  the Dashboard's own OTC%, but reads `loan_schedule.paid_amount` rather than
  the `payments` table computeStats() uses.
This is a genuine, user-facing labeling/definition problem (an officer
looking at "Collection MTD" is not looking at "collections this month" in
the Dashboard sense at all). **Not corrected this round** — relabeling or
reformulating an existing, presumably-relied-upon report page is a design
decision beyond a data-integrity bug fix, and risks changing numbers
officers already report against. Flagged for Manager-readiness follow-up
(H); the underlying `payments`/`loan_schedule` tables themselves are not in
conflict, only the aggregation each page chooses to run over them.

### E.4 — Penalty inclusion differs across balance/outstanding calculations
- **Penalty-inclusive** (matches `loanBalance()`): `/api/loans/arrears-sheet`
  `tbalOf` (loans.js:1837, explicitly documented as byte-identical to the
  frontend formula).
- **Penalty-exclusive**: `/api/loans/view` (loans.js:1103-1105, the backend
  for View Loans), the dead `dashboard.js:17`, `/api/loans/arrears`
  (loans.js:1769).
Real consequence: on any loan with an actually-accrued unpaid penalty, View
Loans shows a lower balance than the Dashboard/Loan Arrears sheet for the
same loan. **Not corrected this round** — determining the *intended* design
(is View Loans' principal+interest-only balance deliberate, e.g. to show
"contractual balance" separately from "balance including penalty"?) needs a
product decision this audit cannot make unilaterally; flagged for follow-up
(H).

### E.5 — Payment allocation: one real authority, one cosmetic-only duplicate
`allocate()` (payments.js:38-86) is confirmed the only place money is ever
actually allocated — no second real implementation exists. One
**display-only** reconstruction exists at `GET
/api/loans/:id/schedule/:scheduleId/transactions` (loans.js:1947-1989),
which replays `payment_allocations` sequentially (principal-first, then
interest) for a receipt/drill-down view, versus `allocate()`'s real pro-rata
P+I split. Row totals still reconcile; only the *displayed* per-transaction
principal/interest split in that one drill-down view is computed by a
different (but harmless, ledger-neutral) method. **Not corrected** — no
financial impact, correcting it is a pure cosmetic-consistency nice-to-have
with no user-facing bug attached; documented for completeness.

### E.6 — Requisitions / Utility Payments correctly isolated from the Dashboard
Confirmed as **not** a bug: both post into the shared `journal_entries`
ledger (feeding Cashflow/P&L/Balance Sheet, as they should), and confirmed
via grep that `dashboard.js` never references `requisitions`,
`utility_payments`, `operating_expense` or `ledgerBalance` — so they
correctly do not leak into any Loan Officer Dashboard KPI. Listed here only
because the audit brief specifically asked this question; no action needed.

### E.7 — Unposted Payments (Loan Officer) reuses a different table by design
The Loan Officer's own "Unposted Payments" sidebar item is deliberately wired
(index.html:13765-13770, explicit code comment) to the topbar M-Pesa C2B
transactions browser (`GET /api/mpesa/c2b/transactions`, raw
`mpesa_c2b_transactions` feed) rather than `GET /api/payments?status=Unposted`
(the real `payments` table filter every other role's "Unposted Payments" tab
uses, `renderUnposted()`, index.html:9175-9180). This is a documented,
intentional design choice, not an accident, but it means a genuinely
`payments.status='Unposted'` row will not necessarily appear here unless it
also happens to correspond to an unmatched/recent C2B transaction. **Not
corrected** — this is an intentional, working design per its own code
comment; flagged only as a naming-expectation risk worth a product review,
not a bug this audit should silently "fix."

### E.8 — Dead/unreached code, second instance: `/api/loans/arrears`
`GET /api/loans/arrears` (loans.js:1750-1779) and its frontend caller
`renderArrears()`/`loadArrears()` (index.html:8774-8796) are not dispatched
from anywhere in the Loan Officer page router (only
`renderArrearsBranchPage()`, a different endpoint, is wired for non-officer
roles). Same pattern as E.1 — a real, correctly-written but currently
unreachable calculation. Left in place, documented here.

---

## F. Corrections Made

All three corrections below were scoped deliberately narrow: each fixes a
concrete, evidenced divergence between a stored/displayed figure and the
system's own established authoritative logic, none of them invents new
business rules, and none of them touch a page's labeling, formula design, or
report semantics (per the audit's explicit "do not fix the display number,
fix the calculation" and "do not over-consolidate" constraints).

### F.1 — Client status now auto-promotes Dormant → Active at disbursement
**File:** `rhinocash-backend/src/routes/loans.js`, inside `completeDisbursement()`'s
existing atomic transaction (line ~131, right after schedule build).
**Before:** `clients.status` was set to `'Dormant'` at registration and never
auto-transitioned by any code path (grep-confirmed: only two human-driven
`UPDATE clients SET status` call sites existed, neither disbursement-related).
Meanwhile the Dashboard's own `activeClients`/`dormantClients` figures are
derived independently from real loan activity, not this column. Result: a
client with a genuinely active, disbursed loan could sit under View Clients'
"Dormant" filter forever, while the Dashboard correctly counted them Active —
two permanently disagreeing definitions of "Active client," visible to the
same officer on two different screens.
**Fix:** `UPDATE clients SET status = 'Active' WHERE id = ? AND status =
'Dormant'` added inside the disbursement transaction — additive only (never
touches a `Blacklisted` client), commits atomically with the loan
status/schedule/journal entries it already commits with.
**Verified:** full backend regression suite green (atomicity.test.js,
viewLoans.test.js, clients.test.js all pass unchanged); live end-to-end
verification via real API calls (client created → Dormant; loan created →
approved through all 4 workflow steps → disbursed by Manager; client
re-fetched → `status: "Active"`); Playwright screenshot confirms the same
client now correctly appears under View Clients' default "Active clients"
filter.

### F.2 — `computeStats()` no longer double-counts Reversed payments
**File:** `rhinocash-app/index.html`, `computeStats()` (4 call sites: lines
~2398-2399, ~2405, ~2432).
**Before:** `collectionsMTD`, `interestIncomeMTD`, `collectionsPrev`,
`todayPct`/`collectedToday` all filtered only `p.status !== "Unposted"` —
never excluding `p.status === "Reversed"`. A reversed payment's original
amount still counted toward the Dashboard's MTD/OTC/today figures, even
though the rest of the app (loan statements, `loan_schedule.paid_amount`
after reversal, Collection Sheet/Report) correctly nets reversals back out.
This is the exact "financial figures calculated independently with
conflicting logic" pattern the audit brief specifically asked to find.
**Fix:** added `&& p.status !== "Reversed"` to all four filters, matching the
convention already used elsewhere in the same file (e.g. loan statement
rendering, index.html:5155) and matching how the backend's own reversal
handler (payments.js:391-409) already treats a reversed payment as not
contributing to collected totals.
**Verified:** full backend + frontend regression suites green; isolated,
low-risk change confined to one already-shared calculation function.

### F.3 — Same Reversed-payment fix applied to Collection Rates backend endpoint
**File:** `rhinocash-backend/src/routes/collections.js`,
`GET /api/collections/officer-rates` (line 584).
**Before:** the endpoint's own internal payments query excluded only
`'Unposted'`, while its `otc`/`paid`/`arrears` figures (computed from
`loan_schedule`, which *does* net out reversals) sat alongside `oc`/`cg7`
figures (computed from raw `payments` rows, which did *not*) — a single API
response internally inconsistent about whether a reversed payment counts,
depending on which column you read.
**Fix:** `status != 'Unposted'` → `status NOT IN ('Unposted', 'Reversed')` —
a one-line, isolated SQL change to a single query already scoped to this one
endpoint.
**Verified:** `collections.test.js` (30 assertions) passes unchanged.

### F.4 — Dashboard "Active Branches" tile now filters by branch status
**File:** `rhinocash-app/index.html`, `orgCounts()` (line 2617).
**Before:** `DB.branches.length` — an unfiltered count of every branch
record ever loaded, regardless of `status`. Confirmed this is not a
theoretical concern: a real, working `POST /api/branches/:id/close`
endpoint already exists (`manage_branches` permission, branches.js:189-197,
with real business-rule protection against closing a branch with active
loans) — the branches table genuinely gets non-Active rows in normal system
use, so this tile was silently wrong for any branch ever closed via that
existing endpoint. This is also directly relevant to Manager readiness (item
18 of the audit brief), since branch lifecycle management is an
Operational-Manager-tier feature that already exists in the backend today.
**Fix:** `DB.branches.filter(b=>b.status==='Active').length`.
**Verified:** live end-to-end via Playwright — closed a real seeded branch
(`br_mombasa` → `status='Closed'`) in the dev database, logged in as the
seeded Loan Officer, confirmed the Dashboard tile correctly dropped from 3 to
2, and confirmed no other tile or page broke (full-page screenshot reviewed).

---

## G. Test Results

### Backend suite (`TEST_DATABASE_URL=... bash test/run-all.sh`)
**29 suites, 1,160+ assertions, 0 failures**, run twice against a fully-reset
PostgreSQL schema, including every suite that exercises code this audit
touched: `atomicity.test.js` (disbursement transaction integrity),
`viewLoans.test.js` (28/28, View Loans categorization), `clients.test.js`,
`collections.test.js` (30/30, the exact endpoint corrected in F.3),
`loanStatusBrowser.test.js`. No regression from any of the four corrections.

### Frontend suite (`bash test/run-frontend.sh`)
Ran four times total (one baseline with all four fixes reverted via `git
stash`, three with the fixes applied) to distinguish real regressions from
pre-existing flakiness. Each run produced **1,056-1,057 of 1,057-1,058
assertions passing**, with a *different* one or two failures each time —
including on the unmodified baseline run — always in scenarios this audit's
four edits never touch (a `productName`/`adaptLoan`/`refreshLoan`
null-product race in two unrelated drill-down scenarios; a timing race in
the M-Pesa C2B "Manager sees unmatched payment" scenario; a timing race in
the client-directory "Unfunded filter" scenario, itself a polling loop that
merely waits for `DB.acctPages.clientdir` to become non-null without
correlating it to the specific request that set it). This is conclusive:
these are pre-existing, nondeterministic timing races in the test harness's
async polling helpers, not something these four corrections introduced.

### Manual cross-module tests (live dev database, real API + UI)
- **CLIENT TEST:** created a real client via `POST /api/clients` → confirmed
  `status: "Dormant"` at creation, confirmed it appears correctly on the
  Clients page.
- **LOAN TEST → DISBURSEMENT TEST (combined):** created a loan application
  for that client, advanced it through all 4 real approval steps (Manager →
  Regional Manager → Operational Manager → Accountant, exactly matching
  `approval_workflow_steps`), disbursed it as a real Manager account →
  confirmed loan `status: "Active"` with a real `disbursed_at`, confirmed the
  client's `status` was atomically promoted to `"Active"` in the same
  transaction, confirmed the Dashboard's Disbursement MTD tile
  (`KES 5,000 · 1 Loans`), Total/Active/Dormant Clients tiles (1/1/0), and
  View Clients' default Active-clients filter all now agree with each other
  for this exact client/loan — the specific cross-module consistency the
  audit brief's CLIENT/LOAN/DISBURSEMENT tests asked to verify.
- **Active Branches tile:** closed a real branch via direct status update
  (equivalent effect to the real `/api/branches/:id/close` endpoint),
  confirmed the Dashboard tile correctly excluded it (3 → 2) while every
  other tile/section on the page rendered unaffected (full-page screenshot
  reviewed).
- **PAYMENT TEST:** not separately exercised live this round (would require
  building a full posted-payment scenario); covered instead by the backend
  regression suite's own payment/allocation/reversal assertions
  (`atomicity.test.js`, `collections.test.js`), which passed unchanged
  against the corrected code.

---

## H. Remaining Limitations

Documented, not fixed, this round — each requires a product/design decision
this audit should not make unilaterally, per the brief's own "do not
over-consolidate" and "do not blindly rewrite working code" constraints:

1. **New/Repeat Loan three-way conflict (E.2)** — highest-priority follow-up.
   Recommend deciding whether `GET /api/users/me/performance` (targets.js)
   should be changed to recompute New/Repeat from real disbursement history
   (matching `computeStats()`), or whether `loan_category` should instead
   become a required, backend-validated-against-history field at loan
   creation time so the officer-picked value is always correct. Either fix
   is a real behavior change to a currently-displayed historical panel and
   needs sign-off before implementation.
2. **Collection MTD / Collection Rate naming vs. actual formula (E.3)** — the
   "Collection MTD" submenu does not compute "collections this month" in the
   sense every other MTD label in the app uses. Recommend either relabeling
   the page (e.g. "Disbursement Cohort Repayment") or reformulating it —
   both are product decisions.
3. **Penalty inclusion divergence between View Loans and Dashboard/Loan
   Arrears balance figures (E.4)** — needs a decision on whether View Loans'
   principal+interest-only balance is intentional.
4. **Two confirmed dead-code endpoints** (`GET /api/dashboard/summary`,
   `GET /api/loans/arrears`) — harmless today, but a trap for future
   development if ever wired up without reconciling their independent
   formulas first. Recommend removing or explicitly repurposing both before
   Manager work begins.
5. **Unposted Payments (Loan Officer) reusing the M-Pesa C2B feed (E.7)** —
   working as intentionally designed, but worth a product review given the
   naming mismatch with every other role's "Unposted Payments" meaning.
6. Frontend regression suite has pre-existing, low-frequency, nondeterministic
   timing flakes in its async-polling test helpers (three distinct patterns
   observed across 4 runs, all pre-existing and unrelated to this audit's
   changes) — worth hardening the test harness's wait-for-response
   correlation logic at some point, but out of scope for a Loan-Officer data-
   integrity audit.

---

## I. Manager Readiness

**The Loan Officer foundation is ready to extend to Manager**, with the
following observations:

- `computeStats(officerId, branchIds)` (index.html:2376) was **already**
  built branch-scope-parameterized before this audit — good forward-looking
  design already in place; Manager can reuse it directly by passing the
  Manager's branch IDs instead of a single officer ID.
- Outstanding balance, DPD, arrears and PAR calculations are genuinely
  consistent between the frontend and the Loan-Officer-scoped backend
  arrears sheet (E.4 aside, which is a penalty-inclusion detail, not a
  structural conflict) — safe to reuse at branch scope.
- Payment allocation (`allocate()`) is a single, real, non-duplicated
  authority already used identically regardless of who posts the payment —
  nothing officer-scoped about its logic; branch-level Manager reporting can
  safely aggregate over it.
- Cashflow/P&L/Balance Sheet are already live aggregations with no stored,
  officer-scoped running balance to reconcile — branch-scope Manager
  reporting is a pure query-scope change, not a recalculation.
- **Before building Manager**, address item H.1 (New/Repeat Loan conflict)
  first if Manager's own dashboard will show branch-level New/Repeat
  figures — building a Manager view on top of `targets.js`'s currently
  divergent definition would propagate the same inconsistency to a second,
  higher-visibility role. The Dashboard-side `computeStats()` definition is
  the one Manager should inherit, since it is already branch-scope-ready.
- Branch closure (`manage_branches` permission, already implemented in
  `branches.js`) is a genuinely Operational-Manager-tier feature already
  built and now correctly reflected on the Dashboard (F.4) — a concrete,
  already-verified example of "prepare the system for Manager" done
  correctly.

No structural blocker was found that would prevent Manager development from
starting once H.1 is addressed (or explicitly deferred with the team's
sign-off).
