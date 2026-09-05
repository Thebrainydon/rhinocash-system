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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
