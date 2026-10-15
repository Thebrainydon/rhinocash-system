// coopBank.test.js — loan disbursement by Co-op Bank transfer, end to end
// against a stand-in Co-op server started by this test (the real Co-op
// API is not reachable from the test environment): Admin-only setup with
// masked keys, production confirmation, the one-time code, the transfer
// request Co-op receives, "pending until the bank confirms", a callback
// that is checked with the bank rather than trusted, failure recovery,
// duplicate protection and PesaLink to another bank.
'use strict';
const http = require('node:http');
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}
async function login(email, password) { const r = await api('POST', '/api/auth/login', { body: { email, password } }); return r.json && r.json.token; }
async function driveLoanToApproved(t, principal) {
  const c = await api('POST', '/api/clients', { token: t.officer, body: { name: 'Bank Test ' + Math.random().toString(36).slice(2, 8), phone: '07' + Math.floor(Math.random() * 90000000 + 10000000) } });
  const products = await api('GET', '/api/loan-products', { token: t.officer });
  const loan = await api('POST', '/api/loans', { token: t.officer, body: { client_id: c.json.client.id, product_id: products.json.products[0].id, principal, term_months: 3 } });
  for (const k of ['manager', 'regional', 'ops', 'acct']) await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: t[k], body: {} });
  return loan.json.loan.id;
}

