// notifications.test.js — confirms the notification triggers added this
// pass actually fire (this was a real gap: the table/API existed but
// nothing ever inserted a row).
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

(async () => {
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const managerKisumuToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const regionalToken = await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD);
  const opsMgrToken = await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD);
  const accountantToken = await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD);
  assert(adminToken && officerToken && managerKisumuToken && regionalToken && opsMgrToken && accountantToken, 'all needed accounts log in');

  const before = await api('GET', '/api/notifications', { token: officerToken });
  const beforeCount = before.json.notifications.length;

  const c = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Notif Test Client', phone: '0722900099' } });
  const products = await api('GET', '/api/loan-products', { token: officerToken });
  const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: c.json.client.id, product_id: products.json.products[0].id, principal: 20000, term_months: 3 } });
  const loanId = loan.json.loan.id;

  // Manager approves -> officer should be notified, AND the Regional Manager
  // (next in line) should be notified too.
  await api('POST', `/api/loans/${loanId}/approve`, { token: managerKisumuToken, body: {} });
  const officerNotifs = await api('GET', '/api/notifications', { token: officerToken });
  assert(officerNotifs.json.notifications.length > beforeCount, 'loan officer received a new notification after their loan was approved');
  assert(officerNotifs.json.notifications.some(n => n.title.includes('Loan approval progressed')), 'the notification content reflects the approval progressing');

  const regionalNotifs = await api('GET', '/api/notifications', { token: regionalToken });
  assert(regionalNotifs.json.notifications.some(n => n.title.includes('awaiting your approval')), 'the next approver (Regional Manager) was notified it is now their turn');

  // A totally unrelated Manager should NOT have gotten that "awaiting your approval" ping.
  const unrelatedManagerToken = await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD);
  const unrelatedNotifs = await api('GET', '/api/notifications', { token: unrelatedManagerToken });
  assert(!unrelatedNotifs.json.notifications.some(n => n.message.includes(loanId)), 'a Manager outside this loan\'s branch scope was not notified about it');

  // Complete the chain and disburse; record a payment; officer notified again.
  await api('POST', `/api/loans/${loanId}/approve`, { token: regionalToken, body: {} });
  await api('POST', `/api/loans/${loanId}/approve`, { token: opsMgrToken, body: {} });
  await api('POST', `/api/loans/${loanId}/approve`, { token: accountantToken, body: {} });
  await api('POST', `/api/loans/${loanId}/disburse`, { token: adminToken, body: { channel: 'Cash' } });
  const afterDisburse = await api('GET', '/api/notifications', { token: officerToken });
  assert(afterDisburse.json.notifications.some(n => n.title === 'Loan disbursed'), 'officer notified on disbursement');

  const beforePayment = afterDisburse.json.notifications.length;
  await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loanId, amount: 5000, channel: 'Cash' } });
  const afterPayment = await api('GET', '/api/notifications', { token: officerToken });
  assert(afterPayment.json.notifications.length > beforePayment, 'officer notified when a payment is recorded against their loan');

  // Leave decision notification
  const leave = await api('POST', '/api/leave-requests', { token: officerToken, body: { leave_type: 'Sick', start_date: '2026-11-01', end_date: '2026-11-02' } });
  await api('POST', `/api/leave-requests/${leave.json.leaveRequest.id}/decide`, { token: managerKisumuToken, body: { decision: 'Rejected' } });
  const afterLeave = await api('GET', '/api/notifications', { token: officerToken });
  assert(afterLeave.json.notifications.some(n => n.title === 'Leave request Rejected'), 'officer notified when their leave request is decided');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
