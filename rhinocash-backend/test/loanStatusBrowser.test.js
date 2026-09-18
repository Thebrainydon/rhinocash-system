// loanStatusBrowser.test.js — the new "category" grouping on
// /api/loans/applications-overview (All templates/Disbursed/Undisbursed/
// Pended/Declined loans, backing the topbar calendar-check icon's loan
// status browser), plus a real, previously-silent bug fix on the same
// route: from/to/min_amount/max_amount were sent by the existing
// Applications Overview page's own filters but never actually read.
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
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const regionalToken = await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD);
  const opsToken = await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD);
  const acctToken = await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD);
  assert(adminToken && officerToken && managerToken && regionalToken && opsToken && acctToken, 'all needed accounts log in');

  const products = (await api('GET', '/api/loan-products', { token: officerToken })).json.products;
  const productId = products[0].id;
  async function newClient(name) {
    const r = await api('POST', '/api/clients', { token: officerToken, body: { name, phone: '0722' + Math.floor(Math.random() * 900000 + 100000) } });
    return r.json.client.id;
  }

  // A real loan fully approved and disbursed — lands in "Disbursed loans".
  const disbursedClientId = await newClient('[TEST] LSB Disbursed Client');
  const disbursedLoanRes = await api('POST', '/api/loans', { token: officerToken, body: { client_id: disbursedClientId, product_id: productId, principal: 55000, term_months: 4 } });
  assert(disbursedLoanRes.status === 201, 'real setup: the disbursed-loan test fixture is genuinely created');
  const disbursedLoan = disbursedLoanRes.json.loan;
  await api('POST', `/api/loans/${disbursedLoan.id}/approve`, { token: managerToken, body: {} });
  await api('POST', `/api/loans/${disbursedLoan.id}/approve`, { token: regionalToken, body: {} });
  await api('POST', `/api/loans/${disbursedLoan.id}/approve`, { token: opsToken, body: {} });
  await api('POST', `/api/loans/${disbursedLoan.id}/approve`, { token: acctToken, body: {} });
  await api('POST', `/api/loans/${disbursedLoan.id}/disburse`, { token: adminToken, body: { channel: 'Bank' } });

  // A real loan still early in the approval pipeline — lands in "Pended loans".
  const pendedClientId = await newClient('[TEST] LSB Pended Client');
  const pendedLoanRes = await api('POST', '/api/loans', { token: officerToken, body: { client_id: pendedClientId, product_id: productId, principal: 30000, term_months: 3 } });
  assert(pendedLoanRes.status === 201, 'real setup: the pended-loan test fixture is genuinely created');
  const pendedLoan = pendedLoanRes.json.loan;

  // A real loan rejected outright — lands in "Declined loans".
  const declinedClientId = await newClient('[TEST] LSB Declined Client');
  const declinedLoanRes = await api('POST', '/api/loans', { token: officerToken, body: { client_id: declinedClientId, product_id: productId, principal: 12000, term_months: 3 } });
  assert(declinedLoanRes.status === 201, 'real setup: the declined-loan test fixture is genuinely created');
  const declinedLoan = declinedLoanRes.json.loan;
  await api('POST', `/api/loans/${declinedLoan.id}/reject`, { token: managerToken, body: { reason: '[TEST] not viable' } });

  // =========================================================
  // 1. CATEGORY GROUPING
  // =========================================================
  {
    const all_ = await api('GET', `/api/loans/applications-overview?category=All templates&q=${encodeURIComponent('[TEST] LSB')}`, { token: officerToken });
    assert(all_.status === 200 && all_.json.rows.length === 3, "'All templates' returns every one of the real test loans regardless of status");

    const disbursed = await api('GET', `/api/loans/applications-overview?category=Disbursed loans&q=${encodeURIComponent('[TEST] LSB')}`, { token: officerToken });
    assert(disbursed.json.rows.length === 1 && disbursed.json.rows[0].loanId === disbursedLoan.id, "'Disbursed loans' genuinely returns only the real disbursed loan");
    assert(!!disbursed.json.rows[0].disbursedAt, 'the real disbursed loan genuinely carries a real disbursedAt timestamp, not null');

    const pended = await api('GET', `/api/loans/applications-overview?category=Pended loans&q=${encodeURIComponent('[TEST] LSB')}`, { token: officerToken });
    assert(pended.json.rows.length === 1 && pended.json.rows[0].loanId === pendedLoan.id, "'Pended loans' genuinely returns only the real loan still in the approval pipeline");
    assert(!pended.json.rows[0].disbursedAt, 'a real pended loan genuinely has no disbursedAt yet');

    const undisbursed = await api('GET', `/api/loans/applications-overview?category=Undisbursed loans&q=${encodeURIComponent('[TEST] LSB')}`, { token: officerToken });
    assert(undisbursed.json.rows.length === 0, "'Undisbursed loans' (Approved for Disbursement) genuinely excludes a loan that has already been fully disbursed");

    const declined = await api('GET', `/api/loans/applications-overview?category=Declined loans&q=${encodeURIComponent('[TEST] LSB')}`, { token: officerToken });
    assert(declined.json.rows.length === 1 && declined.json.rows[0].loanId === declinedLoan.id, "'Declined loans' genuinely returns only the real rejected loan");
  }

  // =========================================================
  // 2. REAL BUG FIX: from/to/min_amount/max_amount actually filter now
  // =========================================================
  {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const future = await api('GET', `/api/loans/applications-overview?category=All templates&q=${encodeURIComponent('[TEST] LSB')}&from=${tomorrow}`, { token: officerToken });
    assert(future.json.rows.length === 0, "the 'from' date filter genuinely excludes real loans created before it — previously a silent no-op");

    const today = new Date().toISOString().slice(0, 10);
    const todayCheck = await api('GET', `/api/loans/applications-overview?category=All templates&q=${encodeURIComponent('[TEST] LSB')}&from=${today}&to=${today}`, { token: officerToken });
    assert(todayCheck.json.rows.length === 3, "the 'from'/'to' date filters genuinely include real loans created today when the range covers today");

    const minAmt = await api('GET', `/api/loans/applications-overview?category=All templates&q=${encodeURIComponent('[TEST] LSB')}&min_amount=50000`, { token: officerToken });
    assert(minAmt.json.rows.length === 1 && minAmt.json.rows[0].loanId === disbursedLoan.id, "the 'min_amount' filter genuinely excludes the two smaller real loans — previously a silent no-op");

    const maxAmt = await api('GET', `/api/loans/applications-overview?category=All templates&q=${encodeURIComponent('[TEST] LSB')}&max_amount=15000`, { token: officerToken });
    assert(maxAmt.json.rows.length === 1 && maxAmt.json.rows[0].loanId === declinedLoan.id, "the 'max_amount' filter genuinely excludes the two larger real loans — previously a silent no-op");
  }

  // =========================================================
  // 3. REAL ROLE SCOPING — reuses the same branchScopeSQL as every other LoanBook endpoint
  // =========================================================
  {
    const asManager = await api('GET', `/api/loans/applications-overview?category=All templates&q=${encodeURIComponent('[TEST] LSB')}`, { token: managerToken });
    assert(asManager.json.rows.length === 3, "the real Kisumu manager (the officer's own branch) genuinely sees all three real test loans");

    const asAdmin = await api('GET', `/api/loans/applications-overview?category=All templates&q=${encodeURIComponent('[TEST] LSB')}`, { token: adminToken });
    assert(asAdmin.json.rows.length === 3, "Admin's real company-wide scope genuinely sees all three real test loans too");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
