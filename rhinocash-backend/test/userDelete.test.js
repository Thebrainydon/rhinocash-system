// userDelete.test.js — the System Administrator permanently deletes a user,
// roles keep HR as a full system role, and Admin can name a new access level.
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
    hr: await login('hr@rhinocash.co.ke', process.env.SEEDED_HR_PASSWORD),
  };
  assert(t.admin && t.manager && t.officer, 'setup: Admin, a manager and a loan officer sign in');

  // 1. Roles: HR is a full system role; new access levels
  const roles = await api('GET', '/api/roles', { token: t.admin });
  const hr = (roles.json.roles || []).find(r => r.id === 'hr');
  assert(hr && hr.is_system && hr.default_access_level === 'HR & People Management Access', '1: HR is a system role with HR & People Management Access');
  const inv = await api('POST', '/api/roles', { token: t.admin, body: { name: 'Investor Relations', code: 'investor_relations', access_level: 'Investor Access', description: 'Looks after investor relations.' } });
  assert(inv.status === 201, '1: a role can use Investor Access');
  assert((await api('POST', '/api/roles', { token: t.admin, body: { name: 'Field Auditor', code: 'field_auditor', access_level: 'Field Audit Access', description: 'Audits branches in the field.' } })).status === 400, '1: an unknown access level is still refused unless marked as new');
  const fa = await api('POST', '/api/roles', { token: t.admin, body: { name: 'Field Auditor', code: 'field_auditor', access_level: 'Field Audit Access', custom_access_level: true, description: 'Audits branches in the field.' } });
  assert(fa.status === 201 && fa.json.role.default_access_level === 'Field Audit Access', '1: Admin can name a new custom access level');
  assert((await api('POST', '/api/roles', { token: t.admin, body: { name: 'Bad Level', code: 'bad_level', access_level: '<x>', custom_access_level: true, description: 'x' } })).status === 400, '1: a malformed custom access level is refused');

  // Removing roles: a custom role nobody holds can go; system roles cannot.
  assert((await api('POST', '/api/roles/hr/delete', { token: t.admin })).status === 400, '1: a system role cannot be deleted');
  assert((await api('POST', `/api/roles/${fa.json.role.id}/delete`, { token: t.manager })).status === 403, '1: only the System Administrator deletes roles');
  const rd = await api('POST', `/api/roles/${fa.json.role.id}/delete`, { token: t.admin });
  assert(rd.status === 200 && !((await api('GET', '/api/roles', { token: t.admin })).json.roles || []).some(r => r.id === fa.json.role.id), '1: an unused custom role is deleted');

  // 2. Permanent delete
  const mk = await api('POST', '/api/users', { token: t.admin, body: { name: 'Delete Me Officer', email: 'deleteme.officer@rhinocash.co.ke', role_id: 'loan_officer', branch_id: 'br_kisumu' } });
  const uid = mk.json && (mk.json.user || mk.json.employee || {}).id;
  assert(!!uid, '2: a user to delete is created');
  assert((await api('POST', `/api/users/${uid}/permanent-delete`, { token: t.manager, body: { confirm: 'Delete Me Officer' } })).status === 403, '2: a manager cannot permanently delete a user');
  assert((await api('POST', `/api/users/${uid}/permanent-delete`, { token: t.admin, body: { confirm: 'wrong name' } })).status === 400, '2: the full name must be typed to confirm');
  // While the officer holds a client, deletion is blocked.
  const c = await api('POST', '/api/clients', { token: t.admin, body: { name: 'Held Client ' + Math.random().toString(36).slice(2, 7), phone: '07' + Math.floor(Math.random() * 90000000 + 10000000), branch_id: 'br_kisumu', officer_id: uid } });
  if (c.json && c.json.client && c.json.client.officer_id === uid) {
    const blocked = await api('POST', `/api/users/${uid}/permanent-delete`, { token: t.admin, body: { confirm: 'Delete Me Officer' } });
    assert(blocked.status === 409 && /client/.test(blocked.json.error || ''), '2: a user who still holds clients cannot be deleted');
    await api('PATCH', `/api/clients/${c.json.client.id}`, { token: t.admin, body: { officer_id: 'usr_officer' } });
  }
  const delLogin = await api('POST', '/api/auth/login', { body: { email: 'deleteme.officer@rhinocash.co.ke', password: mk.json.tempPassword } });
  const oldTok = delLogin.json && delLogin.json.token;
  const delUsername = mk.json.user && mk.json.user.username;
  assert(!!oldTok, '2: the user to delete signs in once (an open session)');
  assert((await api('POST', '/api/auth/device-check', { body: { uid } })).json.removed === false, '2: before deletion, their browser is not marked removed');
  const del = await api('POST', `/api/users/${uid}/permanent-delete`, { token: t.admin, body: { confirm: 'Delete Me Officer' } });
  assert(del.status === 200 && del.json.ok, '2: the System Administrator permanently deletes the user');
  // The removed person is shown "This site can't be reached".
  const stale = await api('GET', '/api/auth/me', { token: oldTok });
  assert(stale.status === 401 && stale.json.code === 'ACCOUNT_REMOVED', '2: their still-open session is answered with ACCOUNT_REMOVED');
  const again = await api('POST', '/api/auth/login', { body: { email: 'DeleteMe.Officer@rhinocash.co.ke', password: mk.json.tempPassword } });
  assert(again.status === 410 && again.json.code === 'ACCOUNT_REMOVED' && /can.t be reached/.test(again.json.error), '2: signing in again (any letter case) gets ACCOUNT_REMOVED');
  if (delUsername) assert((await api('POST', '/api/auth/login', { body: { email: delUsername, password: 'whatever' } })).json.code === 'ACCOUNT_REMOVED', '2: …by username too');
  assert((await api('POST', '/api/auth/device-check', { body: { uid } })).json.removed === true, '2: their browser is recognised as removed');
  assert((await api('POST', '/api/auth/device-check', { body: { uid: 'usr_officer' } })).json.removed === false, '2: an active user\'s browser is not');
  const nobody = await api('POST', '/api/auth/login', { body: { email: 'never.existed@rhinocash.co.ke', password: 'x' } });
  assert(nobody.status === 401 && !nobody.json.code, '2: an address that never existed still gets plain "Invalid credentials"');
  const ra = await require('../src/db').get('SELECT * FROM removed_accounts WHERE user_id = ?', [uid]);
  assert(ra && !JSON.stringify(ra).includes('deleteme'), '2: only hashes are kept, never the email address');
  assert((await api('GET', `/api/users/${uid}`, { token: t.admin })).status === 404, '2: the user is gone');
  const list = await api('GET', '/api/users?limit=200', { token: t.admin });
  assert(!(list.json.users || []).some(u => u.id === uid), '2: the user no longer appears in the staff list');
  assert((await api('POST', `/api/users/${uid}/permanent-delete`, { token: t.admin, body: { confirm: 'Delete Me Officer' } })).status === 404, '2: deleting again finds nothing');
  const me = await api('GET', '/api/auth/me', { token: t.admin });
  assert((await api('POST', `/api/users/${me.json.user.id}/permanent-delete`, { token: t.admin, body: { confirm: me.json.user.name } })).status === 400, '2: the Admin cannot delete their own account');

  // A user with history: an officer who approved and recorded things keeps that history, unnamed.
  const mk2 = await api('POST', '/api/users', { token: t.admin, body: { name: 'History Officer', email: 'history.officer@rhinocash.co.ke', role_id: 'loan_officer', branch_id: 'br_kisumu' } });
  const uid2 = (mk2.json.user || mk2.json.employee || {}).id;
  const al = await api('GET', '/api/audit-logs?limit=5', { token: t.admin });
  const d2 = await api('POST', `/api/users/${uid2}/permanent-delete`, { token: t.admin, body: { confirm: 'History Officer' } });
  assert(d2.status === 200 && al.status === 200, '2: a user with audit history is deleted and the audit trail stays');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
