'use strict';
const { all, get, run, transaction } = require('./../db');
const { hashPassword, generateTempPassword } = require('./../crypto');
const { requireAuth, requireModule, requirePermission } = require('./../middleware');
const { logAction, notify } = require('./../audit');
const email = require('./../integrations/email');
const sms = require('./../integrations/sms');
const { computeFinalAccess, effectiveModules, canActOnStaffRecord, ADMIN_ONLY_ROLES, branchIdsInScope } = require('./../rbac');
const { publicUser } = require('./auth');
const crypto = require('node:crypto');

async function nextStaffCode() {
  const n = (await get('SELECT COUNT(*) as n FROM users')).n + 1;
  return 'RC-' + String(n).padStart(4, '0');
}

// Structural/Dashboard Template — the fixed set of 9 real structural
// roles (loan_officer..director) plus 'investor', each of which already
// has its own real sidebar tree (frontend SIDEBAR_MENUS) and dashboard
// layout. A role's structural_template/dashboard_template say which of
// THOSE 10 real menu/dashboard shapes it reuses — never a permission, and
// never auto-granting the template role's own real permissions/modules
// (see POST /api/roles below). New templates can be added here later
// without any RBAC rewrite — every consumer (POST/PUT /api/roles, the
// frontend's own STRUCTURAL_TEMPLATE_TO_DISPLAY) reads this one list.
const STRUCTURAL_TEMPLATE_IDS = [
  'loan_officer', 'manager', 'regional_manager', 'operational_manager', 'accountant',
  'ceo', 'director', 'investor', 'hr', 'admin',
];

