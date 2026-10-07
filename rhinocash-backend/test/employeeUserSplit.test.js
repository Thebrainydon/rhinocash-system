// employeeUserSplit.test.js — the real Employee <-> User Account split:
// an Employee may exist with no System Account at all; Admin links an
// account to an EXISTING employee rather than duplicating the person;
// HR's own new manage_employees authority never reaches role/access/
// account fields; duplicate prevention; employment-status termination
// cascades to suspend the linked account; the migration backfill gave
// every pre-existing seeded account a working user_accounts row.
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
function rand() { return Math.floor(Math.random() * 1e9); }

(async () => {
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  assert(adminToken && managerToken && officerToken, 'setup: all needed pre-existing accounts log in');

  // 0. Migration backfill — a pre-existing seeded account already has a
  // real working System Account (not just a users row), reflected
  // honestly in its own /api/auth/me.
  {
    const r = await api('GET', '/api/auth/me', { token: officerToken });
    assert(r.status === 200 && r.json.user.systemAccount === 'Active' && r.json.user.hasAccount === true,
      '0: the migration backfill gave a pre-existing seeded user a real, working System Account (systemAccount: Active)');
  }

  // Set up a real HR account to test its own new manage_employees authority.
  let hrToken;
  {
    const r = await api('POST', '/api/users', { token: adminToken, body: { name: 'Test HR Officer', email: `testhr${rand()}@rhinocash.co.ke`, role_id: 'hr' } });
    assert(r.status === 201, 'setup: Admin creates a real HR account');
    hrToken = await login(r.json.user.email, r.json.tempPassword);
    assert(!!hrToken, 'setup: the new HR account can genuinely log in');
  }

  // 1. HR creates a real Employee with NO System Account at all.
  let employeeId, employeeEmail;
  {
    employeeEmail = `newemployee${rand()}@rhinocash.co.ke`;
    const r = await api('POST', '/api/employees', { token: hrToken, body: { name: 'Brand New Employee', email: employeeEmail, role_id: 'loan_officer', branch_id: 'br_kisumu' } });
    assert(r.status === 201, '1: HR genuinely creates a real Employee record via its own new manage_employees authority');
    assert(!r.json.employee.tempPassword, '1: no temp password is ever generated for an Employee-only creation');
    assert(r.json.employee.systemAccount === 'Not Created' && r.json.employee.hasAccount === false,
      '1: the new Employee honestly shows systemAccount: "Not Created" — no System Account row exists yet');
    employeeId = r.json.employee.id;
  }

  // 2. That employee genuinely cannot log in — no account exists at all.
  {
    const tok = await login(employeeEmail, 'anything-at-all');
    assert(!tok, '2: an Employee with no System Account genuinely cannot log in, regardless of password');
  }

  // 3. Admin links a real System Account to that EXISTING employee — no
  // duplicate person is created; the real employee_id is reused.
  let tempPassword, linkedAccountEmail;
  {
    const before = await api('GET', '/api/employees', { token: adminToken, body: undefined });
    const countBefore = before.json.pagination.total;
    const r = await api('POST', '/api/users', { token: adminToken, body: { employee_id: employeeId } });
    assert(r.status === 201, '3: Admin genuinely creates a real System Account linked to the existing employee_id');
    assert(r.json.user.id === employeeId, '3: the linked account reuses the SAME real employee id — no second, duplicate person record');
    assert(r.json.user.systemAccount === 'Active' && r.json.user.hasAccount === true, '3: the employee now honestly shows a real Active System Account');
    tempPassword = r.json.tempPassword;
    linkedAccountEmail = r.json.user.login_email || employeeEmail;
    const after = await api('GET', '/api/employees', { token: adminToken });
    assert(after.json.pagination.total === countBefore, '3: the real total Employee count is genuinely unchanged — linking an account never creates a new person');
  }

  // 4. That employee can now genuinely log in with the real temp password.
  {
    const tok = await login(employeeEmail, tempPassword);
    assert(!!tok, '4: the employee can genuinely log in now that a real System Account exists');
  }

  // 5. One account per employee — linking a second account to the same
  // employee_id is genuinely rejected (instruction #11).
  {
    const r = await api('POST', '/api/users', { token: adminToken, body: { employee_id: employeeId } });
    assert(r.status === 409, '5: creating a second System Account for the same employee_id is genuinely rejected — one account per employee');
  }

  // 6. Duplicate login_email is genuinely rejected.
  let employee2Id;
  {
    const r = await api('POST', '/api/employees', { token: hrToken, body: { name: 'Second New Employee', email: `secondemp${rand()}@rhinocash.co.ke`, role_id: 'loan_officer', branch_id: 'br_kisumu' } });
    assert(r.status === 201, 'setup: a second real Employee is created');
    employee2Id = r.json.employee.id;
    const dup = await api('POST', '/api/users', { token: adminToken, body: { employee_id: employee2Id, login_email: employeeEmail } });
    assert(dup.status === 409, '6: a login_email already in use by another real System Account is genuinely rejected');
  }

  // 7. HR cannot create a System Account at all (manage_employees never
  // implies manage_users) — never reachable even for an employee it was
  // allowed to create.
  {
    const r = await api('POST', '/api/users', { token: hrToken, body: { employee_id: employee2Id } });
    assert(r.status === 403, '7: HR genuinely cannot create a System Account — manage_employees never implies manage_users');
  }

  // 8. HR cannot change role_id/access_level via its own Employee edit
  // surface — those stay exclusively on the manage_users-gated PATCH /api/users/:id.
  {
    const r = await api('PATCH', `/api/employees/${employee2Id}`, { token: hrToken, body: { role_id: 'manager', access_level: 'Branch Management Access' } });
    assert(r.status === 400, '8: role_id/access_level are genuinely not recognized fields on HR\'s own PATCH /api/employees/:id');
    const adminPatch = await api('PATCH', `/api/employees/${employee2Id}`, { token: adminToken, body: { role_id: 'manager' } });
    assert(adminPatch.status === 400, '8: role_id is genuinely unreachable on PATCH /api/employees/:id even for Admin — it stays on PATCH /api/users/:id only');
  }

  // 9. HR genuinely CAN edit real HR/organizational fields on an employee
  // it's authorized for.
  {
    const r = await api('PATCH', `/api/employees/${employee2Id}`, { token: hrToken, body: { phone: '0712345678', job_title: 'Senior Loan Officer' } });
    assert(r.status === 200 && r.json.employee.job_title === 'Senior Loan Officer', '9: HR genuinely edits real HR-owned employee fields via its own new authority');
  }

  // 10. HR cannot touch an Admin/CEO/Director employee record at all —
  // same real canActOnStaffRecord protection CEO/Director already have.
  {
    const adminMe = (await api('GET', '/api/auth/me', { token: adminToken })).json.user;
    const r = await api('PATCH', `/api/employees/${adminMe.id}`, { token: hrToken, body: { phone: '0700000000' } });
    assert(r.status === 403, '10: HR genuinely cannot edit the System Administrator\'s own employee record');
  }

  // 11. The real System Account status toggle (POST /api/users/:id/status)
  // changes ONLY the account's status, never the employee's own
  // employment standing.
  {
    const beforeEmp = await api('GET', '/api/employees/' + employeeId, { token: adminToken });
    const r = await api('POST', `/api/users/${employeeId}/status`, { token: adminToken, body: { status: 'Suspended' } });
    assert(r.status === 200 && r.json.status === 'Suspended', '11: Admin genuinely suspends the real System Account');
    const afterEmp = await api('GET', '/api/employees/' + employeeId, { token: adminToken });
    assert(afterEmp.json.employee.status === beforeEmp.json.employee.status, '11: the employee\'s own employment status is genuinely untouched by suspending their System Account');
    assert(afterEmp.json.employee.systemAccount === 'Suspended', '11: the employee\'s own profile honestly reflects the real Suspended System Account');
    const tok = await login(employeeEmail, tempPassword);
    assert(!tok, '11: a Suspended System Account genuinely cannot log in anymore');
    // Reactivate for the remaining checks below.
    await api('POST', `/api/users/${employeeId}/status`, { token: adminToken, body: { status: 'Active' } });
  }

  // 12. Reporting-manager-active check sees BOTH employment status and
  // account status — a reporting manager whose real account is Suspended
  // is genuinely not assignable, even though their employment status is
  // still Active (the two are genuinely independent now).
  {
    await api('POST', `/api/users/${employeeId}/status`, { token: adminToken, body: { status: 'Suspended' } });
    const r = await api('POST', '/api/employees', { token: hrToken, body: { name: 'Reports To Suspended', role_id: 'loan_officer', reporting_manager_id: employeeId } });
    assert(r.status === 400, '12: a reporting manager whose System Account is genuinely Suspended is rejected, even with Active employment status');
    await api('POST', `/api/users/${employeeId}/status`, { token: adminToken, body: { status: 'Active' } });
  }

  // 13. Terminating an employee (HR's real employment-status action)
  // cascades to suspend their linked System Account — never leaving a
  // terminated employee's login still working.
  {
    const r = await api('POST', `/api/employees/${employeeId}/employment-status`, { token: hrToken, body: { status: 'Terminated', reason: 'Test termination' } });
    assert(r.status === 200 && r.json.accountSuspended === true, '13: terminating an employee genuinely cascades to suspend their real linked System Account');
    const tok = await login(employeeEmail, tempPassword);
    assert(!tok, '13: the terminated employee\'s System Account genuinely can no longer log in');
    const emp = await api('GET', '/api/employees/' + employeeId, { token: adminToken });
    assert(emp.json.employee.status === 'Terminated' && emp.json.employee.systemAccount === 'Deactivated',
      '13: the employee\'s own record honestly shows Terminated employment AND a real Deactivated System Account');
  }

  // 14. The legacy, backward-compatible create-both-at-once flow (no
  // employee_id in the body) still works exactly as before the split.
  {
    const r = await api('POST', '/api/users', { token: adminToken, body: { name: 'Legacy Combined Flow', email: `legacy${rand()}@rhinocash.co.ke`, role_id: 'loan_officer' } });
    assert(r.status === 201 && r.json.user.systemAccount === 'Active' && !!r.json.tempPassword,
      '14: the original, backward-compatible create-employee-and-account-together flow still works unchanged');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
