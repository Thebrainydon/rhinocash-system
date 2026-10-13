// investorPortal.test.js — the Investor's own pages: one aggregate-only
// company report plus the investor's own investment, payment details and
// report preferences. Investors never receive client, borrower or staff
// records, and staff sessions cannot use the investor endpoints.
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


async function investorLogin(email, password) { const r = await api('POST', '/api/investor-auth/login', { body: { email, password } }); return r.json && r.json.token; }

(async () => {
  const investorToken = await investorLogin('sara.investor@example.com', process.env.SEEDED_INVESTOR_PASSWORD);
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  assert(investorToken && adminToken, 'setup: the investor and the System Administrator sign in');

  // 1. Access
  assert((await api('GET', '/api/investor/report')).status === 401, '1: the report needs a signed-in investor');
  assert((await api('GET', '/api/investor/report', { token: adminToken })).status === 401, '1: a staff session cannot use the investor report');
  assert((await api('PUT', '/api/investor/payment-details', { token: adminToken, body: { method: 'Cheque' } })).status === 401, '1: a staff session cannot change investor payment details');

  // 2. The report
  const rep = await api('GET', '/api/investor/report', { token: investorToken });
  assert(rep.status === 200, '2: the investor gets their report');
  const R = rep.json || {};
  assert(R.company && typeof R.company.branches === 'number' && typeof R.company.clients === 'number', '2: company totals are present');
  assert(R.portfolio && Array.isArray(R.portfolio.arrears) && R.portfolio.arrears.length === 5 && Array.isArray(R.portfolio.byBranch), '2: portfolio ageing and per-branch sums are present');
  assert(Array.isArray(R.monthly) && R.monthly.length === 12 && R.monthly.every(m => /^\d{4}-\d{2}$/.test(m.month) && typeof m.netProfit === 'number'), '2: twelve months of company figures');
  assert(R.finance && typeof R.finance.netProfit === 'number' && R.finance.cash, '2: finance totals are present');
  assert(R.investment && R.investment.capital > 0 && Array.isArray(R.investment.payouts), "2: the investor's own investment is present");
  assert(R.strategy && R.risk && R.risk.compliance, '2: strategy and risk summaries are present');

  // 3. Aggregate-only: no client or staff records leak to an investor
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const probe = { name: 'Portal Probe ' + Math.random().toString(36).slice(2, 8), phone: '07' + Math.floor(Math.random() * 90000000 + 10000000) };
  const made = await api('POST', '/api/clients', { token: officerToken, body: probe });
  assert(made.status === 201 || made.status === 200, '3: a real client exists to look for');
  const fresh = await api('GET', '/api/investor/report', { token: investorToken });
  const text = JSON.stringify(fresh.json);
  assert(fresh.json.company.clients >= 1, '3: the new client is counted in the company totals');
  assert(!text.includes(probe.name) && !text.includes(probe.phone), "3: the client's name and phone never appear in the report");
  assert(!/@rhinocash\.co\.ke/.test(text), '3: no staff e-mail appears in the report');
  assert(!/"(clientId|client_id|loanId|loan_id|userId|user_id)"/.test(text), '3: no per-client, per-loan or per-user identifiers');

  // 4. Payment details
  const bad1 = await api('PUT', '/api/investor/payment-details', { token: investorToken, body: { method: 'Gold bars' } });
  assert(bad1.status === 400, '4: an unknown payout method is rejected');
  const bad2 = await api('PUT', '/api/investor/payment-details', { token: investorToken, body: { method: 'Bank transfer', bankName: 'KCB' } });
  assert(bad2.status === 400, '4: a bank transfer needs an account number');
  const bad3 = await api('PUT', '/api/investor/payment-details', { token: investorToken, body: { method: 'M-Pesa', mpesaPhone: '12345' } });
  assert(bad3.status === 400, '4: an invalid M-Pesa number is rejected');
  const ok = await api('PUT', '/api/investor/payment-details', { token: investorToken, body: { method: 'Bank transfer', bankName: 'KCB Bank', bankAccount: '1234567890' } });
  assert(ok.status === 200, '4: valid bank details are saved');
  const after = await api('GET', '/api/investor/report', { token: investorToken });
  const pd = after.json.investment.paymentDetails;
  assert(pd.method === 'Bank transfer' && pd.bankName === 'KCB Bank' && pd.bankAccount === '1234567890', '4: the report shows the saved payment details');
  const back = await api('PUT', '/api/investor/payment-details', { token: investorToken, body: { method: 'M-Pesa', mpesaPhone: '0712345678' } });
  assert(back.status === 200, '4: M-Pesa details are saved');

  // 5. Report preferences
  assert((await api('PUT', '/api/investor/report-preferences', { token: investorToken, body: { frequency: 'Hourly' } })).status === 400, '5: an unknown statement frequency is rejected');
  const pref = await api('PUT', '/api/investor/report-preferences', { token: investorToken, body: { frequency: 'Quarterly' } });
  assert(pref.status === 200 && pref.json.frequency === 'Quarterly', '5: the statement frequency is saved');
  const after2 = await api('GET', '/api/investor/report', { token: investorToken });
  assert(after2.json.investment.reportFrequency === 'Quarterly', '5: the report shows the saved frequency');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
