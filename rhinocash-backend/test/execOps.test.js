// execOps.test.js — Director / CEO executive records: strategy, governance, risk,
// capital and requests that need an executive decision.
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


(async () => {
  const directorToken = await login('director@rhinocash.co.ke', process.env.SEEDED_DIRECTOR_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  assert(directorToken && ceoToken && adminToken && officerToken, 'setup: Director, CEO, Admin and a Loan Officer sign in');

  // 1. Access
  assert((await api('GET', '/api/exec/records', { token: officerToken })).status === 403, '1: a Loan Officer cannot see executive records');
  assert((await api('GET', '/api/exec/records', { token: adminToken })).status === 200, '1: the System Administrator can view them');
  assert((await api('POST', '/api/exec/records', { token: adminToken, body: { kind: 'decision', title: 'X' } })).status === 403, '1: the System Administrator cannot record them');

  // 2. Recording
  const bad = await api('POST', '/api/exec/records', { token: directorToken, body: { kind: 'nonsense', title: 'x' } });
  assert(bad.status === 400, '2: an unknown record type is rejected');
  const noTitle = await api('POST', '/api/exec/records', { token: directorToken, body: { kind: 'strategic_plan', title: '  ' } });
  assert(noTitle.status === 400, '2: a title is required');
  const plan = await api('POST', '/api/exec/records', { token: directorToken, body: { kind: 'strategic_plan', title: 'Reach 50,000 active clients', category: 'Growth', due_date: '2028-12-31', priority: 'High' } });
  assert(plan.status === 201 && plan.json.record.status === 'Draft' && plan.json.record.isOpen, '2: the Director records a strategic plan');
  const riskBad = await api('POST', '/api/exec/records', { token: directorToken, body: { kind: 'risk', title: 'Fraud', data: { likelihood: 9, impact: 2 } } });
  assert(riskBad.status === 400, '2: risk likelihood/impact must be 1-5');
  const risk = await api('POST', '/api/exec/records', { token: directorToken, body: { kind: 'risk', title: 'Collections fraud', category: 'Fraud', data: { likelihood: 3, impact: 5 } } });
  assert(risk.status === 201 && risk.json.record.data.likelihood === 3, '2: a rated enterprise risk is recorded');
  const noAmt = await api('POST', '/api/exec/records', { token: directorToken, body: { kind: 'financial_request', title: 'New branch fit-out' } });
  assert(noAmt.status === 400, '2: a financial request needs an amount');

  // 3. Decisions on requests: not by the requester, only Director/CEO
  const fr = await api('POST', '/api/exec/records', { token: directorToken, body: { kind: 'financial_request', title: 'New branch fit-out', amount: 850000, status: 'Approved' } });
  assert(fr.status === 201 && fr.json.record.status === 'Pending', '3: a request always starts Pending, whatever status is sent');
  const id = fr.json.record.id;
  assert((await api('PATCH', '/api/exec/records/' + id, { token: directorToken, body: { status: 'Approved' } })).status === 403, '3: the requester cannot approve their own request');
  assert((await api('PATCH', '/api/exec/records/' + id, { token: ceoToken, body: { status: 'Paid' } })).status === 400, '3: a request cannot be paid before it is approved');
  const ok = await api('PATCH', '/api/exec/records/' + id, { token: ceoToken, body: { status: 'Approved', outcome: 'Within budget' } });
  assert(ok.status === 200 && ok.json.record.status === 'Approved' && ok.json.record.decidedByName && ok.json.record.outcome === 'Within budget', '3: the CEO approves it and the decision is recorded');
  assert((await api('PATCH', '/api/exec/records/' + id, { token: ceoToken, body: { status: 'Rejected' } })).status === 400, '3: a decided request cannot be decided again');
  const paid = await api('PATCH', '/api/exec/records/' + id, { token: directorToken, body: { status: 'Paid' } });
  assert(paid.status === 200 && !paid.json.record.isOpen && paid.json.record.closedAt, '3: once approved it can be marked paid and is closed');

  // 4. Updates and listing
  const upd = await api('PATCH', '/api/exec/records/' + plan.json.record.id, { token: ceoToken, body: { status: 'Active', score: 40 } });
  assert(upd.status === 200 && upd.json.record.status === 'Active' && upd.json.record.score === 40, '4: progress on a plan is updated');
  assert((await api('PATCH', '/api/exec/records/' + plan.json.record.id, { token: ceoToken, body: { status: 'Paid' } })).status === 400, '4: an invalid status is rejected');
  const list = await api('GET', '/api/exec/records?kind=risk,strategic_plan', { token: directorToken });
  assert(list.status === 200 && list.json.records.length >= 2 && list.json.records.every(r => ['risk', 'strategic_plan'].includes(r.kind)), '4: records filter by kind');
  const audit = await api('GET', '/api/audit-logs?limit=50', { token: adminToken });
  assert(audit.status === 200 && (audit.json.auditLogs || []).some(a => /strategic plan|financial request/i.test(a.action || '')), '4: executive record changes are written to the audit log');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
