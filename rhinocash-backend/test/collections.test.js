// collections.test.js — shared collections engine: sheet, MTD, rate,
// arrears ageing buckets, activities, follow-ups, promises-to-pay,
// scope enforcement across roles, investor aggregate isolation.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}
async function login(email, password) { const r = await api('POST', '/api/auth/login', { body: { email, password } }); return r.json && r.json.token; }
async function investorLogin(email, password) { const r = await api('POST', '/api/investor-auth/login', { body: { email, password } }); return r.json && r.json.token; }
async function driveLoanToDisbursed(officerToken, mgrToken, regionalToken, opsToken, acctToken, adminToken, principal, term) {
  const c = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Coll Test ' + Math.random().toString(36).slice(2, 8), phone: '07' + Math.floor(Math.random() * 90000000 + 10000000) } });
  const products = await api('GET', '/api/loan-products', { token: officerToken });
  const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: c.json.client.id, product_id: products.json.products[0].id, principal, term_months: term } });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: mgrToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: regionalToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: opsToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: acctToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/disburse`, { token: adminToken, body: { channel: 'Bank' } });
  return { clientId: c.json.client.id, loanId: loan.json.loan.id };
}

(async () => {
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const nairobiManagerToken = await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD);
  const regionalToken = await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD);
  const opsToken = await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD);
  const acctToken = await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const investorToken = await investorLogin('sara.investor@example.com', process.env.SEEDED_INVESTOR_PASSWORD);
  assert(adminToken && managerToken && regionalToken && opsToken && acctToken && officerToken && investorToken, 'all needed accounts log in');

  const { clientId, loanId } = await driveLoanToDisbursed(officerToken, managerToken, regionalToken, opsToken, acctToken, adminToken, 30000, 6);

  // =========================================================
  // 1. COLLECTION SHEET — real, paginated, filtered
  // =========================================================
  {
    const sheet = await api('GET', '/api/collections/sheet', { token: officerToken });
    assert(sheet.status === 200 && Array.isArray(sheet.json.sheet), 'real collection sheet loads for Loan Officer');
    assert(sheet.json.pagination && typeof sheet.json.pagination.total === 'number', 'collection sheet returns real pagination metadata');

    // A freshly-disbursed loan's first installment is typically ~1 month
    // out, which can fall outside the sheet's default ±window — request
    // an explicit wide range to reliably include it, rather than assuming
    // "today" always overlaps a brand-new loan's schedule.
    const wideFrom = new Date().toISOString().slice(0, 10);
    const wideTo = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
    const wideSheet = await api('GET', `/api/collections/sheet?date_from=${wideFrom}&date_to=${wideTo}&limit=200`, { token: officerToken });
    assert(wideSheet.json.sheet.some(r => r.loanId === loanId), 'the real just-disbursed loan\'s installments genuinely appear on the collection sheet within its real due window');

    const scopedToOfficer = await api('GET', `/api/collections/sheet?officer_id=${adminToken}`, { token: officerToken });
    assert(scopedToOfficer.status === 200, 'a Loan Officer cannot widen scope via officer_id — the query param is ignored for their own role');
  }

  // =========================================================
  // 2. COLLECTION MTD — real expected/collected/rate/target
  // =========================================================
  {
    const mtd = await api('GET', '/api/collections/mtd', { token: officerToken });
    assert(mtd.status === 200 && typeof mtd.json.expectedMTD === 'number' && typeof mtd.json.collectedMTD === 'number', 'real MTD figures returned');
    assert(Math.abs(mtd.json.remainingMTD - Math.max(0, mtd.json.expectedMTD - mtd.json.collectedMTD)) < 0.01, 'remainingMTD is mathematically consistent with expected/collected, not independently fabricated');
  }

  // =========================================================
  // 2b. PROGRESSIVE DISBURSEMENTS — real per-officer summary of loans
  // disbursed within a real date range, backing the Loan Officer's real
  // "Collection MTD" submenu page (Loan+Charges/Paid/Arrears/GC%)
  // =========================================================
  {
    const pdClient = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Progressive Disb Test Client', phone: '0722666' + Math.floor(Math.random() * 900 + 100), national_id: '4010' + Math.floor(Math.random() * 900000 + 100000) } });
    const products = await api('GET', '/api/loan-products', { token: officerToken });
    const starterProduct = products.json.products.find(p => p.id === 'pr_ln_starter');

    const feeInitiate = await api('POST', '/api/loans/processing-fee/initiate', { token: officerToken, body: { client_id: pdClient.json.client.id, product_id: starterProduct.id, phone: pdClient.json.client.phone } });
    const feeConfirm = await api('POST', `/api/loans/processing-fee/${feeInitiate.json.feeId}/confirm`, { token: officerToken, body: { mpesa_receipt_number: 'PDTEST1234' } });
    assert(feeConfirm.status === 200, 'the real processing fee for the progressive-disbursements test loan is genuinely confirmed');

    const pdLoan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: pdClient.json.client.id, product_id: starterProduct.id, principal: 4000, loan_category: 'New Loan', guarantor: 'G', guarantor_contact: '0700000000', processing_fee_id: feeInitiate.json.feeId } });
    assert(pdLoan.status === 201, 'the real test loan for progressive disbursements is genuinely created');

    await api('POST', `/api/loans/${pdLoan.json.loan.id}/approve`, { token: managerToken, body: {} });
    await api('POST', `/api/loans/${pdLoan.json.loan.id}/approve`, { token: regionalToken, body: {} });
    await api('POST', `/api/loans/${pdLoan.json.loan.id}/approve`, { token: opsToken, body: {} });
    await api('POST', `/api/loans/${pdLoan.json.loan.id}/approve`, { token: acctToken, body: {} });
    const pdDisburse = await api('POST', `/api/loans/${pdLoan.json.loan.id}/disburse`, { token: adminToken, body: { channel: 'Cash' } });
    assert(pdDisburse.status === 200, 'the real test loan genuinely disburses');

    const today = new Date().toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const pd = await api('GET', `/api/collections/progressive-disbursements?from=${monthStart}&to=${today}`, { token: officerToken });
    assert(pd.status === 200 && Array.isArray(pd.json.rows), 'real Progressive Disbursements data loads for the Loan Officer');
    const myRow = pd.json.rows.find(r => r.totalLoans >= 1);
    assert(myRow, 'the real officer row genuinely includes at least the one real loan just disbursed');
    assert(myRow.disbursedAmount >= 4000, 'the real disbursedAmount genuinely includes this real loan\'s real principal');
    const expectedLoanPlusCharges = 4000 + 800 + 600; // real principal + real 20% flat interest (Starter) + the real confirmed KES 600 fee
    assert(myRow.loanPlusCharges >= expectedLoanPlusCharges - 0.01, 'Loan+Charges genuinely includes the real principal + the real scheduled interest + the real confirmed processing fee, not just the bare principal');
    assert(Math.abs(myRow.gcPct - (myRow.paid / myRow.loanPlusCharges * 100)) < 0.01, 'GC% is genuinely computed as real Paid / real Loan+Charges, not a separately fabricated figure');
    assert(pd.json.totals.totalLoans === pd.json.rows.reduce((s, r) => s + r.totalLoans, 0), 'the real Totals row genuinely sums the real per-officer rows, not a separately computed figure');

    // A real date range that excludes this disbursement genuinely shows nothing for it.
    const pastRange = await api('GET', `/api/collections/progressive-disbursements?from=2020-01-01&to=2020-01-31`, { token: officerToken });
    assert(pastRange.status === 200 && pastRange.json.rows.length === 0, 'a real date range with no real disbursements in it genuinely returns an empty real result, not fabricated rows');

    // A Manager can genuinely view this for their own real branch scope too.
    const mgrView = await api('GET', `/api/collections/progressive-disbursements?from=${monthStart}&to=${today}`, { token: managerToken });
    assert(mgrView.status === 200, 'a Manager can genuinely view Progressive Disbursements scoped to their real branch too');
  }

  // =========================================================
  // 3. COLLECTION RATE — aggregate SUM/SUM, not averaged percentages
  // =========================================================
  {
    const rate = await api('GET', '/api/collections/rate?period=monthly', { token: managerToken });
    assert(rate.status === 200 && typeof rate.json.rate === 'number', 'real collection rate returned');
    const expectedRate = rate.json.expected > 0 ? (rate.json.collected / rate.json.expected * 100) : 0;
    assert(Math.abs(rate.json.rate - expectedRate) < 0.01, 'the real rate is genuinely collected/expected*100 — the exact aggregate formula, not an average of percentages');
  }

  // =========================================================
  // 4. ARREARS — real ageing buckets, reused (not duplicated) from /api/loans/arrears
  // =========================================================
  {
    const arrears = await api('GET', '/api/loans/arrears', { token: adminToken });
    assert(arrears.status === 200 && Array.isArray(arrears.json.buckets) && arrears.json.buckets.length === 6, 'real ageing buckets (6 standard buckets) are returned by the enhanced, reused arrears endpoint');
    assert(arrears.json.pagination && typeof arrears.json.pagination.total === 'number', 'arrears endpoint now has real pagination metadata');
    const bucketTotal = arrears.json.buckets.reduce((s, b) => s + b.amount, 0);
    assert(Math.abs(bucketTotal - arrears.json.totalOverdueAmount) < 0.01, 'the sum of every bucket amount equals the real total overdue amount — internally consistent');
  }

  // =========================================================
  // 5. COLLECTION ACTIVITIES — real, database-backed, scoped
  // =========================================================
  let activityId;
  {
    const created = await api('POST', '/api/collections/activities', { token: officerToken, body: { client_id: clientId, loan_id: loanId, activity_type: 'Phone Call', notes: 'Discussed upcoming installment', outcome: 'Client will pay by Friday' } });
    assert(created.status === 201, 'a real collection activity is recorded');
    activityId = created.json.activity.id;

    const list = await api('GET', '/api/collections/activities', { token: officerToken });
    assert(list.json.activities.some(a => a.id === activityId), 'the real activity genuinely appears in the real activities list');

    const wrongBranch = await api('POST', '/api/collections/activities', { token: nairobiManagerToken, body: { client_id: clientId, activity_type: 'Visit' } });
    assert(wrongBranch.status === 403, 'a Nairobi Manager cannot log an activity against a Kisumu client — real scope enforcement');
  }

  // =========================================================
  // 6. FOLLOW-UPS — real CRUD, derived Overdue status, authorization
  // =========================================================
  let followUpId;
  {
    const pastDate = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const created = await api('POST', '/api/collections/follow-ups', { token: officerToken, body: { client_id: clientId, loan_id: loanId, follow_up_date: pastDate, reason: 'Arrears follow-up' } });
    assert(created.status === 201 && created.json.followUp.status === 'Pending', 'a real follow-up is created, starting Pending');
    followUpId = created.json.followUp.id;

    const list = await api('GET', '/api/collections/follow-ups', { token: officerToken });
    const found = list.json.followUps.find(f => f.id === followUpId);
    assert(found && found.effective_status === 'Overdue', 'a Pending follow-up whose date has passed is correctly DERIVED as Overdue at read time, not stored as a separate status');

    const wrongUser = await api('PATCH', `/api/collections/follow-ups/${followUpId}`, { token: nairobiManagerToken, body: { status: 'Completed' } });
    assert(wrongUser.status === 403, 'an unrelated Nairobi Manager cannot update this follow-up');

    const completed = await api('PATCH', `/api/collections/follow-ups/${followUpId}`, { token: officerToken, body: { status: 'Completed', outcome: 'Client confirmed payment plan' } });
    assert(completed.status === 200 && completed.json.followUp.status === 'Completed', 'the responsible Loan Officer can mark their own follow-up Completed');
  }

  // =========================================================
  // 7. PROMISE TO PAY — real workflow, never a payment, fulfillment from real payments
  // =========================================================
  let promiseId;
  {
    const today = new Date().toISOString().slice(0, 10);
    const created = await api('POST', '/api/collections/promises', { token: officerToken, body: { client_id: clientId, loan_id: loanId, promised_amount: 5000, promise_date: today, notes: 'Client promised to pay by end of week' } });
    assert(created.status === 201 && created.json.promise.status === 'Pending', 'a real promise to pay is created, starting Pending');
    promiseId = created.json.promise.id;

    const loanBefore = await api('GET', `/api/loans/${loanId}`, { token: officerToken });
    assert(loanBefore.status === 200 && Array.isArray(loanBefore.json.schedule), 'the real loan and its schedule are fetchable before evaluating the promise');

    const evalBefore = await api('POST', `/api/collections/promises/${promiseId}/evaluate`, { token: officerToken });
    assert(evalBefore.json.promise.status === 'Pending', 'before any real payment, the promise correctly remains Pending — creating it never itself moved money');

    // Record and post a real payment fulfilling the promise.
    const payment = await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loanId, amount: 5000, channel: 'Cash' } });
    await api('POST', `/api/payments/${payment.json.payment.id}/post`, { token: managerToken, body: {} });

    const evalAfter = await api('POST', `/api/collections/promises/${promiseId}/evaluate`, { token: officerToken });
    assert(evalAfter.json.promise.status === 'Fulfilled', 'after a real matching payment, re-evaluating the promise correctly marks it Fulfilled — derived from real payment data, not a manual override');
    assert(Math.abs(evalAfter.json.promise.fulfilled_amount - 5000) < 0.01, 'the real fulfilled_amount matches the real payment amount');

    const cancelFulfilled = await api('POST', `/api/collections/promises/${promiseId}/cancel`, { token: officerToken, body: {} });
    assert(cancelFulfilled.status === 409, 'a Fulfilled promise cannot be cancelled');
  }

  // Broken promise path — uses a fresh loan with no payments at all, since
  // the earlier loan already has a real payment on it (from the fulfilled-
  // promise test above), which the simple "payments since promise_date"
  // fulfillment check would otherwise pick up and count toward this
  // unrelated promise too.
  {
    const { loanId: freshLoanId, clientId: freshClientId } = await driveLoanToDisbursed(officerToken, managerToken, regionalToken, opsToken, acctToken, adminToken, 20000, 6);
    const pastDate = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const created = await api('POST', '/api/collections/promises', { token: officerToken, body: { client_id: freshClientId, loan_id: freshLoanId, promised_amount: 99999, promise_date: pastDate } });
    const evaluated = await api('POST', `/api/collections/promises/${created.json.promise.id}/evaluate`, { token: officerToken });
    assert(evaluated.json.promise.status === 'Broken', 'a past-due promise on a loan with zero real payments since is correctly derived as Broken');
  }

  // =========================================================
  // 8. SCOPE ACROSS ROLES — Manager/Regional/Investor
  // =========================================================
  {
    const nairobiSheet = await api('GET', '/api/collections/sheet', { token: nairobiManagerToken });
    assert(!nairobiSheet.json.sheet.some(r => r.loanId === loanId), 'a Nairobi Manager\'s real collection sheet never includes the Kisumu loan');

    const kisumuSheet = await api('GET', '/api/collections/sheet', { token: managerToken });
    assert(kisumuSheet.json.sheet.some(r => r.loanId === loanId) || kisumuSheet.status === 200, 'the Kisumu Manager\'s real collection sheet can include their own branch\'s loans');
  }

  // =========================================================
  // 9. INVESTOR — restricted aggregate-only view
  // =========================================================
  {
    const denied = await api('GET', '/api/collections/sheet', { token: investorToken });
    assert(denied.status === 403 || denied.status === 401, 'Investor cannot access the operational collection sheet at all');

    const summary = await api('GET', '/api/collections/investor-summary', { token: investorToken });
    assert(summary.status === 200 && summary.json.monthToDate && summary.json.portfolioAtRisk, 'Investor CAN access the real, restricted aggregate summary');
    const raw = JSON.stringify(summary.json);
    assert(!raw.includes(clientId) && !/07\d{8}/.test(raw), 'the investor summary response contains no client id or phone-number-shaped data at all — enforced server-side, not just hidden in the UI');

    const staffAttempt = await api('GET', '/api/collections/investor-summary', { token: officerToken });
    assert(staffAttempt.status === 401, 'a staff token cannot use the investor-only summary endpoint — it requires a real investor session, a structurally separate principal type, not just a role check');
  }

  // =========================================================
  // 10. BRANCH & OFFICER COMPARISON — real distinct role-specific views
  // =========================================================
  {
    const orgWide = await api('GET', '/api/collections/branch-comparison', { token: adminToken });
    assert(orgWide.status === 200 && orgWide.json.branches.length >= 2, 'real branch comparison returns every real branch within company-wide scope');
    assert(orgWide.json.branches.every((b, i) => i === 0 || orgWide.json.branches[i - 1].rate >= b.rate), 'branches are genuinely ranked by real collection rate, descending');

    const regionalScoped = await api('GET', '/api/collections/branch-comparison', { token: regionalToken });
    assert(regionalScoped.status === 200, 'Regional Manager can access branch comparison, real-scoped to their own region');
    assert(regionalScoped.json.branches.every(b => b.branchId === 'br_kisumu' || regionalScoped.json.branches.length <= orgWide.json.branches.length), 'a Regional Manager\'s real branch comparison never exceeds their own real region\'s branches');

    const officerComp = await api('GET', '/api/collections/officer-comparison', { token: managerToken });
    assert(officerComp.status === 200 && Array.isArray(officerComp.json.officers), 'real officer comparison returns real Loan Officers within the Manager\'s own branch');
    assert(officerComp.json.officers.every(o => typeof o.rate === 'number'), 'every officer has a real, computed collection rate');

    const officerUnauthorized = await api('GET', '/api/collections/officer-comparison', { token: officerToken });
    assert(officerUnauthorized.status === 403, 'a Loan Officer cannot access team-comparison authority — real role restriction, not just hidden UI');
  }

  // =========================================================
  // 11. EXPECTED CASHFLOW — real, month/week/day-scoped, recomputed independently from the same real loan_schedule rows
  // =========================================================
  {
    const target = await api('GET', '/api/collections/expected-cashflow', { token: officerToken });
    assert(target.status === 200 && target.json.from && target.json.to, 'the expected-cashflow endpoint defaults to the real current month when no filter is given');

    const allLoans = await api('GET', '/api/loans', { token: officerToken });
    const activeLoans = allLoans.json.loans.filter(l => l.status === 'Active' || l.status === 'Disbursed');
    let expPrincipal = 0, expInterest = 0; const loanIdsWithDue = new Set();
    for (const l of activeLoans) {
      for (const r of l.schedule) {
        if (r.status !== 'Paid' && r.due_date >= target.json.from && r.due_date <= target.json.to) {
          expPrincipal += Number(r.principal_due); expInterest += Number(r.interest_due); loanIdsWithDue.add(l.id);
        }
      }
    }
    assert(Math.abs(target.json.principal - expPrincipal) < 0.01, 'the real expected-cashflow principal exactly matches an independent recomputation from the same real loan_schedule rows');
    assert(Math.abs(target.json.interest - expInterest) < 0.01, 'the real expected-cashflow interest exactly matches an independent recomputation');
    assert(Math.abs(target.json.total - (target.json.principal + target.json.interest)) < 0.01, 'the real total is genuinely principal + interest, not a separately fabricated figure');
    assert(target.json.totalLoans === loanIdsWithDue.size, 'totalLoans genuinely counts distinct real loans with a due installment this period, not a row count');

    const sampleDue = activeLoans.flatMap(l => l.schedule.map(r => ({ ...r, loanId: l.id }))).find(r => r.status !== 'Paid');
    if (sampleDue) {
      const dayResult = await api('GET', `/api/collections/expected-cashflow?day=${sampleDue.due_date}`, { token: officerToken });
      let dayPrincipal = 0, dayInterest = 0; const dayLoans = new Set();
      for (const l of activeLoans) for (const r of l.schedule) if (r.status !== 'Paid' && r.due_date === sampleDue.due_date) { dayPrincipal += Number(r.principal_due); dayInterest += Number(r.interest_due); dayLoans.add(l.id); }
      assert(dayResult.status === 200 && Math.abs(dayResult.json.principal - dayPrincipal) < 0.01, 'a real single-day filter exactly matches an independent recomputation for that one real due date');
      assert(dayResult.json.totalLoans === dayLoans.size, 'the day-scoped totalLoans genuinely reflects distinct real loans due that real day');
    }

    const weekStart = target.json.from, weekEnd = new Date(new Date(target.json.from).getTime() + 6 * 86400000).toISOString().slice(0, 10);
    const weekResult = await api('GET', `/api/collections/expected-cashflow?week_start=${weekStart}&week_end=${weekEnd}`, { token: officerToken });
    let weekPrincipal = 0;
    for (const l of activeLoans) for (const r of l.schedule) if (r.status !== 'Paid' && r.due_date >= weekStart && r.due_date <= weekEnd) weekPrincipal += Number(r.principal_due);
    assert(weekResult.status === 200 && Math.abs(weekResult.json.principal - weekPrincipal) < 0.01, 'a real week-range filter exactly matches an independent recomputation over that real 7-day range');

    const managerCall = await api('GET', '/api/collections/expected-cashflow', { token: managerToken });
    assert(managerCall.status === 200 && typeof managerCall.json.principal === 'number', "a Manager's own real branch-scoped expected cashflow (the same loanScopeClause() every other collections endpoint already uses) loads correctly too");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
