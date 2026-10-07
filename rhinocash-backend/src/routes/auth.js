'use strict';
const { get, run } = require('./../db');
const { hashPassword, verifyPassword, generateTempPassword, signToken, tokenHash } = require('./../crypto');
const { requireAuth, requirePermission, requireMenuFeature } = require('./../middleware');
const { logAction } = require('./../audit');
const { computeFinalAccess } = require('./../rbac');
const email = require('./../integrations/email');
const crypto = require('node:crypto');
const { describeBrowser } = require('./../userAgent');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
// A real, enforced password-age policy — 15 days since password_changed_at
// (stamped by every genuine password-set: self-service change, Admin
// reset, forgot-password). Checked once, at login, alongside the existing
// must_change_password flag rather than as a second parallel signal —
// when it's the age policy (not an explicit reset) that trips it, the
// same flag is persisted so every other already-real enforcement point
// (change-password's skip-current-password exemption, the two existing
// self-service forms' hidden-current-password-field logic) sees exactly
// the same must_change_password=1 it already knows how to handle.
const PASSWORD_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;
// How recently a session must genuinely have been used to still count as
// "active" for the single-active-session login block below.
const SESSION_ACTIVE_WINDOW_SQL = "interval '-5 seconds'";

// Real, always-fresh account info — never trusted from a stale `u` object
// a caller might have loaded before a since-created/suspended account, so
// every response (login, /me, the Staff/Employee directory) reports the
// System Account's actual current state.
async function accountInfoFor(employeeId) {
  const acct = await get('SELECT * FROM user_accounts WHERE employee_id = ?', [employeeId]);
  return {
    systemAccount: acct ? acct.status : 'Not Created',
    hasAccount: !!acct,
    accountCreatedAt: acct ? acct.created_at : null,
    accountLastLoginAt: acct ? acct.last_login_at : null,
  };
}

async function publicUser(u) {
  if (!u) return null;
  const { password_hash, password_salt, account_status, login_email, account_last_login_at, ...rest } = u;
  return { ...rest, ...(await accountInfoFor(u.id)), finalAccess: await computeFinalAccess(u) };
}

