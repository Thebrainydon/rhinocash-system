// opsManager.test.js — the Operational Manager's pages: operational tasks,
// compliance checks, single-loan transfers, and read access to the
// company figures and financial requests.
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
    director: await login('director@rhinocash.co.ke', process.env.SEEDED_DIRECTOR_PASSWORD),
  };
  assert(Object.values(t).every(Boolean), 'setup: every needed account signs in');

  // 1. Operational tasks
  const task = await api('POST', '/api/regional-ops', { token: t.ops, body: { kind: 'task', title: '[TEST] Audit branch cash floats', category: 'Branch operations', due_date: '2030-01-31' } });
  assert(task.status === 201 && task.json.record.status === 'Open', '1: the Operational Manager creates a company-wide task');
  assert((await api('POST', '/api/regional-ops', { token: t.manager, body: { kind: 'task', title: 'x' } })).status === 403, '1: a branch manager cannot create operational tasks');
  assert((await api('PATCH', `/api/regional-ops/${task.json.record.id}`, { token: t.ops, body: { status: 'In Progress' } })).json.record.status === 'In Progress', '1: the task moves to in progress');
  const tdone = await api('PATCH', `/api/regional-ops/${task.json.record.id}`, { token: t.ops, body: { status: 'Done', resolution: 'All floats counted' } });
  assert(tdone.status === 200 && tdone.json.record.status === 'Done' && !tdone.json.record.isOpen, '1: the task is done and closed');

  // 2. Compliance checks
  const cc = await api('POST', '/api/regional-ops', { token: t.ops, body: { kind: 'compliance_check', title: '[TEST] KYC file review', branch_id: 'br_kisumu', category: 'KYC & client files' } });
  assert(cc.status === 201 && cc.json.record.status === 'Scheduled', '2: a compliance check is scheduled');
  const ccf = await api('PATCH', `/api/regional-ops/${cc.json.record.id}`, { token: t.ops, body: { status: 'Failed', resolution: '3 files missing IDs' } });
  assert(ccf.status === 200 && ccf.json.record.status === 'Failed' && ccf.json.record.resolution === '3 files missing IDs', '2: the check is recorded as failed with its findings');
  assert((await api('PATCH', `/api/regional-ops/${cc.json.record.id}`, { token: t.ops, body: { status: 'Passed' } })).status === 400, '2: a finished check cannot be changed');

  // 3. Loan transfers: one loan moves to another officer in the same branch
  const o2 = await api('POST', '/api/users', { token: t.admin, body: { name: 'Second Kisumu Officer', email: 'secondkisumuofficer@rhinocash.co.ke', role_id: 'loan_officer', branch_id: 'br_kisumu' } });
  const o2id = o2.json && (o2.json.user || o2.json.employee || {}).id;
  assert(!!o2id, '3: a second loan officer is added at the branch');
  const L = await driveLoanToDisbursed(t, 15000, 3);
  assert((await api('POST', '/api/regional-ops', { token: t.ops, body: { kind: 'transfer', title: 'Move loan', subject_type: 'loan', subject_id: L.loanId, to_branch_id: 'br_kisumu' } })).status === 400, '3: a loan transfer needs the new officer');
  assert((await api('POST', '/api/regional-ops', { token: t.ops, body: { kind: 'transfer', title: 'Move loan', subject_type: 'loan', subject_id: L.loanId, to_branch_id: 'br_kisumu', to_officer_id: 'usr_officer' } })).status === 400, '3: the new officer must differ from the current one');
  const lt = await api('POST', '/api/regional-ops', { token: t.ops, body: { kind: 'transfer', title: '[TEST] Rebalance portfolio', subject_type: 'loan', subject_id: L.loanId, to_branch_id: 'br_kisumu', to_officer_id: o2id } });
  assert(lt.status === 201 && lt.json.record.subjectType === 'loan' && lt.json.record.subjectName, '3: a loan transfer is requested and names the borrower');
  assert((await api('POST', '/api/regional-ops', { token: t.ops, body: { kind: 'transfer', title: 'again', subject_type: 'loan', subject_id: L.loanId, to_branch_id: 'br_kisumu', to_officer_id: o2id } })).status === 409, '3: a loan cannot have two transfers in progress');
  await api('PATCH', `/api/regional-ops/${lt.json.record.id}`, { token: t.ops, body: { status: 'Approved' } });
  const ltd = await api('PATCH', `/api/regional-ops/${lt.json.record.id}`, { token: t.ops, body: { status: 'Completed' } });
  assert(ltd.status === 200 && ltd.json.record.status === 'Completed', '3: the approved loan transfer is completed');
  const loan = await api('GET', `/api/loans/${L.loanId}`, { token: t.admin });
  assert(loan.json.loan.officer_id === o2id, '3: the loan now belongs to the new officer');
  const client = await api('GET', `/api/clients/${L.clientId}`, { token: t.admin });
  assert(client.json.client.officer_id === 'usr_officer', "3: the client's own record stays with their officer");

  // 4. Read access to company figures and financial requests
  assert((await api('GET', '/api/acct/finance', { token: t.ops })).status === 200, '4: the Operational Manager reads the company figures');
  assert((await api('GET', '/api/acct/client-quality', { token: t.ops })).status === 200, '4: the Operational Manager reads client data quality');
  assert((await api('GET', '/api/acct/controls', { token: t.ops })).status === 403, '4: but not the accounting control queues');
  assert((await api('POST', '/api/acct/records', { token: t.ops, body: { kind: 'exception', title: 'x' } })).status === 403, '4: and cannot record accounting items');
  const fr = await api('POST', '/api/exec/records', { token: t.ops, body: { kind: 'financial_request', title: '[TEST] New branch furniture', amount: 120000 } });
  assert(fr.status === 201 && fr.json.record.status === 'Pending', '4: the Operational Manager raises a financial request');
  assert((await api('GET', '/api/exec/records?kind=financial_request', { token: t.ops })).status === 200, '4: and sees financial requests');
  assert((await api('GET', '/api/exec/records', { token: t.ops })).status === 403, '4: but not other executive records');
  await api('PATCH', `/api/exec/records/${fr.json.record.id}`, { token: t.director, body: { status: 'Approved' } });
  assert((await api('PATCH', `/api/exec/records/${fr.json.record.id}`, { token: t.ops, body: { status: 'Paid' } })).status === 403, '4: only the Accountant marks it paid');
  assert((await api('PATCH', `/api/exec/records/${fr.json.record.id}`, { token: t.acct, body: { status: 'Paid' } })).status === 200, '4: the Accountant pays it');
  const fin = await api('GET', '/api/acct/finance', { token: t.ops });
  assert(fin.json.monthly.every(m => typeof m.newClients === 'number') && fin.json.monthly[11].newClients >= 1, '4: the figures include new clients per month');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
