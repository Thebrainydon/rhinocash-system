'use strict';
const { all, get, run } = require('./../db');
const { hashPassword, generateTempPassword } = require('./../crypto');
const { requireAuth, requireModule, requirePermission } = require('./../middleware');
const { logAction } = require('./../audit');
const { computeFinalAccess, effectiveModules, canActOnStaffRecord, ADMIN_ONLY_ROLES, branchIdsInScope } = require('./../rbac');
const { publicUser } = require('./auth');
const crypto = require('node:crypto');

function nextStaffCode() {
  const n = get('SELECT COUNT(*) as n FROM users').n + 1;
  return 'RC-' + String(n).padStart(4, '0');
}

// The hard line between "can manage staff" (Admin, and CEO/Director in a
// restricted way) and "is the Master System Administrator" (Admin only).
// Used on every sub-action the spec calls out as Admin-exclusive.
function requireAdminOnly(action) {
  return (req, res, next) => {
    if (req.user.role_id !== 'admin') {
      return next({ status: 403, message: `Only the System Administrator can ${action}` });
    }
    next();
  };
}

function register(router) {
  // List — real server-side search/filter/pagination, deterministic order.
  // Every authenticated user with 'staff' module access can see the
  // directory; branch/region scope for WHO shows up in it follows the
  // same real scope rules as everywhere else in this app.
  router.get('/api/users', requireAuth, requireModule('staff'), (req, res) => {
    const scope = branchIdsInScope(req.user);
    const clauses = ['1=1']; const params = [];
    if (scope !== null) {
      if (scope.length === 0) clauses.push('1=0');
      else { clauses.push(`branch_id IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
    }
    if (req.query.role_id) { clauses.push('role_id = ?'); params.push(req.query.role_id); }
    if (req.query.branch_id) {
      if (scope !== null && !scope.includes(req.query.branch_id)) clauses.push('1=0');
      else { clauses.push('branch_id = ?'); params.push(req.query.branch_id); }
    }
    if (req.query.region_id) { clauses.push('region_id = ?'); params.push(req.query.region_id); }
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    if (req.query.employment_status) { clauses.push('employment_status = ?'); params.push(req.query.employment_status); }
    if (req.query.q) { clauses.push('(name LIKE ? OR email LIKE ? OR staff_code LIKE ? OR phone LIKE ?)'); const like = `%${req.query.q}%`; params.push(like, like, like, like); }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const total = get(`SELECT COUNT(*) as c FROM users ${where}`, params).c;
    const rows = all(`SELECT * FROM users ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    res.json({ users: rows.map(publicUser), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  });

  router.get('/api/users/:id', requireAuth, requireModule('staff'), (req, res, next) => {
    const u = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!u) return next({ status: 404, message: 'User not found' });
    res.json({ user: publicUser(u) });
  });

  router.post('/api/users', requireAuth, requirePermission('manage_users'), (req, res, next) => {
    const b = req.body;
    if (!b.name || !b.email || !b.role_id) return next({ status: 400, message: 'name, email and role_id are required' });
    if (!canActOnStaffRecord(req.user, b.role_id)) {
      return next({ status: 403, message: `Your role cannot create a ${b.role_id} account — that stays with the System Administrator` });
    }
    const existing = get('SELECT id FROM users WHERE email = ?', [String(b.email).toLowerCase()]);
    if (existing) return next({ status: 409, message: 'A user with that email already exists' });
    const role = get('SELECT * FROM roles WHERE id = ?', [b.role_id]);
    if (!role) return next({ status: 400, message: 'Unknown role_id' });

    const id = 'usr_' + crypto.randomUUID();
    const tempPassword = generateTempPassword();
    const { hash, salt } = hashPassword(tempPassword);
    run(
      `INSERT INTO users (id, staff_code, name, email, phone, password_hash, password_salt, must_change_password,
        role_id, access_level, job_title, department_id, branch_id, region_id, reporting_manager_id,
        employment_status, status, monthly_disbursement_target, monthly_new_loan_target, leave_days_balance)
       VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, b.staff_code || nextStaffCode(), b.name, String(b.email).toLowerCase(), b.phone || null, hash, salt,
        b.role_id, b.access_level || role.default_access_level, b.job_title || role.name, b.department_id || null,
        b.branch_id || null, b.region_id || null, b.reporting_manager_id || null,
        b.employment_status || 'Full-time', 'Active', b.monthly_disbursement_target || 0, b.monthly_new_loan_target || 0, b.leave_days_balance || 10,
      ]
    );
    const created = get('SELECT * FROM users WHERE id = ?', [id]);
    logAction(req, { action: 'Created user', module: 'users', recordType: 'User', recordId: id, newValue: { name: b.name, role: b.role_id } });
    res.status(201).json({ user: publicUser(created), tempPassword });
  });

  router.patch('/api/users/:id', requireAuth, requirePermission('manage_users'), (req, res, next) => {
    const before = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!before) return next({ status: 404, message: 'User not found' });
    // Can't touch an existing Admin/CEO/Director account unless you ARE Admin...
    if (!canActOnStaffRecord(req.user, before.role_id)) {
      return next({ status: 403, message: `You are not authorized to edit a ${before.role_id} account` });
    }
    const b = req.body;
    // ...and can't PROMOTE someone into one either.
    if (b.role_id && !canActOnStaffRecord(req.user, b.role_id)) {
      return next({ status: 403, message: `Your role cannot assign the ${b.role_id} role` });
    }
    const fields = ['name', 'phone', 'role_id', 'access_level', 'job_title', 'department_id', 'branch_id',
      'region_id', 'reporting_manager_id', 'employment_status', 'monthly_disbursement_target', 'monthly_new_loan_target'];
    const sets = []; const params = [];
    fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); params.push(b[f]); } });
    if (sets.length === 0) return next({ status: 400, message: 'No recognized fields to update' });
    params.push(req.params.id);
    run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
    const after = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    logAction(req, {
      action: 'Updated user access', module: 'users', recordType: 'User', recordId: req.params.id,
      previousValue: pick(before, fields), newValue: pick(after, fields), reason: b.reason,
    });
    res.json({ user: publicUser(after) });
  });

  router.post('/api/users/:id/status', requireAuth, requirePermission('manage_users'), (req, res, next) => {
    const { status, reason } = req.body;
    if (!['Active', 'Suspended', 'Deactivated'].includes(status)) return next({ status: 400, message: 'status must be Active, Suspended or Deactivated' });
    const before = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!before) return next({ status: 404, message: 'User not found' });
    if (!canActOnStaffRecord(req.user, before.role_id)) {
      return next({ status: 403, message: `You are not authorized to change the status of a ${before.role_id} account` });
    }
    // Instruction #6: CEO may Activate/Suspend, but Deactivate and full
    // status control beyond that stays with Admin. Director isn't listed
    // with status-change authority at all in instruction #7.
    if (req.user.role_id === 'director') {
      return next({ status: 403, message: 'Director can add/edit staff but does not have authority to change account status — that requires Admin or CEO' });
    }
    if (req.user.role_id === 'ceo' && status === 'Deactivated') {
      return next({ status: 403, message: 'Deactivating an account requires the System Administrator' });
    }
    run('UPDATE users SET status = ? WHERE id = ?', [status, req.params.id]);
    if (status !== 'Active') run('UPDATE sessions SET revoked_at = datetime(\'now\') WHERE user_id = ? AND revoked_at IS NULL', [req.params.id]);
    logAction(req, { action: `Set status to ${status}`, module: 'users', recordType: 'User', recordId: req.params.id, previousValue: before.status, newValue: status, reason });
    res.json({ ok: true, status });
  });

  // ---- Everything below here is Admin-exclusive (instruction #5: "Admin
  // remains the ultimate system access authority"). CEO/Director can assign
  // a role/access-level/branch/region via PATCH above, but the finer-grained
  // module checklist, personal permission overrides, full access reset,
  // password reset, and session revocation are deliberately kept out of
  // their reach even though they hold 'manage_users'. ----

  // Module access — the personal override list. Empty/absent = use role default.
  router.put('/api/users/:id/module-access', requireAuth, requirePermission('manage_users'), requireAdminOnly('set a user\'s module access'), (req, res, next) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return next({ status: 404, message: 'User not found' });
    const modules = Array.isArray(req.body.modules) ? req.body.modules : [];
    const before = effectiveModules(user);
    run('DELETE FROM user_module_access WHERE user_id = ?', [user.id]);
    modules.forEach(m => run('INSERT OR IGNORE INTO user_module_access (user_id, module_id) VALUES (?,?)', [user.id, m]));
    const after = effectiveModules(user);
    logAction(req, { action: 'Set module access', module: 'users', recordType: 'User', recordId: user.id, previousValue: before, newValue: after, reason: req.body.reason });
    res.json({ ok: true, modules: after });
  });

  router.put('/api/users/:id/permissions/:permissionId', requireAuth, requirePermission('manage_users'), requireAdminOnly('set a user\'s permission overrides'), (req, res, next) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return next({ status: 404, message: 'User not found' });
    const { allowed, reason } = req.body;
    run(
      `INSERT INTO user_permission_overrides (user_id, permission_id, allowed) VALUES (?,?,?)
       ON CONFLICT(user_id, permission_id) DO UPDATE SET allowed = excluded.allowed`,
      [user.id, req.params.permissionId, allowed ? 1 : 0]
    );
    logAction(req, { action: 'Set permission override', module: 'users', recordType: 'User', recordId: user.id, newValue: { [req.params.permissionId]: !!allowed }, reason });
    res.json({ ok: true });
  });

  router.delete('/api/users/:id/permissions/:permissionId', requireAuth, requirePermission('manage_users'), requireAdminOnly('clear a user\'s permission overrides'), (req, res) => {
    run('DELETE FROM user_permission_overrides WHERE user_id = ? AND permission_id = ?', [req.params.id, req.params.permissionId]);
    logAction(req, { action: 'Cleared permission override', module: 'users', recordType: 'User', recordId: req.params.id, newValue: req.params.permissionId });
    res.json({ ok: true });
  });

  router.post('/api/users/:id/reset-access', requireAuth, requirePermission('manage_users'), requireAdminOnly('reset a user\'s access'), (req, res, next) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return next({ status: 404, message: 'User not found' });
    run('DELETE FROM user_module_access WHERE user_id = ?', [user.id]);
    run('DELETE FROM user_permission_overrides WHERE user_id = ?', [user.id]);
    const role = get('SELECT * FROM roles WHERE id = ?', [user.role_id]);
    run('UPDATE users SET access_level = ? WHERE id = ?', [role.default_access_level, user.id]);
    logAction(req, { action: 'Reset access to role defaults', module: 'users', recordType: 'User', recordId: user.id });
    res.json({ ok: true });
  });

  router.get('/api/users/:id/final-access', requireAuth, requireModule('staff'), (req, res, next) => {
    const user = get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return next({ status: 404, message: 'User not found' });
    res.json({ finalAccess: computeFinalAccess(user) });
  });

  router.get('/api/users/:id/activity', requireAuth, requireModule('audit'), (req, res) => {
    const rows = all('SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.params.id]);
    res.json({ activity: rows });
  });

  router.get('/api/users/:id/login-history', requireAuth, requireModule('audit'), (req, res) => {
    const u = get('SELECT email FROM users WHERE id = ?', [req.params.id]);
    const rows = u ? all('SELECT * FROM login_attempts WHERE email = ? ORDER BY created_at DESC LIMIT 50', [u.email]) : [];
    res.json({ loginHistory: rows });
  });

  router.get('/api/roles', requireAuth, (req, res) => {
    res.json({ roles: all('SELECT * FROM roles') });
  });
  router.get('/api/modules', requireAuth, (req, res) => {
    res.json({ modules: all('SELECT * FROM modules') });
  });
  router.get('/api/permissions', requireAuth, (req, res) => {
    res.json({ permissions: all('SELECT * FROM permissions') });
  });
  router.get('/api/roles/:id/permissions', requireAuth, (req, res) => {
    res.json({ permissions: all('SELECT permission_id, allowed FROM role_permissions WHERE role_id = ?', [req.params.id]) });
  });
  router.put('/api/roles/:id/permissions/:permissionId', requireAuth, requirePermission('manage_users'), requireAdminOnly('edit the role permission matrix'), (req, res) => {
    run(
      `INSERT INTO role_permissions (role_id, permission_id, allowed) VALUES (?,?,?)
       ON CONFLICT(role_id, permission_id) DO UPDATE SET allowed = excluded.allowed`,
      [req.params.id, req.params.permissionId, req.body.allowed ? 1 : 0]
    );
    logAction(req, { action: 'Changed role permission matrix', module: 'roles', recordType: 'Role', recordId: req.params.id, newValue: { [req.params.permissionId]: !!req.body.allowed } });
    res.json({ ok: true });
  });
}

function pick(obj, keys) { const o = {}; keys.forEach(k => { o[k] = obj[k]; }); return o; }

module.exports = { register };
