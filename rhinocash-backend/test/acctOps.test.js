// acctOps.test.js — the Accountant's finance pages: analysis endpoints,
// budgets, forecasts, refunds, write-off proposals, verifications,
// exceptions, and financial requests sent to the CEO / Director.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
// This file logs into the same seeded accounts repeatedly, purely for
// convenience — never to test concurrent-session semantics itself (that's
// what section 2, Active Sessions, explicitly does with its own real,
// per-session Admin revoke). Now that a real single-active-session policy
// exists, a later login for an account already logged in earlier in this
// file (and never logged back out, or Admin-revoked) gets genuinely
// rejected (409). Rather than hand-add an explicit logout before every
// such repeat call, this real map tracks the most recent real token issued
// per email; on hitting that exact real block, it logs that prior session
// out (exactly what a real second device would have to do) and retries
// once. A login that fails for any OTHER reason (maintenance mode, wrong
// password, etc.) never touches the existing session.
const __activeLoginToken = new Map();
async function api(method, path, { token, body } = {}) {
  const isLogin = method === 'POST' && (path === '/api/auth/login' || path === '/api/investor-auth/login');
  const doFetch = async () => {
    const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  let result = await doFetch();
  if (isLogin && result.status === 409 && result.json && result.json.code === 'ALREADY_LOGGED_IN' && body && body.email) {
    const key = String(body.email).toLowerCase();
    const prior = __activeLoginToken.get(key);
    if (prior) {
      await fetch(BASE + (path === '/api/auth/login' ? '/api/auth/logout' : '/api/investor-auth/logout'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prior}` },
      }).catch(() => {});
      __activeLoginToken.delete(key);
      result = await doFetch();
    }
  }
  if (isLogin && result.status === 200 && result.json && result.json.token && body && body.email) {
    __activeLoginToken.set(String(body.email).toLowerCase(), result.json.token);
  }
  return result;
}
async function login(email, password) { const r = await api('POST', '/api/auth/login', { body: { email, password } }); return r.json && r.json.token; }


async function driveLoanToDisbursed(t, principal, term) {
  const c = await api('POST', '/api/clients', { token: t.officer, body: { name: 'AcctOps ' + Math.random().toString(36).slice(2, 8), phone: '07' + Math.floor(Math.random() * 90000000 + 10000000) } });
  const products = await api('GET', '/api/loan-products', { token: t.officer });
  const loan = await api('POST', '/api/loans', { token: t.officer, body: { client_id: c.json.client.id, product_id: products.json.products[0].id, principal, term_months: term } });
  for (const k of ['manager', 'regional', 'ops', 'acct']) await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: t[k], body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/disburse`, { token: t.admin, body: { channel: 'Bank' } });
  return { loanId: loan.json.loan.id, clientId: c.json.client.id };
}

(async () => {
  const t = {
    admin: await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD),
    manager: await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD),
    regional: await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD),
    ops: await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD),
    acct: await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD),
    officer: await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD),
    ceo: await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD),
    director: await login('director@rhinocash.co.ke', process.env.SEEDED_DIRECTOR_PASSWORD),
  };
  assert(Object.values(t).every(Boolean), 'setup: every needed account signs in');
  const year = new Date().getUTCFullYear();

  // 1. Access and the analysis endpoints
  assert((await api('GET', '/api/acct/finance', { token: t.officer })).status === 403, '1: a Loan Officer cannot open the finance pages');
  assert((await api('POST', '/api/acct/records', { token: t.officer, body: { kind: 'exception', title: 'x' } })).status === 403, '1: a Loan Officer cannot record accounting items');
  const fin = await api('GET', '/api/acct/finance', { token: t.acct });
  assert(fin.status === 200 && fin.json.monthly.length === 12 && Array.isArray(fin.json.branches) && fin.json.branches.length > 0, '1: finance figures load with 12 months and every branch');
  assert(fin.json.payables && Array.isArray(fin.json.payables.expenses) && fin.json.receivables && fin.json.receivables.ageing.length === 5, '1: receivables and payables are included');
  assert((await api('GET', '/api/acct/finance', { token: t.ceo })).status === 200, '1: the CEO can view the finance figures');
  assert((await api('GET', '/api/acct/finance?year=abc', { token: t.acct })).status === 400, '1: a bad year is rejected');
  const ctl = await api('GET', '/api/acct/controls', { token: t.acct });
  assert(ctl.status === 200 && Array.isArray(ctl.json.transactions) && ctl.json.suspense && Array.isArray(ctl.json.exceptions), '1: control queues load');
  assert((await api('GET', '/api/acct/client-quality', { token: t.acct })).status === 200, '1: client data quality loads');
  assert((await api('GET', '/api/acct/daily?date=13-10-2026', { token: t.acct })).status === 400, '1: a bad report date is rejected');
  assert((await api('GET', '/api/acct/daily', { token: t.acct })).status === 200, "1: today's daily report loads");

  // 2. Budgets: raised by the Accountant, approved by the CEO
  const b1 = await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'budget', category: 'exp_rent', period: String(year), amount: 120000 } });
  assert(b1.status === 201 && b1.json.record.status === 'Pending', '2: a budget line starts as Pending');
  assert((await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'budget', category: 'exp_rent', period: String(year), amount: 5 } })).status === 409, '2: the same account, period and branch cannot be budgeted twice');
  assert((await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'budget', category: 'cash', period: String(year), amount: 5 } })).status === 400, '2: only income and expense accounts can be budgeted');
  assert((await api('PATCH', `/api/acct/records/${b1.json.record.id}`, { token: t.acct, body: { status: 'Approved' } })).status === 403, '2: the Accountant cannot approve a budget');
  const b1a = await api('PATCH', `/api/acct/records/${b1.json.record.id}`, { token: t.ceo, body: { status: 'Approved' } });
  assert(b1a.status === 200 && b1a.json.record.status === 'Approved' && b1a.json.record.decidedByName, '2: the CEO approves the budget');
  assert((await api('PATCH', `/api/acct/records/${b1.json.record.id}`, { token: t.acct, body: { amount: 1 } })).status === 400, '2: an approved budget cannot be changed');

  // 3. Forecasts: a newer forecast for the same month replaces the older one
  const month = new Date(Date.UTC(year, new Date().getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
  const f1 = await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'forecast', category: 'Collections', period: month, amount: 1000 } });
  const f2 = await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'forecast', category: 'Collections', period: month, amount: 2000 } });
  const fl = await api('GET', '/api/acct/records?kind=forecast', { token: t.acct });
  assert(f1.status === 201 && f2.status === 201 && fl.json.records.find(r => r.id === f1.json.record.id).status === 'Superseded' && fl.json.records.find(r => r.id === f2.json.record.id).status === 'Active', '3: a newer forecast supersedes the older one');
  assert((await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'forecast', category: 'Dreams', period: month, amount: 1 } })).status === 400, '3: an unknown forecast line is rejected');

  // 4. Refunds of an overpayment: approved, then paid through the ledger
  const L1 = await driveLoanToDisbursed(t, 10000, 2);
  const pay = await api('POST', '/api/payments', { token: t.officer, body: { loan_id: L1.loanId, amount: 50000, channel: 'Cash' } });
  assert(pay.status === 201 || pay.status === 200, '4: a payment larger than the loan is recorded');
  const ctl2 = await api('GET', '/api/acct/controls', { token: t.acct });
  const credit = ctl2.json.suspense.credits.find(c => c.clientId === L1.clientId);
  assert(credit && credit.available > 0, '4: the overpayment shows as a client credit');
  const suspenseBefore = ctl2.json.suspense.overpaymentSuspense;
  assert((await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'refund', ref_type: 'client', ref_id: L1.clientId, amount: credit.available + 1000 } })).status === 400, '4: a refund larger than the credit is rejected');
  const rf = await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'refund', ref_type: 'client', ref_id: L1.clientId, amount: 500, data: { method: 'Cash' } } });
  assert(rf.status === 201 && rf.json.record.status === 'Pending', '4: the refund waits for approval');
  assert((await api('PATCH', `/api/acct/records/${rf.json.record.id}`, { token: t.acct, body: { status: 'Paid' } })).status === 400, '4: a refund cannot be paid before it is approved');
  assert((await api('PATCH', `/api/acct/records/${rf.json.record.id}`, { token: t.director, body: { status: 'Approved' } })).status === 200, '4: the Director approves the refund');
  assert((await api('PATCH', `/api/acct/records/${rf.json.record.id}`, { token: t.acct, body: { status: 'Paid' } })).status === 200, '4: the Accountant pays the approved refund');
  const je = await api('GET', `/api/journal-entries?ref_type=refund&ref_id=${rf.json.record.id}`, { token: t.admin });
  const jes = (je.json && je.json.entries) || [];
  assert(jes.length === 2 && Math.abs(jes.reduce((s, e) => s + e.debit - e.credit, 0)) < 0.01, '4: paying the refund posts a balanced two-line journal');
  const ctl3 = await api('GET', '/api/acct/controls', { token: t.acct });
  assert(Math.abs(ctl3.json.suspense.overpaymentSuspense - (suspenseBefore - 500)) < 0.01, '4: the overpayment suspense balance drops by the refund');

  // 5. Write-offs: proposed with a reason, approved, then executed
  const L2 = await driveLoanToDisbursed(t, 12000, 2);
  assert((await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'write_off', ref_type: 'loan', ref_id: L2.loanId } })).status === 400, '5: a write-off needs a reason');
  const wo = await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'write_off', ref_type: 'loan', ref_id: L2.loanId, details: 'Client relocated, unreachable' } });
  assert(wo.status === 201 && wo.json.record.amount === 12000, '5: the write-off amount is the principal still owed');
  assert((await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'write_off', ref_type: 'loan', ref_id: L2.loanId, details: 'again' } })).status === 409, '5: a loan cannot have two write-offs in progress');
  assert((await api('PATCH', `/api/acct/records/${wo.json.record.id}`, { token: t.ceo, body: { status: 'Approved' } })).status === 200, '5: the CEO approves the write-off');
  assert((await api('PATCH', `/api/acct/records/${wo.json.record.id}`, { token: t.acct, body: { status: 'Written Off' } })).status === 200, '5: the Accountant executes the write-off');
  const lg = await api('GET', `/api/loans/${L2.loanId}`, { token: t.admin });
  assert(lg.json.loan.status === 'Written Off', '5: the loan is now written off');
  const wje = await api('GET', `/api/journal-entries?ref_type=write_off&ref_id=${L2.loanId}`, { token: t.admin });
  assert(((wje.json && wje.json.entries) || []).some(e => e.account_id === 'loans_receivable' && Math.abs(e.credit - 12000) < 0.01), '5: the loan receivable is credited in the ledger');

  // 6. Verifications and exceptions
  assert((await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'verification', ref_type: 'payment', ref_id: pay.json.payment.id, status: 'Flagged' } })).status === 400, '6: flagging needs a reason');
  assert((await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'verification', ref_type: 'payment', ref_id: pay.json.payment.id, status: 'Verified' } })).status === 201, '6: the Accountant verifies a payment');
  const ctl4 = await api('GET', '/api/acct/controls', { token: t.acct });
  assert((ctl4.json.payments.find(p => p.id === pay.json.payment.id) || {}).verification.status === 'Verified', '6: the payment shows as verified');
  const ex = await api('POST', '/api/acct/records', { token: t.acct, body: { kind: 'exception', title: '[TEST] Cash count short', category: 'Cash', amount: 300 } });
  assert(ex.status === 201 && ex.json.record.status === 'Open', '6: the Accountant raises a control exception');
  assert((await api('PATCH', `/api/acct/records/${ex.json.record.id}`, { token: t.acct, body: { status: 'Resolved', outcome: 'Recounted' } })).json.record.status === 'Resolved', '6: the exception is resolved');

  // 7. Financial requests: raised by the Accountant, decided by an executive, then paid
  assert((await api('GET', '/api/exec/records', { token: t.acct })).status === 403, '7: the Accountant cannot browse every executive record');
  assert((await api('POST', '/api/exec/records', { token: t.acct, body: { kind: 'risk', title: 'x', data: { likelihood: 1, impact: 1 } } })).status === 403, '7: the Accountant cannot record other executive items');
  const fr = await api('POST', '/api/exec/records', { token: t.acct, body: { kind: 'financial_request', title: '[TEST] Branch float top-up', amount: 40000 } });
  assert(fr.status === 201 && fr.json.record.status === 'Pending', '7: the Accountant raises a financial request');
  assert((await api('PATCH', `/api/exec/records/${fr.json.record.id}`, { token: t.acct, body: { status: 'Approved' } })).status === 403, '7: the Accountant cannot approve it');
  assert((await api('PATCH', `/api/exec/records/${fr.json.record.id}`, { token: t.acct, body: { status: 'Paid' } })).status === 400, '7: it cannot be paid before approval');
  assert((await api('PATCH', `/api/exec/records/${fr.json.record.id}`, { token: t.director, body: { status: 'Approved' } })).status === 200, '7: the Director approves it');
  const frp = await api('PATCH', `/api/exec/records/${fr.json.record.id}`, { token: t.acct, body: { status: 'Paid', outcome: 'EFT 123' } });
  assert(frp.status === 200 && frp.json.record.status === 'Paid', '7: the Accountant marks it paid');
  const frl = await api('GET', '/api/exec/records?kind=financial_request', { token: t.acct });
  assert(frl.status === 200 && frl.json.records.some(r => r.id === fr.json.record.id), '7: the Accountant sees financial requests');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