// Case/whitespace-insensitive duplicate check — "Senior Collections
// Officer" and "senior   collections officer" are the same real role
// name to a human Admin, so both must collide here, not just an exact
// byte-for-byte match.
function normalizeRoleName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
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
  router.get('/api/users', requireAuth, requireModule('staff'), async (req, res) => {
    const scope = await branchIdsInScope(req.user);
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
    if (req.query.department_id) { clauses.push('department_id = ?'); params.push(req.query.department_id); }
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    if (req.query.employment_status) { clauses.push('employment_status = ?'); params.push(req.query.employment_status); }
    if (req.query.q) { clauses.push('(name LIKE ? OR email LIKE ? OR staff_code LIKE ? OR phone LIKE ?)'); const like = `%${req.query.q}%`; params.push(like, like, like, like); }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const total = (await get(`SELECT COUNT(*) as c FROM users ${where}`, params)).c;
    const rows = await all(`SELECT * FROM users ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    res.json({ users: await Promise.all(rows.map(publicUser)), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  });

  // Real reference data for the Staff Group filter (Employees > View
  // Employees) — the same small, seeded departments list users.department_id
  // already references, not a fabricated dropdown.
  router.get('/api/departments', requireAuth, requireModule('staff'), async (req, res) => {
    res.json({ departments: await all('SELECT * FROM departments ORDER BY name') });
  });

  router.get('/api/users/:id', requireAuth, requireModule('staff'), async (req, res, next) => {
    const u = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!u) return next({ status: 404, message: 'User not found' });
    res.json({ user: await publicUser(u) });
  });

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const KE_PHONE_RE = /^(?:\+?254|0)[17]\d{8}$/;
  const NATIONAL_ID_RE = /^\d{6,10}$/;
  const EMPLOYMENT_STATUSES = ['Full-time', 'Part-time', 'Contract', 'Probation'];
  const GENDERS = ['Male', 'Female', 'Other', 'Prefer not to say'];

  // Admin > User Management > Create User. Builds the same real employee
  // record every other staff-facing screen already reads (DB.staff),
  // through the exact same POST /api/users this app's "Add New Staff"
  // form on the Admin dashboard already calls — extended, not duplicated.
  router.post('/api/users', requireAuth, requirePermission('manage_users'), async (req, res, next) => {
    const b = req.body;
    if (!b.name || !b.email || !b.role_id) return next({ status: 400, message: 'name, email and role_id are required' });
    if (!canActOnStaffRecord(req.user, b.role_id)) {
      return next({ status: 403, message: `Your role cannot create a ${b.role_id} account — that stays with the System Administrator` });
    }
    if (!EMAIL_RE.test(String(b.email))) return next({ status: 400, message: 'Invalid email address' });
    if (b.phone && !KE_PHONE_RE.test(String(b.phone))) {
      return next({ status: 400, message: 'Invalid phone number — use a real Kenyan number, e.g. 07XXXXXXXX or 2547XXXXXXXX' });
    }
    if (b.national_id && !NATIONAL_ID_RE.test(String(b.national_id))) {
      return next({ status: 400, message: 'Invalid ID number — expected 6 to 10 digits' });
    }
    if (b.gender && !GENDERS.includes(b.gender)) return next({ status: 400, message: `gender must be one of: ${GENDERS.join(', ')}` });
    if (b.employment_status && !EMPLOYMENT_STATUSES.includes(b.employment_status)) {
      return next({ status: 400, message: `employment_status must be one of: ${EMPLOYMENT_STATUSES.join(', ')}` });
    }

    const role = await get('SELECT * FROM roles WHERE id = ?', [b.role_id]);
    if (!role) return next({ status: 400, message: 'Unknown role_id' });

    // Access Level stays a real, existing value — never a second,
    // free-form access-level system (same rule POST /api/roles already
    // enforces for a role's own default). Omitted entirely, it falls
    // back to the selected role's real default, exactly as before.
    let accessLevel = role.default_access_level;
    if (b.access_level) {
      const knownLevels = (await all('SELECT DISTINCT default_access_level FROM roles')).map(r => r.default_access_level);
      if (!knownLevels.includes(b.access_level)) return next({ status: 400, message: 'Unknown Access Level — choose one of the existing access levels' });
      accessLevel = b.access_level;
    }

    let departmentId = null;
    if (b.department_id) {
      const dept = await get('SELECT id FROM departments WHERE id = ?', [b.department_id]);
      if (!dept) return next({ status: 400, message: 'Unknown department_id' });
      departmentId = dept.id;
    }

    // Region is derived from the branch whenever a branch is given (the
    // real Region -> Branch hierarchy — see branches.region_id) rather
    // than trusted as an independently-submitted value that could
    // disagree with it; a region-only assignment (e.g. a Regional
    // Manager with no single branch) is still honored on its own.
    let branchId = null, regionId = null;
    if (b.branch_id) {
      const branch = await get('SELECT * FROM branches WHERE id = ?', [b.branch_id]);
      if (!branch) return next({ status: 400, message: 'Unknown branch_id' });
      branchId = branch.id;
      regionId = branch.region_id;
    } else if (b.region_id) {
      const region = await get('SELECT id FROM regions WHERE id = ?', [b.region_id]);
      if (!region) return next({ status: 400, message: 'Unknown region_id' });
      regionId = region.id;
    }

    let reportingManagerId = null;
    if (b.reporting_manager_id) {
      const manager = await get('SELECT id, status FROM users WHERE id = ?', [b.reporting_manager_id]);
      if (!manager) return next({ status: 400, message: 'Unknown reporting_manager_id' });
      if (manager.status !== 'Active') return next({ status: 400, message: 'The selected reporting manager is not an active account' });
      reportingManagerId = manager.id;
    }

    const normalizedEmail = String(b.email).toLowerCase();
    const existingEmail = await get('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    if (existingEmail) return next({ status: 409, message: 'A user with that email already exists' });
    const staffCode = b.staff_code || (await nextStaffCode());
    const existingStaffCode = await get('SELECT id FROM users WHERE staff_code = ?', [staffCode]);
    if (existingStaffCode) return next({ status: 409, message: `Staff/job number "${staffCode}" is already in use` });
    if (b.national_id) {
      const existingNationalId = await get('SELECT id FROM users WHERE national_id = ?', [b.national_id]);
      if (existingNationalId) return next({ status: 409, message: 'A user with that ID number already exists' });
    }
    if (b.phone) {
      const existingPhone = await get('SELECT id FROM users WHERE phone = ?', [b.phone]);
      if (existingPhone) return next({ status: 409, message: 'A user with that phone number already exists' });
    }

    const id = 'usr_' + crypto.randomUUID();
    const tempPassword = generateTempPassword();
    const { hash, salt } = hashPassword(tempPassword);
    // A real concrete value, resolved once here — created_at is NOT NULL
    // DEFAULT iso_now(), but that default only applies when the column is
    // omitted from the INSERT entirely; passing an explicit NULL (which an
    // absent entry_date would otherwise do) would violate it.
    const entryDate = b.entry_date || (await get('SELECT iso_now() as now')).now;
    let created;
    await transaction(async () => {
      await run(
        `INSERT INTO users (id, staff_code, name, email, phone, password_hash, password_salt, must_change_password,
          role_id, access_level, job_title, department_id, branch_id, region_id, reporting_manager_id,
          employment_status, status, monthly_disbursement_target, monthly_new_loan_target, leave_days_balance,
          national_id, gender, date_of_birth, basic_salary, created_at)
         VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id, staffCode, b.name, normalizedEmail, b.phone || null, hash, salt,
          b.role_id, accessLevel, b.job_title || role.name, departmentId,
          branchId, regionId, reportingManagerId,
          b.employment_status || 'Full-time', 'Active', b.monthly_disbursement_target || 0, b.monthly_new_loan_target || 0,
          b.leave_days_balance != null ? b.leave_days_balance : 10,
          b.national_id || null, b.gender || null, b.date_of_birth || null, b.basic_salary || 0,
          entryDate,
        ]
      );
      created = await get('SELECT * FROM users WHERE id = ?', [id]);
      await notify(id, 'account_created', 'Welcome to Rhinocash', 'Your Rhinocash account has been created. Sign in with the temporary password you were given — you will be asked to set a new one immediately.');
      await logAction(req, {
        action: 'Created user', module: 'users', recordType: 'User', recordId: id,
        newValue: { name: b.name, email: normalizedEmail, role: b.role_id, accessLevel, branchId, regionId, departmentId, staffCode },
      });
    });

    // Real delivery attempts, made only after the account itself is safely
    // committed — never inside the DB transaction above (an external call
    // has no business holding a DB connection/lock open, and can't be
    // "rolled back" if it fails). Both integrations already exist and
    // already report NOT_CONFIGURED honestly rather than pretending to
    // have sent anything (see src/integrations/email.js, sms.js) — this is
    // the first real caller for email's existing account_invitation
    // template, and SMS reuses its existing password_reset template,
    // whose wording ("your temporary password is X, you'll be asked to
    // change it on login") is equally true of a brand-new account.
    // The account itself is already safely committed above — a real
    // delivery-side failure (or an adapter that's genuinely not
    // implemented yet for a partially-configured provider) must never
    // surface as an account-creation failure to the Admin who just
    // successfully created it.
    let emailResult = { status: 'FAILED' }, smsResult = null;
    try { emailResult = await email.send('account_invitation', normalizedEmail, { name: b.name, email: normalizedEmail, tempPassword }); }
    catch (e) { console.error('[account_invitation email failed]', e.message); }
    if (b.phone) {
      smsResult = { status: 'FAILED' };
      try { smsResult = await sms.send('password_reset', b.phone, { tempPassword }); }
      catch (e) { console.error('[account invitation SMS failed]', e.message); }
    }

    res.status(201).json({
      user: await publicUser(created), tempPassword,
      notifications: { email: emailResult.status, sms: smsResult ? smsResult.status : 'NOT_ATTEMPTED_NO_PHONE' },
    });
  });

  router.patch('/api/users/:id', requireAuth, requirePermission('manage_users'), async (req, res, next) => {
    const before = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
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
      'region_id', 'reporting_manager_id', 'employment_status', 'monthly_disbursement_target', 'monthly_new_loan_target',
      'basic_salary', 'national_id', 'gender'];
    const sets = []; const params = [];
    fields.forEach(f => { if (b[f] !== undefined) { sets.push(`${f} = ?`); params.push(b[f]); } });
    if (sets.length === 0) return next({ status: 400, message: 'No recognized fields to update' });
    params.push(req.params.id);
    await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
    const after = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    await logAction(req, {
      action: 'Updated user access', module: 'users', recordType: 'User', recordId: req.params.id,
      previousValue: pick(before, fields), newValue: pick(after, fields), reason: b.reason,
    });
    res.json({ user: await publicUser(after) });
  });

  router.post('/api/users/:id/status', requireAuth, requirePermission('manage_users'), async (req, res, next) => {
    const { status, reason } = req.body;
    if (!['Active', 'Suspended', 'Deactivated'].includes(status)) return next({ status: 400, message: 'status must be Active, Suspended or Deactivated' });
    const before = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
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
    await run('UPDATE users SET status = ? WHERE id = ?', [status, req.params.id]);
    if (status !== 'Active') await run("UPDATE sessions SET revoked_at = iso_now() WHERE user_id = ? AND revoked_at IS NULL", [req.params.id]);
    await logAction(req, { action: `Set status to ${status}`, module: 'users', recordType: 'User', recordId: req.params.id, previousValue: before.status, newValue: status, reason });
    res.json({ ok: true, status });
  });

  // ---- Everything below here is Admin-exclusive (instruction #5: "Admin
  // remains the ultimate system access authority"). CEO/Director can assign
  // a role/access-level/branch/region via PATCH above, but the finer-grained
  // module checklist, personal permission overrides, full access reset,
  // password reset, and session revocation are deliberately kept out of
  // their reach even though they hold 'manage_users'. ----

  // Module access — the personal override list. Empty/absent = use role default.
  router.put('/api/users/:id/module-access', requireAuth, requirePermission('manage_users'), requireAdminOnly('set a user\'s module access'), async (req, res, next) => {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return next({ status: 404, message: 'User not found' });
    const modules = Array.isArray(req.body.modules) ? req.body.modules : [];
    const before = await effectiveModules(user);
    await run('DELETE FROM user_module_access WHERE user_id = ?', [user.id]);
    for (const m of modules) {
      await run('INSERT INTO user_module_access (user_id, module_id) VALUES (?,?) ON CONFLICT DO NOTHING', [user.id, m]);
    }
    const after = await effectiveModules(user);
    await logAction(req, { action: 'Set module access', module: 'users', recordType: 'User', recordId: user.id, previousValue: before, newValue: after, reason: req.body.reason });
    res.json({ ok: true, modules: after });
  });

  router.put('/api/users/:id/permissions/:permissionId', requireAuth, requirePermission('manage_users'), requireAdminOnly('set a user\'s permission overrides'), async (req, res, next) => {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return next({ status: 404, message: 'User not found' });
    const { allowed, reason } = req.body;
    await run(
      `INSERT INTO user_permission_overrides (user_id, permission_id, allowed) VALUES (?,?,?)
       ON CONFLICT(user_id, permission_id) DO UPDATE SET allowed = excluded.allowed`,
      [user.id, req.params.permissionId, allowed ? 1 : 0]
    );
    await logAction(req, { action: 'Set permission override', module: 'users', recordType: 'User', recordId: user.id, newValue: { [req.params.permissionId]: !!allowed }, reason });
    res.json({ ok: true });
  });

  router.delete('/api/users/:id/permissions/:permissionId', requireAuth, requirePermission('manage_users'), requireAdminOnly('clear a user\'s permission overrides'), async (req, res) => {
    await run('DELETE FROM user_permission_overrides WHERE user_id = ? AND permission_id = ?', [req.params.id, req.params.permissionId]);
    await logAction(req, { action: 'Cleared permission override', module: 'users', recordType: 'User', recordId: req.params.id, newValue: req.params.permissionId });
    res.json({ ok: true });
  });

  router.post('/api/users/:id/reset-access', requireAuth, requirePermission('manage_users'), requireAdminOnly('reset a user\'s access'), async (req, res, next) => {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return next({ status: 404, message: 'User not found' });
    await run('DELETE FROM user_module_access WHERE user_id = ?', [user.id]);
    await run('DELETE FROM user_permission_overrides WHERE user_id = ?', [user.id]);
    const role = await get('SELECT * FROM roles WHERE id = ?', [user.role_id]);
    await run('UPDATE users SET access_level = ? WHERE id = ?', [role.default_access_level, user.id]);
    await logAction(req, { action: 'Reset access to role defaults', module: 'users', recordType: 'User', recordId: user.id });
    res.json({ ok: true });
  });

  router.get('/api/users/:id/final-access', requireAuth, requireModule('staff'), async (req, res, next) => {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return next({ status: 404, message: 'User not found' });
    res.json({ finalAccess: await computeFinalAccess(user) });
  });

  router.get('/api/users/:id/activity', requireAuth, requireModule('audit'), async (req, res) => {
    const rows = await all('SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.params.id]);
    res.json({ activity: rows });
  });

  router.get('/api/users/:id/login-history', requireAuth, requireModule('audit'), async (req, res) => {
    const u = await get('SELECT email FROM users WHERE id = ?', [req.params.id]);
    const rows = u ? await all('SELECT * FROM login_attempts WHERE email = ? ORDER BY created_at DESC LIMIT 50', [u.email]) : [];
    res.json({ loginHistory: rows });
  });

  // Admin > Roles & Access Control > Create Role. A real, persisted role
  // DEFINITION: a real row in `roles` (structural_template/
  // dashboard_template included — see db.js), a real role_permissions
  // matrix, is_system=0. Selecting a structural_template/dashboard_template
  // (default 'loan_officer' for every custom role, per spec) ONLY picks
  // which existing real sidebar tree/dashboard layout this role reuses —
  // it never seeds role_permissions or role_modules; a newly created role
  // starts with zero business permissions and zero module access
  // regardless of which template it uses, exactly like the explicit
  // `permissions` list below (nothing requested = nothing granted). Admin
  // must separately use Role Permissions to grant real access afterward.
  router.post('/api/roles', requireAuth, requirePermission('manage_users'), requireAdminOnly('create a new role'), async (req, res, next) => {
    const b = req.body;
    const name = String(b.name || '').trim();
    if (name.length < 3 || name.length > 60) return next({ status: 400, message: 'Role Name must be between 3 and 60 characters' });

    const code = String(b.code || '').trim().toLowerCase();
    if (!code) return next({ status: 400, message: 'Role Code is required' });
    if (!/^[a-z][a-z0-9_]{2,49}$/.test(code)) {
      return next({ status: 400, message: 'Role Code must start with a letter and contain only lowercase letters, numbers and underscores (3–50 characters total)' });
    }

    const accessLevel = String(b.access_level || '').trim();
    if (!accessLevel) return next({ status: 400, message: 'Access Level is required' });
    const knownLevels = (await all('SELECT DISTINCT default_access_level FROM roles')).map(r => r.default_access_level);
    if (!knownLevels.includes(accessLevel)) {
      return next({ status: 400, message: 'Unknown Access Level — choose one of the existing access levels' });
    }

    const status = b.status || 'Active';
    if (!['Active', 'Inactive'].includes(status)) return next({ status: 400, message: 'Status must be Active or Inactive' });

    const structuralTemplate = b.structural_template || 'loan_officer';
    if (!STRUCTURAL_TEMPLATE_IDS.includes(structuralTemplate)) {
      return next({ status: 400, message: `structural_template must be one of: ${STRUCTURAL_TEMPLATE_IDS.join(', ')}` });
    }
    const dashboardTemplate = b.dashboard_template || 'loan_officer';
    if (!STRUCTURAL_TEMPLATE_IDS.includes(dashboardTemplate)) {
      return next({ status: 400, message: `dashboard_template must be one of: ${STRUCTURAL_TEMPLATE_IDS.join(', ')}` });
    }

    const description = b.description != null ? String(b.description).trim().slice(0, 500) : '';
    if (!description) return next({ status: 400, message: 'Description is required' });
    if (description.length > 500) return next({ status: 400, message: 'Description must be 500 characters or fewer' });

    const requestedPermissionIds = Array.isArray(b.permissions) ? [...new Set(b.permissions)] : [];
    const allPermissions = await all('SELECT id FROM permissions');
    const validPermissionIds = new Set(allPermissions.map(p => p.id));
    const invalidPermissionIds = requestedPermissionIds.filter(p => !validPermissionIds.has(p));
    if (invalidPermissionIds.length) {
      return next({ status: 400, message: `Unknown permission id(s): ${invalidPermissionIds.join(', ')}` });
    }

    const existingById = await get('SELECT id FROM roles WHERE id = ?', [code]);
    if (existingById) return next({ status: 409, message: `A role with code "${code}" already exists` });
    const existingByName = await get('SELECT id FROM roles WHERE name = ?', [name]);
    if (existingByName) return next({ status: 409, message: `A role named "${name}" already exists` });
    const normalizedName = normalizeRoleName(name);
    const allRoleNames = await all('SELECT name FROM roles');
    if (allRoleNames.some(r => normalizeRoleName(r.name) === normalizedName)) {
      return next({ status: 409, message: `A role named "${name}" already exists` });
    }

    let created;
    await transaction(async () => {
      await run(
        `INSERT INTO roles (id, name, default_access_level, description, status, is_system, structural_template, dashboard_template, created_at)
         VALUES (?,?,?,?,?,0,?,?,iso_now())`,
        [code, name, accessLevel, description, status, structuralTemplate, dashboardTemplate]
      );
      for (const p of allPermissions) {
        await run('INSERT INTO role_permissions (role_id, permission_id, allowed) VALUES (?,?,?)', [code, p.id, requestedPermissionIds.includes(p.id) ? 1 : 0]);
      }
      await logAction(req, {
        action: 'Created role', module: 'roles', recordType: 'Role', recordId: code,
        newValue: {
          name, code, accessLevel, status, description,
          roleType: 'Custom', structuralTemplate, dashboardTemplate,
          permissions: requestedPermissionIds,
        },
      });
      created = await get('SELECT * FROM roles WHERE id = ?', [code]);
    });

    res.status(201).json({ role: created });
  });

  // Edit an existing role's own metadata — never its permissions/modules
  // (those stay Role Permissions' job, via the endpoints below/above).
  // Changing structural_template/dashboard_template only changes which
  // real sidebar tree/dashboard layout the role reuses; it never touches
  // role_permissions or role_modules, so a role's actually-assigned
  // access is preserved exactly across a template change, per spec.
  router.put('/api/roles/:id', requireAuth, requirePermission('manage_users'), requireAdminOnly('edit a role'), async (req, res, next) => {
    const before = await get('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (!before) return next({ status: 404, message: 'Role not found' });
    const b = req.body;

    const name = b.name !== undefined ? String(b.name).trim() : before.name;
    if (name.length < 3 || name.length > 60) return next({ status: 400, message: 'Role Name must be between 3 and 60 characters' });

    const accessLevel = b.access_level !== undefined ? String(b.access_level).trim() : before.default_access_level;
    if (!accessLevel) return next({ status: 400, message: 'Access Level is required' });
    const knownLevels = (await all('SELECT DISTINCT default_access_level FROM roles')).map(r => r.default_access_level);
    if (!knownLevels.includes(accessLevel)) {
      return next({ status: 400, message: 'Unknown Access Level — choose one of the existing access levels' });
    }

    const status = b.status !== undefined ? b.status : before.status;
    if (!['Active', 'Inactive'].includes(status)) return next({ status: 400, message: 'Status must be Active or Inactive' });

    const structuralTemplate = b.structural_template !== undefined ? b.structural_template : before.structural_template;
    if (!STRUCTURAL_TEMPLATE_IDS.includes(structuralTemplate)) {
      return next({ status: 400, message: `structural_template must be one of: ${STRUCTURAL_TEMPLATE_IDS.join(', ')}` });
    }
    const dashboardTemplate = b.dashboard_template !== undefined ? b.dashboard_template : before.dashboard_template;
    if (!STRUCTURAL_TEMPLATE_IDS.includes(dashboardTemplate)) {
      return next({ status: 400, message: `dashboard_template must be one of: ${STRUCTURAL_TEMPLATE_IDS.join(', ')}` });
    }

    let description = before.description;
    if (b.description !== undefined) {
      description = String(b.description || '').trim().slice(0, 500);
      if (!description) return next({ status: 400, message: 'Description is required' });
    }

    if (name !== before.name) {
      const normalizedName = normalizeRoleName(name);
      const others = await all('SELECT id, name FROM roles WHERE id != ?', [before.id]);
      if (others.some(r => normalizeRoleName(r.name) === normalizedName)) {
        return next({ status: 409, message: `A role named "${name}" already exists` });
      }
    }

    await run(
      `UPDATE roles SET name = ?, default_access_level = ?, description = ?, status = ?, structural_template = ?, dashboard_template = ? WHERE id = ?`,
      [name, accessLevel, description, status, structuralTemplate, dashboardTemplate, before.id]
    );
    const after = await get('SELECT * FROM roles WHERE id = ?', [before.id]);
    await logAction(req, {
      action: 'Updated role', module: 'roles', recordType: 'Role', recordId: before.id,
      previousValue: { name: before.name, accessLevel: before.default_access_level, description: before.description, status: before.status, structuralTemplate: before.structural_template, dashboardTemplate: before.dashboard_template },
      newValue: { name, accessLevel, description, status, structuralTemplate, dashboardTemplate },
    });
    res.json({ role: after });
  });

  router.get('/api/roles', requireAuth, async (req, res) => {
    const roles = await all('SELECT * FROM roles ORDER BY name');
    if (!req.query.with_counts) return res.json({ roles });
    // Real, server-computed counts for the Admin > Roles page — never
    // hard-coded, and never derived from a client-side array that could be
    // truncated by a list endpoint's own page-size cap. permissionsTotal is
    // the same denominator for every role (the one real permissions table),
    // so it's returned once rather than duplicated onto every row.
    const permissionsTotal = (await get('SELECT COUNT(*) as c FROM permissions')).c;
    const modulesTotal = (await get('SELECT COUNT(*) as c FROM modules')).c;
    const withCounts = await Promise.all(roles.map(async (role) => {
      const userCount = (await get('SELECT COUNT(*) as c FROM users WHERE role_id = ?', [role.id])).c;
      const activeUserCount = (await get('SELECT COUNT(*) as c FROM users WHERE role_id = ? AND status = ?', [role.id, 'Active'])).c;
      const permissionCount = (await get('SELECT COUNT(*) as c FROM role_permissions WHERE role_id = ? AND allowed = 1', [role.id])).c;
      const moduleCount = (await get('SELECT COUNT(*) as c FROM role_modules WHERE role_id = ?', [role.id])).c;
      const lastAudit = await get(
        `SELECT created_at FROM audit_logs WHERE record_type = 'Role' AND record_id = ? ORDER BY created_at DESC LIMIT 1`,
        [role.id]
      );
      return { ...role, userCount, activeUserCount, permissionCount, moduleCount, lastModifiedAt: lastAudit ? lastAudit.created_at : null };
    }));
    res.json({ roles: withCounts, permissionsTotal, modulesTotal });
  });
  router.get('/api/modules', requireAuth, async (req, res) => {
    res.json({ modules: await all('SELECT * FROM modules') });
  });
  router.get('/api/permissions', requireAuth, async (req, res) => {
    res.json({ permissions: await all('SELECT * FROM permissions') });
  });
  // Admin > Roles & Access Control > Roles — a role's real granted module
  // list (role_modules), the exact same real data requireModule()/
  // hasModuleAccess() enforce server-side on every gated endpoint — mirrors
  // GET /api/roles/:id/permissions exactly, just for the separate,
  // coarser-grained Module access layer (not the same thing as an action
  // permission).
  router.get('/api/roles/:id/modules', requireAuth, async (req, res, next) => {
    const role = await get('SELECT id FROM roles WHERE id = ?', [req.params.id]);
    if (!role) return next({ status: 404, message: 'Role not found' });
    const rows = await all('SELECT module_id FROM role_modules WHERE role_id = ?', [req.params.id]);
    res.json({ moduleIds: rows.map(r => r.module_id) });
  });
  router.get('/api/roles/:id/permissions', requireAuth, async (req, res, next) => {
    const role = await get('SELECT id FROM roles WHERE id = ?', [req.params.id]);
    if (!role) return next({ status: 404, message: 'Role not found' });
    res.json({ permissions: await all('SELECT permission_id, allowed FROM role_permissions WHERE role_id = ?', [req.params.id]) });
  });
  router.put('/api/roles/:id/permissions/:permissionId', requireAuth, requirePermission('manage_users'), requireAdminOnly('edit the role permission matrix'), async (req, res, next) => {
    const role = await get('SELECT id FROM roles WHERE id = ?', [req.params.id]);
    if (!role) return next({ status: 404, message: 'Role not found' });
    const permission = await get('SELECT id FROM permissions WHERE id = ?', [req.params.permissionId]);
    if (!permission) return next({ status: 400, message: 'Unknown permission id' });
    // The Admin role's own manage_users permission is what every one of
    // these role-permission-editing endpoints (this one included) is
    // gated by — revoking it would permanently strand every Admin
    // account with no way to ever restore it through the real API.
    if (role.id === 'admin' && permission.id === 'manage_users' && !req.body.allowed) {
      return next({ status: 400, message: 'manage_users cannot be revoked from the Admin role — doing so would permanently lock every Admin account out of managing roles and permissions' });
    }
    await run(
      `INSERT INTO role_permissions (role_id, permission_id, allowed) VALUES (?,?,?)
       ON CONFLICT(role_id, permission_id) DO UPDATE SET allowed = excluded.allowed`,
      [req.params.id, req.params.permissionId, req.body.allowed ? 1 : 0]
    );
    await logAction(req, { action: 'Changed role permission matrix', module: 'roles', recordType: 'Role', recordId: req.params.id, newValue: { [req.params.permissionId]: !!req.body.allowed } });
    res.json({ ok: true });
  });
  // Admin > Roles & Access Control > Role Permissions — bulk save. The
  // page loads the role's current matrix via the GET above, lets the
  // Admin change any number of checkboxes locally, then sends the whole
  // desired set here in one request: this computes the real added/
  // removed diff server-side (never trusting a frontend-computed diff),
  // validates every id against the real permissions table, and applies
  // the whole set atomically with one audit record — never one silent
  // partial write per checkbox, and never a duplicate role_permissions
  // row (the same ON CONFLICT upsert as the single-permission PUT above).
  router.put('/api/roles/:id/permissions', requireAuth, requirePermission('manage_users'), requireAdminOnly('edit a role\'s permission matrix'), async (req, res, next) => {
    const role = await get('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (!role) return next({ status: 404, message: 'Role not found' });

    const requested = Array.isArray(req.body.permissions) ? [...new Set(req.body.permissions)] : null;
    if (!requested) return next({ status: 400, message: 'permissions must be an array of permission ids' });

    const allPermissions = await all('SELECT id FROM permissions');
    const validIds = new Set(allPermissions.map(p => p.id));
    const invalidIds = requested.filter(p => !validIds.has(p));
    if (invalidIds.length) return next({ status: 400, message: `Unknown permission id(s): ${invalidIds.join(', ')}` });

    if (role.id === 'admin' && !requested.includes('manage_users')) {
      return next({ status: 400, message: 'manage_users cannot be revoked from the Admin role — doing so would permanently lock every Admin account out of managing roles and permissions' });
    }

    const before = await all('SELECT permission_id, allowed FROM role_permissions WHERE role_id = ?', [role.id]);
    const beforeAllowed = new Set(before.filter(p => p.allowed).map(p => p.permission_id));
    const added = requested.filter(p => !beforeAllowed.has(p)).sort();
    const removed = [...beforeAllowed].filter(p => !requested.includes(p)).sort();

    await transaction(async () => {
      for (const p of allPermissions) {
        await run(
          `INSERT INTO role_permissions (role_id, permission_id, allowed) VALUES (?,?,?)
           ON CONFLICT(role_id, permission_id) DO UPDATE SET allowed = excluded.allowed`,
          [role.id, p.id, requested.includes(p.id) ? 1 : 0]
        );
      }
      if (added.length || removed.length) {
        await logAction(req, {
          action: 'Changed role permission matrix', module: 'roles', recordType: 'Role', recordId: role.id,
          previousValue: [...beforeAllowed].sort(), newValue: requested.slice().sort(),
          reason: req.body.reason,
        });
      }
    });

    const after = await all('SELECT permission_id, allowed FROM role_permissions WHERE role_id = ?', [role.id]);
    res.json({ ok: true, permissions: after, added, removed });
  });

  // Admin > Roles & Access Control > Role Permissions — bulk-set a role's
  // real granted MODULE list (role_modules), the same coarser-grained,
  // section-level access layer requireModule()/hasModuleAccess() already
  // enforce server-side on every gated endpoint and effectiveModules()
  // computes (see rbac.js) — mirrors the permissions bulk PUT above
  // exactly, just for role_modules (no `allowed` column there: a grant is
  // row-presence, so this recomputes the whole set under one transaction
  // rather than toggling one flag per id). This is the one real write
  // path role_modules has ever had outside initial seeding — previously
  // only readable (GET /api/roles/:id/modules), never settable through
  // any API, which is exactly why no custom role could ever get a
  // working module/sidebar access before this endpoint existed.
  router.put('/api/roles/:id/modules', requireAuth, requirePermission('manage_users'), requireAdminOnly('edit a role\'s module access'), async (req, res, next) => {
    const role = await get('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (!role) return next({ status: 404, message: 'Role not found' });

    const requested = Array.isArray(req.body.moduleIds) ? [...new Set(req.body.moduleIds)] : null;
    if (!requested) return next({ status: 400, message: 'moduleIds must be an array of module ids' });

    const allModules = await all('SELECT id FROM modules');
    const validIds = new Set(allModules.map(m => m.id));
    const invalidIds = requested.filter(m => !validIds.has(m));
    if (invalidIds.length) return next({ status: 400, message: `Unknown module id(s): ${invalidIds.join(', ')}` });

    const before = await all('SELECT module_id FROM role_modules WHERE role_id = ?', [role.id]);
    const beforeSet = new Set(before.map(m => m.module_id));
    const added = requested.filter(m => !beforeSet.has(m)).sort();
    const removed = [...beforeSet].filter(m => !requested.includes(m)).sort();

    await transaction(async () => {
      await run('DELETE FROM role_modules WHERE role_id = ?', [role.id]);
      for (const m of requested) {
        await run('INSERT INTO role_modules (role_id, module_id) VALUES (?,?)', [role.id, m]);
      }
      if (added.length || removed.length) {
        await logAction(req, {
          action: 'Changed role module access', module: 'roles', recordType: 'Role', recordId: role.id,
          previousValue: [...beforeSet].sort(), newValue: requested.slice().sort(),
          reason: req.body.reason,
        });
      }
    });

    res.json({ ok: true, moduleIds: requested.slice().sort(), added, removed });
  });
}

function pick(obj, keys) { const o = {}; keys.forEach(k => { o[k] = obj[k]; }); return o; }

module.exports = { register, nextStaffCode };
