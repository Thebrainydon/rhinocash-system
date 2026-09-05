// v2.test.js — tests everything added/fixed in the V2 hardening pass.
// Run alongside test/integration.test.js (which still covers V1 behavior
// end-to-end and is re-run, unmodified in spirit, as part of this pass).
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}
async function login(email, password) {
  const r = await api('POST', '/api/auth/login', { body: { email, password } });
  return r.json && r.json.token;
}

(async () => {
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const managerToken = await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD);
  const managerKisumuToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const regionalToken = await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD);
  const opsMgrToken = await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD);
  const accountantToken = await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  const directorToken = await login('director@rhinocash.co.ke', process.env.SEEDED_DIRECTOR_PASSWORD);
  assert(adminToken && officerToken && managerToken && ceoToken && directorToken, 'all seeded demo accounts log in');

  // =========================================================
  // 1. OBJECT-LEVEL BRANCH SECURITY — instruction #2
  // =========================================================
  {
    // officer (Kisumu) creates a client + loan
    const c = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Mary Wanjiku', phone: '0722900001' } });
    assert(c.status === 201, 'Kisumu officer creates a client');
    const clientId = c.json.client.id;
    assert(c.json.client.branch_id === 'br_kisumu', 'client is correctly recorded under br_kisumu');

    const products = await api('GET', '/api/loan-products', { token: officerToken });
    const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: clientId, product_id: products.json.products[0].id, principal: 30000, term_months: 4 } });
    const loanId = loan.json.loan.id;

    // GET /:id — the exact scenario named in the spec
    const nairobiClientGet = await api('GET', `/api/clients/${clientId}`, { token: managerToken });
    assert(nairobiClientGet.status === 403, 'GET /api/clients/:id — Nairobi manager cannot fetch a Kisumu client by ID');
    const nairobiLoanGet = await api('GET', `/api/loans/${loanId}`, { token: managerToken });
    assert(nairobiLoanGet.status === 403, 'GET /api/loans/:id — Nairobi manager cannot fetch a Kisumu loan by ID');
    const kisumuClientGet = await api('GET', `/api/clients/${clientId}`, { token: managerKisumuToken });
    assert(kisumuClientGet.status === 200, 'Kisumu manager CAN fetch the Kisumu client');

    // PATCH /:id
    const patchAttempt = await api('PATCH', `/api/clients/${clientId}`, { token: managerToken, body: { name: 'Hijacked Name' } });
    assert(patchAttempt.status === 403, 'PATCH /api/clients/:id — Nairobi manager cannot edit a Kisumu client');

    // =========================================================
    // 2. PREVENT CROSS-BRANCH DATA CREATION — instruction #3
    // =========================================================
    const spoofedClient = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Spoofed', phone: '0722900002', branch_id: 'br_nairobi' } });
    assert(spoofedClient.status === 201 && spoofedClient.json.client.branch_id === 'br_kisumu', 'Kisumu officer supplying branch_id=br_nairobi is silently overridden to their own real branch, not trusted');

    const spoofedLoan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: clientId, product_id: products.json.products[0].id, principal: 20000, term_months: 3, branch_id: 'br_nairobi' } });
    assert(spoofedLoan.status === 201 && spoofedLoan.json.loan.branch_id === 'br_kisumu', 'Kisumu officer cannot plant a loan under br_nairobi by supplying branch_id in the request body');

    // Payments against a loan outside scope
    const paymentAttempt = await api('POST', '/api/payments', { token: managerToken, body: { loan_id: loanId, amount: 5000, channel: 'Cash' } });
    assert(paymentAttempt.status === 403, 'Nairobi manager cannot record a payment against a Kisumu loan');
  }

  // =========================================================
  // 3. SELF-APPROVAL / DUPLICATE APPROVAL PREVENTION — instruction #8
  // =========================================================
  {
    const c = await api('POST', '/api/clients', { token: managerToken, body: { name: 'Self Approval Test', phone: '0722900010' } });
    const products = await api('GET', '/api/loan-products', { token: managerToken });
    // A Manager submitting their own application directly via the API (edge
    // case, but the API must not trust that a Manager only ever acts as an
    // approver — instruction #8 explicitly bans self-approval).
    const loan = await api('POST', '/api/loans', { token: managerToken, body: { client_id: c.json.client.id, product_id: products.json.products[0].id, principal: 15000, term_months: 3 } });
    const selfApprove = await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: managerToken, body: {} });
    assert(selfApprove.status === 403, 'a Manager cannot approve a loan they personally submitted, even at the step their role normally handles');
  }

  // =========================================================
  // 4. FINANCIAL INTEGRITY — instruction #9: total debits = total credits
  // =========================================================
  {
    const c = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Ledger Test Client', phone: '0722900020' } });
    const products = await api('GET', '/api/loan-products', { token: officerToken });
    const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: c.json.client.id, product_id: products.json.products[0].id, principal: 40000, term_months: 5 } });
    const loanId = loan.json.loan.id;
    await api('POST', `/api/loans/${loanId}/approve`, { token: managerKisumuToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: regionalToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: opsMgrToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: accountantToken, body: {} });
    await api('POST', `/api/loans/${loanId}/disburse`, { token: adminToken, body: { channel: 'Bank' } });
    await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loanId, amount: 9800, channel: 'Bank' } });
    // Deliberate overpayment to exercise the suspense-account leg too.
    const overpay = await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loanId, amount: 999999, channel: 'Bank', confirm_duplicate: true } });
    assert(overpay.json.payment.status === 'Overpayment', 'overpayment produces an Overpayment-status payment (exercises the suspense-account journal leg)');

    const trialBalance = await api('GET', '/api/accounting/trial-balance', { token: adminToken });
    assert(trialBalance.status === 200, 'trial balance endpoint responds');
    assert(trialBalance.json.balanced === true, `SUM(debit) === SUM(credit) across the whole ledger (debits=${trialBalance.json.totalDebits}, credits=${trialBalance.json.totalCredits})`);
  }

  // =========================================================
  // 5. DUPLICATE PAYMENT GUARD
  // =========================================================
  {
    const c = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Dup Payment Client', phone: '0722900030' } });
    const products = await api('GET', '/api/loan-products', { token: officerToken });
    const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: c.json.client.id, product_id: products.json.products[0].id, principal: 25000, term_months: 4 } });
    const loanId = loan.json.loan.id;
    await api('POST', `/api/loans/${loanId}/approve`, { token: managerKisumuToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: regionalToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: opsMgrToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: accountantToken, body: {} });
    await api('POST', `/api/loans/${loanId}/disburse`, { token: adminToken, body: { channel: 'Cash' } });

    const first = await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loanId, amount: 6000, channel: 'Cash' } });
    assert(first.status === 201, 'first payment succeeds');
    const dup = await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loanId, amount: 6000, channel: 'Cash' } });
    assert(dup.status === 409 && dup.json.code === 'POSSIBLE_DUPLICATE', 'an identical payment moments later is flagged as a possible duplicate, not silently double-recorded');
    const forced = await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loanId, amount: 6000, channel: 'Cash', confirm_duplicate: true } });
    assert(forced.status === 201, 'the same payment goes through when explicitly confirmed as genuine');
  }

  // =========================================================
  // 6. DOUBLE REVERSAL PREVENTION (was already implemented — re-confirm under V2)
  // =========================================================
  {
    const c = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Double Reverse Client', phone: '0722900040' } });
    const products = await api('GET', '/api/loan-products', { token: officerToken });
    const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: c.json.client.id, product_id: products.json.products[0].id, principal: 20000, term_months: 4 } });
    const loanId = loan.json.loan.id;
    await api('POST', `/api/loans/${loanId}/approve`, { token: managerKisumuToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: regionalToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: opsMgrToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: accountantToken, body: {} });
    await api('POST', `/api/loans/${loanId}/disburse`, { token: adminToken, body: { channel: 'Cash' } });
    const pay = await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loanId, amount: 5000, channel: 'Cash' } });
    const rev1 = await api('POST', `/api/payments/${pay.json.payment.id}/reverse`, { token: accountantToken, body: {} });
    assert(rev1.status === 200, 'first reversal succeeds');
    const rev2 = await api('POST', `/api/payments/${pay.json.payment.id}/reverse`, { token: accountantToken, body: {} });
    assert(rev2.status === 409, 'a second reversal of the same payment is rejected');
  }

  // =========================================================
  // 7. DISBURSEMENT CANNOT HAPPEN TWICE
  // =========================================================
  {
    const c = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Double Disburse Client', phone: '0722900050' } });
    const products = await api('GET', '/api/loan-products', { token: officerToken });
    const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: c.json.client.id, product_id: products.json.products[0].id, principal: 15000, term_months: 3 } });
    const loanId = loan.json.loan.id;
    await api('POST', `/api/loans/${loanId}/approve`, { token: managerKisumuToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: regionalToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: opsMgrToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: accountantToken, body: {} });
    const d1 = await api('POST', `/api/loans/${loanId}/disburse`, { token: adminToken, body: { channel: 'Cash' } });
    assert(d1.status === 200, 'first disbursement succeeds');
    const d2 = await api('POST', `/api/loans/${loanId}/disburse`, { token: adminToken, body: { channel: 'Cash' } });
    assert(d2.status === 409, 'a second disbursement attempt on the same loan is rejected');
  }

  // =========================================================
  // 8. NOTIFICATION OWNERSHIP — instruction #13
  // =========================================================
  {
    // create a leave request as officer to generate SOME notification-adjacent
    // activity; more directly, just probe the endpoint with a foreign id.
    const notifs = await api('GET', '/api/notifications', { token: officerToken });
    assert(notifs.status === 200, 'officer can read their own notifications');
    // Attempt to mark an arbitrary/non-existent id as read shouldn't 200 as if it worked silently
    const fakeRead = await api('POST', '/api/notifications/does-not-exist/read', { token: officerToken });
    assert(fakeRead.status === 404, 'marking a nonexistent notification id returns 404, not a silent success');
  }

  // =========================================================
  // 9. SUPPORT TICKET VISIBILITY — instruction #14
  // =========================================================
  {
    const t = await api('POST', '/api/support-tickets', { token: officerToken, body: { subject: 'Officer private issue', priority: 'Low' } });
    assert(t.status === 201, 'officer opens a ticket');
    const ticketId = t.json.ticket.id;

    // A different, unrelated ordinary staff member (accountant, non-managerial
    // relative to this ticket) should not see it in the list or by id.
    const accountantList = await api('GET', '/api/support-tickets', { token: accountantToken });
    assert(!accountantList.json.tickets.some(x => x.id === ticketId), 'a non-managerial Accountant does not see another employee\'s ticket in the list');
    const accountantGet = await api('GET', `/api/support-tickets/${ticketId}`, { token: accountantToken });
    assert(accountantGet.status === 403, 'a non-managerial Accountant cannot fetch another employee\'s ticket by id');

    // The officer's own branch manager (Kisumu) SHOULD see it (branch-scoped visibility).
    const kisumuMgrList = await api('GET', '/api/support-tickets', { token: managerKisumuToken });
    assert(kisumuMgrList.json.tickets.some(x => x.id === ticketId), 'the Kisumu branch manager DOES see a ticket from their own branch\'s officer');

    // The Nairobi manager should NOT (different branch).
    const nairobiMgrList = await api('GET', '/api/support-tickets', { token: managerToken });
    assert(!nairobiMgrList.json.tickets.some(x => x.id === ticketId), 'the Nairobi manager does NOT see a Kisumu-branch ticket');

    // Admin sees everything.
    const adminList = await api('GET', '/api/support-tickets', { token: adminToken });
    assert(adminList.json.tickets.some(x => x.id === ticketId), 'Admin sees every ticket system-wide');

    // CEO sees only Critical-priority tickets (or their own).
    const ceoList = await api('GET', '/api/support-tickets', { token: ceoToken });
    assert(!ceoList.json.tickets.some(x => x.id === ticketId), 'CEO does not see an ordinary-priority ticket that is not theirs');
    const critical = await api('POST', '/api/support-tickets', { token: officerToken, body: { subject: 'Critical system outage', priority: 'Critical' } });
    const ceoList2 = await api('GET', '/api/support-tickets', { token: ceoToken });
    assert(ceoList2.json.tickets.some(x => x.id === critical.json.ticket.id), 'CEO DOES see a Critical-priority ticket');
  }

  // =========================================================
  // 10. LEAVE / SALARY ADVANCE AUTHORIZATION — instruction #12
  // =========================================================
  {
    const leave = await api('POST', '/api/leave-requests', { token: officerToken, body: { leave_type: 'Annual', start_date: '2026-10-01', end_date: '2026-10-05' } });
    assert(leave.status === 201, 'officer applies for leave');
    const leaveId = leave.json.leaveRequest.id;

    // Officer tries to approve their own leave
    const selfDecide = await api('POST', `/api/leave-requests/${leaveId}/decide`, { token: officerToken, body: { decision: 'Approved' } });
    assert(selfDecide.status === 403, 'an employee cannot approve their own leave request');

    // An unrelated manager (not their reporting manager, no manage_users) tries to decide
    const unrelatedDecide = await api('POST', `/api/leave-requests/${leaveId}/decide`, { token: managerToken, body: { decision: 'Approved' } });
    assert(unrelatedDecide.status === 403, 'a manager who is NOT this employee\'s reporting manager cannot decide on it');

    // The officer's actual reporting manager (their Kisumu branch manager, per seed) CAN decide
    const properDecide = await api('POST', `/api/leave-requests/${leaveId}/decide`, { token: managerKisumuToken, body: { decision: 'Approved' } });
    assert(properDecide.status === 200, 'the employee\'s real reporting manager CAN approve the leave request');

    // Salary advance — same pattern
    const advance = await api('POST', '/api/salary-advances', { token: officerToken, body: { amount: 5000, reason: 'Emergency' } });
    const advSelf = await api('POST', `/api/salary-advances/${advance.json.salaryAdvance.id}/decide`, { token: officerToken, body: { decision: 'Approved' } });
    assert(advSelf.status === 403, 'an employee cannot approve their own salary advance');
    const advAdmin = await api('POST', `/api/salary-advances/${advance.json.salaryAdvance.id}/decide`, { token: adminToken, body: { decision: 'Approved' } });
    assert(advAdmin.status === 200, 'Admin (manage_users holder) can decide on any salary advance regardless of reporting line');
  }

  // =========================================================
  // 11. CEO / DIRECTOR SCOPED STAFF MANAGEMENT — instruction #6/#7
  // =========================================================
  {
    // CEO creates an ordinary Loan Officer — allowed
    const ceoCreates = await api('POST', '/api/users', { token: ceoToken, body: { name: 'CEO-Created Officer', email: 'ceo.created@rhinocash.co.ke', role_id: 'loan_officer', branch_id: 'br_nairobi' } });
    assert(ceoCreates.status === 201, 'CEO can create an ordinary Loan Officer');

    // CEO tries to create an Admin — blocked
    const ceoCreatesAdmin = await api('POST', '/api/users', { token: ceoToken, body: { name: 'Should Fail', email: 'should.fail1@rhinocash.co.ke', role_id: 'admin' } });
    assert(ceoCreatesAdmin.status === 403, 'CEO CANNOT create an Admin account');

    // Director creates an ordinary Manager — allowed
    const directorCreates = await api('POST', '/api/users', { token: directorToken, body: { name: 'Director-Created Manager', email: 'director.created@rhinocash.co.ke', role_id: 'manager', branch_id: 'br_nairobi' } });
    assert(directorCreates.status === 201, 'Director can create an ordinary Manager');

    // Director tries to create a CEO — blocked
    const directorCreatesCeo = await api('POST', '/api/users', { token: directorToken, body: { name: 'Should Fail', email: 'should.fail2@rhinocash.co.ke', role_id: 'ceo' } });
    assert(directorCreatesCeo.status === 403, 'Director CANNOT create another CEO account');

    // CEO tries to edit the real Admin account — blocked
    const adminUser = await api('GET', '/api/users', { token: adminToken });
    const realAdmin = adminUser.json.users.find(u => u.role_id === 'admin');
    const ceoEditsAdmin = await api('PATCH', `/api/users/${realAdmin.id}`, { token: ceoToken, body: { job_title: 'Hijacked' } });
    assert(ceoEditsAdmin.status === 403, 'CEO cannot edit the Admin account');

    // Director tries to deactivate someone — blocked entirely (instruction #7: no status authority listed)
    const directorDeactivate = await api('POST', `/api/users/${ceoCreates.json.user.id}/status`, { token: directorToken, body: { status: 'Suspended' } });
    assert(directorDeactivate.status === 403, 'Director has no authority to change account status at all');

    // CEO can Suspend an ordinary staff member...
    const ceoSuspends = await api('POST', `/api/users/${ceoCreates.json.user.id}/status`, { token: ceoToken, body: { status: 'Suspended' } });
    assert(ceoSuspends.status === 200, 'CEO CAN suspend an ordinary staff member');
    // ...but cannot Deactivate one (Admin-only distinction within CEO\'s own allowed actions)
    const ceoDeactivates = await api('POST', `/api/users/${ceoCreates.json.user.id}/status`, { token: ceoToken, body: { status: 'Deactivated' } });
    assert(ceoDeactivates.status === 403, 'CEO CANNOT deactivate an account — only Admin can');

    // CEO tries the Admin-exclusive sub-actions
    const ceoModuleAccess = await api('PUT', `/api/users/${ceoCreates.json.user.id}/module-access`, { token: ceoToken, body: { modules: ['dashboard'] } });
    assert(ceoModuleAccess.status === 403, 'CEO cannot set a user\'s module-access overrides — Admin only');
    const ceoResetAccess = await api('POST', `/api/users/${ceoCreates.json.user.id}/reset-access`, { token: ceoToken, body: {} });
    assert(ceoResetAccess.status === 403, 'CEO cannot reset a user\'s access — Admin only');
    const ceoResetPassword = await api('POST', `/api/users/${ceoCreates.json.user.id}/reset-password`, { token: ceoToken, body: {} });
    assert(ceoResetPassword.status === 403, 'CEO cannot reset a user\'s password — Admin only');
    const ceoRevoke = await api('POST', `/api/users/${ceoCreates.json.user.id}/revoke-sessions`, { token: ceoToken, body: {} });
    assert(ceoRevoke.status === 403, 'CEO cannot revoke sessions — Admin only');

    // Admin CAN do all of the above on the same account
    const adminModuleAccess = await api('PUT', `/api/users/${ceoCreates.json.user.id}/module-access`, { token: adminToken, body: { modules: ['dashboard', 'clients'] } });
    assert(adminModuleAccess.status === 200, 'Admin CAN set module-access overrides');
  }

  // =========================================================
  // 12. LOAN RESTRUCTURING — instruction #19
  // =========================================================
  {
    const c = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Restructure Client', phone: '0722900060' } });
    const products = await api('GET', '/api/loan-products', { token: officerToken });
    const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: c.json.client.id, product_id: products.json.products[0].id, principal: 30000, term_months: 3 } });
    const loanId = loan.json.loan.id;
    await api('POST', `/api/loans/${loanId}/approve`, { token: managerKisumuToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: regionalToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: opsMgrToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: accountantToken, body: {} });
    await api('POST', `/api/loans/${loanId}/disburse`, { token: adminToken, body: { channel: 'Cash' } });
    const restructure = await api('POST', `/api/loans/${loanId}/restructure`, { token: managerKisumuToken, body: { new_term_months: 8, reason: 'Client requested longer term' } });
    assert(restructure.status === 200 && restructure.json.loan.status === 'Restructured', 'loan restructuring produces a Restructured loan with a rebuilt schedule');
    assert(restructure.json.schedule.length === 8, 'restructured schedule has the new term length');
  }

  // =========================================================
  // 13. SECURITY HEADERS — instruction #16
  // =========================================================
  {
    const res = await fetch(BASE + '/api/health');
    assert(res.headers.get('x-content-type-options') === 'nosniff', 'security header X-Content-Type-Options is present');
    assert(res.headers.get('x-frame-options') === 'DENY', 'security header X-Frame-Options is present');
  }

  // =========================================================
  // 14. M-PESA / SMS / EMAIL — instruction #17/#18: must not claim to be live
  // =========================================================
  {
    const status = await api('GET', '/api/integrations/status');
    assert(status.json.mpesa === 'NOT_CONFIGURED', 'M-Pesa correctly reports NOT_CONFIGURED (no real credentials in this environment)');
    assert(status.json.sms === 'NOT_CONFIGURED', 'SMS correctly reports NOT_CONFIGURED');
    assert(status.json.email === 'NOT_CONFIGURED', 'Email correctly reports NOT_CONFIGURED');
  }

  // =========================================================
  // 15. RATE LIMITING — instruction #16 (run LAST: deliberately exhausts
  // this process's per-minute quota, which would fail every test after it)
  // =========================================================
  {
    let got429 = false;
    for (let i = 0; i < 200; i++) {
      const r = await fetch(BASE + '/api/health');
      if (r.status === 429) { got429 = true; break; }
    }
    assert(got429, 'general rate limiter actually returns 429 once a single client exceeds the per-minute threshold');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
