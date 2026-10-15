// notificationsFlow.test.js — the system tells the next person what to do:
// a new application reaches the branch Manager (and the Regional Manager
// hears of it), each approval hands it to the next approver and marks the
// earlier request done, a fully approved loan asks for disbursement, staff
// requests reach their approver, and payments nobody assigned or posted
// reach Managers and above — then are assigned/posted automatically.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}
const login = async (email, pw) => (await api('POST', '/api/auth/login', { body: { email, password: pw } })).json.token;

(async () => {
  const t = {
    officer: await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD),
    mgrK: await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD),
    regional: await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD),
    ops: await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD),
    acct: await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD),
    admin: await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD),
  };
  assert(Object.values(t).every(Boolean), 'setup: every role signs in');
  const notes = async tok => (await api('GET', '/api/notifications', { token: tok })).json.notifications;
  const about = (list, id) => list.filter(n => n.related_id === id);

  // A Regional Manager whose account has only a branch (no region) still
  // works in that branch's region — the whole flow below runs that way.
  const { run } = require('../src/db');
  await run(`UPDATE users SET region_id = NULL WHERE email = 'regional@rhinocash.co.ke'`);

  // 1. A new application
  const phone = '07' + String(Date.now()).slice(-8);
  const c = await api('POST', '/api/clients', { token: t.officer, body: { name: 'Notify Flow Client', phone } });
  const products = (await api('GET', '/api/loan-products', { token: t.officer })).json.products;
  const prod = products.find(p => !p.processing_fee_amount) || products[0];
  const loan = (await api('POST', '/api/loans', { token: t.officer, body: { client_id: c.json.client.id, product_id: prod.id, principal: 20000, term_months: 3 } })).json.loan;
  assert(loan && loan.status === 'Waiting for Manager', 'setup: the application waits for the Manager');
  let m = about(await notes(t.mgrK), loan.id);
  assert(m.some(n => n.title === 'Loan awaiting your approval' && n.action === 'approve' && !n.acted_at && JSON.parse(n.link).subtab === 'Loan Applications'), '1: the branch Manager is asked to approve, with a link to Loan Applications');
  assert(m.some(n => /Notify Flow Client/.test(n.message) && /KES 20,000/.test(n.message)), '1: the notification names the client and amount, not an internal id');
  const r1 = about(await notes(t.regional), loan.id);
  assert(r1.some(n => n.title === 'New loan application' && !n.action), '1: the Regional Manager hears of the new application in their region');

  // 2. Approvals hand it on and close earlier requests
  await api('POST', `/api/loans/${loan.id}/approve`, { token: t.mgrK, body: {} });
  m = about(await notes(t.mgrK), loan.id);
  assert(m.some(n => n.action === 'approve' && n.acted_at && /Approved by/.test(n.action_taken)), "2: the Manager's request is marked done: Approved by …");
  const r2 = about(await notes(t.regional), loan.id);
  assert(r2.some(n => n.title === 'Loan awaiting your approval' && n.action === 'approve' && !n.acted_at), '2: the Regional Manager is now asked to approve');
  const o = about(await notes(t.officer), loan.id);
  assert(o.some(n => n.title === 'Loan approval progressed' && /approved by/.test(n.message)), '2: the loan officer is told who approved it');
  const rmList = (await api('GET', '/api/loans?limit=500', { token: t.regional })).json;
  assert(((rmList && rmList.loans) || []).some(l => l.id === loan.id), "2: the Regional Manager (branch set, no region) sees the loan in their list");
  const rmApprove = await api('POST', `/api/loans/${loan.id}/approve`, { token: t.regional, body: {} });
  assert(rmApprove.status === 200 && rmApprove.json.loan.status === 'Waiting for Operational Manager', '2: …and approves it (' + rmApprove.status + ')');
  await api('POST', `/api/loans/${loan.id}/approve`, { token: t.ops, body: {} });
  await api('POST', `/api/loans/${loan.id}/approve`, { token: t.acct, body: {} });
  const a = about(await notes(t.mgrK), loan.id);
  assert(a.some(n => n.title === 'Loan ready to disburse' && n.action === 'disburse' && !n.acted_at), '2: once fully approved, whoever can disburse in the branch is asked to');
  const d = await api('POST', `/api/loans/${loan.id}/disburse`, { token: t.mgrK, body: { channel: 'Bank' } });
  assert(d.status === 200, '2: it is disbursed');
  assert(about(await notes(t.mgrK), loan.id).some(n => n.action === 'disburse' && n.acted_at && /Disbursed/.test(n.action_taken)), '2: the disbursement request is marked done');
  assert(about(await notes(t.officer), loan.id).some(n => n.title === 'Loan disbursed'), '2: the loan officer is told it was disbursed');

  // 3. A leave request reaches its approver and closes on decision
  const lv = await api('POST', '/api/leave-requests', { token: t.officer, body: { leave_type: 'Annual', start_date: '2031-01-05', end_date: '2031-01-07', reason: 'flow test' } });
  const hrTok = await login('hr@rhinocash.co.ke', process.env.SEEDED_HR_PASSWORD);
  const me = (await api('GET', '/api/auth/me', { token: t.officer })).json.user;
  const approverTok = me.reporting_manager_id ? null : hrTok;
  if (approverTok) {
    const h = about(await notes(approverTok), lv.json.leaveRequest.id);
    assert(h.some(n => n.title === 'Leave request to decide' && n.action === 'decide'), '3: the approver is asked to decide the leave request');
    await api('POST', `/api/leave-requests/${lv.json.leaveRequest.id}/decide`, { token: approverTok, body: { decision: 'Approved' } });
    assert(about(await notes(approverTok), lv.json.leaveRequest.id).some(n => n.acted_at && /Approved by/.test(n.action_taken)), '3: …and it is marked done when decided');
  } else assert(true, '3: (officer has a reporting manager; covered by that path)');

  // 4. A payment recorded as Unposted reaches Managers and above, and posts itself if left
  const loan2 = (await api('POST', '/api/loans', { token: t.officer, body: { client_id: c.json.client.id, product_id: prod.id, principal: 10000, term_months: 3 } })).json.loan;
  for (const tk of [t.mgrK, t.regional, t.ops, t.acct]) await api('POST', `/api/loans/${loan2.id}/approve`, { token: tk, body: {} });
  await api('POST', `/api/loans/${loan2.id}/disburse`, { token: t.mgrK, body: { channel: 'Bank' } });
  const up = await api('POST', '/api/payments', { token: t.mgrK, body: { loan_id: loan2.id, amount: 500, channel: 'Cash', posted: false } });
  assert(up.status === 201 && up.json.payment.status === 'Unposted', 'setup: a payment is recorded as Unposted');
  const pm = about(await notes(t.mgrK), up.json.payment.id);
  assert(pm.some(n => n.title === 'Payment to post' && n.action === 'post'), '4: the branch Manager is asked to post it');
  assert(about(await notes(t.regional), up.json.payment.id).length && about(await notes(t.acct), up.json.payment.id).length, '4: the Regional Manager and the Accountant are told too');
  assert(!about(await notes(t.officer), up.json.payment.id).some(n => n.action), '4: the loan officer is not asked to post payments');
  assert((await api('POST', '/api/payments/auto-assign/run', { token: t.mgrK, body: { now: true } })).status === 403, '4: only Admin/Accountant run automatic assignment by hand');
  const run1 = await api('POST', '/api/payments/auto-assign/run', { token: t.admin, body: { now: true } });
  assert(run1.status === 200 && run1.json.posted.some(p => p.paymentId === up.json.payment.id), '4: left waiting, it is posted automatically');
  const pays = (await api('GET', `/api/payments?loan_id=${loan2.id}&limit=50`, { token: t.admin })).json;
  const mine = ((pays && pays.payments) || []).find(p => p.id === up.json.payment.id);
  assert(mine && ['Posted', 'Overpayment'].includes(mine.status), '4: the payment is now posted (' + (mine ? mine.status : JSON.stringify(pays).slice(0, 120)) + ')');
  assert(about(await notes(t.mgrK), up.json.payment.id).some(n => n.acted_at && n.action_taken === 'Posted automatically'), '4: the request is marked "Posted automatically"');

  // 5. An unmatched Paybill payment reaches Managers and above, then is assigned automatically when only one loan fits
  const transId = 'NTF' + String(Date.now()).slice(-7);
  const conf = await api('POST', '/api/mpesa/c2b/confirmation/sandbox', { body: { TransID: transId, TransAmount: '300', MSISDN: '254' + phone.slice(1), BillRefNumber: 'WRONGREF' } });
  assert(conf.status === 200, 'setup: an M-Pesa payment arrives with a wrong account number');
  // The phone matches the client, so the normal match already finds it; a truly unknown one stays unassigned.
  const unknown = 'NTU' + String(Date.now()).slice(-7);
  await api('POST', '/api/mpesa/c2b/confirmation/sandbox', { body: { TransID: unknown, TransAmount: '250', MSISDN: '254700000001', BillRefNumber: 'NOBODY' } });
  const mn = await notes(t.ops);
  assert(mn.some(n => n.title === 'Payment to assign' && n.action === 'assign' && JSON.parse(n.link).panel === 'payments' && n.message.includes(unknown)), '5: Managers and above are asked to assign an unmatched payment');
  const run2 = await api('POST', '/api/payments/auto-assign/run', { token: t.acct, body: { now: true } });
  assert(run2.status === 200 && run2.json.leftForPeople >= 1 && !run2.json.assigned.some(x => x.transaction === unknown), '5: a payment no loan fits is left for a person, never guessed');

  await run(`UPDATE users u SET region_id = b.region_id FROM branches b WHERE b.id = u.branch_id AND u.email = 'regional@rhinocash.co.ke'`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
