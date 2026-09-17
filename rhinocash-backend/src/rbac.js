// rbac.js — the access model, enforced server-side on every request.
// Mirrors the spec's composition exactly:
//   SYSTEM ROLE + ACCESS LEVEL + BRANCH/REGION SCOPE + MODULE PERMISSIONS
//   + ACTION PERMISSIONS = FINAL USER ACCESS
'use strict';
const { all, get } = require('./db');

// Baseline module access per role. This is DATA (role_modules table), not a
// hardcoded switch — seed.js populates it, and it can be edited at runtime
// through the Admin API without a code change.
function roleModules(roleId) {
  return all('SELECT module_id FROM role_modules WHERE role_id = ?', [roleId]).map(r => r.module_id);
}
function rolePermissions(roleId) {
  const rows = all('SELECT permission_id, allowed FROM role_permissions WHERE role_id = ?', [roleId]);
  const map = {};
  rows.forEach(r => { map[r.permission_id] = !!r.allowed; });
  return map;
}

// A user's effective module list = personal override (if any restricts it)
// intersected with role baseline; otherwise just the role baseline.
function effectiveModules(user) {
  const base = roleModules(user.role_id);
  const overrideRows = all('SELECT module_id FROM user_module_access WHERE user_id = ?', [user.id]);
  if (overrideRows.length === 0) return base;
  const overrideSet = new Set(overrideRows.map(r => r.module_id));
  return base.filter(m => overrideSet.has(m));
}

function hasModuleAccess(user, moduleId) {
  return effectiveModules(user).includes(moduleId);
}

// Effective action permission = personal override wins, else role default.
function hasPermission(user, permissionId) {
  const override = get(
    'SELECT allowed FROM user_permission_overrides WHERE user_id = ? AND permission_id = ?',
    [user.id, permissionId]
  );
  if (override) return !!override.allowed;
  const roleDefault = get(
    'SELECT allowed FROM role_permissions WHERE role_id = ? AND permission_id = ?',
    [user.role_id, permissionId]
  );
  return roleDefault ? !!roleDefault.allowed : false;
}

// ---- Branch/region data scoping ----------------------------------------
// Returns a { clause, params } SQL fragment restricting a query (aliased
// table must expose branch_id) to what this user is allowed to see.
// Admin/CEO/Director/Accountant/Investor are treated as company-wide for
// *reading* (their dashboards are explicitly company-wide per spec); write
// actions are still separately gated by module+action permissions above.
function branchScopeSQL(user, branchColumn = 'branch_id') {
  const roleId = user.role_id;
  if (['admin', 'ceo', 'director', 'accountant', 'investor'].includes(roleId)) {
    return { clause: '1=1', params: [] };
  }
  if (roleId === 'regional_manager') {
    const branchIds = all('SELECT id FROM branches WHERE region_id = ?', [user.region_id]).map(b => b.id);
    if (branchIds.length === 0) return { clause: '1=0', params: [] };
    return { clause: `${branchColumn} IN (${branchIds.map(() => '?').join(',')})`, params: branchIds };
  }
  if (roleId === 'operational_manager') {
    return { clause: '1=1', params: [] }; // operates across branches by design
  }
  // Manager / Loan Officer: own branch only.
  return { clause: `${branchColumn} = ?`, params: [user.branch_id] };
}

// The same policy as branchScopeSQL, but as an in-memory list — used for
// per-object checks (GET /:id, approvals) where we already have the row and
// just need a yes/no, not another query. Returns null to mean "all branches".
function branchIdsInScope(user) {
  const roleId = user.role_id;
  if (['admin', 'ceo', 'director', 'accountant', 'operational_manager'].includes(roleId)) return null;
  if (roleId === 'regional_manager') {
    return all('SELECT id FROM branches WHERE region_id = ?', [user.region_id]).map(b => b.id);
  }
  return user.branch_id ? [user.branch_id] : [];
}

function isBranchAllowed(user, branchId) {
  const scope = branchIdsInScope(user);
  if (scope === null) return true; // company-wide role
  if (!branchId) return false;
  return scope.includes(branchId);
}

// The object-level counterpart to instruction #2/#3: given a record that
// carries (or resolves to) a branch_id, is this user allowed to see/act on
// it? Every GET/:id, PATCH/:id, approval and payment route below calls this
// instead of trusting that module-level access is enough.
function assertRecordInScope(user, branchId, entityLabel) {
  if (!isBranchAllowed(user, branchId)) {
    const err = new Error(`You do not have access to this ${entityLabel || 'record'} — it belongs to a branch outside your scope`);
    err.status = 403;
    throw err;
  }
}

// Instruction #3: never trust a client-supplied branch_id for a restricted
// role. Returns the branch_id that should actually be written. Unrestricted
// roles (admin/ceo/director/accountant/operational_manager) may specify any
// real branch; everyone else gets their own scope enforced regardless of
// what the request body said.
function resolveWriteBranchId(user, requestedBranchId) {
  const scope = branchIdsInScope(user);
  if (scope === null) return requestedBranchId || user.branch_id || null; // unrestricted role: trust their input (or default to their own branch)
  if (scope.length === 0) { const err = new Error('You are not assigned to a branch'); err.status = 403; throw err; }
  if (requestedBranchId && scope.includes(requestedBranchId)) return requestedBranchId;
  return scope[0]; // silently pin to their own (single-branch roles) or first-in-region branch — never the client's arbitrary value
}

function computeFinalAccess(user) {
  const role = get('SELECT * FROM roles WHERE id = ?', [user.role_id]);
  const branch = user.branch_id ? get('SELECT name FROM branches WHERE id = ?', [user.branch_id]) : null;
  const region = user.region_id ? get('SELECT name FROM regions WHERE id = ?', [user.region_id]) : null;
  return {
    role: role ? role.name : user.role_id,
    accessLevel: user.access_level,
    branch: branch ? branch.name : null,
    region: region ? region.name : null,
    modules: effectiveModules(user),
    finalLine: `${role ? role.name : user.role_id} — ${user.access_level}`,
  };
}

// ---- Instruction #6/#7: CEO/Director may manage staff, but are NOT Admin.
// Roles nobody but Admin may assign, edit, or touch the account of.
const ADMIN_ONLY_ROLES = ['admin', 'ceo', 'director'];
function canActOnStaffRecord(actor, targetRoleId) {
  if (actor.role_id === 'admin') return true;
  if (['ceo', 'director'].includes(actor.role_id)) {
    // CEO/Director can manage operational staff, never Admin/CEO/Director accounts
    // (including each other) and can never grant those roles either.
    return !ADMIN_ONLY_ROLES.includes(targetRoleId);
  }
  return false;
}

module.exports = {
  roleModules, rolePermissions, effectiveModules, hasModuleAccess, hasPermission,
  branchScopeSQL, branchIdsInScope, isBranchAllowed, assertRecordInScope, resolveWriteBranchId,
  computeFinalAccess, canActOnStaffRecord, ADMIN_ONLY_ROLES,
};
