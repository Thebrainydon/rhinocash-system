// loanCollateral.test.js — Create Loan Application: collateral, business
// type, self-guarantee, client signature, saved guarantors; list scope filters.
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

(async () => {
  const t = {
    officer: await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD),
    ops: await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD),
    regional: await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD),
  };
  assert(Object.values(t).every(Boolean), 'setup: every needed account signs in');
  const products = await api('GET', '/api/loan-products', { token: t.officer });
  const product = products.json.products.find(p => p.processing_fee_amount == null && !p.term_weeks) || products.json.products[0];
  const c = await api('POST', '/api/clients', { token: t.officer, body: { name: 'Collateral ' + Math.random().toString(36).slice(2, 8), phone: '07' + Math.floor(Math.random() * 90000000 + 10000000) } });
  const clientId = c.json.client.id;

  // 1. Collateral, business type, self-guarantee and signature are stored
  const up = await fetch(BASE + '/api/uploads', { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Filename': 'sig.png', Authorization: `Bearer ${t.officer}` }, body: Buffer.from('89504e470d0a1a0a', 'hex') });
  const sigPath = (await up.json()).path;
  const body = { client_id: clientId, product_id: product.id, principal: product.min_amount, term_months: product.min_term || 3, business_type: 'Retail shop', self_guaranteed: true, client_signature_path: sigPath,
    collaterals: [{ category: 'Household Items', security_type: 'Television', details: '43 inch Samsung', serial_no: 'SN-1' }, { category: 'Custom Securities', security_type: 'Fridge', details: 'LG double door' }] };
  const loan = await api('POST', '/api/loans', { token: t.officer, body });
  assert(loan.status === 201, '1: the application with collateral is created');
  assert(loan.json.loan.business_type === 'Retail shop' && Number(loan.json.loan.self_guaranteed) === 1 && loan.json.loan.client_signature_path === sigPath, '1: business type, self-guarantee and the client signature are saved');
  assert(loan.json.loan.collaterals.length === 2 && loan.json.loan.collaterals[0].serial_no === 'SN-1', '1: both securities are saved with their details');
  const cols = await api('GET', `/api/loans/${loan.json.loan.id}/collaterals`, { token: t.officer });
  assert(cols.status === 200 && cols.json.collaterals.map(x => x.security_type).join(',') === 'Television,Fridge', '1: the securities list back in order');
  const bad = await api('POST', '/api/loans', { token: t.officer, body: { ...body, collaterals: [{ security_type: 'Phone', details: '' }] } });
  assert(bad.status === 400, '1: a security without details is refused');

  // 2. Saved guarantors come from the client's earlier applications
  await api('POST', '/api/loans', { token: t.officer, body: { client_id: clientId, product_id: product.id, principal: product.min_amount, term_months: product.min_term || 3, guarantor: 'Mary Wanjiru', guarantor_contact: '0711000111' } });
  const g = await api('GET', `/api/clients/${clientId}/saved-guarantors`, { token: t.officer });
  assert(g.status === 200 && g.json.guarantors.length === 1 && g.json.guarantors[0].name === 'Mary Wanjiru' && g.json.guarantors[0].loans === 1, '2: the client\'s earlier guarantor is offered');

  // 3. ?branch_id / ?region_id narrow a list to that branch or region, never wider than the user's scope
  const officerBranch = c.json.client.branch_id;
  const all = await api('GET', '/api/clients?limit=200', { token: t.ops });
  const narrowed = await api('GET', `/api/clients?limit=200&branch_id=${officerBranch}`, { token: t.ops });
  assert(narrowed.status === 200 && narrowed.json.clients.length > 0 && narrowed.json.clients.every(x => x.branch_id === officerBranch), '3: a branch filter returns only that branch\'s clients');
  assert(all.json.clients.some(x => x.branch_id !== officerBranch) || all.json.clients.length === narrowed.json.clients.length, '3: without the filter other branches are included');
  const loans = await api('GET', `/api/loans?branch_id=${officerBranch}`, { token: t.ops });
  assert(loans.status === 200 && (loans.json.loans || []).every(x => x.branch_id === officerBranch), '3: loan lists honour the branch filter too');
  const branches = await api('GET', '/api/branches', { token: t.ops });
  const regional = await api('GET', '/api/users/me', { token: t.regional });
  const outside = (branches.json.branches || []).find(b => b.region_id && regional.json && b.region_id !== (regional.json.user || regional.json).region_id);
  if (outside) {
    const r = await api('GET', `/api/clients?limit=50&branch_id=${outside.id}`, { token: t.regional });
    assert(r.status === 200 && r.json.clients.every(x => x.branch_id !== outside.id), '3: a Regional Manager cannot widen scope to a branch outside the region');
  } else assert(true, '3: (no branch outside the region to test)');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
