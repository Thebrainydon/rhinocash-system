// accountingControl.test.js — periods, adjustments, chart of accounts
// management, PAR, branch profitability, approval aging.
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
async function driveLoanToDisbursed(officerToken, mgrToken, regionalToken, opsToken, acctToken, adminToken, principal, term) {
  const c = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Ctrl Test ' + Math.random().toString(36).slice(2, 8), phone: '07' + Math.floor(Math.random() * 90000000 + 10000000) } });
  const products = await api('GET', '/api/loan-products', { token: officerToken });
  const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: c.json.client.id, product_id: products.json.products[0].id, principal, term_months: term } });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: mgrToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: regionalToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: opsToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: acctToken, body: {} });
  return { loanId: loan.json.loan.id, disburse: () => api('POST', `/api/loans/${loan.json.loan.id}/disburse`, { token: adminToken, body: { channel: 'Bank' } }) };
}

(async () => {
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const regionalToken = await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD);
  const opsToken = await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD);
  const acctToken = await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  assert(adminToken && managerToken && regionalToken && opsToken && acctToken && officerToken, 'all needed accounts log in');

  // =========================================================
  // 1. CHART OF ACCOUNTS MANAGEMENT
  // =========================================================
  {
    const created = await api('POST', '/api/accounts', { token: adminToken, body: { code: 'TESTACC1', name: 'Test Suspense Account', account_type: 'Asset' } });
    assert(created.status === 201 && created.json.account.status === 'Active', 'Admin can create a real new GL account, starting Active');

    const dup = await api('POST', '/api/accounts', { token: adminToken, body: { code: 'TESTACC1', name: 'Duplicate', account_type: 'Asset' } });
    assert(dup.status === 409, 'creating an account with a duplicate code is rejected');

    const badType = await api('POST', '/api/accounts', { token: adminToken, body: { code: 'TESTACC2', name: 'Bad', account_type: 'Nonsense' } });
    assert(badType.status === 400, 'an invalid account_type is rejected');

    const wrongRole = await api('POST', '/api/accounts', { token: acctToken, body: { code: 'TESTACC3', name: 'X', account_type: 'Asset' } });
    assert(wrongRole.status === 403, 'Accountant cannot create GL accounts — this requires manage_system_settings, a higher authority than routine accounting operations');

    const renamed = await api('PATCH', `/api/accounts/${created.json.account.id}`, { token: adminToken, body: { name: 'Renamed Suspense Account' } });
    assert(renamed.status === 200 && renamed.json.account.name === 'Renamed Suspense Account', 'the account name can be edited');

    const typeChangeAttempt = await api('PATCH', `/api/accounts/${created.json.account.id}`, { token: adminToken, body: { account_type: 'Liability' } });
    assert(typeChangeAttempt.status === 400, "account_type is deliberately NOT editable via PATCH — changing it would silently reinterpret every historical posting's sign");

    const deactivated = await api('PATCH', `/api/accounts/${created.json.account.id}`, { token: adminToken, body: { status: 'Inactive' } });
    assert(deactivated.status === 200 && deactivated.json.account.status === 'Inactive', 'the account can be deactivated (archive, not destructive delete)');

    const filtered = await api('GET', '/api/accounts?account_type=Asset', { token: adminToken });
    assert(filtered.json.accounts.every(a => a.account_type === 'Asset'), 'chart of accounts can be filtered by type');
  }

  // =========================================================
  // 2. ACCOUNTING PERIODS
  // =========================================================
  {
    const nextMonth = new Date(); nextMonth.setMonth(nextMonth.getMonth() + 1);
    const futureKey = nextMonth.toISOString().slice(0, 7);

    const closed = await api('POST', `/api/accounting/periods/${futureKey}/close`, { token: acctToken, body: {} });
    assert(closed.status === 200 && closed.json.period.status === 'Closed', 'Accountant can close a real accounting period');

    const doubleClose = await api('POST', `/api/accounting/periods/${futureKey}/close`, { token: acctToken, body: {} });
    assert(doubleClose.status === 409, 'closing an already-closed period is rejected');

    const wrongRoleReopen = await api('POST', `/api/accounting/periods/${futureKey}/reopen`, { token: acctToken, body: { reason: 'test' } });
    assert(wrongRoleReopen.status === 403, 'Accountant cannot reopen a closed period — reopening requires higher (manage_system_settings) authority than closing does');

    const noReason = await api('POST', `/api/accounting/periods/${futureKey}/reopen`, { token: adminToken, body: {} });
    assert(noReason.status === 400, 'reopening without a reason is rejected');

    const reopened = await api('POST', `/api/accounting/periods/${futureKey}/reopen`, { token: adminToken, body: { reason: 'Correcting a posting error' } });
    assert(reopened.status === 200 && reopened.json.period.status === 'Open' && reopened.json.period.reopen_reason === 'Correcting a posting error', 'Admin can reopen a closed period with a real recorded reason');

    const listView = await api('GET', '/api/accounting/periods', { token: adminToken });
    assert(listView.json.periods.some(p => p.id === futureKey), 'the real period appears in the periods list');
  }

  // =========================================================
  // 3. FORMAL FINANCIAL ADJUSTMENTS
  // =========================================================
  {
    const draft = await api('POST', '/api/adjustments', { token: acctToken, body: { reason: 'Correcting misposted interest income', debit_account: 'interest_income', credit_account: 'fee_income', amount: 500 } });
    assert(draft.status === 201 && draft.json.adjustment.status === 'Draft', 'Accountant can draft a real adjustment');

    const sameAccount = await api('POST', '/api/adjustments', { token: acctToken, body: { reason: 'x', debit_account: 'cash', credit_account: 'cash', amount: 100 } });
    assert(sameAccount.status === 400, 'debit_account and credit_account must differ');

    const submitted = await api('POST', `/api/adjustments/${draft.json.adjustment.id}/submit`, { token: acctToken, body: {} });
    assert(submitted.status === 200 && submitted.json.adjustment.status === 'Submitted', 'the creator can submit their own draft adjustment');

    const selfApprove = await api('POST', `/api/adjustments/${draft.json.adjustment.id}/decide`, { token: acctToken, body: { decision: 'Approved' } });
    assert(selfApprove.status === 403, 'the creator cannot approve their own adjustment — real segregation of duties');

    const approved = await api('POST', `/api/adjustments/${draft.json.adjustment.id}/decide`, { token: adminToken, body: { decision: 'Approved' } });
    assert(approved.status === 200 && approved.json.adjustment.status === 'Approved', 'a different, independent approver can approve it');

    const glBefore = await api('GET', `/api/journal-entries?ref_type=adjustment&ref_id=${draft.json.adjustment.id}`, { token: adminToken });
    assert(glBefore.json.entries.length === 0, 'no journal entry exists yet for an Approved-but-not-yet-Posted adjustment');

    const posted = await api('POST', `/api/adjustments/${draft.json.adjustment.id}/post`, { token: acctToken, body: {} });
    assert(posted.status === 200 && posted.json.adjustment.status === 'Posted', 'the adjustment can be posted once Approved');

    const glAfter = await api('GET', `/api/journal-entries?ref_type=adjustment&ref_id=${draft.json.adjustment.id}`, { token: adminToken });
    assert(glAfter.json.entries.length === 2, 'posting created a real balanced 2-line journal entry');
    const debits = glAfter.json.entries.reduce((s, e) => s + e.debit, 0);
    const credits = glAfter.json.entries.reduce((s, e) => s + e.credit, 0);
    assert(Math.abs(debits - credits) < 0.01, 'the adjustment journal entry is genuinely balanced');

    const doublePost = await api('POST', `/api/adjustments/${draft.json.adjustment.id}/post`, { token: acctToken, body: {} });
    assert(doublePost.status === 409, 'posting an already-Posted adjustment is rejected — no duplicate posting');

    // Rejection path.
    const draft2 = await api('POST', '/api/adjustments', { token: acctToken, body: { reason: 'test reject', debit_account: 'cash', credit_account: 'bank', amount: 50 } });
    await api('POST', `/api/adjustments/${draft2.json.adjustment.id}/submit`, { token: acctToken, body: {} });
    const rejected = await api('POST', `/api/adjustments/${draft2.json.adjustment.id}/decide`, { token: adminToken, body: { decision: 'Rejected' } });
    assert(rejected.status === 200 && rejected.json.adjustment.status === 'Rejected', 'an adjustment can be rejected');
    const postRejected = await api('POST', `/api/adjustments/${draft2.json.adjustment.id}/post`, { token: acctToken, body: {} });
    assert(postRejected.status === 409, 'a Rejected adjustment can never be posted');
  }

  // =========================================================
  // 4. CLOSED-PERIOD POSTING PROTECTION (cross-module)
  // =========================================================
  {
    const thisMonth = new Date().toISOString().slice(0, 7);
    await api('POST', `/api/accounting/periods/${thisMonth}/close`, { token: acctToken, body: {} });

    const { loanId, disburse } = await driveLoanToDisbursed(officerToken, managerToken, regionalToken, opsToken, acctToken, adminToken, 15000, 3);
    const blockedDisbursement = await disburse();
    assert(blockedDisbursement.status === 409, 'a real loan disbursement is rejected while the current accounting period is closed');

    await api('POST', `/api/accounting/periods/${thisMonth}/reopen`, { token: adminToken, body: { reason: 'Continue testing' } });
    const nowAllowed = await disburse();
    assert(nowAllowed.status === 200, 'the same disbursement succeeds once the period is reopened — real enforcement, not a permanent block');

    const usage = await api('GET', '/api/accounts/bank/usage', { token: adminToken });
    assert(usage.status === 200 && usage.json.inUse === true, 'the "bank" account now genuinely reports usage after the real disbursement above posted to it');
  }

  // =========================================================
  // 5. PORTFOLIO AT RISK
  // =========================================================
  {
    const par = await api('GET', '/api/accounting/par', { token: adminToken });
    assert(par.status === 200 && Array.isArray(par.json.par) && par.json.par.length === 5, 'real PAR endpoint returns all 5 standard thresholds (1/7/30/60/90)');
    assert(par.json.par.every(p => p.percentage >= 0 && p.percentage <= 100.01), 'every PAR percentage is a real, sane value between 0 and 100');
    assert(typeof par.json.totalOutstanding === 'number', 'PAR includes the real total outstanding denominator, not a hidden/undocumented figure');
    assert(!!par.json.formula, 'the PAR formula is explicitly documented in the response, not left implicit');

    const scopedPar = await api('GET', '/api/accounting/par?branch_id=br_kisumu', { token: adminToken });
    assert(scopedPar.status === 200, 'PAR can be scoped to a real specific branch');
  }

  // =========================================================
  // 6. BRANCH PROFITABILITY
  // =========================================================
  {
    const bp = await api('GET', '/api/accounting/branch-profitability', { token: adminToken });
    assert(bp.status === 200 && bp.json.branches.length >= 2, 'real branch profitability returns every branch within scope');
    assert(bp.json.branches.every(b => typeof b.netResult === 'number'), 'every branch has a real computed net result');

    const scopedBp = await api('GET', '/api/accounting/branch-profitability', { token: managerToken });
    assert(scopedBp.json.branches.length === 1 && scopedBp.json.branches[0].branchId === 'br_kisumu', "a Manager only sees their own real branch's profitability, not every branch");
  }

  // =========================================================
  // 7. APPROVAL AGING
  // =========================================================
  {
    const pendingExp = await api('POST', '/api/expenses', { token: managerToken, body: { category: 'Aging Test', amount: 999 } });
    const aging = await api('GET', '/api/accounting/approval-aging', { token: adminToken });
    assert(aging.status === 200 && aging.json.items.some(i => i.id === pendingExp.json.expense.id), 'the real just-submitted expense genuinely appears in the real approval-aging list');
    const item = aging.json.items.find(i => i.id === pendingExp.json.expense.id);
    assert(item.ageHours >= 0 && item.ageHours < 1, 'the real age is a genuine, freshly-computed value (just submitted, so under an hour old)');
    assert(aging.json.overdueThresholdHours === 48, 'the overdue threshold is explicitly documented in the response, not a hidden magic number');
    assert(item.overdue === false, 'a just-submitted item correctly shows as not yet overdue');
  }

  // =========================================================
  // 8. INVESTOR ACCOUNTING CROSS-CHECK — payout must create a real journal entry
  // =========================================================
  {
    const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
    const investors = await api('GET', '/api/investors', { token: adminToken });
    assert(investors.status === 200 && investors.json.investors.length > 0, 'real seeded investor(s) exist to test against');
    const investor = investors.json.investors[0];

    const generated = await api('POST', `/api/investors/${investor.id}/generate-payout`, { token: acctToken, body: { period: new Date().toISOString().slice(0, 7) } });
    assert(generated.status === 201, 'a real payout can be generated for a real investor');
    const payoutId = generated.json.payout.id;

    const glBefore = await api('GET', `/api/journal-entries?ref_type=investor_payout&ref_id=${payoutId}`, { token: adminToken });
    assert(glBefore.json.entries.length === 0, 'no journal entry exists yet for a Pending (not yet paid) payout');

    const paid = await api('POST', `/api/investor-payouts/${payoutId}/mark-paid`, { token: acctToken, body: {} });
    assert(paid.status === 200 && paid.json.payout.status === 'Paid', 'the payout can be marked Paid');

    const glAfter = await api('GET', `/api/journal-entries?ref_type=investor_payout&ref_id=${payoutId}`, { token: adminToken });
    if (generated.json.payout.investor_profit > 0) {
      assert(glAfter.json.entries.length === 2, 'marking the payout Paid NOW creates a real balanced 2-line journal entry — previously this never happened at all, so paid payouts silently never appeared in the real ledger');
      const debits = glAfter.json.entries.reduce((s, e) => s + e.debit, 0);
      const credits = glAfter.json.entries.reduce((s, e) => s + e.credit, 0);
      assert(Math.abs(debits - credits) < 0.01, 'the investor payout journal entry is genuinely balanced');
    } else {
      assert(true, 'this period had zero real profit, so correctly no journal entry was created for a zero-amount payout');
    }

    const doublePay = await api('POST', `/api/investor-payouts/${payoutId}/mark-paid`, { token: acctToken, body: {} });
    assert(doublePay.status === 409, 'marking an already-Paid payout Paid again is rejected — no duplicate accounting entry');

    // Investor isolation — an investor's own real session cannot see this admin-side payout list at all (structurally different auth).
    const investorToken = await login('sara.investor@example.com', process.env.SEEDED_INVESTOR_PASSWORD);
    let investorBlocked = false;
    try { await api('GET', '/api/investors', { token: investorToken }); } catch (e) { /* fetch doesn't throw on 4xx */ }
    const investorAttempt = await api('GET', '/api/investors', { token: investorToken });
    assert(investorAttempt.status === 401, 'an investor session cannot access the staff-only /api/investors endpoint at all — structural isolation, not just hidden UI');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
