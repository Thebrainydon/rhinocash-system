// concurrentLogin.test.js — the single-active-session login block in
// depth: real browser-name detection from a real stored User-Agent across
// several real browsers, a naturally-expired (never revoked) session
// genuinely NOT blocking a fresh login, and Admin's explicit per-session
// revoke genuinely unblocking one too. The core block itself (409, the
// message wording, the still-active first session being unaffected, a
// wrong password never leaking the blocked state, and the investor
// variant) is covered in logout.test.js, which already owns real session
// mechanics — this file goes deeper on the parts that deserve their own
// direct coverage.
'use strict';
const { run } = require('../src/db');
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}

(async () => {
  // =========================================================
  // 1. REAL BROWSER-NAME DETECTION — a real login establishes a real
  //    session carrying a real User-Agent string; a blocked second login
  //    attempt's message genuinely reflects THAT exact real browser, for
  //    several real, genuinely different User-Agent strings.
  // =========================================================
  {
    const cases = [
      { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', expect: 'Chrome' },
      { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0', expect: 'Firefox' },
      { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15', expect: 'Safari' },
      { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0', expect: 'Microsoft Edge' },
      { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0', expect: 'Opera' },
    ];
    for (const { ua, expect } of cases) {
      const first = await api('POST', '/api/auth/login', {
        body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD },
        headers: { 'User-Agent': ua },
      });
      assert(first.status === 200, `sanity: a real login establishing a session with a real ${expect} User-Agent succeeds`);
      const blocked = await api('POST', '/api/auth/login', { body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD } });
      assert(blocked.status === 409 && blocked.json.error.includes(expect), `a real second login attempt genuinely reports the existing real session's own browser as "${expect}", derived from its real stored User-Agent, not a generic placeholder`);
      await api('POST', '/api/auth/logout', { token: first.json.token });
    }

    // No real User-Agent at all (a bare API client, not a browser) still
    // produces an honest, non-fabricated description.
    const noUaFirst = await api('POST', '/api/auth/login', {
      body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD },
      headers: { 'User-Agent': '' },
    });
    const noUaBlocked = await api('POST', '/api/auth/login', { body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD } });
    assert(noUaBlocked.status === 409 && noUaBlocked.json.error.includes('another device or browser'), 'a real session with no real User-Agent recorded genuinely gets an honest generic description, never a fabricated browser name');
    await api('POST', '/api/auth/logout', { token: noUaFirst.json.token });
  }

  // =========================================================
  // 2. A NATURALLY-EXPIRED SESSION (never explicitly logged out) does NOT
  //    block a fresh login — only a genuinely still-active session does.
  // =========================================================
  {
    const login1 = await api('POST', '/api/auth/login', { body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD } });
    assert(login1.status === 200, 'sanity: a real session is established');

    // Backdate this real session's own real expires_at into the past —
    // the exact real column the login-block check itself reads — rather
    // than faking the check or waiting out the real 12-hour TTL.
    await run(`UPDATE sessions SET expires_at = iso_offset(interval '-1 minutes') WHERE user_id = (SELECT id FROM users WHERE email = ?)`, ['manager.kisumu@rhinocash.co.ke']);

    const login2 = await api('POST', '/api/auth/login', { body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD } });
    assert(login2.status === 200, 'a real login succeeds when the only existing session for this account has genuinely expired — expiry alone is enough to no longer count as "currently active", with no explicit logout required');
    await api('POST', '/api/auth/logout', { token: login2.json.token });
  }

  // =========================================================
  // 3. A STALE-BUT-NOT-EXPIRED SESSION (the real bug report: the owner
  //    closed their browser/app without hitting Logout, so the real
  //    client-side idle-logout JS never got a chance to call the real
  //    logout endpoint — the session is still technically un-expired, but
  //    it was last genuinely used well outside the real 5-second active
  //    window) does NOT block that same real account holder's next login.
  //    This is the exact real scenario a bare expires_at/revoked_at check
  //    got wrong, locking a legitimate account holder out of their own
  //    account for up to a real 12 hours over nothing.
  // =========================================================
  {
    const login1 = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(login1.status === 200, 'sanity: a real session is established');

    // Backdate only this real session's own real last_seen_at — expires_at
    // stays genuinely 12 real hours out, exactly like an abandoned but
    // not-yet-expired real session — rather than faking the check itself.
    await run(`UPDATE sessions SET last_seen_at = iso_offset(interval '-10 seconds') WHERE user_id = (SELECT id FROM users WHERE email = ?)`, ['officer@rhinocash.co.ke']);

    const login2 = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(login2.status === 200, 'a real login for the SAME real account holder succeeds when their own existing session has genuinely not been used in over 5 real seconds, even though it has not technically expired yet — nobody else logged in, so this must never be blocked');
    await api('POST', '/api/auth/logout', { token: login2.json.token });

    // The inverse: a session genuinely used within the last real 5
    // seconds DOES still block, proving this is a real, live window check
    // and not just a blanket "never block" regression from the fix above.
    const login3 = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(login3.status === 200, 'sanity: a fresh real session is established again');
    const stillBlocked = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(stillBlocked.status === 409, 'a real session genuinely just used moments ago — still inside the real 5-second active window — correctly still blocks a second login');
    await run(`UPDATE sessions SET revoked_at = iso_now() WHERE user_id = (SELECT id FROM users WHERE email = ?) AND revoked_at IS NULL`, ['officer@rhinocash.co.ke']);
  }

  // =========================================================
  // 3. ADMIN'S EXPLICIT PER-SESSION REVOKE (System Administration >
  //    Active Sessions) also genuinely clears the real block, exactly
  //    like the account holder's own logout does.
  // =========================================================
  {
    const adminToken = (await api('POST', '/api/auth/login', { body: { email: 'admin@rhinocash.co.ke', password: process.env.SEEDED_ADMIN_PASSWORD } })).json.token;
    const officerLogin = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(officerLogin.status === 200, 'sanity: a real officer session is established');

    const blockedRelogin = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(blockedRelogin.status === 409, 'sanity: a second real officer login is genuinely blocked while the first is still active');

    const sessions = await api('GET', '/api/system/sessions', { token: adminToken });
    const officerSession = sessions.json.sessions.find(s => s.email === 'officer@rhinocash.co.ke');
    await api('POST', `/api/system/sessions/${officerSession.id}/revoke`, { token: adminToken, body: {} });

    const afterAdminRevoke = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(afterAdminRevoke.status === 200, "Admin explicitly revoking the officer's real active session genuinely clears the block too — not just the account holder's own logout");
    await api('POST', '/api/auth/logout', { token: afterAdminRevoke.json.token });
    await api('POST', '/api/auth/logout', { token: adminToken });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
