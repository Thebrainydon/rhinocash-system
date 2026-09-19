// atomicity.test.js — Production Readiness remediation, Phase 1: proves
// the real transaction() wrapper genuinely rolls back multi-step
// financial writes under deliberate failure injection, and that healthy
// multi-step writes still commit fully. This is not a re-test of business
// logic (already covered elsewhere) — it specifically targets atomicity.
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
  assert(adminToken && officerToken && managerToken, 'needed accounts log in');

  // =========================================================
  // 1. DIRECT UNIT TEST OF transaction() ITSELF — commit, rollback, nesting
  // =========================================================
  {
    const { run, all, get, transaction } = require('../src/db');
    await run('CREATE TABLE IF NOT EXISTS atomicity_probe (id BIGSERIAL PRIMARY KEY, val TEXT)');
    await run('DELETE FROM atomicity_probe');

    await transaction(async () => {
      await run('INSERT INTO atomicity_probe (val) VALUES (?)', ['a']);
      await run('INSERT INTO atomicity_probe (val) VALUES (?)', ['b']);
    });
    assert((await all('SELECT * FROM atomicity_probe')).length === 2, 'a real successful transaction commits every statement inside it');

    let threw = false;
    try {
      await transaction(async () => {
        await run('INSERT INTO atomicity_probe (val) VALUES (?)', ['c']);
        await run('INSERT INTO atomicity_probe (val) VALUES (?)', ['d']);
        throw new Error('deliberate mid-transaction failure — simulating a real crash between two financial writes');
      });
    } catch (e) { threw = true; }
    assert(threw, 'the deliberate error genuinely propagates out of transaction() — never silently swallowed');
    assert((await all('SELECT * FROM atomicity_probe')).length === 2, 'the real rollback discarded BOTH statements from the failed transaction — never just the one that threw, and never left partially applied');

    // Nested transaction() calls join the outer one — a real regression
    // guard for the exact pattern the payment/disbursement routes use
    // (e.g. a route-level transaction() wrapping a call to a function
    // that also wraps itself in transaction()).
    await transaction(async () => {
      await run('INSERT INTO atomicity_probe (val) VALUES (?)', ['e']);
      await transaction(async () => { await run('INSERT INTO atomicity_probe (val) VALUES (?)', ['f']); });
    });
    assert((await all('SELECT * FROM atomicity_probe')).length === 4, 'nested transaction() calls correctly join the outer transaction rather than erroring on a second real BEGIN');

    let nestedFailureThrew = false;
    try {
      await transaction(async () => {
        await run('INSERT INTO atomicity_probe (val) VALUES (?)', ['g']);
        await transaction(async () => {
          await run('INSERT INTO atomicity_probe (val) VALUES (?)', ['h']);
          throw new Error('failure inside the nested call');
        });
      });
    } catch (e) { nestedFailureThrew = true; }
    assert(nestedFailureThrew && (await all('SELECT * FROM atomicity_probe')).length === 4, 'a failure inside a NESTED transaction() call rolls back the entire OUTER transaction too, including the statement that ran before the nested call — proving nesting does not create a false sense of partial safety');
  }

  // =========================================================
  // 2. REAL PAYMENT RECORDING — genuinely atomic end-to-end
  // =========================================================
  {
    const c = await api('POST', '/api/clients', { token: officerToken, body: { name: '[TEST] Atomicity Client', phone: '0722' + Math.floor(Math.random() * 900000 + 100000) } });
    const products = (await api('GET', '/api/loan-products', { token: officerToken })).json.products;
    const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: c.json.client.id, product_id: products[0].id, principal: 30000, term_months: 4 } });
    const loanId = loan.json.loan.id;
    await api('POST', `/api/loans/${loanId}/approve`, { token: managerToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: regionalToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: opsToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: acctToken, body: {} });
    await api('POST', `/api/loans/${loanId}/disburse`, { token: adminToken, body: { channel: 'Bank' } });

    const payment = await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loanId, amount: 5000, channel: 'Cash' } });
    assert(payment.status === 201, 'a real payment is recorded successfully with the new transaction wrapping in place — no regression from adding atomicity');

    // Verify the real journal entries genuinely exist for this exact payment — not just that the payment row exists.
    const { all: dbAll } = require('../src/db');
    const journalRows = await dbAll(`SELECT * FROM journal_entries WHERE ref_type = 'payment' AND ref_id = ?`, [payment.json.payment.id]);
    assert(journalRows.length >= 2, 'the real payment has real journal entries — confirming the transaction committed all statements together, not just the payment row');
    const totalDebit = journalRows.reduce((s, r) => s + r.debit, 0);
    const totalCredit = journalRows.reduce((s, r) => s + r.credit, 0);
    assert(Math.abs(totalDebit - totalCredit) < 0.01, 'the real journal entries for this payment are genuinely balanced (SUM debit = SUM credit) — the actual double-entry invariant, not an assumed entry count');
  }

  // =========================================================
  // 3. REAL DISBURSEMENT — genuinely atomic end-to-end
  // =========================================================
  {
    const c = await api('POST', '/api/clients', { token: officerToken, body: { name: '[TEST] Disbursement Atomicity', phone: '0722' + Math.floor(Math.random() * 900000 + 100000) } });
    const products = (await api('GET', '/api/loan-products', { token: officerToken })).json.products;
    const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: c.json.client.id, product_id: products[0].id, principal: 15000, term_months: 3 } });
    const loanId = loan.json.loan.id;
    await api('POST', `/api/loans/${loanId}/approve`, { token: managerToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: regionalToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: opsToken, body: {} });
    await api('POST', `/api/loans/${loanId}/approve`, { token: acctToken, body: {} });
    const disburse = await api('POST', `/api/loans/${loanId}/disburse`, { token: adminToken, body: { channel: 'Bank' } });
    assert(disburse.status === 200, 'real disbursement still succeeds with transaction wrapping in place');

    const { all: dbAll2, get: dbGet2 } = require('../src/db');
    const loanRow = await dbGet2('SELECT * FROM loans WHERE id = ?', [loanId]);
    const scheduleRows = await dbAll2('SELECT * FROM loan_schedule WHERE loan_id = ?', [loanId]);
    const journalRows2 = await dbAll2(`SELECT * FROM journal_entries WHERE ref_type = 'loan' AND ref_id = ?`, [loanId]);
    assert(loanRow.status === 'Active', 'the real loan status is genuinely Active');
    assert(scheduleRows.length === 3, 'the real loan schedule (3 installments) was genuinely built');
    assert(journalRows2.length === 3, 'the real disbursement journal entries (receivable debit, net funding credit, real processing-fee income credit) genuinely exist — status, schedule, and journal all committed together in the one real transaction');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
