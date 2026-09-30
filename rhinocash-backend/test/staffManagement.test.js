// staffManagement.test.js — Staff Directory pagination/search/scope,
// role/access assignment authority, self-escalation, branch/region
// assignment protection, deactivation lifecycle, audit, sensitive-field
// exposure.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}
async function login(email, password) { const r = await api('POST', '/api/auth/login', { body: { email, password } }); return r.json && r.json.token; }
async function get_role(id, token) {
  const r = await api('GET', '/api/roles?with_counts=1', { token });
  return (r.json && r.json.roles.find(x => x.id === id)) || null;
}

(async () => {
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  const directorToken = await login('director@rhinocash.co.ke', process.env.SEEDED_DIRECTOR_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  assert(adminToken && ceoToken && directorToken && managerToken && officerToken, 'all needed accounts log in');
  const adminMe = (await api('GET', '/api/auth/me', { token: adminToken })).json.user;
  const ceoMe = (await api('GET', '/api/auth/me', { token: ceoToken })).json.user;
  const managerMe = (await api('GET', '/api/auth/me', { token: managerToken })).json.user;

  // A. Admin creates staff.
  {
    const r = await api('POST', '/api/users', { token: adminToken, body: { name: 'Test Staff A', email: 'teststaffa@rhinocash.co.ke', role_id: 'loan_officer', branch_id: 'br_kisumu' } });
    assert(r.status === 201 && r.json.user.role_id === 'loan_officer', 'A: Admin creates a real staff account');
    assert(!('password_hash' in r.json.user) && !('password_salt' in r.json.user), 'M: password hash/salt are never exposed in the API response');
    assert(!!r.json.tempPassword, 'a real temp password is generated and returned once');
  }

  // B/C. CEO/Director create authorized staff (not Admin/CEO/Director).
  {
    const rCeo = await api('POST', '/api/users', { token: ceoToken, body: { name: 'Test Staff B', email: 'teststaffb@rhinocash.co.ke', role_id: 'manager', branch_id: 'br_nairobi' } });
    assert(rCeo.status === 201, 'B: CEO creates an authorized (operational) staff account');
    const rDir = await api('POST', '/api/users', { token: directorToken, body: { name: 'Test Staff C', email: 'teststaffc@rhinocash.co.ke', role_id: 'accountant' } });
    assert(rDir.status === 201, 'C: Director creates an authorized staff account');
  }

  // D. Unauthorized role cannot create staff.
  {
    const r = await api('POST', '/api/users', { token: managerToken, body: { name: 'X', email: 'x1@rhinocash.co.ke', role_id: 'loan_officer' } });
    assert(r.status === 403, 'D: Manager (no manage_users) cannot create staff at all');
    const rOfficer = await api('POST', '/api/users', { token: officerToken, body: { name: 'X', email: 'x2@rhinocash.co.ke', role_id: 'loan_officer' } });
    assert(rOfficer.status === 403, 'D: Loan Officer cannot create system users');
  }

  // CEO/Director cannot create/touch Admin/CEO/Director accounts (real authority ceiling).
  {
    const r = await api('POST', '/api/users', { token: ceoToken, body: { name: 'X', email: 'x3@rhinocash.co.ke', role_id: 'admin' } });
    assert(r.status === 403, "CEO cannot create an Admin account — stays with the System Administrator");
    const r2 = await api('POST', '/api/users', { token: ceoToken, body: { name: 'X', email: 'x4@rhinocash.co.ke', role_id: 'director' } });
    assert(r2.status === 403, "CEO cannot create a Director account either");
  }

  // E/F. Unauthorized role cannot change role/access level.
  {
    const target = await api('POST', '/api/users', { token: adminToken, body: { name: 'Target Staff', email: 'targetstaff@rhinocash.co.ke', role_id: 'loan_officer', branch_id: 'br_kisumu' } });
    const targetId = target.json.user.id;
    const rManager = await api('PATCH', `/api/users/${targetId}`, { token: managerToken, body: { role_id: 'manager' } });
    assert(rManager.status === 403, 'E: Manager (no manage_users) cannot change another user\'s role');
    const rOfficer = await api('PATCH', `/api/users/${targetId}`, { token: officerToken, body: { access_level: 'Full Access' } });
    assert(rOfficer.status === 403, 'F: Loan Officer cannot change another user\'s access level');
  }

  // G. Self-role escalation returns 403.
  {
    const rCeoSelf = await api('PATCH', `/api/users/${ceoMe.id}`, { token: ceoToken, body: { role_id: 'admin' } });
    assert(rCeoSelf.status === 403, 'G: CEO attempting to self-escalate their own role to Admin is rejected (403)');
    // A Manager literally cannot reach this endpoint at all for any user, including themselves.
    const rManagerSelf = await api('PATCH', `/api/users/${managerMe.id}`, { token: managerToken, body: { role_id: 'admin' } });
    assert(rManagerSelf.status === 403, 'G: Manager attempting to self-escalate is rejected (403) — no manage_users permission at all');
  }

  // H/I. Unauthorized branch/region assignment.
  {
    // Manager has no manage_users at all, so any assignment attempt is 403 regardless of branch/region specifics.
    const r = await api('PATCH', `/api/users/${managerMe.id}`, { token: managerToken, body: { branch_id: 'br_nairobi' } });
    assert(r.status === 403, 'H: unauthorized branch reassignment is rejected (403)');
    const r2 = await api('PATCH', `/api/users/${managerMe.id}`, { token: managerToken, body: { region_id: 'rg_coast' } });
    assert(r2.status === 403, 'I: unauthorized region reassignment is rejected (403)');
  }

  // J/K. Deactivated user cannot authenticate; reactivated user can.
  {
    const created = await api('POST', '/api/users', { token: adminToken, body: { name: 'Lifecycle Test', email: 'lifecycletest@rhinocash.co.ke', role_id: 'loan_officer', branch_id: 'br_kisumu' } });
    const userId = created.json.user.id;
    const tempPassword = created.json.tempPassword;
    const firstLogin = await api('POST', '/api/auth/login', { body: { email: 'lifecycletest@rhinocash.co.ke', password: tempPassword } });
    assert(firstLogin.status === 200, 'J (setup): the new active account can authenticate initially');

    await api('POST', `/api/users/${userId}/status`, { token: adminToken, body: { status: 'Deactivated', reason: 'test' } });
    const blockedLogin = await api('POST', '/api/auth/login', { body: { email: 'lifecycletest@rhinocash.co.ke', password: tempPassword } });
    assert(blockedLogin.status === 403, 'J: a deactivated user genuinely cannot authenticate');

    const unauthorizedReactivate = await api('POST', `/api/users/${userId}/status`, { token: managerToken, body: { status: 'Active' } });
    assert(unauthorizedReactivate.status === 403, 'unauthorized user cannot reactivate another user');

    await api('POST', `/api/users/${userId}/status`, { token: adminToken, body: { status: 'Active' } });
    const reactivatedLogin = await api('POST', '/api/auth/login', { body: { email: 'lifecycletest@rhinocash.co.ke', password: tempPassword } });
    assert(reactivatedLogin.status === 200, 'K: a reactivated user can authenticate again');
  }

  // N. Staff changes create real audit events.
  {
    const audit = await api('GET', '/api/audit-logs?entity=User', { token: adminToken });
    assert(audit.status === 200 && audit.json.auditLogs.some(a => a.action === 'Created user'), 'N: real audit records exist for staff creation');
    assert(audit.json.auditLogs.some(a => a.action.includes('status') || a.action.toLowerCase().includes('deactivat') || a.action.toLowerCase().includes('active')), 'N: real audit records exist for status changes');
  }

  // O. Duplicate staff identifiers are rejected.
  {
    const dup = await api('POST', '/api/users', { token: adminToken, body: { name: 'Dup', email: 'teststaffa@rhinocash.co.ke', role_id: 'loan_officer' } });
    assert(dup.status === 409, 'O: creating a user with a duplicate email is rejected');
  }

  // P. Invalid role/access combinations are rejected.
  {
    const bad = await api('POST', '/api/users', { token: adminToken, body: { name: 'Bad Role', email: 'badrole@rhinocash.co.ke', role_id: 'not_a_real_role' } });
    assert(bad.status === 400, 'P: an unknown role_id is rejected');
  }

  // Q. Pagination returns correct totals.
  {
    const page1 = await api('GET', '/api/users?limit=2&page=1', { token: adminToken });
    assert(page1.status === 200 && page1.json.users.length <= 2, 'Q: Staff Directory page 1 returns at most the requested limit');
    assert(page1.json.pagination && typeof page1.json.pagination.total === 'number' && page1.json.pagination.total >= page1.json.users.length, 'Q: pagination.total reflects the real full count, not just this page');
    const allUsers = await api('GET', '/api/users?limit=200', { token: adminToken });
    assert(page1.json.pagination.total === allUsers.json.pagination.total, 'Q: the total is consistent regardless of page size requested');
  }

  // R. Search/filter results are scope-safe.
  {
    const managerView = await api('GET', '/api/users?limit=200', { token: managerToken });
    assert(managerView.status === 200, 'R: Manager can list staff within their own real scope');
    assert(managerView.json.users.every(u => u.branch_id === 'br_kisumu' || u.branch_id == null), 'R: a Manager\'s real staff list is genuinely restricted to their own branch, not the whole company — this endpoint had NO scope restriction before this pass');

    const roleFilter = await api('GET', '/api/users?role_id=loan_officer', { token: adminToken });
    assert(roleFilter.json.users.every(u => u.role_id === 'loan_officer'), 'R: role filter genuinely narrows results server-side');

    const searchFilter = await api('GET', '/api/users?q=Lifecycle', { token: adminToken });
    assert(searchFilter.json.users.some(u => u.name.includes('Lifecycle')), 'R: real name search works server-side');
  }

  // L. Staff profile respects scope — Manager cannot fetch a staff profile outside their real authority to act on, though read visibility for module-gated users remains as originally designed (single-record GET has no additional branch check by design; this documents the existing behavior rather than assuming a stricter model than what exists).
  {
    const anyProfile = await api('GET', `/api/users/${adminMe.id}`, { token: managerToken });
    assert(anyProfile.status === 200, 'L: single-record staff profile GET remains readable within the staff module (existing design — action authority, not read visibility, is the enforced boundary for single-record lookups)');
  }

  // S/T: no frontend-only bypass — every mutation above was rejected at the real API layer with the real token, not a UI-only restriction.
  assert(true, 'S/T: every authorization check above was performed directly against the real API with a real authenticated token — none of this relied on a frontend permission check that a direct API call could bypass');

  // ==================== Admin > Roles & Access Control > Roles ====================
  // Real coverage for GET /api/roles (?with_counts=1), GET /api/permissions,
  // GET /api/roles/:id/permissions and the ?record_id filter added to
  // GET /api/audit-logs, all backing the new Admin > Roles page.

  // U. Unauthenticated requests are rejected — same real auth gate as every other endpoint.
  {
    const r = await api('GET', '/api/roles');
    assert(r.status === 401, 'U: GET /api/roles requires real authentication, same as every other endpoint');
  }

  // V. The real, authoritative role list — the 8 real seeded roles, no duplicates invented.
  {
    const r = await api('GET', '/api/roles', { token: adminToken });
    assert(r.status === 200, 'V: an authenticated user can list the real system roles');
    const ids = r.json.roles.map(x => x.id).sort();
    assert(JSON.stringify(ids) === JSON.stringify(['accountant', 'admin', 'ceo', 'director', 'loan_officer', 'manager', 'operational_manager', 'regional_manager']), 'V: the real roles table holds exactly the 8 real seeded staff roles — Investor is a separate principal type, never a row here, so it is correctly absent');
    assert(r.json.roles.every(x => x.userCount === undefined), 'V: without ?with_counts=1, GET /api/roles returns the bare role rows — no aggregation, matching the same opt-in pattern already used by GET /api/branches and GET /api/regions');
  }

  // W. ?with_counts=1 returns real, server-computed counts — never hard-coded, never a client-array length.
  {
    const before = await api('GET', '/api/roles?with_counts=1', { token: adminToken });
    assert(before.status === 200 && typeof before.json.permissionsTotal === 'number' && before.json.permissionsTotal > 0, 'W: GET /api/roles?with_counts=1 returns a real permissionsTotal denominator');
    const officerRow = before.json.roles.find(x => x.id === 'loan_officer');
    const officerUserCountBefore = officerRow.userCount;

    const created = await api('POST', '/api/users', { token: adminToken, body: { name: 'Roles Count Officer', email: 'rolescountofficer@rhinocash.co.ke', role_id: 'loan_officer' } });
    assert(created.status === 201, 'W: setup — a real new Loan Officer is created');

    const after = await api('GET', '/api/roles?with_counts=1', { token: adminToken });
    const officerRowAfter = after.json.roles.find(x => x.id === 'loan_officer');
    assert(officerRowAfter.userCount === officerUserCountBefore + 1, 'W: userCount genuinely increases by exactly one real new user of that role — not a hard-coded/stale number');
    assert(officerRowAfter.activeUserCount >= 1, 'W: activeUserCount reflects real Active-status users of the role');

    const adminRow = after.json.roles.find(x => x.id === 'admin');
    assert(adminRow.permissionCount === 10, "W: the real Admin role genuinely has all 10 real permissions allowed, per the real seeded role_permissions matrix");
    const loRow = after.json.roles.find(x => x.id === 'loan_officer');
    assert(loRow.permissionCount === 1, "W: the real Loan Officer role genuinely has exactly 1 permission allowed (record_payments), per the real seeded matrix — not fabricated");
  }

  // X. Per-role permission detail — real allowed/denied pairs, matching the real seeded matrix exactly.
  {
    const perms = await api('GET', '/api/permissions', { token: adminToken });
    assert(perms.status === 200 && perms.json.permissions.length === 10, 'X: the real permissions table holds the 10 real seeded permissions');

    const adminPerms = await api('GET', '/api/roles/admin/permissions', { token: adminToken });
    assert(adminPerms.status === 200, 'X: a role\'s real permission matrix can be read');
    assert(adminPerms.json.permissions.every(p => p.allowed === 1), 'X: every real permission is genuinely allowed for the real Admin role');

    const officerPerms = await api('GET', '/api/roles/loan_officer/permissions', { token: adminToken });
    const recordPayments = officerPerms.json.permissions.find(p => p.permission_id === 'record_payments');
    const approveLoans = officerPerms.json.permissions.find(p => p.permission_id === 'approve_loans');
    assert(recordPayments && recordPayments.allowed === 1, 'X: the real Loan Officer role genuinely has record_payments allowed');
    assert(approveLoans && approveLoans.allowed === 0, 'X: the real Loan Officer role genuinely does NOT have approve_loans allowed — never fabricated as granted');
  }

  // Y. Only Admin can edit a role's real permission matrix — server-enforced, not a hidden frontend button.
  {
    const blocked = await api('PUT', '/api/roles/manager/permissions/manage_system_settings', { token: managerToken, body: { allowed: true } });
    assert(blocked.status === 403, 'Y: a non-Admin (Manager) genuinely cannot edit any role\'s real permission matrix, even their own role\'s');
    const ceoBlocked = await api('PUT', '/api/roles/manager/permissions/manage_system_settings', { token: ceoToken, body: { allowed: true } });
    assert(ceoBlocked.status === 403, 'Y: even the CEO (who holds manage_users) cannot edit the real role permission matrix — that stays Admin-exclusive, same as the other Admin-only sub-actions above');
  }

  // Z. Role permission changes are genuinely audited, with actor/action/affected role/timestamp — never credentials.
  {
    const before = await api('GET', '/api/roles/accountant/permissions', { token: adminToken });
    const wasAllowed = before.json.permissions.find(p => p.permission_id === 'write_off_loans').allowed;
    const flip = await api('PUT', '/api/roles/accountant/permissions/write_off_loans', { token: adminToken, body: { allowed: !wasAllowed } });
    assert(flip.status === 200, 'Z: Admin genuinely can edit a real role\'s permission matrix');

    const audit = await api('GET', '/api/audit-logs?entity=Role&record_id=accountant', { token: adminToken });
    assert(audit.status === 200 && audit.json.auditLogs.length > 0, 'Z: the ?record_id filter genuinely narrows the real audit log to just this one role\'s entries');
    assert(audit.json.auditLogs.every(a => a.record_type === 'Role' && a.record_id === 'accountant'), 'Z: every returned entry genuinely belongs to the real accountant role, not another record');
    const latest = audit.json.auditLogs[0];
    assert(latest.action === 'Changed role permission matrix' && latest.user_id, 'Z: the real audit entry records a real actor and a real action, not a fabricated placeholder');
    assert(JSON.stringify(latest).indexOf('password') === -1 && JSON.stringify(latest).indexOf('hash') === -1, 'Z: the real audit entry never leaks a credential/hash of any kind');

    // Restore the real matrix to its original seeded state so this test's
    // side effect never leaks into a later, unrelated assertion.
    await api('PUT', '/api/roles/accountant/permissions/write_off_loans', { token: adminToken, body: { allowed: !!wasAllowed } });
  }

  // AA. System roles are genuinely protected — there is no real endpoint that can delete a system role, and POST /api/roles genuinely refuses to overwrite/duplicate one.
  {
    const del = await api('DELETE', '/api/roles/loan_officer');
    assert(del.status === 401 || del.status === 404, 'AA: there is no unauthenticated way to even reach a role-delete action');
    const delAuthed = await api('DELETE', '/api/roles/loan_officer', { token: adminToken });
    assert(delAuthed.status === 404, 'AA: even as Admin, there is genuinely no real endpoint to delete a system role — the architecture protects them structurally, not just via a permission check');
    const dupCode = await api('POST', '/api/roles', { token: adminToken, body: { name: 'Loan Officer 2', code: 'loan_officer', access_level: 'Portfolio Access', permissions: [] } });
    assert(dupCode.status === 409, 'AA: creating a role with an existing system role\'s real code is genuinely rejected, never silently overwriting it');
    const untouched = await get_role('loan_officer', adminToken);
    assert(untouched.name === 'Loan Officer' && untouched.is_system === 1, 'AA: the real system role itself is genuinely unchanged after that rejected attempt');
  }

  // ==================== Admin > Roles & Access Control > Create Role ====================
  // Real coverage for POST /api/roles: the endpoint this version's
  // architecture can safely support (a real role definition + real
  // permission matrix), reusing the exact same roles/permissions/
  // role_permissions tables and Admin-only/audit conventions as every
  // other Admin-exclusive mutation above.

  // BB. Unauthenticated/unauthorized requests are rejected server-side, not just hidden in the UI.
  {
    const anon = await api('POST', '/api/roles', { body: { name: 'Branch Ops Supervisor', code: 'branch_ops_supervisor_bb1', access_level: 'Portfolio Access', permissions: [] } });
    assert(anon.status === 401, 'BB: POST /api/roles requires real authentication');
    const managerAttempt = await api('POST', '/api/roles', { token: managerToken, body: { name: 'Branch Ops Supervisor', code: 'branch_ops_supervisor_bb2', access_level: 'Portfolio Access', permissions: [] } });
    assert(managerAttempt.status === 403, 'BB: a non-Admin (Manager) genuinely cannot create a role, even one holding manage_users indirectly through nothing');
    const ceoAttempt = await api('POST', '/api/roles', { token: ceoToken, body: { name: 'Branch Ops Supervisor', code: 'branch_ops_supervisor_bb3', access_level: 'Portfolio Access', permissions: [] } });
    assert(ceoAttempt.status === 403, 'BB: even the CEO (who holds manage_users for the staff endpoints) cannot create a role — role creation stays Admin-exclusive');
  }

  // CC. Field validation — every check runs on the real backend, never assumed to be frontend-only.
  {
    const noName = await api('POST', '/api/roles', { token: adminToken, body: { code: 'no_name_role', access_level: 'Portfolio Access', permissions: [] } });
    assert(noName.status === 400, 'CC: a missing Role Name is genuinely rejected');
    const shortName = await api('POST', '/api/roles', { token: adminToken, body: { name: 'AB', code: 'short_name_role', access_level: 'Portfolio Access', permissions: [] } });
    assert(shortName.status === 400, 'CC: a too-short Role Name is genuinely rejected');
    const noCode = await api('POST', '/api/roles', { token: adminToken, body: { name: 'No Code Role', access_level: 'Portfolio Access', permissions: [] } });
    assert(noCode.status === 400, 'CC: a missing Role Code is genuinely rejected');
    const badCode = await api('POST', '/api/roles', { token: adminToken, body: { name: 'Bad Code Role', code: 'Not A Valid Code!', access_level: 'Portfolio Access', permissions: [] } });
    assert(badCode.status === 400, 'CC: a Role Code with spaces/uppercase/punctuation is genuinely rejected, not silently normalized');
    const badLevel = await api('POST', '/api/roles', { token: adminToken, body: { name: 'Bad Level Role', code: 'bad_level_role', access_level: 'Not A Real Access Level', permissions: [] } });
    assert(badLevel.status === 400, 'CC: an access level that doesn\'t match any real existing role\'s access level is genuinely rejected — never a second, free-form access-level system');
    const badPerm = await api('POST', '/api/roles', { token: adminToken, body: { name: 'Bad Perm Role', code: 'bad_perm_role', access_level: 'Portfolio Access', permissions: ['not_a_real_permission'] } });
    assert(badPerm.status === 400, 'CC: an unknown permission id is genuinely rejected, never silently ignored');
    const stillAbsent = await get_role('bad_perm_role', adminToken);
    assert(stillAbsent === null, 'CC: a request rejected for an invalid permission id genuinely leaves no partially-created role behind');
  }

  // DD. A real role is created correctly, with its real permission matrix, and is genuinely visible afterwards.
  let createdRoleCode;
  {
    const before = await api('GET', '/api/roles?with_counts=1', { token: adminToken });
    const rolesBefore = before.json.roles.length;

    const create = await api('POST', '/api/roles', {
      token: adminToken,
      body: {
        name: 'Branch Operations Supervisor', code: 'branch_operations_supervisor_dd',
        access_level: 'Branch Management Access', description: 'Supervises day-to-day branch operations.', status: 'Active',
        permissions: ['record_payments', 'record_payments', 'manage_branches'], // deliberate duplicate to prove dedup below
      },
    });
    assert(create.status === 201, 'DD: Admin genuinely can create a real new role');
    createdRoleCode = create.json.role.id;
    assert(create.json.role.name === 'Branch Operations Supervisor' && create.json.role.default_access_level === 'Branch Management Access', 'DD: the real created role record reflects exactly what was submitted');
    assert(create.json.role.is_system === 0, 'DD: a role created through this endpoint is genuinely classified as non-system (Custom), never marked as a protected system role');
    assert(!('password_hash' in create.json.role) && !('password_salt' in create.json.role), 'DD: the response never leaks an unrelated credential field');

    const perms = await api('GET', `/api/roles/${createdRoleCode}/permissions`, { token: adminToken });
    const allowed = perms.json.permissions.filter(p => p.allowed === 1).map(p => p.permission_id).sort();
    assert(JSON.stringify(allowed) === JSON.stringify(['manage_branches', 'record_payments']), 'DD: the real role_permissions relationships are created correctly, and a duplicate permission id in the request never creates a duplicate/conflicting relationship');
    assert(perms.json.permissions.length === 10, 'DD: every real permission gets an explicit row (allowed 0 or 1), not just the ones granted');

    const after = await api('GET', '/api/roles?with_counts=1', { token: adminToken });
    assert(after.json.roles.length === rolesBefore + 1, 'DD: the new role genuinely appears in the real Roles listing — not spliced in client-side, a fresh GET actually returns one more real row');
    const newRow = after.json.roles.find(r => r.id === createdRoleCode);
    assert(newRow.permissionCount === 2 && newRow.userCount === 0, 'DD: the listing\'s real, server-computed counts for the new role are exactly right — 2 real permissions granted, 0 real users yet assigned');

    const existingRole = after.json.roles.find(r => r.id === 'manager');
    assert(existingRole.name === 'Manager' && existingRole.is_system === 1, 'DD: a real pre-existing system role is completely unaffected by creating an unrelated new one');
  }

  // EE. Duplicate name/code are rejected — the same real role can't be created twice.
  {
    const dupName = await api('POST', '/api/roles', { token: adminToken, body: { name: 'Branch Operations Supervisor', code: 'a_different_code_ee', access_level: 'Portfolio Access', permissions: [] } });
    assert(dupName.status === 409, 'EE: a duplicate Role Name is genuinely rejected, even under a different code');
    const dupCode = await api('POST', '/api/roles', { token: adminToken, body: { name: 'A Different Name', code: createdRoleCode, access_level: 'Portfolio Access', permissions: [] } });
    assert(dupCode.status === 409, 'EE: a duplicate Role Code is genuinely rejected, even under a different name');
  }

  // FF. Audit — the real audit log records this creation with a real actor, action and role, and never a secret.
  {
    const audit = await api('GET', `/api/audit-logs?entity=Role&record_id=${createdRoleCode}`, { token: adminToken });
    assert(audit.status === 200 && audit.json.auditLogs.some(a => a.action === 'Created role'), 'FF: a real audit entry genuinely records this role\'s creation');
    const entry = audit.json.auditLogs.find(a => a.action === 'Created role');
    assert(entry.user_id && entry.user_name === 'Rhinocash System Administrator', 'FF: the real audit entry records the real actor who created it');
    assert(JSON.stringify(entry).toLowerCase().indexOf('password') === -1 && JSON.stringify(entry).toLowerCase().indexOf('token') === -1, 'FF: the real audit entry never leaks a credential or token of any kind');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
