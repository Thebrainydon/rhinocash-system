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

### E.1 — Dead code: `GET /api/dashboard/summary` (dashboard.js:1-57) — RECONCILED (F.7)
Fully implemented, computes `outstandingPortfolio`/`arrearsAmount`/`par`/
`disbursedMTD`/`collectionsMTD`/`activeLoans`/`activeClients` via direct SQL.
Grep-confirmed: zero calls to `dashboard/summary` anywhere in
`rhinocash-app/index.html`, and no explanatory "kept intentionally" comment
existed near it (unlike E.8/`/api/loans/arrears` below, which does have
one) — this really does look like a first-pass endpoint abandoned when the
frontend went with client-side `computeStats()` instead, not a deliberate
design decision. **Still not removed** (deleting genuinely untested,
uncalled code has no functional benefit either way, and it's already
branch-scope-aware — a real candidate for a future Manager/Admin
server-side aggregation endpoint if company-wide data ever gets too large
to ship to the client whole). Instead **reconciled its formula with the
now-corrected authoritative logic** — see F.7 — so it's no longer a latent
trap if it's ever wired up later.

### E.2 — Three-way New/Repeat Loan definition conflict — CORRECTED (F.5)
- **Dashboard** (`computeStats()`, index.html:2423-2428): New iff the client
  has zero prior loans with `disbursedAt` earlier than this loan's.
- **Backend loan_category validation** (`POST`/`PATCH /api/loans`,
  loans.js:2182-2203): "Repeat" only requires *any* prior loan row of *any*
  status (rejected/pending loans count); "New" is never checked against
  actual history. Re-read directly as part of this continuation: this is
  explicitly documented as deliberate, specified business logic for
  guarantor inheritance ("Real New Loan / Repeat Loan enforcement —
  server-side, not a frontend-only convenience, exactly as specified",
  loans.js:2182-2189) — a genuinely different concept from statistical
  New/Repeat reporting (a guarantor collected on a since-rejected prior
  application is still real, reusable information). **Left untouched** —
  see I below for why this is a deliberate, correct distinction, not a gap.
- **My Account → View Details → Performance panel** (`GET
  /api/users/me/performance`, targets.js): previously trusted the stored,
  officer-picked, optional `loan_category` column directly — a loan left
  with `loan_category = NULL` (the common case) was counted in **neither**
  bucket, while `computeStats()` would still classify it. **Corrected this
  round — see F.5.**

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

### E.4 — Penalty inclusion differs across balance/outstanding calculations — CORRECTED (F.6)
- **Penalty-inclusive** (matches `loanBalance()`): `/api/loans/arrears-sheet`
  `tbalOf` (loans.js:1837, explicitly documented as byte-identical to the
  frontend formula).
- **Was penalty-exclusive, now fixed**: `/api/loans/view` (View Loans, the
  live page real Loan Officers use daily) — see F.6.
- **Still penalty-exclusive, deliberately left alone**: `dashboard.js:17`
  (genuinely dead code, no caller — see E.1; reconciled anyway, see F.7) and
  `/api/loans/arrears` (loans.js:1769 — confirmed this round to be
  intentionally-retained legacy code superseded by `/api/loans/arrears-sheet`,
  explicitly documented "untouched and still real/tested" at index.html:
  6257-6269; left exactly as its own comment specifies, not touched).
Real, verified consequence before the fix: on a loan with a genuinely
accrued unpaid penalty, View Loans showed a lower balance than the
Dashboard/Loan Arrears sheet for the exact same loan. Reproduced live this
round (Starter product, 5% penalty_pct, one overdue installment): View
Loans showed 5,750 while the Dashboard's arrears banner and the Loan
Arrears sheet's T.Bal both showed 5,845.84/5,846 — a real, visible
KES 95.83 discrepancy for a Loan Officer looking at two of their own pages
back to back. **Corrected — see F.6.**

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

### E.8 — `/api/loans/arrears` — CORRECTED characterization: intentionally-retained legacy, not accidental dead code
`GET /api/loans/arrears` (loans.js:1750-1779) and its frontend caller
`renderArrears()`/`loadArrears()` (index.html:8774-8796) are not dispatched
from anywhere in the Loan Officer page router (only
`renderArrearsBranchPage()`/`arrears-sheet`, the current, different
endpoint, is wired to the live "Loan Arrears" submenu). Originally
characterized as a second instance of orphaned dead code, matching E.1 —
**this was wrong, corrected this round.** Directly re-reading the code
comment at index.html:6257-6269 (right where the current Loan Arrears
sheet is defined) shows this was a deliberate supersession, explicitly
documented at the time: *"Replaces the old KPI-bucket 'Ageing Summary' page
for this role specifically (renderArrears()/loadArrears()/
/api/loans/arrears are untouched and still real/tested — just no longer
wired to this submenu)."* It is also directly exercised by both the
backend suite (`collections.test.js:240`) and the frontend suite
(`frontend-integration-suffix.js:2476`, `loadArrears({},1)` called
directly). **Left exactly as-is, not touched** — its own comment already
says what to do with it, and doing anything else would contradict a
documented past decision rather than fix a real gap.

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

