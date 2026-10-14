// receipts.test.js — Payments: receipt numbers and printed tracking,
// merging unassigned paybill payments, moving an overpayment to another loan.
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
async function otp(token) { const r = await api('POST', '/api/otp/request', { token }); return r.json && r.json.otpForTesting; }
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
  const c = await api('POST', '/api/clients', { token: t.officer, body: { name: 'Receipts ' + Math.random().toString(36).slice(2, 8), phone: '07' + Math.floor(Math.random() * 90000000 + 10000000) } });
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
  };
  assert(Object.values(t).every(Boolean), 'setup: every needed account signs in');
  const today = new Date().toISOString().slice(0, 10);
  const [yy, mm] = today.split('-').map(Number);

  // 1. Receipts: a number per payment, per-day counts, printed tracking
  const L = await driveLoanToDisbursed(t, 20000, 6);
  const p1 = await api('POST', '/api/payments', { token: t.officer, body: { loan_id: L.loanId, amount: 1500, channel: 'Cash', posted: true } });
  const p2 = await api('POST', '/api/payments', { token: t.officer, body: { loan_id: L.loanId, amount: 900, channel: 'Bank', posted: true } });
  assert(p1.status === 201 && p2.status === 201, '1: setup — two payments are recorded');
  const settings = await api('GET', '/api/receipts/settings', { token: t.officer });
  assert(settings.status === 200 && settings.json.settings.perPage === 6 && settings.json.settings.startNumber > 0, '1: every user reads the receipt settings');
  const days = await api('GET', `/api/receipts/days?year=${yy}&month=${mm}`, { token: t.officer });
  const day = (days.json.days || []).find(d => d.date === today);
  assert(days.status === 200 && day && day.receipts >= 2 && day.unprinted >= 2, "1: today's receipts and unprinted count are listed");
  const list = await api('GET', `/api/receipts?date=${today}&unprinted=1`, { token: t.officer });
  const mine = list.json.receipts.filter(r => [p1.json.payment.id, p2.json.payment.id].includes(r.id));
  assert(mine.length === 2 && mine.every(r => r.receiptNo > settings.json.settings.startNumber && r.clientName && r.officerName && r.total > 0), '1: each receipt carries a number, client, loan officer and total');
  assert(mine[0].receiptNo !== mine[1].receiptNo, '1: receipt numbers are unique');
  assert(Math.abs(mine[0].principal + mine[0].interest + mine[0].penalty + mine[0].overpay - mine[0].total) < 0.01, '1: the receipt lines add up to the total');
  assert((await api('GET', '/api/receipts?date=14-10-2026', { token: t.officer })).status === 400, '1: a bad date is rejected');
  assert((await api('GET', `/api/receipts?date=${today}`)).status === 401, '1: receipts need a signed-in user');
  const mark = await api('POST', '/api/receipts/mark-printed', { token: t.officer, body: { receipts: mine.map(r => ({ kind: r.kind, id: r.id })) } });
  assert(mark.status === 200 && mark.json.marked === 2, '1: printing marks the receipts printed');
  const after = await api('GET', `/api/receipts?date=${today}&unprinted=1`, { token: t.officer });
  assert(!after.json.receipts.some(r => mine.some(m => m.id === r.id)), '1: printed receipts leave the unprinted list');
  const all = await api('GET', `/api/receipts?date=${today}`, { token: t.officer });
  assert(all.json.receipts.filter(r => mine.some(m => m.id === r.id)).every(r => r.printed), '1: Download All still includes printed receipts');
  const again = await api('POST', '/api/receipts/mark-printed', { token: t.officer, body: { receipts: mine.map(r => ({ kind: r.kind, id: r.id })) } });
  assert(again.json.marked === 0, '1: a receipt is only marked printed once');

  // 2. Admin sets how the receipt sheet looks
  const save = await api('PUT', '/api/admin/settings/payments.receipts', { token: t.admin, body: { value: { perPage: '4', startNumber: 500000, numberColor: '#112233', watermark: false } } });
  assert(save.status === 200, '2: the System Administrator saves the receipt settings');
  const s2 = await api('GET', '/api/receipts/settings', { token: t.manager });
  assert(s2.json.settings.perPage === 4 && s2.json.settings.startNumber === 500000 && s2.json.settings.watermark === false && s2.json.settings.numberColor === '#112233', '2: every user sees the new settings');
  const renum = await api('GET', `/api/receipts?date=${today}`, { token: t.officer });
  const r1 = renum.json.receipts.find(r => r.id === p1.json.payment.id);
  assert(r1 && r1.receiptNo === mine.find(m => m.id === p1.json.payment.id).receiptNo - settings.json.settings.startNumber + 500000, '2: receipt numbers follow the new starting number');
  await api('PUT', '/api/admin/settings/payments.receipts', { token: t.admin, body: { value: {} } });

  // 3. Merging unassigned paybill payments
  const phone = '2547' + String(Math.floor(Math.random() * 90000000) + 10000000);
  const tids = [];
  for (const amt of [400, 350, 250]) {
    const tid = 'RCPT' + Math.random().toString(36).slice(2, 10).toUpperCase(); tids.push(tid);
    await api('POST', '/api/mpesa/c2b/confirmation/sandbox', { body: { TransID: tid, TransAmount: String(amt), MSISDN: phone, BillRefNumber: 'WRONG-' + tid } });
  }
  const mergeable = await api('GET', '/api/payments/mergeable?q=' + phone.slice(-9), { token: t.manager });
  const picks = mergeable.json.transactions.filter(x => tids.includes(x.transId));
  assert(mergeable.status === 200 && picks.length === 3, '3: unassigned paybill payments are listed for merging');
  assert((await api('POST', '/api/payments/merge', { token: t.officer, body: { transaction_ids: picks.slice(0, 2).map(x => x.id), loan_id: L.loanId } })).status === 403, '3: a Loan Officer cannot merge payments');
  assert((await api('POST', '/api/payments/merge', { token: t.manager, body: { transaction_ids: [picks[0].id], loan_id: L.loanId } })).status === 400, '3: at least two payments are needed');
  assert((await api('POST', '/api/payments/merge', { token: t.manager, body: { transaction_ids: picks.slice(0, 2).map(x => x.id) } })).status === 400, '3: the loan is required');
  const merged = await api('POST', '/api/payments/merge', { token: t.manager, body: { transaction_ids: picks.slice(0, 2).map(x => x.id), loan_id: L.loanId } });
  const want = picks.slice(0, 2).reduce((x, p) => x + p.amount, 0);
  assert(merged.status === 201 && merged.json.merge.total === want && /^MERGED\d+$/.test(merged.json.merge.reference), '3: two payments merge into one MERGED payment of their total');
  assert((await api('POST', '/api/payments/merge', { token: t.manager, body: { transaction_ids: [picks[0].id, picks[2].id], loan_id: L.loanId } })).status === 409, '3: a payment cannot be merged twice');
  const merges = await api('GET', '/api/payments/merges', { token: t.manager });
  const mg = merges.json.merges.find(m => m.id === merged.json.merge.id);
  assert(mg && mg.transactions.length === 2 && mg.total === want && mg.clientName, '3: the merge is listed with its transactions and client');
  const pays = await api('GET', `/api/payments?loan_id=${L.loanId}&limit=50`, { token: t.manager });
  assert(pays.json.payments.some(p => p.reference === merged.json.merge.reference && ['Posted', 'Overpayment'].includes(p.status)), '3: the merged payment is posted to the loan');
  const offScope = await api('GET', '/api/payments/merges', { token: t.officer });
  assert(offScope.status === 200, '3: the merge list is readable within scope');

  // 4. Moving an overpayment to the same client's other loan
  const L2 = await driveLoanToDisbursed(t, 15000, 3);
  const big = await api('POST', '/api/payments', { token: t.officer, body: { loan_id: L2.loanId, amount: 100000, channel: 'Cash', posted: true } });
  assert(big.status === 201 && big.json.payment.status === 'Overpayment', '4: setup — a payment larger than the loan is an overpayment');
  assert((await api('POST', `/api/payments/${big.json.payment.id}/assign-overpay`, { token: t.manager, body: { loan_id: L.loanId } })).status === 400, "4: an overpayment can only move to the same client's loan");
  const c2 = await api('POST', '/api/clients', { token: t.officer, body: { name: 'Receipts second', phone: '07' + Math.floor(Math.random() * 90000000 + 10000000) } });
  assert(c2.status === 201, '4: setup — client');
  // a second loan for the overpaying client
  const products = await api('GET', '/api/loan-products', { token: t.officer });
  const ln = await api('POST', '/api/loans', { token: t.officer, body: { client_id: L2.clientId, product_id: products.json.products[0].id, principal: 12000, term_months: 3 } });
  if (ln.status === 201) {
    for (const k of ['manager', 'regional', 'ops', 'acct']) await api('POST', `/api/loans/${ln.json.loan.id}/approve`, { token: t[k], body: {} });
    await api('POST', `/api/loans/${ln.json.loan.id}/disburse`, { token: t.admin, body: { channel: 'Bank' } });
    assert((await api('POST', `/api/payments/${big.json.payment.id}/assign-overpay`, { token: t.officer, body: { loan_id: ln.json.loan.id } })).status === 403, '4: a Loan Officer cannot move an overpayment');
    const mv = await api('POST', `/api/payments/${big.json.payment.id}/assign-overpay`, { token: t.manager, body: { loan_id: ln.json.loan.id } });
    assert(mv.status === 201 && /^OVERPAY\d+$/.test(mv.json.payment.reference) && mv.json.payment.amount > 0, '4: the overpayment moves to the client’s other loan');
    assert((await api('POST', `/api/payments/${big.json.payment.id}/assign-overpay`, { token: t.manager, body: { loan_id: ln.json.loan.id } })).status === 409, '4: an overpayment moves only once');
    const ovp = await api('GET', `/api/payments?status=Overpayment&loan_id=${L2.loanId}`, { token: t.manager });
    assert(!ovp.json.payments.some(p => p.id === big.json.payment.id), '4: the source payment leaves the Overpayments list');
  } else {
    assert(ln.status === 409 || ln.status === 400, '4: (a client with a running loan cannot take a second one in this setup)');
  }

  // 5. Unposted list: scoped and enriched
  const left = picks[2].transId; // the one not merged
  const c2b = await api('GET', '/api/mpesa/c2b/transactions?q=' + left, { token: t.manager });
  const row = c2b.json.transactions.find(x => x.transId === left);
  assert(c2b.status === 200 && row && row.matched === false && 'linkedApplication' in row && 'paybill' in row, '5: unassigned payments show to the branch with paybill and application link');

  // 6. Payments report: one row per loan officer per month, with drill-downs
  const rep = await api('GET', `/api/payments/staff-report?year=${yy}&month=${mm}`, { token: t.manager });
  assert(rep.status === 200 && Array.isArray(rep.json.staff) && rep.json.totals, '6: the monthly payments report loads');
  const officerRow = rep.json.staff.find(o => o.principal > 0);
  assert(officerRow && officerRow.name && Math.abs(officerRow.totalIncome - (officerRow.interest + officerRow.fee + officerRow.penalty)) < 0.01 && Math.abs(officerRow.totals - (officerRow.principal + officerRow.totalIncome)) < 0.01, '6: total income = interest + fees + penalties; totals add principal');
  const sum = k => rep.json.staff.reduce((x, o) => x + o[k], 0);
  assert(Math.abs(sum('totals') - rep.json.totals.totals) < 0.05, '6: the Totals row adds up the staff rows');
  const det = await api('GET', `/api/payments/staff-report/detail?year=${yy}&month=${mm}&bucket=principal&officer_id=${officerRow.officerId}`, { token: t.manager });
  assert(det.status === 200 && det.json.officerName === officerRow.name && Math.abs(det.json.total - officerRow.principal) < 0.05, "6: the Principal drill-down lists exactly that officer's principal");
  assert(det.json.rows.every(r => r.transaction && r.clientName && r.receiptNo && r.branch && r.approval), '6: each drill-down row has transaction, client, branch, receipt and approval');
  assert((await api('GET', `/api/payments/staff-report/detail?year=${yy}&month=${mm}&bucket=nope`, { token: t.manager })).status === 400, '6: an unknown column is rejected');
  assert((await api('GET', `/api/payments/staff-report?year=x&month=1`, { token: t.manager })).status === 400, '6: a bad month is rejected');
  const own = await api('GET', `/api/payments/staff-report?year=${yy}&month=${mm}`, { token: t.officer });
  assert(own.status === 200 && own.json.staff.every(o => !o.officerId || o.officerId === own.json.staff[0].officerId), '6: a Loan Officer sees only their own row');
  const daily = await api('GET', `/api/mpesa/c2b/daily-summary?from=${today}&to=${today}`, { token: t.manager });
  assert(daily.status === 200 && Array.isArray(daily.json.days), '6: the daily paybill collection calendar loads');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
