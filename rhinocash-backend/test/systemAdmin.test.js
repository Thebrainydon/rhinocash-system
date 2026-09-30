// systemAdmin.test.js — Organization Settings, Active Sessions (real
// listing + real per-session revoke), Maintenance Mode (real login gate,
// not a cosmetic switch), and a real bounded Backup mechanism.
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
  let adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  let managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  assert(adminToken && ceoToken && managerToken && officerToken, 'all needed accounts log in');

  // =========================================================
  // 1. ORGANIZATION SETTINGS — real, persisted, audited
  // =========================================================
  {
    const view = await api('GET', '/api/system/organization', { token: ceoToken });
    assert(view.status === 200, 'CEO has real view access to organization settings');
    const managerDenied = await api('GET', '/api/system/organization', { token: managerToken });
    assert(managerDenied.status === 403, 'Manager has no organization-settings visibility');

    const officerCannotEdit = await api('PUT', '/api/system/organization', { token: officerToken, body: { company_name: 'Hacked Inc' } });
    assert(officerCannotEdit.status === 403, 'a Loan Officer cannot edit organization settings');
    const ceoCannotEdit = await api('PUT', '/api/system/organization', { token: ceoToken, body: { company_name: 'CEO Edit' } });
    assert(ceoCannotEdit.status === 403, 'even CEO (view-only here) cannot edit organization settings — Admin-only action');

    const updated = await api('PUT', '/api/system/organization', { token: adminToken, body: { company_name: 'Rhinocash Limited', currency: 'KES', phone: '+254700000000' } });
    assert(updated.status === 200 && updated.json.organization.company_name === 'Rhinocash Limited', 'Admin can genuinely update organization settings, and the real change persists');

    const reread = await api('GET', '/api/system/organization', { token: adminToken });
    assert(reread.json.organization.company_name === 'Rhinocash Limited', 'the real update genuinely persisted to the database, not just echoed back');
  }

  // =========================================================
  // 2. ACTIVE SESSIONS — real listing, real per-session revoke
  // =========================================================
  {
    const sessions = await api('GET', '/api/system/sessions', { token: adminToken });
    assert(sessions.status === 200 && Array.isArray(sessions.json.sessions), 'Admin can view the real active sessions list');
    assert(sessions.json.sessions.some(s => s.email === 'officer@rhinocash.co.ke'), 'the real officer session (from this very test run\'s login) genuinely appears in the list');
    assert(!JSON.stringify(sessions.json.sessions).match(/token_hash/), 'the raw token_hash is never exposed in the real API response, even though it is only a one-way hash');

    const managerDenied = await api('GET', '/api/system/sessions', { token: managerToken });
    assert(managerDenied.status === 403, 'Manager cannot view company-wide active sessions');

    const officerSession = sessions.json.sessions.find(s => s.email === 'officer@rhinocash.co.ke');
    const revoked = await api('POST', `/api/system/sessions/${officerSession.id}/revoke`, { token: adminToken, body: {} });
    assert(revoked.status === 200, 'Admin can genuinely revoke a specific real session');

    // Confirm the real revoked session can no longer authenticate.
    const revokedCheck = await api('GET', '/api/auth/me', { token: officerToken });
    assert(revokedCheck.status === 401, 'the real revoked session genuinely can no longer authenticate — not just removed from a list view');
  }

  // =========================================================
  // 3. MAINTENANCE MODE — real login gate, not a cosmetic switch
  // =========================================================
  {
    const officerCannotToggle = await api('PUT', '/api/system/maintenance', { token: (await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD)), body: { enabled: true } });
    assert(officerCannotToggle.status === 403, 'a Loan Officer cannot enable maintenance mode');

    const enabled = await api('PUT', '/api/system/maintenance', { token: adminToken, body: { enabled: true, message: 'Scheduled upgrade in progress.' } });
    assert(enabled.status === 200 && enabled.json.maintenanceMode === true, 'Admin can genuinely enable real maintenance mode');

    // The real, critical check: a non-Admin login is actually blocked now.
    const blockedLogin = await api('POST', '/api/auth/login', { body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD } });
    assert(blockedLogin.status === 403 && blockedLogin.json.code === 'MAINTENANCE_MODE' && blockedLogin.json.error.includes('Scheduled upgrade'), 'a real non-Admin login is genuinely blocked with the real configured maintenance message — not a cosmetic flag that does nothing, and not accidentally swallowed by the router\'s generic 5xx handling');

    // Admin can still log in during their own maintenance window. This
    // fresh login becomes the account's one real active session (under the
    // real single-active-session policy, it genuinely logs the earlier one
    // out to do so) — adminToken is reassigned to it so the rest of this
    // section keeps using a real, currently-valid admin session.
    const adminStillWorks = await api('POST', '/api/auth/login', { body: { email: 'admin@rhinocash.co.ke', password: process.env.SEEDED_ADMIN_PASSWORD } });
    assert(adminStillWorks.status === 200, 'Admin can still genuinely log in during maintenance mode — otherwise nobody could ever turn it back off');
    adminToken = adminStillWorks.json.token;

    const disabled = await api('PUT', '/api/system/maintenance', { token: adminToken, body: { enabled: false } });
    assert(disabled.status === 200 && disabled.json.maintenanceMode === false, 'Admin can genuinely disable maintenance mode again');
    // Same reasoning as adminToken above — this fresh login genuinely
    // becomes the manager's one active session, so managerToken is
    // reassigned to it for the rest of the file to keep using.
    const unblockedLogin = await api('POST', '/api/auth/login', { body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD } });
    assert(unblockedLogin.status === 200, 'a real non-Admin login genuinely works again once maintenance mode is disabled');
    managerToken = unblockedLogin.json.token;
  }

  // =========================================================
  // 4. BACKUP — real, bounded, genuine data snapshot
  // =========================================================
  {
    const officerCannotBackup = await api('POST', '/api/system/backup', { token: managerToken, body: {} });
    assert(officerCannotBackup.status === 403, 'Manager cannot trigger a real system backup — Admin-only');

    const created = await api('POST', '/api/system/backup', { token: adminToken, body: {} });
    assert(created.status === 200 && created.json.backup.status === 'Completed', 'Admin can genuinely trigger a real backup, which completes');
    assert(created.json.backup.row_count > 0, 'the real backup genuinely captured real rows, not a fabricated empty success');
    assert(created.json.snapshot && JSON.parse(created.json.snapshot).tables.users.length > 0, 'the real backup snapshot contains real user data — a genuine data export, not a placeholder');

    const history = await api('GET', '/api/system/backups', { token: adminToken });
    assert(history.status === 200 && history.json.backups.some(b => b.id === created.json.backup.id), 'the real backup genuinely appears in the real backup history — no fabricated history');
  }

  // =========================================================
  // 5. CONFIGURABLE SESSION-WARNING LEAD TIME — real, not hardcoded
  // =========================================================
  {
    const defaultView = await api('GET', '/api/system/security-settings', { token: ceoToken });
    assert(defaultView.status === 200 && defaultView.json.sessionWarningMinutes === 5, 'the real default session warning lead time is 5 minutes, genuinely configurable rather than a frontend-hardcoded constant');

    const managerDenied = await api('GET', '/api/system/security-settings', { token: managerToken });
    assert(managerDenied.status === 403, 'Manager has no visibility into security settings');

    const freshOfficerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
    const officerCannotEdit = await api('PUT', '/api/system/security-settings', { token: freshOfficerToken, body: { sessionWarningMinutes: 10 } });
    assert(officerCannotEdit.status === 403, 'a Loan Officer cannot change the real session warning lead time');

    const invalidValue = await api('PUT', '/api/system/security-settings', { token: adminToken, body: { sessionWarningMinutes: 999 } });
    assert(invalidValue.status === 400, 'an out-of-range value (>60 minutes) is genuinely rejected, not silently clamped or accepted');

    const updated = await api('PUT', '/api/system/security-settings', { token: adminToken, body: { sessionWarningMinutes: 15 } });
    assert(updated.status === 200 && updated.json.sessionWarningMinutes === 15, 'Admin can genuinely change the real session warning lead time');

    const reread = await api('GET', '/api/system/security-settings', { token: adminToken });
    assert(reread.json.sessionWarningMinutes === 15, 'the real updated value genuinely persisted, not just echoed back');

    // The real, updated value is genuinely reflected on the next real login — not a separate, disconnected number.
    const freshLogin = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(freshLogin.json.sessionWarningMinutes === 15, 'a real fresh login genuinely reflects the real, currently-configured warning lead time — the same single source of truth, not a cached or hardcoded value');

    // Reset back to the default so this doesn't leak into other test suites' assumptions.
    await api('PUT', '/api/system/security-settings', { token: adminToken, body: { sessionWarningMinutes: 5 } });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
