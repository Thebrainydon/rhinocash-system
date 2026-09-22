// integration.test.js — hits the REAL, currently-running server with real
// HTTP requests (Node's built-in fetch). Run the server first:
//   node server.js &
//   node test/integration.test.js
'use strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('OK:', msg); }
  else { fail++; console.error('FAIL:', msg); }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

(async () => {
  // ---- 1. Health ----
  {
    const r = await api('GET', '/api/health');
    assert(r.status === 200 && r.json.ok, 'health check responds');
  }

  // ---- 2. Auth: wrong password fails, tracked ----
  {
    const r = await api('POST', '/api/auth/login', { body: { email: 'admin@rhinocash.co.ke', password: 'wrong-password' } });
    assert(r.status === 401, 'wrong password is rejected');
  }

  // ---- 3. Real admin login (using the credentials seed.js actually printed) ----
  const ADMIN_EMAIL = 'admin@rhinocash.co.ke';
  const ADMIN_PASSWORD = process.env.SEEDED_ADMIN_PASSWORD; // passed in by the test runner script
  let adminToken;
  {
    const r = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    assert(r.status === 200 && r.json.token, 'admin logs in with real seeded credentials');
    assert(r.json.mustChangePassword === true, 'fresh admin account is flagged to force a password change');
    adminToken = r.json.token;
  }

  // ---- 4. Forced password change actually works, and old sessions elsewhere get revoked ----
  {
    const r = await api('POST', '/api/auth/change-password', { token: adminToken, body: { newPassword: 'N3wSecureAdminPass!' } });
    assert(r.status === 200, 'admin can change password on first login');
    const relogin = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: 'N3wSecureAdminPass!' } });
    assert(relogin.status === 200, 'admin can log in with the new password');
    adminToken = relogin.json.token;
    const oldPasswordAttempt = await api('POST', '/api/auth/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    assert(oldPasswordAttempt.status === 401, 'the old temp password no longer works after change');
  }

  // ---- 5. RBAC: unauthenticated request is rejected ----
  {
    const r = await api('GET', '/api/users');
    assert(r.status === 401, 'unauthenticated request to a protected route is rejected');
  }

  // ---- 6. Admin creates a new Loan Officer user ----
  let officerToken, officerId, officerEmail;
  {
    officerEmail = 'test.officer@rhinocash.co.ke';
    const r = await api('POST', '/api/users', {
      token: adminToken,
      body: { name: 'Test Officer', email: officerEmail, role_id: 'loan_officer', branch_id: 'br_kisumu', phone: '0700000099' },
    });
    assert(r.status === 201 && r.json.tempPassword, 'admin creates a new Loan Officer with a real generated temp password');
    officerId = r.json.user.id;
    const login = await api('POST', '/api/auth/login', { body: { email: officerEmail, password: r.json.tempPassword } });
    assert(login.status === 200, 'the newly created officer can log in with their temp password');
    officerToken = login.json.token;
    // force through their own required password change so later calls aren't blocked
    await api('POST', '/api/auth/change-password', { token: officerToken, body: { newPassword: 'OfficerPass!234' } });
    const relogin = await api('POST', '/api/auth/login', { body: { email: officerEmail, password: 'OfficerPass!234' } });
    officerToken = relogin.json.token;
  }

  // ---- 7. RBAC: a Loan Officer cannot create other users (no manage_users permission) ----
  {
    const r = await api('POST', '/api/users', { token: officerToken, body: { name: 'Should Fail', email: 'x@x.com', role_id: 'loan_officer' } });
    assert(r.status === 403, 'loan officer is blocked from creating users (server-side, not just hidden UI)');
  }

  // ---- 8. RBAC: module-level restriction actually blocks access, even though role allows it ----
  {
    const before = await api('GET', '/api/notifications', { token: officerToken });
    assert(before.status === 200, 'officer can access notifications before restriction');
    const restrict = await api('PUT', `/api/users/${officerId}/module-access`, { token: adminToken, body: { modules: ['dashboard', 'clients'] } });
    assert(restrict.status === 200, 'admin sets a personal module-access restriction on the officer');
    const clientsCheck = await api('GET', '/api/clients', { token: officerToken });
    assert(clientsCheck.status === 200, 'officer can still access an explicitly-allowed module (clients)');
    const paymentsCheck = await api('GET', '/api/payments', { token: officerToken });
    assert(paymentsCheck.status === 403, 'officer is blocked from a module NOT in their personal restriction, despite role normally allowing it');
    const reset = await api('POST', `/api/users/${officerId}/reset-access`, { token: adminToken });
    assert(reset.status === 200, 'admin resets officer access back to role defaults');
    const paymentsAfterReset = await api('GET', '/api/payments', { token: officerToken });
    assert(paymentsAfterReset.status === 200, 'after reset, officer regains normal role-based access');
  }

  // ---- 9. Suspended account cannot log in ----
  {
    const suspend = await api('POST', `/api/users/${officerId}/status`, { token: adminToken, body: { status: 'Suspended', reason: 'test' } });
    assert(suspend.status === 200, 'admin suspends the officer');
    const blockedLogin = await api('POST', '/api/auth/login', { body: { email: officerEmail, password: 'OfficerPass!234' } });
    assert(blockedLogin.status === 403, 'suspended account cannot log in');
    const reactivate = await api('POST', `/api/users/${officerId}/status`, { token: adminToken, body: { status: 'Active' } });
    assert(reactivate.status === 200, 'admin reactivates the officer');
    const okLogin = await api('POST', '/api/auth/login', { body: { email: officerEmail, password: 'OfficerPass!234' } });
    assert(okLogin.status === 200, 'reactivated account can log in again');
    officerToken = okLogin.json.token;
  }

  // ---- 10. Revoke sessions actually invalidates the token server-side ----
  {
    const meBefore = await api('GET', '/api/auth/me', { token: officerToken });
    assert(meBefore.status === 200, 'officer session works before revocation');
    const revoke = await api('POST', `/api/users/${officerId}/revoke-sessions`, { token: adminToken });
    assert(revoke.status === 200 && revoke.json.revoked >= 1, 'admin revokes the officer\'s session(s)');
    const meAfter = await api('GET', '/api/auth/me', { token: officerToken });
    assert(meAfter.status === 401, 'the exact same token is now rejected — real server-side revocation, not just client-side logout');
    const relogin = await api('POST', '/api/auth/login', { body: { email: officerEmail, password: 'OfficerPass!234' } });
    officerToken = relogin.json.token;
  }

  // ---- 11. Full client + loan lifecycle, real sequential 4-level approval ----
  let clientId, loanId;
  {
    const c = await api('POST', '/api/clients', { token: officerToken, body: { name: 'John Mwangi', phone: '0722555001', national_id: '30112233' } });
    assert(c.status === 201, 'officer creates a client');
    clientId = c.json.client.id;

    const products = await api('GET', '/api/loan-products', { token: officerToken });
    const productId = products.json.products[0].id;

    const badAmount = await api('POST', '/api/loans', { token: officerToken, body: { client_id: clientId, product_id: productId, principal: 999999999, term_months: 6 } });
    assert(badAmount.status === 400, 'loan amount outside product range is rejected server-side');

    const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: clientId, product_id: productId, principal: 50000, term_months: 6, purpose: 'Stock' } });
    assert(loan.status === 201 && loan.json.loan.status === 'Waiting for Manager', 'loan application starts at step 1: Waiting for Manager');
    loanId = loan.json.loan.id;

    // Loan officer cannot approve their own loan (no approve_loans permission)
    const selfApprove = await api('POST', `/api/loans/${loanId}/approve`, { token: officerToken, body: {} });
    assert(selfApprove.status === 403, 'loan officer cannot approve loans (server-enforced)');

    // Regional Manager cannot approve out of order (loan is waiting for Manager, not them)
    const rmLogin = await api('POST', '/api/auth/login', { body: { email: 'regional@rhinocash.co.ke', password: process.env.SEEDED_REGIONAL_PASSWORD } });
    const outOfOrder = await api('POST', `/api/loans/${loanId}/approve`, { token: rmLogin.json.token, body: {} });
    assert(outOfOrder.status === 403, 'Regional Manager blocked from approving out of sequence — loan is waiting for Manager, not them');

    // Manager approves -> step 2 (must be the Kisumu-branch manager — the
    // loan belongs to a Kisumu client/officer, and branch scope is now
    // actually enforced, so the Nairobi manager correctly CANNOT do this).
    const nairobiMgrLogin = await api('POST', '/api/auth/login', { body: { email: 'manager@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_PASSWORD } });
    const wrongBranchAttempt = await api('POST', `/api/loans/${loanId}/approve`, { token: nairobiMgrLogin.json.token, body: {} });
    assert(wrongBranchAttempt.status === 403, 'a Manager from a DIFFERENT branch cannot approve this loan (branch scope enforced on the approval action itself)');
    const mgrLogin = await api('POST', '/api/auth/login', { body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD } });
    const step1 = await api('POST', `/api/loans/${loanId}/approve`, { token: mgrLogin.json.token, body: { comments: 'Looks fine' } });
    assert(step1.status === 200 && step1.json.loan.status === 'Waiting for Regional Manager', 'Manager approval advances loan to Waiting for Regional Manager');

    // Now Manager trying again should be blocked (no longer their turn)
    const managerAgain = await api('POST', `/api/loans/${loanId}/approve`, { token: mgrLogin.json.token, body: {} });
    assert(managerAgain.status === 403, 'Manager cannot approve the same loan twice / out of turn');

    // Regional Manager approves -> step 3
    const step2 = await api('POST', `/api/loans/${loanId}/approve`, { token: rmLogin.json.token, body: {} });
    assert(step2.status === 200 && step2.json.loan.status === 'Waiting for Operational Manager', 'Regional Manager approval advances to Waiting for Operational Manager');

    // Operational Manager approves -> step 4
    const omLogin = await api('POST', '/api/auth/login', { body: { email: 'opsmanager@rhinocash.co.ke', password: process.env.SEEDED_OPSMGR_PASSWORD } });
    const step3 = await api('POST', `/api/loans/${loanId}/approve`, { token: omLogin.json.token, body: {} });
    assert(step3.status === 200 && step3.json.loan.status === 'Waiting for Accountant', 'Operational Manager approval advances to Waiting for Accountant');

    // Accountant approves -> Approved for Disbursement
    const acctLogin = await api('POST', '/api/auth/login', { body: { email: 'accountant@rhinocash.co.ke', password: process.env.SEEDED_ACCOUNTANT_PASSWORD } });
    const step4 = await api('POST', `/api/loans/${loanId}/approve`, { token: acctLogin.json.token, body: {} });
    assert(step4.status === 200 && step4.json.loan.status === 'Approved for Disbursement', 'Accountant approval completes the chain: Approved for Disbursement');

    // Full approval history recorded with approver/role/decision/timestamps
    const detail = await api('GET', `/api/loans/${loanId}`, { token: adminToken });
    assert(detail.json.approvals.length === 4, 'all 4 approval decisions are permanently recorded');
    assert(detail.json.approvals.every(a => a.approver_id && a.role_id && a.decision && a.created_at), 'each approval record has approver, role, decision, and timestamp');

    // Disburse — disbursement is a Manager/Operational Manager/Admin action, not the Accountant's
    // (matches the original frontend's permission matrix: Accountant approves, doesn't disburse).
    const accountantCannotDisburse = await api('POST', `/api/loans/${loanId}/disburse`, { token: acctLogin.json.token, body: { channel: 'M-Pesa' } });
    assert(accountantCannotDisburse.status === 403, 'Accountant cannot disburse (approves only — server-enforced permission split)');
    const disburse = await api('POST', `/api/loans/${loanId}/disburse`, { token: adminToken, body: { channel: 'M-Pesa' } });
    assert(disburse.status === 200 && disburse.json.loan.status === 'Active', 'disbursement activates the loan');
    assert(disburse.json.schedule.length === 6, 'disbursement generates a real 6-month repayment schedule');

    // Loan Details: "Posted By" (real disbursement journal entry poster) and "Template Creation"
    // (real audit log row for the original application) — both derived, not fabricated.
    const officerMeForDetails = await api('GET', '/api/auth/me', { token: officerToken });
    const adminMeForDetails = await api('GET', '/api/auth/me', { token: adminToken });
    const detailAfterDisbursement = await api('GET', `/api/loans/${loanId}`, { token: adminToken });
    assert(detailAfterDisbursement.json.postedBy && detailAfterDisbursement.json.postedBy.name === adminMeForDetails.json.user.name && !!detailAfterDisbursement.json.postedBy.at, 'the real "Posted By" genuinely identifies the real Admin who disbursed this loan, with a real timestamp');
    assert(detailAfterDisbursement.json.templateCreation && detailAfterDisbursement.json.templateCreation.name === officerMeForDetails.json.user.name && !!detailAfterDisbursement.json.templateCreation.at, 'the real "Template Creation" genuinely identifies the real Loan Officer who submitted this application, with a real timestamp');
    assert(detailAfterDisbursement.json.disbursementChannel === 'M-Pesa', 'the real "disbursementChannel" genuinely identifies the real channel this loan was disbursed through, derived from the real disbursement audit log row');

    // Record a payment, verify allocation + cash position moves
    const cashBefore = await api('GET', '/api/accounting/cash-position', { token: adminToken });
    const payment = await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loanId, amount: 9500, channel: 'M-Pesa' } });
    assert(payment.status === 201 && payment.json.payment.status === 'Posted', 'payment recorded and posted');
    const cashAfter = await api('GET', '/api/accounting/cash-position', { token: adminToken });
    assert(cashAfter.json.balances.mpesa > cashBefore.json.balances.mpesa, 'cash position (M-Pesa account) increases from a real posted payment, derived from the ledger');

    // The real GET /api/payments?loan_id= filter (used by the Loan Account
    // Statement / Loan Ledger Statement pages) returns this exact real
    // payment with its real allocated_principal/allocated_interest split.
    const loanPayments = await api('GET', `/api/payments?loan_id=${loanId}`, { token: officerToken });
    assert(loanPayments.status === 200 && loanPayments.json.payments.some(p => p.id === payment.json.payment.id), 'GET /api/payments?loan_id= genuinely returns this real payment');
    const foundPayment = loanPayments.json.payments.find(p => p.id === payment.json.payment.id);
    assert(Math.abs((foundPayment.allocated_principal + foundPayment.allocated_interest) - 9500) < 0.01, 'the real allocated_principal + allocated_interest for this payment genuinely sums to the real amount paid');

    // Reverse it (accountant permission), verify schedule unwinds
    const scheduleBefore = (await api('GET', `/api/loans/${loanId}`, { token: adminToken })).json.schedule;
    const paidBefore = scheduleBefore[0].paid_amount;
    const reverse = await api('POST', `/api/payments/${payment.json.payment.id}/reverse`, { token: acctLogin.json.token, body: { reason: 'test reversal' } });
    assert(reverse.status === 200 && reverse.json.payment.status === 'Reversed', 'accountant can reverse a payment');
    const scheduleAfter = (await api('GET', `/api/loans/${loanId}`, { token: adminToken })).json.schedule;
    assert(scheduleAfter[0].paid_amount < paidBefore, 'reversal actually unwinds the schedule allocation');

    // ---- Installments view: per-installment transaction breakdown,
    // derived by replaying real payment_allocations principal-first (the
    // schema has no stored principal/interest split per payment) ----
    const period1 = scheduleAfter[0];
    assert(Number(period1.paid_amount) === 0, 'period 1 is a clean slate again after the earlier payment was reversed');
    const principalDue1 = Number(period1.principal_due);
    const firstAmt = Math.round(principalDue1 / 2);
    const pay1 = await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loanId, amount: firstAmt, channel: 'Cash' } });
    assert(pay1.status === 201, 'first real payment against period 1 recorded');
    const secondAmt = (principalDue1 - firstAmt) + 50; // finishes principal, spills 50 into interest
    const pay2 = await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loanId, amount: secondAmt, channel: 'M-Pesa' } });
    assert(pay2.status === 201, 'second real payment against period 1 recorded');

    const badLoanTxns = await api('GET', `/api/loans/does-not-exist/schedule/${period1.id}/transactions`, { token: adminToken });
    assert(badLoanTxns.status === 404, 'unknown loan id on the transactions endpoint 404s');
    const badScheduleTxns = await api('GET', `/api/loans/${loanId}/schedule/999999999/transactions`, { token: adminToken });
    assert(badScheduleTxns.status === 404, 'schedule id that does not belong to this loan 404s as "Installment not found"');

    const txns = await api('GET', `/api/loans/${loanId}/schedule/${period1.id}/transactions`, { token: officerToken });
    assert(txns.status === 200 && txns.json.transactions.length === 2, 'the owning Loan Officer can pull both real payments that touched this period');
    const [t1, t2] = txns.json.transactions;
    assert(t1.channel === 'Cash' && t2.channel === 'M-Pesa', 'transactions come back in real chronological order (first payment, Cash, before second, M-Pesa)');
    assert(Math.abs(t1.principal - firstAmt) < 0.01 && Math.abs(t1.interest) < 0.01, 'first payment applies entirely to principal (principal-first replay)');
    assert(Math.abs(t2.principal - (principalDue1 - firstAmt)) < 0.01 && Math.abs(t2.interest - 50) < 0.01, 'second payment finishes principal then spills the remainder into interest');
    assert(t1.deducted === firstAmt && t1.amount === firstAmt, 'deducted/amount reflect the real amount_applied and real payment amount');
    assert(!!t1.postedBy && t1.postedBy !== 'System', 'each transaction carries the real staff member who recorded it');

    const scheduleAfterPayments = (await api('GET', `/api/loans/${loanId}`, { token: adminToken })).json.schedule;
    assert(!!scheduleAfterPayments[0].last_payment_date, 'schedule now carries a real last_payment_date for the period the two payments touched');
  }

  // ---- 11b. Processing fee (real, deducted at disbursement) & late-payment
  // penalty (real, accrued on overdue installments, payable and reversible
  // through the same allocate()/reverse machinery as principal/interest) ----
  {
    const mgrLogin = await api('POST', '/api/auth/login', { body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD } });
    const rmLogin = await api('POST', '/api/auth/login', { body: { email: 'regional@rhinocash.co.ke', password: process.env.SEEDED_REGIONAL_PASSWORD } });
    const omLogin = await api('POST', '/api/auth/login', { body: { email: 'opsmanager@rhinocash.co.ke', password: process.env.SEEDED_OPSMGR_PASSWORD } });
    const acctLogin = await api('POST', '/api/auth/login', { body: { email: 'accountant@rhinocash.co.ke', password: process.env.SEEDED_ACCOUNTANT_PASSWORD } });

    const c = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Fee Penalty Test Client', phone: '0722555099', national_id: '30112299' } });
    const productsRes = await api('GET', '/api/loan-products', { token: officerToken });
    const product = productsRes.json.products[0];
    assert(product.penalty_pct > 0 && product.fee_pct > 0, 'the real seeded product genuinely carries nonzero fee_pct and penalty_pct — the feature is actually configured, not merely present in the schema');

    const loanRes = await api('POST', '/api/loans', { token: officerToken, body: { client_id: c.json.client.id, product_id: product.id, principal: 20000, term_months: 2, purpose: 'Stock' } });
    const feePenaltyLoanId = loanRes.json.loan.id;
    await api('POST', `/api/loans/${feePenaltyLoanId}/approve`, { token: mgrLogin.json.token, body: {} });
    await api('POST', `/api/loans/${feePenaltyLoanId}/approve`, { token: rmLogin.json.token, body: {} });
    await api('POST', `/api/loans/${feePenaltyLoanId}/approve`, { token: omLogin.json.token, body: {} });
    await api('POST', `/api/loans/${feePenaltyLoanId}/approve`, { token: acctLogin.json.token, body: {} });
    const disburseFP = await api('POST', `/api/loans/${feePenaltyLoanId}/disburse`, { token: adminToken, body: { channel: 'Cash' } });
    assert(disburseFP.status === 200, 'fee/penalty test loan disburses');

    // Real processing fee — the product's real fee_pct applied to the real
    // principal, stored on the loan, and genuinely deducted from the cash
    // actually disbursed (never inflating what the client owes).
    const expectedFee = Math.round((20000 * product.fee_pct / 100) * 100) / 100;
    const loanAfterDisburse = await api('GET', `/api/loans/${feePenaltyLoanId}`, { token: adminToken });
    assert(Math.abs(loanAfterDisburse.json.loan.processing_fee - expectedFee) < 0.01, 'the real processing_fee stored on the loan matches principal * the product\'s real fee_pct');
    const feeJournal = await api('GET', `/api/journal-entries?ref_type=loan&ref_id=${feePenaltyLoanId}`, { token: adminToken });
    assert(feeJournal.json.entries.length === 3, 'disbursement posted exactly 3 real journal lines: receivable, net cash, and real fee income');
    const cashLine = feeJournal.json.entries.find(e => e.account_id === 'cash');
    const feeLine = feeJournal.json.entries.find(e => e.account_id === 'fee_income');
    assert(cashLine && Math.abs(cashLine.credit - (20000 - expectedFee)) < 0.01, 'the real cash account was credited the NET disbursed amount (principal minus the real fee), not the full principal');
    assert(feeLine && Math.abs(feeLine.credit - expectedFee) < 0.01, 'real fee income was genuinely recognized for the exact real fee amount at the moment of disbursement');
    const receivableLine = feeJournal.json.entries.find(e => e.account_id === 'loans_receivable');
    assert(receivableLine && Math.abs(receivableLine.debit - 20000) < 0.01, 'loans_receivable is still debited the FULL principal — the fee never inflates what the client owes');

    // Backdate period 1's due date directly in the real database to
    // simulate it genuinely being overdue (the schedule always starts in
    // the future relative to "today", so there is no other way to
    // reach this real state inside a single test run).
    const { run: dbRun, get: dbGet, all: dbAll3 } = require('../src/db');
    const scheduleFP = (await api('GET', `/api/loans/${feePenaltyLoanId}`, { token: adminToken })).json.schedule;
    const period1FP = scheduleFP[0];
    const pastDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    await dbRun('UPDATE loan_schedule SET due_date = ? WHERE id = ?', [pastDate, period1FP.id]);

    // Real accrual — genuinely happens as a side effect of reading the
    // loan (this dependency-free app has no background job runner).
    const afterAccrual = await api('GET', `/api/loans/${feePenaltyLoanId}`, { token: adminToken });
    const accruedPeriod1 = afterAccrual.json.schedule.find(r => r.id === period1FP.id);
    const expectedPenalty = Math.round((period1FP.total_due * product.penalty_pct / 100) * 100) / 100;
    assert(Math.abs(accruedPeriod1.penalty_due - expectedPenalty) < 0.01, 'the real penalty_due genuinely equals the product\'s real penalty_pct applied to this installment\'s real total_due, once it is genuinely overdue');
    assert(accruedPeriod1.penalty_paid === 0, 'the real penalty is charged but not yet paid');

    // Re-reading again must NOT double-charge (idempotent accrual).
    const afterSecondRead = await api('GET', `/api/loans/${feePenaltyLoanId}`, { token: adminToken });
    const stillSamePenalty = afterSecondRead.json.schedule.find(r => r.id === period1FP.id);
    assert(Math.abs(stillSamePenalty.penalty_due - expectedPenalty) < 0.01, 'accruing penalties a second time genuinely does not double-charge the same installment');

    // No journal entry exists yet for the mere accrual — penalty income,
    // like interest income, is only ever recognized once really collected.
    const journalBeforePenaltyPay = await api('GET', `/api/journal-entries?ref_type=loan&ref_id=${feePenaltyLoanId}`, { token: adminToken });
    assert(journalBeforePenaltyPay.json.entries.length === 3, 'accruing a real penalty posts no journal entry by itself — it is recognized only when actually paid, exactly like interest');

    // Pay exactly enough to clear period 1's principal+interest AND its
    // real accrued penalty — a genuine, real three-way split.
    const payAmount = Math.round((period1FP.total_due + expectedPenalty) * 100) / 100;
    const penaltyPayment = await api('POST', '/api/payments', { token: officerToken, body: { loan_id: feePenaltyLoanId, amount: payAmount, channel: 'Cash' } });
    assert(penaltyPayment.status === 201, 'the real payment covering principal+interest+penalty is recorded');
    assert(Math.abs(penaltyPayment.json.payment.allocated_penalty - expectedPenalty) < 0.01, 'the real payment\'s allocated_penalty genuinely equals the real accrued penalty it paid off');
    assert(Math.abs(penaltyPayment.json.payment.allocated_principal - period1FP.principal_due) < 0.01 && Math.abs(penaltyPayment.json.payment.allocated_interest - period1FP.interest_due) < 0.01, 'principal and interest are still allocated in full alongside the real penalty');

    const scheduleAfterPenaltyPay = (await api('GET', `/api/loans/${feePenaltyLoanId}`, { token: adminToken })).json.schedule;
    const period1AfterPay = scheduleAfterPenaltyPay.find(r => r.id === period1FP.id);
    assert(period1AfterPay.status === 'Paid' && Math.abs(period1AfterPay.penalty_paid - expectedPenalty) < 0.01, 'the real installment is only marked Paid once BOTH principal+interest and the real penalty are fully settled');

    const journalAfterPenaltyPay = await api('GET', `/api/journal-entries?ref_type=payment&ref_id=${penaltyPayment.json.payment.id}`, { token: adminToken });
    const penaltyIncomeLine = journalAfterPenaltyPay.json.entries.find(e => e.account_id === 'penalty_income' && e.credit > 0);
    assert(penaltyIncomeLine && Math.abs(penaltyIncomeLine.credit - expectedPenalty) < 0.01, 'real penalty income is recognized in the ledger for the exact real amount collected, at the moment it was actually paid');

    // The per-installment transactions endpoint correctly attributes the
    // real penalty portion of this payment (principal-first, interest
    // second, penalty last — matching allocate()'s own real priority).
    const txnsFP = await api('GET', `/api/loans/${feePenaltyLoanId}/schedule/${period1FP.id}/transactions`, { token: adminToken });
    assert(txnsFP.json.transactions.length === 1 && Math.abs(txnsFP.json.transactions[0].penalty - expectedPenalty) < 0.01, 'the real per-installment transactions breakdown correctly attributes the real penalty portion of the payment');

    // Reversing the payment genuinely unwinds the real penalty too.
    const reversePenaltyPay = await api('POST', `/api/payments/${penaltyPayment.json.payment.id}/reverse`, { token: acctLogin.json.token, body: { reason: 'test' } });
    assert(reversePenaltyPay.status === 200, 'the real payment (principal+interest+penalty) can be reversed');
    const scheduleAfterReverse = (await api('GET', `/api/loans/${feePenaltyLoanId}`, { token: adminToken })).json.schedule;
    const period1AfterReverse = scheduleAfterReverse.find(r => r.id === period1FP.id);
    assert(period1AfterReverse.penalty_paid === 0 && period1AfterReverse.paid_amount === 0 && period1AfterReverse.status === 'Pending', 'reversing the payment genuinely unwinds BOTH the real principal/interest AND the real penalty_paid');
    const journalAfterReverse = await api('GET', `/api/journal-entries?ref_type=payment_reversal&ref_id=${penaltyPayment.json.payment.id}`, { token: adminToken });
    const penaltyReversalLine = journalAfterReverse.json.entries.find(e => e.account_id === 'penalty_income' && e.debit > 0);
    assert(penaltyReversalLine && Math.abs(penaltyReversalLine.debit - expectedPenalty) < 0.01, 'reversing the payment genuinely posts a real, exact reversal of the penalty income that was recognized');

    // Product management genuinely persists and returns the real
    // configured penalty_pct (not just fee_pct) end-to-end.
    const newProduct = await api('POST', '/api/loan-products', { token: adminToken, body: { name: 'Penalty Config Test Product', rate_pct: 3, min_amount: 1000, max_amount: 50000, min_term_months: 1, max_term_months: 6, fee_pct: 1.5, penalty_pct: 7.5 } });
    assert(newProduct.status === 201 && Math.abs(newProduct.json.product.penalty_pct - 7.5) < 0.01, 'creating a real loan product with a real, non-default penalty_pct genuinely persists and returns it');
  }

  // ---- 11c. Tag/Rate Loan: the Loan History "Unrated" badge is a real,
  // persisted rating + reason, not a cosmetic default ----
  {
    const badRating = await api('POST', `/api/loans/${loanId}/rate`, { token: officerToken, body: { rating: 'Not a real option', reason: 'x' } });
    assert(badRating.status === 400, 'an invalid rating value is genuinely rejected');

    const rateRes = await api('POST', `/api/loans/${loanId}/rate`, { token: officerToken, body: { rating: 'Good paying client', reason: 'Always pays on time' } });
    assert(rateRes.status === 200 && rateRes.json.loan.rating === 'Good paying client' && rateRes.json.loan.rating_reason === 'Always pays on time', 'a real, valid rating + reason genuinely persists on the loan');
    assert(!!rateRes.json.loan.rated_by && !!rateRes.json.loan.rated_at, 'the real rater and timestamp are genuinely recorded');

    const detailAfterRate = await api('GET', `/api/loans/${loanId}`, { token: adminToken });
    assert(detailAfterRate.json.loan.rating === 'Good paying client', 'the real rating genuinely comes back on a fresh GET /api/loans/:id, not just the write response');

    // Re-rating overwrites, not duplicates.
    const reRate = await api('POST', `/api/loans/${loanId}/rate`, { token: officerToken, body: { rating: 'Bad Faith Client', reason: 'Missed several installments' } });
    assert(reRate.status === 200 && reRate.json.loan.rating === 'Bad Faith Client', 're-rating a loan genuinely overwrites the previous rating, not stacking a history');

    // A Nairobi manager (different branch) cannot rate a Kisumu loan.
    const nairobiMgrLoginForRate = await api('POST', '/api/auth/login', { body: { email: 'manager@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_PASSWORD } });
    const wrongBranchRate = await api('POST', `/api/loans/${loanId}/rate`, { token: nairobiMgrLoginForRate.json.token, body: { rating: 'Control Failure', reason: 'x' } });
    assert(wrongBranchRate.status === 403, "a Manager outside this loan's branch cannot rate it (real branch scoping)");
  }

  // ---- 11d. Real short-term, single-repayment loan product catalog
  // (Starter/Jijenge/Ibuka/Mavuno/Fly + their 6-week "Special" variants) —
  // a flat rate for the loan's whole real term, repaid once; and real
  // backend-enforced New Loan / Repeat Loan validation on POST /api/loans ----
  {
    const mgrLoginWk = await api('POST', '/api/auth/login', { body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD } });
    const rmLoginWk = await api('POST', '/api/auth/login', { body: { email: 'regional@rhinocash.co.ke', password: process.env.SEEDED_REGIONAL_PASSWORD } });
    const omLoginWk = await api('POST', '/api/auth/login', { body: { email: 'opsmanager@rhinocash.co.ke', password: process.env.SEEDED_OPSMGR_PASSWORD } });
    const acctLoginWk = await api('POST', '/api/auth/login', { body: { email: 'accountant@rhinocash.co.ke', password: process.env.SEEDED_ACCOUNTANT_PASSWORD } });

    const allProducts = (await api('GET', '/api/loan-products', { token: officerToken })).json.products;
    const starter = allProducts.find(p => p.id === 'pr_ln_starter');
    const jijengeSpecial = allProducts.find(p => p.id === 'pr_ln_jijenge_special');
    assert(starter && starter.term_weeks === 4 && Number(starter.rate_pct) === 20 && Number(starter.min_amount) === 3000 && Number(starter.max_amount) === 5000, 'the real "Starter" product genuinely has the real 4-week term, 20% flat rate, and 3,000–5,000 range');
    assert(jijengeSpecial && jijengeSpecial.term_weeks === 6 && Number(jijengeSpecial.rate_pct) === 30 && Number(jijengeSpecial.min_amount) === 6000 && Number(jijengeSpecial.max_amount) === 10000, 'the real "Jijenge Special" product genuinely has the real 6-week term, 30% flat rate, and 6,000–10,000 range');

    const wkClient = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Weekly Product Test Client', phone: '0722555088', national_id: '30112288' } });

    // Real helper: run the real processing-fee flow (initiate, then a real
    // manual confirm with a real-format receipt code — this sandbox has no
    // real Safaricom network access, so the STK push itself will genuinely
    // come back NOT_CONFIGURED/FAILED, and confirmation is the real,
    // working path, exactly like this codebase's existing C2B manual-
    // reconciliation pattern) and return the real, now-Confirmed feeId.
    async function payProcessingFee(token, clientId, productId, receiptNumber) {
      const initiate = await api('POST', '/api/loans/processing-fee/initiate', { token, body: { client_id: clientId, product_id: productId, phone: '0722555088' } });
      assert(initiate.status === 201, 'the real processing-fee initiate call genuinely succeeds and returns a real fee record, even though the real STK push to Safaricom cannot complete in this sandbox');
      const confirm = await api('POST', `/api/loans/processing-fee/${initiate.json.feeId}/confirm`, { token, body: { mpesa_receipt_number: receiptNumber } });
      assert(confirm.status === 200 && confirm.json.fee.status === 'Confirmed' && confirm.json.fee.mpesa_receipt_number === receiptNumber, 'the real manual confirmation genuinely marks the fee payment Confirmed with the real receipt code');
      return initiate.json.feeId;
    }

    // Amount outside the real product range is genuinely rejected — before
    // the processing-fee check is even reached.
    const outOfRange = await api('POST', '/api/loans', { token: officerToken, body: { client_id: wkClient.json.client.id, product_id: starter.id, principal: 2000 } });
    assert(outOfRange.status === 400, 'a principal below the real product range (3,000–5,000) is genuinely rejected');

    // No term_months sent at all — the server is authoritative for a real
    // term_weeks product; it never needs (or trusts) a client-supplied term.
    const wkLoanNoGuarantor = await api('POST', '/api/loans', { token: officerToken, body: { client_id: wkClient.json.client.id, product_id: starter.id, principal: 4000, loan_category: 'New Loan' } });
    assert(wkLoanNoGuarantor.status === 400, 'a real "New Loan" application without guarantor name/contact is genuinely rejected server-side');

    // No loan application can be created for this real product without a
    // real, Confirmed processing-fee payment — server-enforced.
    const wkLoanNoFee = await api('POST', '/api/loans', { token: officerToken, body: { client_id: wkClient.json.client.id, product_id: starter.id, principal: 4000, loan_category: 'New Loan', guarantor: 'Jane Guarantor', guarantor_contact: '0733000111' } });
    assert(wkLoanNoFee.status === 400, 'a real loan application for a product that requires a real upfront processing fee is genuinely rejected without one — never created for free');

    const wkFeeId = await payProcessingFee(officerToken, wkClient.json.client.id, starter.id, 'QGX7TT61SV');
    const wkLoan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: wkClient.json.client.id, product_id: starter.id, principal: 4000, term_months: 99, loan_category: 'New Loan', guarantor: 'Jane Guarantor', guarantor_contact: '0733000111', processing_fee_id: wkFeeId } });
    assert(wkLoan.status === 201 && wkLoan.json.loan.term_months === 1, 'the real loan is created with term_months forced to 1 — a bogus client-sent term_months (99) is genuinely ignored, not trusted');
    assert(Number(wkLoan.json.loan.processing_fee) === 600 && wkLoan.json.loan.processing_fee_receipt === 'QGX7TT61SV', 'the real confirmed processing fee amount and real M-Pesa receipt code genuinely land on the new loan record itself, not just the payment row');
    const wkLoanId = wkLoan.json.loan.id;

    // That same confirmed fee payment can never be spent twice.
    const wkLoanReuseFee = await api('POST', '/api/loans', { token: officerToken, body: { client_id: wkClient.json.client.id, product_id: starter.id, principal: 4000, loan_category: 'New Loan', guarantor: 'Jane Guarantor', guarantor_contact: '0733000111', processing_fee_id: wkFeeId } });
    assert(wkLoanReuseFee.status === 400, 'a real processing-fee payment already spent on one real loan application is genuinely refused for a second one');

    // Repeat Loan on a client with NO prior loan is genuinely rejected —
    // this specific client's very first loan (wkLoan above) doesn't count
    // as "prior" for itself, so a second, fresh client with zero loans
    // makes the "no prior loan" case unambiguous.
    const freshClient = await api('POST', '/api/clients', { token: officerToken, body: { name: 'No Prior Loan Client', phone: '0722555077', national_id: '30112277' } });
    const repeatNoPrior = await api('POST', '/api/loans', { token: officerToken, body: { client_id: freshClient.json.client.id, product_id: starter.id, principal: 4000, loan_category: 'Repeat Loan' } });
    assert(repeatNoPrior.status === 400, 'a real "Repeat Loan" application for a client with NO prior loan is genuinely rejected server-side');

    // Repeat Loan on the client that now genuinely has a prior loan
    // (wkLoan above) succeeds, and genuinely inherits that prior loan's
    // real guarantor — never asked for again on the form — once its own
    // real processing fee has genuinely been paid too.
    const repeatFeeId = await payProcessingFee(officerToken, wkClient.json.client.id, jijengeSpecial.id, 'QGX7TT62SW');
    const repeatLoan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: wkClient.json.client.id, product_id: jijengeSpecial.id, principal: 8000, loan_category: 'Repeat Loan', processing_fee_id: repeatFeeId } });
    assert(repeatLoan.status === 201 && repeatLoan.json.loan.guarantor === 'Jane Guarantor' && repeatLoan.json.loan.guarantor_contact === '0733000111', 'a real "Repeat Loan" application genuinely succeeds for a client with a real prior loan, and genuinely inherits that prior loan\'s real guarantor');

    // A freshly submitted, never-approved loan genuinely has no last_approval yet.
    const bulkLoansFresh = await api('GET', '/api/loans', { token: adminToken });
    const repeatLoanBulk = bulkLoansFresh.json.loans.find(l => l.id === repeatLoan.json.loan.id);
    assert(repeatLoanBulk && repeatLoanBulk.last_approval === null, 'a real loan with no real approval decisions yet genuinely has a null last_approval, not a fabricated one');
    assert(Array.isArray(repeatLoanBulk.approvals) && repeatLoanBulk.approvals.length === 0, 'a real loan with no real approval decisions yet genuinely has an empty approvals array, not a fabricated one');

    // Full real approval chain + disbursement of the first (Starter, 4-week) loan.
    await api('POST', `/api/loans/${wkLoanId}/approve`, { token: mgrLoginWk.json.token, body: {} });

    // The bulk GET /api/loans list (what populates the real Undisbursed
    // Loans page) genuinely carries the real most-recent approval — name
    // and decision — for this loan, not a fabricated placeholder.
    const mgrMe = await api('GET', '/api/auth/me', { token: mgrLoginWk.json.token });
    const bulkLoansAfterMgr = await api('GET', '/api/loans', { token: adminToken });
    const wkLoanBulk = bulkLoansAfterMgr.json.loans.find(l => l.id === wkLoanId);
    assert(wkLoanBulk && wkLoanBulk.last_approval && wkLoanBulk.last_approval.name === mgrMe.json.user.name && wkLoanBulk.last_approval.decision === 'Approved', 'the real bulk GET /api/loans genuinely carries the real most-recent approver name and decision for this loan');
    assert(wkLoanBulk.approvals.length === 1 && wkLoanBulk.approvals[0].name === mgrMe.json.user.name, 'the real approvals array genuinely carries this one real decision so far, in real chronological order');

    await api('POST', `/api/loans/${wkLoanId}/approve`, { token: rmLoginWk.json.token, body: {} });
    const rmMe = await api('GET', '/api/auth/me', { token: rmLoginWk.json.token });
    const bulkLoansAfterRm = await api('GET', '/api/loans', { token: adminToken });
    const wkLoanBulk2 = bulkLoansAfterRm.json.loans.find(l => l.id === wkLoanId);
    assert(wkLoanBulk2.last_approval.name === rmMe.json.user.name, 'the real last_approval genuinely advances to the next real approver, not stuck on the first one');
    assert(wkLoanBulk2.approvals.length === 2 && wkLoanBulk2.approvals[0].name === mgrMe.json.user.name && wkLoanBulk2.approvals[1].name === rmMe.json.user.name, 'the real approvals array genuinely accumulates the whole real chain in the real order it happened, not just the latest decision');
    await api('POST', `/api/loans/${wkLoanId}/approve`, { token: omLoginWk.json.token, body: {} });
    await api('POST', `/api/loans/${wkLoanId}/approve`, { token: acctLoginWk.json.token, body: {} });
    const wkDisburse = await api('POST', `/api/loans/${wkLoanId}/disburse`, { token: adminToken, body: { channel: 'Cash' } });
    assert(wkDisburse.status === 200, 'the real weekly-product loan disburses');
    assert(Number(wkDisburse.json.loan.processing_fee) === 600 && wkDisburse.json.loan.processing_fee_receipt === 'QGX7TT61SV', 'disbursement genuinely never overwrites the real upfront processing fee already confirmed at application time — a real regression this exact assertion catches');
    assert(wkDisburse.json.schedule.length === 1, 'a real term_weeks product genuinely builds exactly ONE schedule row — a single real repayment, not monthly installments');
    const wkRow = wkDisburse.json.schedule[0];
    assert(Math.abs(wkRow.principal_due - 4000) < 0.01, 'the single real installment\'s principal_due genuinely equals the full real principal');
    assert(Math.abs(wkRow.interest_due - 800) < 0.01, 'the single real installment\'s interest_due genuinely equals the real flat 20% of principal (4000 * 0.20 = 800), not a per-month rate');
    assert(Math.abs(wkRow.total_due - 4800) < 0.01, 'total_due genuinely equals principal + the real flat interest');
    const expectedDueDate = new Date(wkDisburse.json.loan.disbursed_at);
    expectedDueDate.setDate(expectedDueDate.getDate() + 28);
    assert(wkRow.due_date === expectedDueDate.toISOString().slice(0, 10), 'the single real installment is genuinely due exactly 4 real weeks (28 days) after disbursement, not 1 month later');

    // Admin-facing product management genuinely accepts and returns a
    // real term_weeks product end-to-end too.
    const newWeeklyProduct = await api('POST', '/api/loan-products', { token: adminToken, body: { name: 'Weekly Config Test Product', rate_pct: 20, min_amount: 1000, max_amount: 2000, fee_pct: 0, penalty_pct: 0, term_weeks: 4 } });
    assert(newWeeklyProduct.status === 201 && newWeeklyProduct.json.product.term_weeks === 4 && newWeeklyProduct.json.product.min_term_months === 1 && newWeeklyProduct.json.product.max_term_months === 1, 'creating a real loan product with a real term_weeks genuinely persists it and forces the month range to a real single period');
    assert(newWeeklyProduct.json.product.processing_fee_amount === null, 'a real product created without a real processing_fee_amount genuinely has none — a term_weeks product does not automatically require an upfront fee, only one that explicitly carries one');

    // Admin can also configure a real upfront processing fee on a new product.
    const feeConfiguredProduct = await api('POST', '/api/loan-products', { token: adminToken, body: { name: 'Fee Config Test Product', rate_pct: 20, min_amount: 1000, max_amount: 2000, fee_pct: 0, penalty_pct: 0, term_weeks: 4, processing_fee_amount: 350 } });
    assert(feeConfiguredProduct.status === 201 && Number(feeConfiguredProduct.json.product.processing_fee_amount) === 350, 'Admin can genuinely configure a real flat upfront processing fee on a loan product, persisted and returned');

    // A loan application for the fee-less product above genuinely does NOT
    // require a processing_fee_id at all — the gate is scoped to products
    // that actually carry a real processing_fee_amount.
    const noFeeProductLoan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: wkClient.json.client.id, product_id: newWeeklyProduct.json.product.id, principal: 1500, loan_category: 'New Loan', guarantor: 'Jane Guarantor', guarantor_contact: '0733000111' } });
    assert(noFeeProductLoan.status === 201, 'a real loan application for a product with no real processing_fee_amount genuinely succeeds without any processing_fee_id at all');
  }

  // ---- 11e. Processing fee payment: real client/product mismatch,
  // invalid receipt format, and double-confirmation are all genuinely
  // refused server-side ----
  {
    const feeClient = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Fee Mismatch Test Client', phone: '0722555199', national_id: '30112399' } });
    const otherFeeClient = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Other Fee Test Client', phone: '0722555200', national_id: '30112400' } });
    const feeProducts = (await api('GET', '/api/loan-products', { token: officerToken })).json.products;
    const feeStarter = feeProducts.find(p => p.id === 'pr_ln_starter');
    const feeIbuka = feeProducts.find(p => p.id === 'pr_ln_ibuka');

    // Initiating for a product with no real processing_fee_amount is genuinely refused.
    const legacyProduct = feeProducts.find(p => p.processing_fee_amount == null);
    const legacyInitiate = await api('POST', '/api/loans/processing-fee/initiate', { token: officerToken, body: { client_id: feeClient.json.client.id, product_id: legacyProduct.id, phone: '0722555099' } });
    assert(legacyInitiate.status === 400, 'a real processing-fee initiate request for a product that does not require one is genuinely refused');

    const initiate = await api('POST', '/api/loans/processing-fee/initiate', { token: officerToken, body: { client_id: feeClient.json.client.id, product_id: feeStarter.id, phone: '0722555099' } });
    assert(initiate.status === 201 && Number(initiate.json.amount) === 600, 'the real initiate call genuinely returns the real flat fee amount configured on the product');
    const feeId = initiate.json.feeId;

    // An invalid receipt code (wrong length/characters) is genuinely refused.
    const badReceipt = await api('POST', `/api/loans/processing-fee/${feeId}/confirm`, { token: officerToken, body: { mpesa_receipt_number: 'short' } });
    assert(badReceipt.status === 400, 'a real M-Pesa receipt code that does not match the real 10-character Safaricom format is genuinely refused');

    const confirm = await api('POST', `/api/loans/processing-fee/${feeId}/confirm`, { token: officerToken, body: { mpesa_receipt_number: 'ABCDE12345' } });
    assert(confirm.status === 200 && confirm.json.fee.status === 'Confirmed', 'a real, correctly-formatted M-Pesa receipt code is genuinely accepted and confirms the payment');

    // Confirming the same real payment twice is genuinely refused.
    const doubleConfirm = await api('POST', `/api/loans/processing-fee/${feeId}/confirm`, { token: officerToken, body: { mpesa_receipt_number: 'ZZZZZ99999' } });
    assert(doubleConfirm.status === 409, 'a real processing-fee payment that is already Confirmed is genuinely refused a second confirmation');

    // Using this real Confirmed payment for a DIFFERENT client's loan
    // application is genuinely refused — it only matches the exact real
    // client and product it was paid for.
    const mismatchClientLoan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: otherFeeClient.json.client.id, product_id: feeStarter.id, principal: 4000, loan_category: 'New Loan', guarantor: 'G', guarantor_contact: '0700000000', processing_fee_id: feeId } });
    assert(mismatchClientLoan.status === 400, 'a real confirmed processing-fee payment genuinely cannot be used for a different client\'s loan application');

    // Using it for the right client but a DIFFERENT product is also refused.
    const mismatchProductLoan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: feeClient.json.client.id, product_id: feeIbuka.id, principal: 12000, loan_category: 'New Loan', guarantor: 'G', guarantor_contact: '0700000000', processing_fee_id: feeId } });
    assert(mismatchProductLoan.status === 400, 'a real confirmed processing-fee payment genuinely cannot be used for a different product\'s loan application');

    // The real matching client + product finally succeeds.
    const matchingLoan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: feeClient.json.client.id, product_id: feeStarter.id, principal: 4000, loan_category: 'New Loan', guarantor: 'G', guarantor_contact: '0700000000', processing_fee_id: feeId } });
    assert(matchingLoan.status === 201 && matchingLoan.json.loan.processing_fee_receipt === 'ABCDE12345', 'the real confirmed payment genuinely succeeds for the exact real client and product it was paid for, and its real receipt code lands on the new loan');
  }

  // ---- 12. Branch data scoping: a Manager only sees their own branch's clients ----
  {
    const mgrLogin = await api('POST', '/api/auth/login', { body: { email: 'manager@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_PASSWORD } });
    const managerClients = await api('GET', '/api/clients', { token: mgrLogin.json.token });
    const foundKisumuClient = managerClients.json.clients.some(c => c.id === clientId);
    assert(!foundKisumuClient, 'Nairobi-branch Manager does NOT see a client created in the Kisumu branch (real branch scoping)');
  }

  // ---- 13. Investor isolation: investor auth is structurally separate, cannot reach staff endpoints ----
  {
    const invLogin = await api('POST', '/api/investor-auth/login', { body: { email: 'sara.investor@example.com', password: process.env.SEEDED_INVESTOR_PASSWORD } });
    assert(invLogin.status === 200, 'investor logs in through the dedicated investor auth endpoint');
    const invToken = invLogin.json.token;
    const meInv = await api('GET', '/api/investor/me', { token: invToken });
    assert(meInv.status === 200 && meInv.json.name === 'Sara Mbula', 'investor sees only their own record');
    const tryStaffRoute = await api('GET', '/api/users', { token: invToken });
    assert(tryStaffRoute.status === 401, 'an investor token is structurally rejected by staff-only endpoints (no role_id at all)');
    const payouts = await api('GET', '/api/investor/payouts', { token: invToken });
    assert(payouts.status === 200, 'investor can view their own payout history');
  }

  // ---- 14. Audit log actually recorded everything above ----
  {
    const audit = await api('GET', '/api/audit-logs', { token: adminToken });
    assert(audit.status === 200, 'admin can read the audit log');
    const actions = audit.json.auditLogs.map(a => a.action);
    ['User logged in', 'Created user', 'Approved loan', 'Disbursed loan', 'Reversed payment', 'Set status to Suspended', 'Revoked sessions']
      .forEach(expected => assert(actions.includes(expected), `audit log contains a real "${expected}" entry`));
    const nonAdmin = await api('GET', '/api/audit-logs', { token: officerToken });
    assert(nonAdmin.status === 403, 'a Loan Officer cannot read the audit log (module-gated)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
