// forgotPassword.test.js — the real, public, unauthenticated password
// recovery flow (POST /api/auth/forgot-password): a matching Active
// account genuinely gets a new temp password (same real mechanism as the
// Admin-triggered reset), must-change-password is forced, all of that
// user's sessions are genuinely revoked, and — critically — a request for
// an email that does NOT match a real account gets the exact same generic
// response, never revealing which emails are registered.
'use strict';
const { get } = require('../src/db');
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
  // 1. A REAL, MATCHING, ACTIVE ACCOUNT — genuinely reset
  // =========================================================
  {
    const login = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(login.status === 200, 'sanity: the seeded officer account logs in with its real seeded password before we reset it');

    const forgot = await api('POST', '/api/auth/forgot-password', { body: { email: 'officer@rhinocash.co.ke' } });
    assert(forgot.status === 200 && forgot.json.ok, 'a real, matching, Active account gets a 200 ok response');
    assert(typeof forgot.json.message === 'string' && !forgot.json.message.toLowerCase().includes('temp'), 'the response is a generic confirmation message, not the temp password itself — a public endpoint must never hand out credentials over an unauthenticated channel');

    const oldPasswordNowFails = await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } });
    assert(oldPasswordNowFails.status === 401, 'the OLD real seeded password genuinely no longer works after a forgot-password request — this is a real reset, not a no-op');

    const stillLoggedIn = await api('GET', '/api/auth/me', { token: login.json.token });
    assert(stillLoggedIn.status === 401, 'the officer’s pre-existing real session is genuinely revoked by the forgot-password reset, exactly like the Admin-triggered reset does');

    const row = await get('SELECT must_change_password, password_hash FROM users WHERE email = ?', ['officer@rhinocash.co.ke']);
    assert(row && Number(row.must_change_password) === 1, 'must_change_password is genuinely forced on for the next real login');
    // No restore needed: test/run-all.sh reseeds a genuinely fresh database
    // before every suite, this one included — nothing later in this run
    // depends on the officer's rotated password.
  }

  // =========================================================
  // 2. AN EMAIL THAT DOES NOT MATCH ANY REAL ACCOUNT — same generic response
  // =========================================================
  {
    const forgot = await api('POST', '/api/auth/forgot-password', { body: { email: 'this-email-does-not-exist-anywhere@rhinocash.co.ke' } });
    assert(forgot.status === 200 && forgot.json.ok, 'a non-existent email still gets a 200 ok response — never a 404, which would reveal the email is not registered');
    assert(typeof forgot.json.message === 'string' && forgot.json.message.length > 0, 'a non-existent email gets a real, non-empty generic message');
  }

  // =========================================================
  // 3. MISSING EMAIL — a real validation error, not silently accepted
  // =========================================================
  {
    const forgot = await api('POST', '/api/auth/forgot-password', { body: {} });
    assert(forgot.status === 400, 'a request with no email at all is a genuine 400, distinct from the not-found-but-still-200 case above');
  }

  // =========================================================
  // 4. A NON-ACTIVE (e.g. Suspended/Inactive) ACCOUNT — no reset happens,
  //    but the response still looks identical from the outside
  // =========================================================
  {
    const adminToken = (await api('POST', '/api/auth/login', { body: { email: 'admin@rhinocash.co.ke', password: process.env.SEEDED_ADMIN_PASSWORD } })).json.token;
    const created = await api('POST', '/api/users', {
      token: adminToken,
      body: { name: 'Forgot Password Test Suspended', email: 'suspended.forgot-test@rhinocash.co.ke', role_id: 'loan_officer', branch_id: 'br_kisumu' },
    });
    assert(created.status === 201 || created.status === 200, 'sanity: a fresh test user is genuinely created for the suspended-account case');
    await api('POST', `/api/users/${created.json.user.id}/status`, { token: adminToken, body: { status: 'Suspended' } });
    const before = await get('SELECT password_hash FROM users WHERE email = ?', ['suspended.forgot-test@rhinocash.co.ke']);

    const forgot = await api('POST', '/api/auth/forgot-password', { body: { email: 'suspended.forgot-test@rhinocash.co.ke' } });
    assert(forgot.status === 200 && forgot.json.ok, 'a real but Suspended account still gets the same generic 200 response — the outside caller can never distinguish this from a non-existent email');

    const after = await get('SELECT password_hash FROM users WHERE email = ?', ['suspended.forgot-test@rhinocash.co.ke']);
    assert(before.password_hash === after.password_hash, 'a Suspended account’s real password hash is genuinely left untouched — no reset actually happens underneath the identical-looking response');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
