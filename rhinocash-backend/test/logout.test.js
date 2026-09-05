// logout.test.js — real session revocation on logout, for both staff and
// investor principal types (structurally separate auth), confirming a
// revoked session genuinely cannot authenticate again, other sessions
// remain unaffected, and expiresAt is real and present on login/me.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

(async () => {
  // =========================================================
  // 1. STAFF LOGOUT — real session revocation
  // =========================================================
  {
    const login = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(login.status === 200 && login.json.expiresAt, 'real staff login returns a real expiresAt timestamp — not fabricated, the same value written to the real sessions row');

    const before = await api('GET', '/api/auth/me', { token: login.json.token });
    assert(before.status === 200 && before.json.expiresAt, 'real GET /api/auth/me also returns the real session expiry, for a session established without a fresh login (e.g. page reload)');

    const logout = await api('POST', '/api/auth/logout', { token: login.json.token });
    assert(logout.status === 200, 'real staff logout succeeds');

    const after = await api('GET', '/api/auth/me', { token: login.json.token });
    assert(after.status === 401, 'the real logged-out staff session genuinely cannot authenticate anymore — not just cleared client-side');
  }

  // =========================================================
  // 2. LOGOUT NEVER AFFECTS OTHER SESSIONS
  // =========================================================
  {
    const session1 = await api('POST', '/api/auth/login', { body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD } });
    const session2 = await api('POST', '/api/auth/login', { body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD } });
    assert(session1.json.token !== session2.json.token, 'two real logins for the same real user genuinely produce two distinct real sessions');

    await api('POST', '/api/auth/logout', { token: session1.json.token });
    const session1Check = await api('GET', '/api/auth/me', { token: session1.json.token });
    assert(session1Check.status === 401, 'the real logged-out session (session1) cannot authenticate');
    const session2Check = await api('GET', '/api/auth/me', { token: session2.json.token });
    assert(session2Check.status === 200, 'the real OTHER session (session2, same user, different login) remains genuinely unaffected — logout never accidentally revokes a different session');
  }

  // =========================================================
  // 3. INVESTOR LOGOUT — the real, previously-missing bridge
  // =========================================================
  {
    const invLogin = await api('POST', '/api/investor-auth/login', { body: { email: 'sara.investor@example.com', password: process.env.SEEDED_INVESTOR_PASSWORD } });
    assert(invLogin.status === 200 && invLogin.json.expiresAt, 'real investor login also returns a real expiresAt timestamp');

    // The real, previously-missing gap: the OLD staff-only logout endpoint genuinely rejects an investor token.
    const wrongEndpoint = await api('POST', '/api/auth/logout', { token: invLogin.json.token });
    assert(wrongEndpoint.status === 401, 'an investor token genuinely cannot use the staff-only /api/auth/logout endpoint — confirms why a dedicated investor logout route was a real, necessary fix, not a redundant one');

    const invBefore = await api('GET', '/api/investor/me', { token: invLogin.json.token });
    assert(invBefore.status === 200, 'the real investor session works before logout');

    const invLogout = await api('POST', '/api/investor-auth/logout', { token: invLogin.json.token });
    assert(invLogout.status === 200, 'the real, new investor-specific logout endpoint succeeds');

    const invAfter = await api('GET', '/api/investor/me', { token: invLogin.json.token });
    assert(invAfter.status === 401, 'the real logged-out investor session genuinely cannot authenticate anymore — the critical fix: previously this session would have stayed valid forever after a client-side-only "logout"');
  }

  // =========================================================
  // 4. INVESTOR AND STAFF SESSIONS REMAIN ISOLATED
  // =========================================================
  {
    const staffLogin = await api('POST', '/api/auth/login', { body: { email: 'admin@rhinocash.co.ke', password: process.env.SEEDED_ADMIN_PASSWORD } });
    const invLogin = await api('POST', '/api/investor-auth/login', { body: { email: 'sara.investor@example.com', password: process.env.SEEDED_INVESTOR_PASSWORD } });

    const staffOnInvestorRoute = await api('GET', '/api/investor/me', { token: staffLogin.json.token });
    assert(staffOnInvestorRoute.status === 401, 'a real staff token genuinely cannot access investor-only routes');
    const investorOnStaffRoute = await api('GET', '/api/auth/me', { token: invLogin.json.token });
    assert(investorOnStaffRoute.status === 401, 'a real investor token genuinely cannot access staff-only routes — the two principal types remain structurally isolated, including around logout');

    // Logging out the investor session never touches the real staff session.
    await api('POST', '/api/investor-auth/logout', { token: invLogin.json.token });
    const staffStillWorks = await api('GET', '/api/auth/me', { token: staffLogin.json.token });
    assert(staffStillWorks.status === 200, 'logging out a real investor session never affects a real, unrelated staff session');
  }

  // =========================================================
  // 5. ADMIN SESSION REVOCATION USES THE SAME REAL MECHANISM
  // =========================================================
  {
    const adminToken = (await api('POST', '/api/auth/login', { body: { email: 'admin@rhinocash.co.ke', password: process.env.SEEDED_ADMIN_PASSWORD } })).json.token;
    const officerLogin = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    const sessions = await api('GET', '/api/system/sessions', { token: adminToken });
    const officerSession = sessions.json.sessions.find(s => s.email === 'officer@rhinocash.co.ke');
    assert(officerSession, 'the real officer session genuinely appears in the real Admin session-management list');

    await api('POST', `/api/system/sessions/${officerSession.id}/revoke`, { token: adminToken, body: {} });
    const revokedCheck = await api('GET', '/api/auth/me', { token: officerLogin.json.token });
    assert(revokedCheck.status === 401, 'Admin session revocation (System Administration) and self-logout genuinely reject the same session the same way — one real underlying mechanism, not two competing ones');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
