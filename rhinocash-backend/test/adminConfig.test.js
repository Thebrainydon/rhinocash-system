// adminConfig.test.js — the System Administrator configuration store:
// settings documents (+history), reference lists, and live system stats.
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
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  assert(adminToken && ceoToken && managerToken && officerToken, 'setup: all needed accounts log in');

  // 1. Settings documents
  {
    const denied = await api('PUT', '/api/admin/settings/company.info', { token: ceoToken, body: { value: { legalName: 'X' } } });
    assert(denied.status === 403, '1: CEO (view-only) cannot change system configuration');
    const deniedMgr = await api('GET', '/api/admin/settings?prefix=company.', { token: managerToken });
    assert(deniedMgr.status === 403, '1: Manager has no System Administration visibility');
    const badKey = await api('PUT', '/api/admin/settings/BAD KEY', { token: adminToken, body: { value: {} } });
    assert(badKey.status === 400, '1: an invalid settings key is rejected');
    const badVal = await api('PUT', '/api/admin/settings/company.info', { token: adminToken, body: { value: ['not', 'an', 'object'] } });
    assert(badVal.status === 400, '1: a non-object settings value is rejected');
    const saved = await api('PUT', '/api/admin/settings/company.info', { token: adminToken, body: { value: { legalName: 'Rhinocash Ltd', kraPin: 'P051234567X' } } });
    assert(saved.status === 200 && saved.json.ok, '1: Admin saves a settings document');
    await api('PUT', '/api/admin/settings/company.info', { token: adminToken, body: { value: { legalName: 'Rhinocash Limited', kraPin: 'P051234567X' } } });
    const asCeo = await api('GET', '/api/admin/settings?prefix=company.', { token: ceoToken });
    assert(asCeo.status === 200 && asCeo.json.settings['company.info'].value.legalName === 'Rhinocash Limited', '1: CEO reads the persisted latest value');
    assert(!!asCeo.json.settings['company.info'].updatedBy, '1: the settings document records who last changed it');
    const hist = await api('GET', '/api/admin/settings-history?prefix=company.', { token: adminToken });
    assert(hist.status === 200 && hist.json.history.length === 2, '1: every save is kept in the change history');
    assert(hist.json.history[0].previous.legalName === 'Rhinocash Ltd' && hist.json.history[0].next.legalName === 'Rhinocash Limited', '1: history keeps the real before/after values, newest first');
    const unchanged = await api('PUT', '/api/admin/settings/company.info', { token: adminToken, body: { value: { legalName: 'Rhinocash Limited', kraPin: 'P051234567X' } } });
    const hist2 = await api('GET', '/api/admin/settings-history?prefix=company.', { token: adminToken });
    assert(unchanged.json.unchanged === true && hist2.json.history.length === 2, '1: saving an identical document adds no history noise');
    const audit = await api('GET', '/api/audit-logs?module=admin', { token: adminToken });
    const logs = (audit.json && audit.json.auditLogs) || [];
    assert(Array.isArray(logs) && logs.some(l => (l.action || '') === 'Updated system configuration'), '1: configuration saves are written to the audit trail');
  }

  // 2. Reference lists
  {
    const officerAdd = await api('POST', '/api/admin/lookups/client-types', { token: officerToken, body: { name: 'Individual' } });
    assert(officerAdd.status === 403, '2: a Loan Officer cannot add configuration list items');
    const noName = await api('POST', '/api/admin/lookups/client-types', { token: adminToken, body: { name: '  ' } });
    assert(noName.status === 400, '2: a list item needs a name');
    const a = await api('POST', '/api/admin/lookups/client-types', { token: adminToken, body: { name: 'Individual', code: 'IND', description: 'Single borrower', attrs: { minAge: 18 } } });
    assert(a.status === 201 && a.json.item.attrs.minAge === 18, '2: Admin adds a list item with its extra attributes');
    const dup = await api('POST', '/api/admin/lookups/client-types', { token: adminToken, body: { name: 'individual' } });
    assert(dup.status === 409, '2: duplicate names in the same list are rejected (case-insensitive)');
    const otherList = await api('POST', '/api/admin/lookups/job-grades', { token: adminToken, body: { name: 'Individual' } });
    assert(otherList.status === 201, '2: the same name is allowed in a different list');
    const b = await api('POST', '/api/admin/lookups/client-types', { token: adminToken, body: { name: 'Group', sortOrder: -1 } });
    const listed = await api('GET', '/api/admin/lookups/client-types', { token: officerToken });
    assert(listed.status === 200 && listed.json.items.length === 2 && listed.json.items[0].name === 'Group', '2: any staff member can read a list, ordered by sort order');
    const upd = await api('PUT', `/api/admin/lookups/client-types/${a.json.item.id}`, { token: adminToken, body: { status: 'Inactive' } });
    assert(upd.status === 200 && upd.json.item.status === 'Inactive' && upd.json.item.code === 'IND', '2: a partial update keeps untouched fields');
    const badStatus = await api('PUT', `/api/admin/lookups/client-types/${a.json.item.id}`, { token: adminToken, body: { status: 'Deleted' } });
    assert(badStatus.status === 400, '2: an unknown status is rejected');
    const renameDup = await api('PUT', `/api/admin/lookups/client-types/${b.json.item.id}`, { token: adminToken, body: { name: 'INDIVIDUAL' } });
    assert(renameDup.status === 409, '2: renaming onto an existing name is rejected');
    const wrongList = await api('DELETE', `/api/admin/lookups/job-grades/${a.json.item.id}`, { token: adminToken });
    assert(wrongList.status === 404, '2: an item cannot be deleted through a different list');
    const del = await api('DELETE', `/api/admin/lookups/client-types/${b.json.item.id}`, { token: adminToken });
    const after = await api('GET', '/api/admin/lookups/client-types', { token: adminToken });
    assert(del.status === 200 && after.json.items.length === 1, '2: Admin removes a list item');
  }

  // 3. Live system statistics
  {
    const ceo = await api('GET', '/api/admin/system-stats', { token: ceoToken });
    assert(ceo.status === 403, '3: system statistics are Admin-only');
    const r = await api('GET', '/api/admin/system-stats', { token: adminToken });
    assert(r.status === 200 && r.json.database.sizeBytes > 0, '3: real database size is reported');
    assert(r.json.tables.some(t => t.name === 'users'), '3: real per-table statistics are reported');
    assert(r.json.process.uptimeSec >= 0 && r.json.process.rssBytes > 0, '3: real server process uptime and memory are reported');
    assert(r.json.rateLimitPerMinute > 0, '3: the real configured rate limit is reported');
    const errs = await api('GET', '/api/admin/error-log', { token: adminToken });
    assert(errs.status === 200 && Array.isArray(errs.json.errors) && typeof errs.json.totalSinceStart === 'number', '3: the recent server error log is available to Admin');
    const errsMgr = await api('GET', '/api/admin/error-log', { token: managerToken });
    assert(errsMgr.status === 403, '3: the error log is Admin-only');
    const wf = await api('GET', '/api/admin/loan-workflow', { token: ceoToken });
    assert(wf.status === 200 && wf.json.steps.length > 0 && wf.json.steps[0].step_order != null, '3: the live loan approval chain is readable by the governance tier');
  }

  // 4. Account security actions
  {
    for (let i = 0; i < 5; i++) await api('POST', '/api/auth/login', { body: { email: 'locktest@rhinocash.co.ke', password: 'definitely-wrong' } });
    const locked = await api('GET', '/api/system/locked-accounts', { token: adminToken });
    assert(locked.status === 200 && locked.json.lockedAccounts.some(a => a.email === 'locktest@rhinocash.co.ke'), '4: five failed attempts lock the account');
    const ceoUnlock = await api('POST', '/api/admin/accounts/unlock', { token: ceoToken, body: { email: 'locktest@rhinocash.co.ke' } });
    assert(ceoUnlock.status === 403, '4: only the System Administrator can unlock an account');
    const unlock = await api('POST', '/api/admin/accounts/unlock', { token: adminToken, body: { email: 'locktest@rhinocash.co.ke' } });
    assert(unlock.status === 200 && unlock.json.cleared >= 5, '4: Admin unlock clears the recent failed attempts');
    const locked2 = await api('GET', '/api/system/locked-accounts', { token: adminToken });
    assert(!locked2.json.lockedAccounts.some(a => a.email === 'locktest@rhinocash.co.ke'), '4: the account is no longer listed as locked');
    const events = await api('GET', '/api/system/security-events?outcome=Failed&limit=200', { token: adminToken });
    assert(events.json.events.filter(e => e.email === 'locktest@rhinocash.co.ke').length >= 5, '4: the failed attempts are kept in the security trail');

    const me = await api('GET', '/api/auth/me', { token: officerToken });
    const officerId = me.json.user.id;
    const ceoForce = await api('POST', `/api/admin/users/${officerId}/force-password-change`, { token: ceoToken, body: {} });
    assert(ceoForce.status === 403, '4: only the System Administrator can force a password change');
    const force = await api('POST', `/api/admin/users/${officerId}/force-password-change`, { token: adminToken, body: {} });
    assert(force.status === 200 && force.json.mustChangePassword === true, '4: Admin requires a password change at next login');
    const clear = await api('POST', `/api/admin/users/${officerId}/force-password-change`, { token: adminToken, body: { required: false } });
    assert(clear.status === 200 && clear.json.mustChangePassword === false, '4: Admin can clear the requirement again');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
