// passwordPolicy.test.js — the real 15-day password-age policy: a fresh
// password (just seeded, or just genuinely changed) does not force a
// reset; once password_changed_at is more than 15 days old, the very next
// login forces one — reusing the exact same must_change_password flag/
// flow every other forced-change path (Admin reset, forgot-password, a
// fresh account) already uses, never a second parallel signal. Every
// real password-set call site is also checked to genuinely stamp
// password_changed_at, since that's the one column this whole policy
// hinges on.
'use strict';
const { get, run } = require('../src/db');
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
  // 1. A FRESH SEEDED PASSWORD — under 15 days old, never forced by age
  // =========================================================
  let officerToken;
  {
    const login = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(login.status === 200, 'sanity: the seeded officer logs in with the real seeded password');
    assert(login.json.mustChangePassword === false, 'a freshly-seeded password (well under 15 days old) does not force a reset on login');
    officerToken = login.json.token;
    const row = await get('SELECT password_changed_at FROM users WHERE email = ?', ['officer@rhinocash.co.ke']);
    assert(!!row.password_changed_at, 'the real password_changed_at column is genuinely populated (backfilled from created_at) for a seeded account, not left NULL');
  }

  // =========================================================
  // 2. PASSWORD AGED PAST 15 DAYS — the very next login genuinely forces it
  // =========================================================
  {
    await run(`UPDATE users SET password_changed_at = iso_offset(interval '-16 days') WHERE email = ?`, ['officer@rhinocash.co.ke']);
    const login = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(login.status === 200, 'a login with the still-correct password genuinely still succeeds even once the password is stale');
    assert(login.json.mustChangePassword === true, 'a real login response now forces a password reset once password_changed_at is more than 15 days old');
    const row = await get('SELECT must_change_password FROM users WHERE email = ?', ['officer@rhinocash.co.ke']);
    assert(Number(row.must_change_password) === 1, 'the age-triggered force is genuinely persisted server-side via the exact same must_change_password column every other forced-change path uses — not a response-only flag that forgets itself');
    officerToken = login.json.token;
  }

  // =========================================================
  // 3. UNDER THE THRESHOLD (14 days) — never forced by age alone
  // =========================================================
  {
    await run(`UPDATE users SET password_changed_at = iso_offset(interval '-14 days'), must_change_password = 0 WHERE email = ?`, ['officer@rhinocash.co.ke']);
    const login = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(login.json.mustChangePassword === false, 'a password genuinely 14 days old (under the 15-day threshold) does not get force-flagged');
  }

  // =========================================================
  // 4. A NULL password_changed_at (pre-migration row) fails toward safety
  // =========================================================
  {
    await run(`UPDATE users SET password_changed_at = NULL, must_change_password = 0 WHERE email = ?`, ['officer@rhinocash.co.ke']);
    const login = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(login.json.mustChangePassword === true, 'a real row with no password_changed_at at all is treated as stale (fails toward requiring a reset), never silently skipped');
    officerToken = login.json.token;
  }

  // =========================================================
  // 5. THE REAL SELF-SERVICE CHANGE genuinely resets the age clock
  // =========================================================
  {
    const changed = await api('POST', '/api/auth/change-password', { token: officerToken, body: { newPassword: 'FreshPass2026!' } });
    assert(changed.status === 200 && changed.json.ok, 'the real self-service change-password call succeeds while must_change_password is set, with no currentPassword required');
    const row = await get('SELECT password_changed_at, must_change_password FROM users WHERE email = ?', ['officer@rhinocash.co.ke']);
    assert(Number(row.must_change_password) === 0, 'a real password change genuinely clears must_change_password');
    const ageMs = Date.now() - new Date(row.password_changed_at).getTime();
    assert(ageMs >= 0 && ageMs < 60000, 'the real change-password call genuinely stamps password_changed_at to just now, resetting the 15-day clock');

    const reLogin = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: 'FreshPass2026!' } });
    assert(reLogin.status === 200 && reLogin.json.mustChangePassword === false, 'logging in again with the genuinely-fresh new password is no longer forced to reset');
  }

  // =========================================================
  // 6. THE ADMIN-TRIGGERED RESET also stamps password_changed_at
  // =========================================================
  {
    const adminToken = (await api('POST', '/api/auth/login', { body: { email: 'admin@rhinocash.co.ke', password: process.env.SEEDED_ADMIN_PASSWORD } })).json.token;
    const target = await get('SELECT id FROM users WHERE email = ?', ['officer@rhinocash.co.ke']);
    await run(`UPDATE users SET password_changed_at = iso_offset(interval '-30 days') WHERE id = ?`, [target.id]);
    const reset = await api('POST', `/api/users/${target.id}/reset-password`, { token: adminToken, body: { reason: 'password policy test' } });
    assert(reset.status === 200 && reset.json.tempPassword, 'sanity: the real Admin-triggered reset succeeds and returns a real temp password');
    const row = await get('SELECT password_changed_at FROM users WHERE id = ?', [target.id]);
    const ageMs = Date.now() - new Date(row.password_changed_at).getTime();
    assert(ageMs >= 0 && ageMs < 60000, 'the real Admin-triggered reset-password call genuinely stamps password_changed_at to just now too');
  }

  // =========================================================
  // 7. FORGOT-PASSWORD also stamps password_changed_at
  // =========================================================
  {
    const target = await get('SELECT id FROM users WHERE email = ?', ['officer@rhinocash.co.ke']);
    await run(`UPDATE users SET password_changed_at = iso_offset(interval '-30 days') WHERE id = ?`, [target.id]);
    const forgot = await api('POST', '/api/auth/forgot-password', { body: { email: 'officer@rhinocash.co.ke' } });
    assert(forgot.status === 200 && forgot.json.ok, 'sanity: the real forgot-password call succeeds');
    const row = await get('SELECT password_changed_at FROM users WHERE id = ?', [target.id]);
    const ageMs = Date.now() - new Date(row.password_changed_at).getTime();
    assert(ageMs >= 0 && ageMs < 60000, 'the real forgot-password call genuinely stamps password_changed_at to just now too');
  }

  // =========================================================
  // 8. THE SAME REAL POLICY, EXTENDED TO INVESTORS — a structurally
  //    separate principal type (own table, own login/change-password
  //    routes), never a second/lesser copy of the staff logic
  // =========================================================
  {
    const adminToken = (await api('POST', '/api/auth/login', { body: { email: 'admin@rhinocash.co.ke', password: process.env.SEEDED_ADMIN_PASSWORD } })).json.token;
    const created = await api('POST', '/api/investors', {
      token: adminToken,
      body: { name: 'Password Policy Investor', email: 'pwpolicy.investor@rhinocash.co.ke', password: 'InvestorInitial1!', amount: 500000, profit_share_pct: 10 },
    });
    assert(created.status === 201, 'sanity: a real fresh investor account with real login credentials is created');
    assert(Number(created.json.investor.must_change_password) === 1, 'a real investor created WITH a password is genuinely forced to change it on first login, exactly like a fresh staff account');

    const login1 = await api('POST', '/api/investor-auth/login', { body: { email: 'pwpolicy.investor@rhinocash.co.ke', password: 'InvestorInitial1!' } });
    assert(login1.status === 200 && login1.json.investor.mustChangePassword === true, 'a real investor login response genuinely surfaces mustChangePassword, previously always hardcoded false on the frontend with nothing real behind it');

    const changed = await api('POST', '/api/investor-auth/change-password', { token: login1.json.token, body: { newPassword: 'InvestorFresh2026!' } });
    assert(changed.status === 200 && changed.json.ok, 'the real investor self-service change-password endpoint succeeds while must_change_password is set, with no currentPassword required — previously this endpoint did not exist at all, so an investor had no real way to ever change their own password');

    const login2 = await api('POST', '/api/investor-auth/login', { body: { email: 'pwpolicy.investor@rhinocash.co.ke', password: 'InvestorFresh2026!' } });
    assert(login2.status === 200 && login2.json.investor.mustChangePassword === false, 'logging in again with the genuinely-changed password is no longer forced to reset');

    // The real 15-day age policy, same as staff.
    await run(`UPDATE investors SET password_changed_at = iso_offset(interval '-16 days') WHERE email = ?`, ['pwpolicy.investor@rhinocash.co.ke']);
    const login3 = await api('POST', '/api/investor-auth/login', { body: { email: 'pwpolicy.investor@rhinocash.co.ke', password: 'InvestorFresh2026!' } });
    assert(login3.status === 200 && login3.json.investor.mustChangePassword === true, 'a real investor login also forces a reset once password_changed_at is more than 15 days old');
    const row = await get('SELECT must_change_password FROM investors WHERE email = ?', ['pwpolicy.investor@rhinocash.co.ke']);
    assert(Number(row.must_change_password) === 1, 'the age-triggered force is genuinely persisted server-side for an investor too, not response-only');

    // A WRONG currentPassword is still genuinely rejected once must_change_password is cleared.
    await run(`UPDATE investors SET must_change_password = 0, password_changed_at = iso_now() WHERE email = ?`, ['pwpolicy.investor@rhinocash.co.ke']);
    const badCurrent = await api('POST', '/api/investor-auth/change-password', { token: login3.json.token, body: { currentPassword: 'TotallyWrong!', newPassword: 'AnotherNew2026!' } });
    assert(badCurrent.status === 401, 'once must_change_password is not set, the real investor change-password endpoint genuinely requires the real current password, exactly like the staff endpoint');

    // The real audit trail correctly attributes the change to the investor, not "system".
    const goodChange = await api('POST', '/api/investor-auth/change-password', { token: login3.json.token, body: { currentPassword: 'InvestorFresh2026!', newPassword: 'AnotherNew2026!' } });
    assert(goodChange.status === 200, 'sanity: the real current-password-verified change succeeds');
    const audit = await get(`SELECT user_name, role_id FROM audit_logs WHERE record_type = 'Investor' AND action = 'Password changed' AND record_id = ? ORDER BY created_at DESC LIMIT 1`, [created.json.investor.id]);
    assert(audit && audit.user_name === 'Password Policy Investor' && audit.role_id === 'investor', 'the real audit log genuinely attributes an investor-initiated password change to that investor by name, not a generic "system" actor');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
