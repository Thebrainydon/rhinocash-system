'use strict';
const { get, run } = require('./../db');
const { hashPassword, verifyPassword, generateTempPassword, signToken, tokenHash } = require('./../crypto');
const { requireAuth, requirePermission } = require('./../middleware');
const { logAction } = require('./../audit');
const { computeFinalAccess } = require('./../rbac');
const crypto = require('node:crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

async function publicUser(u) {
  if (!u) return null;
  const { password_hash, password_salt, ...rest } = u;
  return { ...rest, finalAccess: await computeFinalAccess(u) };
}

function register(router) {
  router.post('/api/auth/login', async (req, res, next) => {
    const { email, password } = req.body;
    const ip = req.socket ? req.socket.remoteAddress : null;
    if (!email || !password) return next({ status: 400, message: 'Email and password are required' });

    const user = await get('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase()]);
    if (!user) {
      await run('INSERT INTO login_attempts (email, success, reason, ip) VALUES (?,0,?,?)', [email, 'no such user', ip]);
      return next({ status: 401, message: 'Invalid credentials' });
    }
    if (user.status !== 'Active') {
      await run('INSERT INTO login_attempts (email, success, reason, ip) VALUES (?,0,?,?)', [email, `account ${user.status}`, ip]);
      await logAction({ user }, { action: 'Blocked login — account not active', module: 'auth', recordType: 'User', recordId: user.id, newValue: user.status });
      return next({ status: 403, message: `This account is ${user.status.toLowerCase()}. Contact your Admin.` });
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

    await run('INSERT INTO login_attempts (email, success, ip) VALUES (?,1,?)', [email, ip]);
    await run("UPDATE users SET last_login_at = iso_now() WHERE id = ?", [user.id]);

    const token = signToken({ sub: user.id, role: user.role_id, iat: Date.now(), exp: Date.now() + SESSION_TTL_MS });
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    await run(
      'INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES (?,?,?,?,?)',
      [tokenHash(token), user.id, expiresAt, ip, req.headers['user-agent'] || null]
    );
    req.user = user;
    await logAction(req, { action: 'User logged in', module: 'auth', recordType: 'User', recordId: user.id });

    const sysRow = await get('SELECT session_warning_minutes FROM system_settings WHERE id = 1');
    res.json({ token, user: await publicUser(user), mustChangePassword: !!user.must_change_password, expiresAt, sessionWarningMinutes: sysRow ? sysRow.session_warning_minutes : 5 });
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
  router.patch('/api/auth/me', requireAuth, async (req, res, next) => {
    const allowed = ['phone', 'email'];
    const sets = []; const params = [];
    allowed.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); } });
    if (!sets.length) return next({ status: 400, message: 'Nothing to update — only phone and email can be changed here' });
    params.push(req.user.id);
    await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
    await logAction(req, { action: 'Updated own profile', module: 'account', recordType: 'User', recordId: req.user.id, newValue: req.body });
    res.json({ user: await publicUser(await get('SELECT * FROM users WHERE id = ?', [req.user.id])) });
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
    await run('UPDATE users SET password_hash=?, password_salt=?, must_change_password=0 WHERE id=?', [hash, salt, req.user.id]);
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
    const tempPassword = generateTempPassword();
    const { hash, salt } = hashPassword(tempPassword);
    await run('UPDATE users SET password_hash=?, password_salt=?, must_change_password=1 WHERE id=?', [hash, salt, target.id]);
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