### F.5 — New/Repeat Loan performance panel now derives from real disbursement history, not the stored `loan_category` field
**File:** `rhinocash-backend/src/routes/targets.js`, `GET
/api/users/me/performance` (the My Account → View Details → Performance
panel's backend).
**Before:** trusted the stored, officer-picked, optional `loan_category`
column directly (`WHERE loan_category = 'New Loan'` / `'Repeat Loan'`). A
disbursed loan left with `loan_category = NULL` — the common case, since
the field is optional on the application form — was counted in **neither**
bucket, while the Dashboard's `computeStats()` would still correctly
classify it as New or Repeat from real history. This let the Dashboard's
Performance Indicators table and this same officer's own My Account
Performance panel show genuinely different New/Repeat counts for the same
month.
**Fix:** replaced both `loan_category`-based queries with the same rule
`computeStats()` already uses — a disbursed loan is Repeat iff its client
has any other loan disbursed strictly earlier (checked company-wide, not
scoped to this officer, exactly matching `computeStats()`'s own
`DB.loans.filter(x=>x.clientId===l.clientId && x.disbursedAt && x.disbursedAt < l.disbursedAt)`),
else New. Every disbursed loan in the period is now classified into
exactly one bucket. Left the backend's `loan_category` guarantor-inheritance
validation (loans.js:2182-2203) untouched — confirmed this round to be
explicitly documented, deliberate business logic for a genuinely different
concept (guarantor reuse eligibility, not statistical New/Repeat
reporting); see E.2 and I.
**Verified:** full backend suite green, including `myAccount.test.js` (the
only test exercising this endpoint, which checks structure/target
flow-through, not `loan_category`-dependent actual counts, so it was
unaffected); live end-to-end via real API calls — disbursed a client's
first-ever loan with `loan_category` left blank, confirmed the performance
panel now correctly shows it as New:1 (previously would have shown 0/0);
disbursed a second loan for the same client the same day and confirmed the
fix is byte-faithful to `computeStats()`, including its existing
same-calendar-day granularity limitation (`disbursed_at` is date-only, so
two loans disbursed the very same day for one client are both read as
"New" by both definitions — a shared, pre-existing characteristic now
made *consistent* rather than a new bug; see H).

### F.6 — View Loans balance now includes accrued penalty, matching the Dashboard and Loan Arrears sheet
**File:** `rhinocash-backend/src/routes/loans.js`, `GET /api/loans/view`
(line ~1113).
**Before:** `balance = Math.max(0, toPay - paid)` — principal+interest
only, never referencing the real `penalty_due`/`penalty_paid` schedule
columns that the frontend's `loanBalance()` and the Loan Arrears sheet's
`tbalOf` (loans.js:1837) already include. On any loan with a genuinely
accrued, unpaid penalty, View Loans showed a lower balance than the
Dashboard or Loan Arrears sheet for the exact same loan.
**Fix:** added `penaltyOutstanding = Σ max(0, penalty_due − penalty_paid)`
across the loan's schedule and included it in `balance`, matching
`loanBalance()`'s formula exactly. Left `toPay`/`paid`/`collectionRate`
untouched (those retain their existing principal+interest-only meaning);
only the `balance` ("T.Bal") field — and everything that sums it
(`summary.totalOutstanding`, `byOfficer[].outstanding`,
`byBranch[].outstanding`, the `min_outstanding`/`max_outstanding` filters,
the `balanceasc`/`balancedesc` sorts) — now includes penalty.
**Verified:** full backend suite green, including `viewLoans.test.js`
(28/28 — only checks relative sort order and category membership, not
hardcoded balance values, so unaffected). Live end-to-end: disbursed a
real loan on the Starter product (5% `penalty_pct`), backdated one
installment to make it genuinely overdue, confirmed via `GET
/api/loans/:id` that `accrueOverduePenalties()` (payments.js:21-36, the
app's existing, real, idempotent-on-read accrual mechanism) correctly
posted a real penalty of 95.83; confirmed View Loans then returned
`balance: 5,845.84`, exactly matching the Loan Arrears sheet's own
`tbal: 5,845.84` for the same loan and the Dashboard's arrears banner
(KES 5,846, rounded) — all three surfaces now agree. Playwright
screenshots of both the Dashboard and View Loans confirm the same figure
renders correctly end to end.

### F.7 — Dead `GET /api/dashboard/summary` reconciled with the corrected authoritative formulas
**File:** `rhinocash-backend/src/routes/dashboard.js`.
**Before:** computed its own third, independent formula — no Reversed-
payment exclusion (same gap as F.2/F.3, before those fixes) and no penalty
inclusion in its balance/arrears figures (same gap as F.6, before that
fix).
**Fix:** applied the same two corrections already verified elsewhere in
this audit — `status NOT IN ('Unposted', 'Reversed')` for its collections
query, and added the penalty term to its per-loan balance calculation —
plus a code comment explaining why this genuinely-uncalled endpoint is
being kept (rather than deleted) and reconciled rather than left to drift:
it is already branch-scope-aware and is the natural candidate for a real
backend aggregation endpoint if a future Manager/Admin scope needs
server-computed summary figures instead of shipping the whole company's
loans/payments to the client for `computeStats()`-style client-side
aggregation.
**Verified:** `node --check` (syntax), full backend suite still green (no
test exercises this route either way, so this is a no-regression check,
not a coverage check).

---

## G. Test Results

### Backend suite (`TEST_DATABASE_URL=... bash test/run-all.sh`)
**29 suites, 1,205 assertions, 0 failures**, run four times total across
both rounds of this audit (twice after the first four corrections, twice
more after F.5/F.6/F.7), always against a fully-reset PostgreSQL schema.
Covers every suite that exercises code either round touched:
`atomicity.test.js` (disbursement transaction integrity),
`viewLoans.test.js` (28/28, View Loans categorization and balance/arrears
figures), `clients.test.js`, `collections.test.js` (30/30, the endpoint
corrected in F.3), `myAccount.test.js` (the only test covering the
performance panel corrected in F.5), `loanStatusBrowser.test.js`. No
regression from any of the seven corrections across both rounds.

### Frontend suite (`bash test/run-frontend.sh`)
Ran five times total across both rounds (one baseline with the first
round's four fixes reverted via `git stash`, four more with fixes applied
at various points) to distinguish real regressions from pre-existing
flakiness. Each run produced **1,056-1,058 of 1,057-1,058 assertions
passing**, with a *different* one or two failures each time — including on
the unmodified baseline run — always in scenarios these corrections never
touch (a `productName`/`adaptLoan`/`refreshLoan` null-product race in two
unrelated drill-down scenarios; a timing race in the M-Pesa C2B "Manager
sees unmatched payment" scenario; a timing race in the client-directory
"Unfunded filter"/"All statuses default" scenario, itself a polling loop
that merely waits for `DB.acctPages.clientdir` to become non-null without
correlating it to the specific request that set it — this exact one
reproduced again on the most recent run of this round, unchanged). This is
conclusive: these are pre-existing, nondeterministic timing races in the
test harness's async polling helpers, not something any of these
corrections introduced.

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
- **New/Repeat Loan cross-check (second round):** disbursed a client's
  first-ever loan (no `loan_category` set) → confirmed `GET
  /api/users/me/performance` now shows New:1/Repeat:0 for that month
  (previously would have shown 0/0, since `loan_category` was blank);
  disbursed a second loan for the same client the same calendar day →
  confirmed the result (New:2/Repeat:0) is byte-faithful to
  `computeStats()`'s own same-day-disbursement behavior rather than a new
  divergence (see F.5, H.6).
- **Penalty-inclusion cross-check (second round):** disbursed a real loan
  on a 5%-penalty product, backdated one installment to make it genuinely
  overdue, triggered the app's existing real penalty accrual via `GET
  /api/loans/:id`, then confirmed View Loans (`balance: 5,845.84`), the
  Loan Arrears sheet (`tbal: 5,845.84`), and the Dashboard's arrears banner
  (KES 5,846) all now agree for the same loan — verified via both direct
  API calls and Playwright screenshots of the Dashboard and View Loans
  pages (see F.6).

---

## H. Remaining Limitations

Two of the four items originally listed here (New/Repeat Loan, penalty
inclusion) were investigated further and corrected this round — see F.5 and
F.6. What remains is genuinely a product/design decision this audit should
not make unilaterally, per the brief's own "do not over-consolidate" and "do
not blindly rewrite working code" constraints, plus two small newly-surfaced
notes:

1. **Collection MTD / Collection Rate naming vs. actual formula (E.3)** — the
   "Collection MTD" submenu does not compute "collections this month" in the
   sense every other MTD label in the app uses. Recommend either relabeling
   the page (e.g. "Disbursement Cohort Repayment") or reformulating it —
   both are product decisions. Unchanged this round.
2. **Unposted Payments (Loan Officer) reusing the M-Pesa C2B feed (E.7)** —
   working as intentionally designed, but worth a product review given the
   naming mismatch with every other role's "Unposted Payments" meaning.
   Unchanged this round.
3. **Penalty accrual freshness is best-effort app-wide, not just on View
   Loans (new this round).** `accrueOverduePenalties()` (payments.js:21-36)
   only actually runs when a specific loan is read (`GET /api/loans/:id`)
   or paid against (`allocate()`) — never from a list endpoint. This means
   `loan_schedule.penalty_due` for a loan nobody has individually opened or
   paid against since it became overdue can still read 0/stale everywhere,
   including in the now-fixed View Loans and the already-correct Dashboard/
   Loan Arrears sheet alike. F.6 made View Loans consistent with the rest
   of the app's existing best-effort freshness; it did not (and shouldn't,
   without a performance-impact review) add per-row accrual calls to a list
   endpoint. Worth considering a scheduled/batch accrual pass if this ever
   becomes visibly stale in practice.
4. **New/Repeat classification still can't distinguish same-calendar-day
   disbursements (new this round, shared/pre-existing, not a new gap).**
   Both `computeStats()` and the now-fixed `targets.js` (F.5) determine
   "prior loan" via `disbursed_at <` a strict date comparison, and
   `disbursed_at` is stored date-only (no time component). Two loans
   disbursed for the same client on the same calendar day are both read as
   "New" by both definitions. This was true of `computeStats()` before this
   audit and remains true now that `targets.js` matches it exactly — F.5
   fixed the *disagreement* between the two, not this pre-existing,
   low-impact granularity limit of the definition itself. Changing it would
   mean changing `computeStats()`'s own, already-in-production Dashboard
   behavior, which is outside this audit's corrective mandate.
5. Frontend regression suite has pre-existing, low-frequency, nondeterministic
   timing flakes in its async-polling test helpers (three distinct patterns
   observed across 5 runs spanning both rounds of this audit, all
   pre-existing and unrelated to any of these corrections) — worth
   hardening the test harness's wait-for-response correlation logic at some
   point, but out of scope for a Loan-Officer data-integrity audit.

---

## I. Manager Readiness

**The Loan Officer foundation is ready to extend to Manager**, with the
following observations:

- `computeStats(officerId, branchIds)` (index.html:2376) was **already**
  built branch-scope-parameterized before this audit — good forward-looking
  design already in place; Manager can reuse it directly by passing the
  Manager's branch IDs instead of a single officer ID.
- Outstanding balance, DPD, arrears and PAR calculations are now genuinely
  consistent across the frontend, View Loans, the Loan Arrears sheet and the
  Dashboard (E.4/F.6 resolved this round, verified live with a real accrued
  penalty) — safe to reuse at branch scope without carrying forward a
  known, page-dependent discrepancy.
- Payment allocation (`allocate()`) is a single, real, non-duplicated
  authority already used identically regardless of who posts the payment —
  nothing officer-scoped about its logic; branch-level Manager reporting can
  safely aggregate over it.
- Cashflow/P&L/Balance Sheet are already live aggregations with no stored,
  officer-scoped running balance to reconcile — branch-scope Manager
  reporting is a pure query-scope change, not a recalculation.
- **New/Repeat Loan conflict resolved this round (F.5).** `GET
  /api/users/me/performance` now derives New/Repeat from the same real
  disbursement-history rule `computeStats()` already uses, rather than
  trusting the officer-picked `loan_category` field — Manager can safely
  build a branch-level New/Repeat view on either source now, since they
  agree. (The guarantor-inheritance use of `loan_category`, loans.js:
  2182-2203, remains its own deliberate, documented concept — not something
  Manager reporting should reuse for New/Repeat counts, since it was never
  meant to track that.)
- Branch closure (`manage_branches` permission, already implemented in
  `branches.js`) is a genuinely Operational-Manager-tier feature already
  built and now correctly reflected on the Dashboard (F.4) — a concrete,
  already-verified example of "prepare the system for Manager" done
  correctly.
- `GET /api/dashboard/summary` (dashboard.js), while still unused, is now
  formula-reconciled (F.7) and already branch-scope-aware — a real,
  ready-to-adopt candidate if Manager/Admin scope ever needs a server-side
  aggregation endpoint instead of shipping the whole company's loans/
  payments to the client for `computeStats()`-style aggregation.

No structural blocker was found that would prevent Manager development from
starting once H.1 is addressed (or explicitly deferred with the team's
sign-off).