// ---- stand-in Co-op Bank server ----
const coop = { transfers: [], statusByRef: {}, tokenCalls: 0 };
function startFakeCoop() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let raw = ''; req.on('data', d => { raw += d; });
      req.on('end', () => {
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.url === '/token') {
          coop.tokenCalls++;
          const ok = String(req.headers.authorization || '').startsWith('Basic ') && raw.includes('grant_type=client_credentials');
          return ok ? send(200, { access_token: 'fake-token', expires_in: 3600 }) : send(401, { error: 'invalid_client' });
        }
        if (String(req.headers.authorization) !== 'Bearer fake-token') return send(401, { message: 'no token' });
        const body = raw ? JSON.parse(raw) : {};
        if (req.url.startsWith('/FundsTransfer/')) {
          coop.transfers.push({ path: req.url, body });
          return send(200, { MessageReference: body.MessageReference, MessageCode: '0', MessageDescription: 'REQUEST ACCEPTED FOR PROCESSING' });
        }
        if (req.url === '/Enquiry/TransactionStatus/2.0.0') {
          const st = coop.statusByRef[body.MessageReference] || 'pending';
          if (st === 'success') return send(200, { MessageReference: body.MessageReference, MessageCode: '0', MessageDescription: 'SUCCESS', Destinations: [{ ResponseCode: '0', ResponseDescription: 'Success', TransactionID: 'FT' + body.MessageReference.slice(-6) }] });
          if (st === 'failed') return send(200, { MessageReference: body.MessageReference, MessageCode: '0', MessageDescription: 'SUCCESS', Destinations: [{ ResponseCode: '1', ResponseDescription: 'Invalid destination account' }] });
          return send(200, { MessageReference: body.MessageReference, MessageCode: '0', MessageDescription: 'SUCCESS', Destinations: [{ ResponseCode: '-1', ResponseDescription: 'Transaction pending' }] });
        }
        send(404, { message: 'unknown path' });
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const fakeCoop = await startFakeCoop();
  const coopUrl = `http://127.0.0.1:${fakeCoop.address().port}`;
  const { get } = require('../src/db');
  const t = {
    admin: await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD),
    manager: await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD),
    regional: await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD),
    ops: await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD),
    acct: await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD),
    officer: await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD),
  };
  assert(Object.values(t).every(Boolean), 'all needed accounts log in');
  t.disb = t.manager; // disburse_loans: Manager (and Accountant where Admin grants it)

  // ---- 1. Off until set up ----
  const loan1 = await driveLoanToApproved(t, 12000);
  const st0 = await api('GET', '/api/bank/status', { token: t.disb });
  assert(st0.status === 200 && st0.json.active === false, 'Co-op Bank transfers are off until an Admin sets them up');
  const off = await api('POST', `/api/loans/${loan1}/disburse/bank`, { token: t.disb, body: { rail: 'internal', account_number: '01100000001', account_name: 'Test Client', otp_code: '000000' } });
  assert(off.json && off.json.status === 'NOT_CONFIGURED', 'disbursing by bank while it is off says so and sends nothing');

  // ---- 2. Admin-only setup, keys never returned ----
  const notAdmin = await api('PUT', '/api/admin/bank/config/sandbox', { token: t.acct, body: { consumerKey: 'x' } });
  assert(notAdmin.status === 403, 'only the Admin can change Co-op Bank settings');
  const badAcct = await api('PUT', '/api/admin/bank/config/sandbox', { token: t.admin, body: { sourceAccount: '12ab' } });
  assert(badAcct.status === 400, 'a malformed Rhinocash account number is refused');
  const badUrl = await api('PUT', '/api/admin/bank/config/sandbox', { token: t.admin, body: { baseUrl: 'http://evil.example.com' } });
  assert(badUrl.status === 400, 'a plain-http API address (other than this machine) is refused');
  const saved = await api('PUT', '/api/admin/bank/config/sandbox', { token: t.admin, body: { consumerKey: 'CK-SECRET-123456', consumerSecret: 'CS-SECRET-654321', sourceAccount: '01192000000100', baseUrl: coopUrl } });
  assert(saved.status === 200 && saved.json.config.configured === true, 'the Admin saves the sandbox keys, account and API address');
  const cfg = await api('GET', '/api/admin/bank/config', { token: t.admin });
  const raw = JSON.stringify(cfg.json);
  assert(cfg.status === 200 && !raw.includes('CK-SECRET-123456') && !raw.includes('CS-SECRET-654321') && cfg.json.sandbox.consumerKey && cfg.json.sandbox.defaultCallbackUrl.endsWith('/api/bank/coop/callback/sandbox'), 'saved keys are only ever shown masked; the callback address is suggested');
  const dbRow = await get('SELECT consumer_key_enc FROM bank_environment_configs WHERE environment = ?', ['sandbox']);
  assert(dbRow && dbRow.consumer_key_enc && !dbRow.consumer_key_enc.includes('CK-SECRET'), 'keys are encrypted in the database');
  const test = await api('POST', '/api/admin/bank/test-connection/sandbox', { token: t.admin });
  assert(test.json && test.json.status === 'Connection Successful', 'Test Connection gets a token from the bank');
  const prodNoConfirm = await api('POST', '/api/admin/bank/set-active', { token: t.admin, body: { environment: 'production' } });
  assert(prodNoConfirm.status === 400, 'switching on Production needs an explicit confirmation');
  const on = await api('POST', '/api/admin/bank/set-active', { token: t.admin, body: { environment: 'sandbox' } });
  assert(on.status === 200 && on.json.activeEnvironment === 'sandbox', 'the Admin switches on sandbox transfers');
  assert((await api('GET', '/api/bank/status', { token: t.disb })).json.active === true, 'staff who disburse now see bank transfers as available');

  // ---- 3. Sending: permission, checks, one-time code ----
  const officerTry = await api('POST', `/api/loans/${loan1}/disburse/bank`, { token: t.officer, body: { rail: 'internal', account_number: '01100000001', account_name: 'Test Client' } });
  assert(officerTry.status === 403, 'a Loan Officer cannot disburse by bank');
  const badDest = await api('POST', `/api/loans/${loan1}/disburse/bank`, { token: t.disb, body: { rail: 'internal', account_number: '12', account_name: 'Test Client' } });
  assert(badDest.status === 400, 'an invalid account number is refused before anything is sent');
  const noCode = await api('POST', `/api/loans/${loan1}/disburse/bank`, { token: t.disb, body: { rail: 'internal', account_number: '01100000001', account_name: 'Test Client', otp_code: '123' } });
  assert(noCode.status === 400 && noCode.json.code === 'INVALID_OTP' && coop.transfers.length === 0, 'without the right one-time code nothing is sent');
  const otp = await api('POST', '/api/bank/disburse/request-otp', { token: t.disb });
  const code = otp.json && otp.json.otpForTesting;
  assert(!!code, 'a one-time code is issued (shown on screen here because SMS is off in tests)');
  const sent = await api('POST', `/api/loans/${loan1}/disburse/bank`, { token: t.disb, body: { rail: 'internal', account_number: '0110 0000 0001', account_name: 'Test Client', otp_code: code } });
  assert(sent.status === 200 && sent.json.status === 'PENDING' && sent.json.loan.status === 'Disbursement Pending', 'the transfer is sent and the loan waits as Disbursement Pending');
  const tr = coop.transfers[0];
  assert(tr && tr.path === '/FundsTransfer/Internal/A2A/2.0.0' && tr.body.Source.AccountNumber === '01192000000100' && tr.body.Destinations[0].AccountNumber === '011000000001'
    && tr.body.Destinations[0].Amount === sent.json.amount && tr.body.Source.Amount === sent.json.amount && tr.body.CallBackUrl.endsWith('/api/bank/coop/callback/sandbox') && tr.body.Destinations[0].TransactionCurrency === 'KES',
    'Co-op receives the transfer from the Rhinocash account to the client account, in KES, with the callback address');
  const reuse = await api('POST', `/api/loans/${loan1}/disburse/bank`, { token: t.disb, body: { rail: 'internal', account_number: '01100000001', account_name: 'Test Client', otp_code: code } });
  assert(reuse.status === 409 || reuse.status === 400, 'the same loan cannot be sent twice (and a code works only once)');
  const manualWhilePending = await api('POST', `/api/loans/${loan1}/disburse`, { token: t.disb, body: { channel: 'Bank' } });
  assert(manualWhilePending.status === 409, 'it cannot be marked disbursed by hand while the bank transfer is pending');

  // ---- 4. Callback is checked with the bank, never trusted ----
  const ref1 = tr.body.MessageReference;
  await api('POST', '/api/bank/coop/callback/sandbox', { body: { MessageReference: ref1, MessageCode: '0', Destinations: [{ ResponseCode: '0' }] } });
  let l1 = await get('SELECT status FROM loans WHERE id = ?', [loan1]);
  assert(l1.status === 'Disbursement Pending', 'a callback claiming success does not complete the loan while the bank still says pending');
  coop.statusByRef[ref1] = 'success';
  await api('POST', '/api/bank/coop/callback/sandbox', { body: { MessageReference: ref1 } });
  l1 = await get('SELECT status FROM loans WHERE id = ?', [loan1]);
  const row1 = await get('SELECT status, bank_reference FROM bank_disbursements WHERE message_reference = ?', [ref1]);
  assert(l1.status === 'Active' && row1.status === 'Completed' && row1.bank_reference, 'once the bank confirms, the loan becomes Active and the bank reference is kept');
  const jr = await get(`SELECT COALESCE(SUM(credit),0) AS c FROM journal_entries WHERE ref_type = 'loan' AND ref_id = ? AND account_id = 'bank'`, [loan1]);
  assert(Math.abs(Number(jr.c) - sent.json.amount) < 0.01, 'the disbursement is posted to the Bank account for the amount sent');
  const again = await api('POST', '/api/bank/coop/callback/sandbox', { body: { MessageReference: ref1 } });
  const jr2 = await get(`SELECT COUNT(*) AS n FROM journal_entries WHERE ref_type = 'loan' AND ref_id = ? AND account_id = 'loans_receivable'`, [loan1]);
  assert(again.status === 200 && Number(jr2.n) === 1, 'a repeated callback posts nothing twice');

  // ---- 5. A failed transfer returns the loan for another try ----
  const loan2 = await driveLoanToApproved(t, 12000);
  const code2 = (await api('POST', '/api/bank/disburse/request-otp', { token: t.disb })).json.otpForTesting;
  const sent2 = await api('POST', `/api/loans/${loan2}/disburse/bank`, { token: t.disb, body: { rail: 'pesalink', bank_code: '68', account_number: '0123456789', account_name: 'Other Bank Client', otp_code: code2 } });
  const tr2 = coop.transfers[coop.transfers.length - 1];
  assert(sent2.json.status === 'PENDING' && tr2.path === '/FundsTransfer/External/A2A/PesaLink/1.0.0' && tr2.body.Destinations[0].BankCode === '68', 'a transfer to another bank goes by PesaLink with the bank code');
  const reqRow = await get('SELECT id FROM bank_disbursements WHERE message_reference = ?', [tr2.body.MessageReference]);
  coop.statusByRef[tr2.body.MessageReference] = 'failed';
  const chk = await api('POST', `/api/bank/disbursements/${reqRow.id}/check`, { token: t.disb });
  const l2 = await get('SELECT status FROM loans WHERE id = ?', [loan2]);
  assert(chk.json.status === 'Failed' && l2.status === 'Approved for Disbursement', '"Check with bank" on a failed transfer returns the loan to Approved for Disbursement');
  const list = await api('GET', `/api/bank/disbursements?loan_id=${loan2}`, { token: t.disb });
  assert(list.json.disbursements.length === 1 && list.json.disbursements[0].status === 'Failed' && /Invalid destination/.test(list.json.disbursements[0].resultDesc), 'the loan\'s bank transfers list shows the failure and the bank\'s reason');
  const coopSelf = await api('POST', `/api/loans/${loan2}/disburse/bank`, { token: t.disb, body: { rail: 'pesalink', bank_code: '11', account_number: '0123456789', account_name: 'X', otp_code: '1' } });
  assert(coopSelf.status === 400, 'PesaLink to Co-op itself is refused (use Co-op Bank account)');

  // ---- 6. Switching off ----
  const offAgain = await api('POST', '/api/admin/bank/set-active', { token: t.admin, body: { environment: null } });
  assert(offAgain.status === 200 && (await api('GET', '/api/bank/status', { token: t.disb })).json.active === false, 'the Admin can switch bank transfers off again');

  fakeCoop.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