function register(router) {
  router.post('/api/auth/login', async (req, res, next) => {
    const { email, password } = req.body;
    const ip = req.socket ? req.socket.remoteAddress : null;
    if (!email || !password) return next({ status: 400, message: 'Email and password are required' });

    // Real login identifier is the System Account's own login_email — an
    // Employee with no account at all (or whose account uses a different
    // login_email than their contact email) correctly finds no row here,
    // exactly like a genuinely unknown address, never leaking which case
    // it was. Still merged with the real Employee row for everything else
    // login already needs (name, employment status, role_id, etc.).
    const user = await get(
      `SELECT u.*, ua.status AS account_status, ua.login_email, ua.created_at AS account_created_at
       FROM user_accounts ua JOIN users u ON u.id = ua.employee_id WHERE ua.login_email = ?`,
      [String(email).toLowerCase()]
    );
    if (!user) {
      await run('INSERT INTO login_attempts (email, success, reason, ip) VALUES (?,0,?,?)', [email, 'no such user', ip]);
      return next({ status: 401, message: 'Invalid credentials' });
    }
    if (user.account_status !== 'Active') {
      await run('INSERT INTO login_attempts (email, success, reason, ip) VALUES (?,0,?,?)', [email, `account ${user.account_status}`, ip]);
      await logAction({ user }, { action: 'Blocked login — account not active', module: 'auth', recordType: 'User', recordId: user.id, newValue: user.account_status });
      return next({ status: 403, message: `This account is ${user.account_status.toLowerCase()}. Contact your Admin.` });
    }
    // Real maintenance-mode gate — Admin can always still log in (they're
    // the only role that can turn it back off); everyone else is blocked
    // with the real configured message, not a generic error. Uses 403,
    // not 503: this router treats any status >=500 as an unexpected crash
    // and deliberately replaces the message with a generic one (a real,
    // intentional security behavior for genuine server errors) — 503
    // would silently swallow the real maintenance message.
    if (user.role_id !== 'admin') {
      const sys = await get('SELECT * FROM system_settings WHERE id = 1');
      if (sys && sys.maintenance_mode) {
        return next({ status: 403, message: sys.maintenance_message || 'The system is currently under maintenance. Please try again later.', code: 'MAINTENANCE_MODE' });
      }
    }
    if (!verifyPassword(password, user.password_hash, user.password_salt)) {
      await run('INSERT INTO login_attempts (email, success, reason, ip) VALUES (?,0,?,?)', [email, 'bad password', ip]);
      const recentFailsRow = await get(
        `SELECT COUNT(*) as n FROM login_attempts WHERE email = ? AND success = 0 AND created_at > iso_offset(interval '-15 minutes')`,
        [email]
      );
      if (recentFailsRow.n >= 5) return next({ status: 429, message: 'Too many failed attempts. Try again later.' });
      return next({ status: 401, message: 'Invalid credentials' });
    }

    // Single active session per account — credentials are already verified
    // at this point, so it's safe to tell the caller exactly why they're
    // blocked. A second real login attempt while a first real session is
    // still genuinely active (not expired, not already logged out, AND
    // genuinely used recently — see SESSION_ACTIVE_WINDOW_SQL above) never
    // gets to spawn a competing session; the account holder is told which
    // real browser that other session is on and sent to log out there
    // first, rather than silently taking over or silently failing.
    const activeSession = await get(
      `SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > iso_now() AND last_seen_at > iso_offset(${SESSION_ACTIVE_WINDOW_SQL}) ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    if (activeSession) {
      await run('INSERT INTO login_attempts (email, success, reason, ip) VALUES (?,0,?,?)', [email, 'already logged in elsewhere', ip]);
      return next({ status: 409, message: `Your account is currently logged in on ${describeBrowser(activeSession.user_agent)}. Kindly logout first to access your account.`, code: 'ALREADY_LOGGED_IN' });
    }

    await run('INSERT INTO login_attempts (email, success, ip) VALUES (?,1,?)', [email, ip]);
    await run("UPDATE users SET last_login_at = iso_now() WHERE id = ?", [user.id]);
    await run("UPDATE user_accounts SET last_login_at = iso_now() WHERE employee_id = ?", [user.id]);

    const token = signToken({ sub: user.id, role: user.role_id, iat: Date.now(), exp: Date.now() + SESSION_TTL_MS });
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await run(
      'INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent, last_seen_at) VALUES (?,?,?,?,?,iso_now())',
      [tokenHash(token), user.id, expiresAt, ip, req.headers['user-agent'] || null]
    );
    req.user = user;
    await logAction(req, { action: 'User logged in', module: 'auth', recordType: 'User', recordId: user.id });

    let mustChangePassword = !!user.must_change_password;
    if (!mustChangePassword) {
      const changedAt = user.password_changed_at ? new Date(user.password_changed_at).getTime() : NaN;
      const passwordExpired = Number.isNaN(changedAt) || (Date.now() - changedAt) >= PASSWORD_MAX_AGE_MS;
      if (passwordExpired) {
        await run('UPDATE users SET must_change_password=1 WHERE id=?', [user.id]);
        mustChangePassword = true;
      }
    }

    const sysRow = await get('SELECT session_warning_minutes FROM system_settings WHERE id = 1');
    res.json({ token, user: await publicUser(user), mustChangePassword, expiresAt, sessionWarningMinutes: sysRow ? sysRow.session_warning_minutes : 5 });
  });

  // Public, unauthenticated password recovery. Never reveals whether the
  // given email matched a real account — same generic response either way,
  // same reasoning as the login route's credential errors. When it does
  // match a real, Active account, it does exactly what the Admin-triggered
  // reset above does (real temp password, forced change, sessions revoked),
  // then attempts real delivery via the email integration — which honestly
  // reports NOT_CONFIGURED rather than fabricating a "sent" email when no
  // real provider is wired up (see src/integrations/email.js).
  router.post('/api/auth/forgot-password', async (req, res, next) => {
    const { email: rawEmail } = req.body;
    if (!rawEmail) return next({ status: 400, message: 'Email is required' });
    const genericMessage = 'If that email is registered, password reset instructions have been sent.';
    const user = await get(
      `SELECT u.*, ua.status AS account_status, ua.login_email
       FROM user_accounts ua JOIN users u ON u.id = ua.employee_id WHERE ua.login_email = ?`,
      [String(rawEmail).toLowerCase()]
    );
    if (user && user.account_status === 'Active') {
      const tempPassword = generateTempPassword();
      const { hash, salt } = hashPassword(tempPassword);
      await run('UPDATE users SET password_hash=?, password_salt=?, must_change_password=1, password_changed_at=iso_now() WHERE id=?', [hash, salt, user.id]);
      await run("UPDATE sessions SET revoked_at = iso_now() WHERE user_id = ?", [user.id]);
      await logAction({ user }, { action: 'Requested password reset', module: 'auth', recordType: 'User', recordId: user.id });
      await email.send('password_reset', user.login_email, { name: user.name, tempPassword });
    }
    res.json({ ok: true, message: genericMessage });
  });

  router.post('/api/auth/logout', requireAuth, async (req, res) => {
    await run("UPDATE sessions SET revoked_at = iso_now() WHERE token_hash = ?", [req.sessionTokenHash]);
    await logAction(req, { action: 'User logged out', module: 'auth', recordType: 'User', recordId: req.user.id });
    res.json({ ok: true });
  });

  router.get('/api/auth/me', requireAuth, async (req, res) => {
    const session = await get('SELECT expires_at FROM sessions WHERE token_hash = ?', [req.sessionTokenHash]);
    res.json({ user: await publicUser(req.user), expiresAt: session ? session.expires_at : null });
  });

  // A user updating their OWN profile — deliberately a tiny, explicit
  // allow-list (contact info only). Role, access_level, branch_id,
  // region_id, permissions, and status can never be changed here, no
  // matter what the request body contains — those all go through the
  // real Staff Management PATCH /api/users/:id path, which requires
  // manage_users and is never reachable by editing your own record.
  //
  // An optional newPassword may ride along in the same request (the
  // combined Email/Contact/Password "Update" form) — this is the one
  // password-change path in the app that never asks for the current
  // password, since the caller is already proven to hold this exact
  // account's own live session token; every other change-password path
  // (the Security page, the forced first-login reset) still goes through
  // POST /api/auth/change-password below and still requires it.
  router.patch('/api/auth/me', requireAuth, requireMenuFeature('menu-update-details'), async (req, res, next) => {
    const allowed = ['phone', 'email'];
    const sets = []; const params = [];
    allowed.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); } });
    let passwordChanged = false;
    if (req.body.newPassword) {
      if (req.body.newPassword.length < 8) return next({ status: 400, message: 'New password must be at least 8 characters' });
      const { hash, salt } = hashPassword(req.body.newPassword);
      sets.push('password_hash = ?', 'password_salt = ?', 'must_change_password = 0', 'password_changed_at = iso_now()');
      params.push(hash, salt);
      passwordChanged = true;
    }
    if (!sets.length) return next({ status: 400, message: 'Nothing to update — only phone, email and password can be changed here' });
    params.push(req.user.id);
    await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
    // Keep the System Account's own login_email in step with a
    // self-service contact-email change — but only while it hasn't
    // already been deliberately set to something different (e.g. by an
    // Admin at account creation), so this never silently overwrites a
    // real intentional divergence between contact and login email.
    if (req.body.email !== undefined && req.user.login_email === req.user.email) {
      await run('UPDATE user_accounts SET login_email = ? WHERE employee_id = ?', [req.body.email, req.user.id]);
    }
    if (passwordChanged) {
      // Same real invalidation change-password already performs — a new
      // password must retire every other active session, not just this one.
      await run("UPDATE sessions SET revoked_at = iso_now() WHERE user_id = ? AND token_hash != ?", [req.user.id, req.sessionTokenHash]);
    }
    await logAction(req, { action: 'Updated own profile', module: 'account', recordType: 'User', recordId: req.user.id, newValue: { phone: req.body.phone, email: req.body.email, passwordChanged } });
    res.json({ user: await publicUser(await get('SELECT * FROM users WHERE id = ?', [req.user.id])), passwordChanged });
  });

  router.post('/api/auth/change-password', requireAuth, async (req, res, next) => {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) return next({ status: 400, message: 'New password must be at least 8 characters' });
    if (!req.user.must_change_password) {
      if (!verifyPassword(currentPassword || '', req.user.password_hash, req.user.password_salt)) {
        return next({ status: 401, message: 'Current password is incorrect' });
      }
    }
    const { hash, salt } = hashPassword(newPassword);
    await run('UPDATE users SET password_hash=?, password_salt=?, must_change_password=0, password_changed_at=iso_now() WHERE id=?', [hash, salt, req.user.id]);
    // changing your password invalidates every other active session — real, not decorative
    await run("UPDATE sessions SET revoked_at = iso_now() WHERE user_id = ? AND token_hash != ?", [req.user.id, req.sessionTokenHash]);
    await logAction(req, { action: 'Password changed', module: 'auth', recordType: 'User', recordId: req.user.id });
    res.json({ ok: true });
  });

  // Admin-triggered reset: generates a real temp password, forces change on next login.
  // Kept Admin-exclusive even though CEO/Director hold 'manage_users' —
  // password/session control is exactly the "Master System Administrator"
  // authority instruction #5 says must stay separate from operational
  // staff-management authority.
  router.post('/api/users/:id/reset-password', requireAuth, requirePermission('manage_users'), async (req, res, next) => {
    if (req.user.role_id !== 'admin') return next({ status: 403, message: 'Only the System Administrator can reset a password' });
    const target = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!target) return next({ status: 404, message: 'User not found' });
    if (!(await get('SELECT 1 FROM user_accounts WHERE employee_id = ?', [target.id]))) {
      return next({ status: 400, message: 'This employee has no System Account to reset a password for' });
    }
    const tempPassword = generateTempPassword();
    const { hash, salt } = hashPassword(tempPassword);
    await run('UPDATE users SET password_hash=?, password_salt=?, must_change_password=1, password_changed_at=iso_now() WHERE id=?', [hash, salt, target.id]);
    await run("UPDATE sessions SET revoked_at = iso_now() WHERE user_id = ?", [target.id]);
    await logAction(req, { action: 'Reset user password', module: 'users', recordType: 'User', recordId: target.id, reason: req.body.reason });
    // In production this would be emailed/SMSed to the user, never returned over
    // an unauthenticated channel. Here it's returned to the (already
    // authenticated, already-permission-checked) Admin making the request.
    res.json({ ok: true, tempPassword });
  });

  router.post('/api/users/:id/revoke-sessions', requireAuth, requirePermission('manage_users'), async (req, res, next) => {
    if (req.user.role_id !== 'admin') return next({ status: 403, message: 'Only the System Administrator can revoke sessions' });
    const target = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!target) return next({ status: 404, message: 'User not found' });
    const result = await run("UPDATE sessions SET revoked_at = iso_now() WHERE user_id = ? AND revoked_at IS NULL", [target.id]);
    await logAction(req, { action: 'Revoked sessions', module: 'users', recordType: 'User', recordId: target.id, newValue: { revoked: result.changes } });
    res.json({ ok: true, revoked: result.changes });
  });
}

module.exports = { register, publicUser };
