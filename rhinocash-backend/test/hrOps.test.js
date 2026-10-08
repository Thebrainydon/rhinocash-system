// hrOps.test.js — Human Resources records, attendance, payroll and HR authority.
// settings documents (+history), reference lists, and live system stats.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
// This file logs into the same seeded accounts repeatedly, purely for
// convenience — never to test concurrent-session semantics itself (that's
// what section 2, Active Sessions, explicitly does with its own real,
// per-session Admin revoke). Now that a real single-active-session policy
// exists, a later login for an account already logged in earlier in this
// file (and never logged back out, or Admin-revoked) gets genuinely
// rejected (409). Rather than hand-add an explicit logout before every
// such repeat call, this real map tracks the most recent real token issued
// per email; on hitting that exact real block, it logs that prior session
// out (exactly what a real second device would have to do) and retries
// once. A login that fails for any OTHER reason (maintenance mode, wrong
// password, etc.) never touches the existing session.
const __activeLoginToken = new Map();
async function api(method, path, { token, body } = {}) {
  const isLogin = method === 'POST' && (path === '/api/auth/login' || path === '/api/investor-auth/login');
  const doFetch = async () => {
    const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await res.json(); } catch { /* no body */ }
    return { status: res.status, json };
  };
  let result = await doFetch();
  if (isLogin && result.status === 409 && result.json && result.json.code === 'ALREADY_LOGGED_IN' && body && body.email) {
    const key = String(body.email).toLowerCase();
    const prior = __activeLoginToken.get(key);
    if (prior) {
      await fetch(BASE + (path === '/api/auth/login' ? '/api/auth/logout' : '/api/investor-auth/logout'), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${prior}` },
      }).catch(() => {});
      __activeLoginToken.delete(key);
      result = await doFetch();
    }
  }
  if (isLogin && result.status === 200 && result.json && result.json.token && body && body.email) {
    __activeLoginToken.set(String(body.email).toLowerCase(), result.json.token);
  }
  return result;
}
async function login(email, password) { const r = await api('POST', '/api/auth/login', { body: { email, password } }); return r.json && r.json.token; }

(async () => {
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const created = await api('POST', '/api/users', { token: adminToken, body: { name: 'Mercy Atieno', email: `hr${Date.now()}@rhinocash.co.ke`, role_id: 'hr', branch_id: 'br_nairobi' } });
  const hrToken = await login(created.json.user.email, created.json.tempPassword);
  assert(adminToken && ceoToken && officerToken && hrToken, 'setup: Admin, CEO, Loan Officer and a new HR officer sign in');

  // 1. Access
  {
    assert((await api('GET', '/api/hr/records', { token: officerToken })).status === 403, '1: a Loan Officer has no HR access');
    assert((await api('GET', '/api/hr/records', { token: ceoToken })).status === 200, '1: the CEO can read HR records');
    const ceoWrite = await api('POST', '/api/hr/records', { token: ceoToken, body: { kind: 'vacancy', title: 'X' } });
    assert(ceoWrite.status === 403, '1: the CEO cannot change HR records');
  }

  // 2. Recruitment
  let vacancyId;
  {
    const bad = await api('POST', '/api/hr/records', { token: hrToken, body: { kind: 'nonsense', title: 'x' } });
    assert(bad.status === 400, '2: an unknown record type is rejected');
    const v = await api('POST', '/api/hr/records', { token: hrToken, body: { kind: 'vacancy', title: 'Loan Officer — Kwale', category: 'Operations', end_date: '2030-01-31', data: { positions: 2, branchId: 'br_kwale' } } });
    assert(v.status === 201 && v.json.record.status === 'Open' && v.json.record.data.positions === 2, '2: HR opens a vacancy');
    vacancyId = v.json.record.id;
    const app = await api('POST', '/api/hr/records', { token: hrToken, body: { kind: 'application', title: 'Jane Wambui', related_id: vacancyId, data: { email: 'jane@example.com', phone: '0712000111' } } });
    assert(app.status === 201 && app.json.record.status === 'Received', '2: an application is received against the vacancy');
    const sl = await api('PATCH', `/api/hr/records/${app.json.record.id}`, { token: hrToken, body: { status: 'Shortlisted', score: 78 } });
    assert(sl.status === 200 && sl.json.record.status === 'Shortlisted' && sl.json.record.score === 78, '2: HR shortlists and scores the candidate');
    const badSt = await api('PATCH', `/api/hr/records/${app.json.record.id}`, { token: hrToken, body: { status: 'Approved' } });
    assert(badSt.status === 400, '2: a status from another workflow is rejected');
    const list = await api('GET', `/api/hr/records?kind=application&related_id=${vacancyId}`, { token: hrToken });
    assert(list.json.records.length === 1 && list.json.records[0].title === 'Jane Wambui', '2: applications are listed per vacancy');
    const noEmp = await api('POST', '/api/hr/records', { token: hrToken, body: { kind: 'review', title: 'Q3 review' } });
    assert(noEmp.status === 400, '2: an employee record (e.g. a review) needs an employee');
    const badScore = await api('POST', '/api/hr/records', { token: hrToken, body: { kind: 'appraisal', title: 'Annual', employee_id: 'usr_officer', score: 140 } });
    assert(badScore.status === 400, '2: scores must be 0–100');
  }

  // 3. Staff transfer (executes on completion)
  {
    const t = await api('POST', '/api/hr/records', { token: hrToken, body: { kind: 'transfer', title: 'Officer to Kwale', employee_id: 'usr_officer', data: { toBranchId: 'br_kwale' } } });
    assert(t.status === 201 && t.json.record.data.fromBranchId === 'br_kisumu', '3: HR requests a staff transfer');
    const early = await api('PATCH', `/api/hr/records/${t.json.record.id}`, { token: hrToken, body: { status: 'Completed' } });
    assert(early.status === 400, '3: a transfer is approved before it is completed');
    await api('PATCH', `/api/hr/records/${t.json.record.id}`, { token: hrToken, body: { status: 'Approved' } });
    const done = await api('PATCH', `/api/hr/records/${t.json.record.id}`, { token: hrToken, body: { status: 'Completed' } });
    const officer = (await api('GET', '/api/hr/employees', { token: hrToken })).json.employees.find(e => e.id === 'usr_officer');
    assert(done.status === 200 && officer.branch_id === 'br_kwale', '3: completing the transfer really moves the employee');
    const adminT = await api('POST', '/api/hr/records', { token: hrToken, body: { kind: 'transfer', title: 'Move CEO', employee_id: 'usr_ceo', data: { toBranchId: 'br_kwale' } } });
    assert(adminT.status === 403, '3: HR cannot transfer an executive');
  }

  // 4. Access requests — raised by HR, decided and applied by Admin
  {
    const r = await api('POST', '/api/hr/records', { token: hrToken, body: { kind: 'access_request', title: 'Suspend during investigation', employee_id: 'usr_manager_kisumu', data: { action: 'Suspend account' } } });
    assert(r.status === 201 && r.json.record.status === 'Pending', '4: HR raises an account suspension request');
    const hrDecide = await api('PATCH', `/api/hr/records/${r.json.record.id}`, { token: hrToken, body: { status: 'Approved' } });
    assert(hrDecide.status === 403, '4: HR cannot approve its own access request');
    const ok = await api('PATCH', `/api/hr/records/${r.json.record.id}`, { token: adminToken, body: { status: 'Approved' } });
    assert(ok.status === 200 && ok.json.effect && ok.json.effect.accountStatus === 'Suspended', '4: Admin approval suspends the account');
    const blocked = await api('POST', '/api/auth/login', { body: { email: 'manager.kisumu@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_KISUMU_PASSWORD } });
    assert(blocked.status === 403, '4: the suspended employee can no longer sign in');
    const back = await api('POST', '/api/hr/records', { token: hrToken, body: { kind: 'access_request', title: 'Reinstate', employee_id: 'usr_manager_kisumu', data: { action: 'Activate account' } } });
    const ok2 = await api('PATCH', `/api/hr/records/${back.json.record.id}`, { token: adminToken, body: { status: 'Approved' } });
    assert(ok2.json.effect.accountStatus === 'Active', '4: an approved activation reinstates the account');
    const badAction = await api('POST', '/api/hr/records', { token: hrToken, body: { kind: 'access_request', title: 'x', employee_id: 'usr_officer', data: { action: 'Make me admin' } } });
    assert(badAction.status === 400, '4: only known access changes can be requested');
  }

  // 5. Attendance
  {
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const f = await api('POST', '/api/hr/attendance', { token: hrToken, body: { date: future, entries: [{ employee_id: 'usr_officer', status: 'Present' }] } });
    assert(f.status === 400, '5: attendance cannot be recorded for a future date');
    const badS = await api('POST', '/api/hr/attendance', { token: hrToken, body: { date: today, entries: [{ employee_id: 'usr_officer', status: 'Sleeping' }] } });
    assert(badS.status === 400, '5: unknown attendance statuses are rejected');
    const saved = await api('POST', '/api/hr/attendance', { token: hrToken, body: { date: today, entries: [
      { employee_id: 'usr_officer', status: 'Late', check_in: '08:40', check_out: '17:05', minutes_late: 40 },
      { employee_id: 'usr_accountant', status: 'Present', check_in: '07:55', check_out: '17:00' } ] } });
    assert(saved.status === 200 && saved.json.saved === 2, '5: HR records the day\'s attendance');
    await api('POST', '/api/hr/attendance', { token: hrToken, body: { date: today, entries: [{ employee_id: 'usr_accountant', status: 'Absent' }] } });
    const list = await api('GET', `/api/hr/attendance?from=${today}&to=${today}`, { token: hrToken });
    const acc = list.json.records.filter(r => r.employeeId === 'usr_accountant');
    assert(acc.length === 1 && acc[0].status === 'Absent', '5: re-recording a day updates it instead of duplicating');
    assert(list.json.records.find(r => r.employeeId === 'usr_officer').minutesLate === 40, '5: lateness minutes are kept');
  }

  // 6. Payroll
  {
    const salary = await api('PATCH', '/api/hr/employees/usr_officer', { token: hrToken, body: { basic_salary: 50000, kra_pin: 'A001234567Z', job_grade: 'G4' } });
    assert(salary.status === 200 && Number(salary.json.employee.basic_salary) === 50000, '6: HR sets a basic salary');
    const exec = await api('PATCH', '/api/hr/employees/usr_admin', { token: hrToken, body: { basic_salary: 1 } });
    assert(exec.status === 403 || exec.status === 404, '6: HR cannot edit the System Administrator\'s record');
    const badContract = await api('PATCH', '/api/hr/employees/usr_officer', { token: hrToken, body: { contract_start: '2026-01-01', contract_end: '2025-01-01' } });
    assert(badContract.status === 400, '6: a contract cannot end before it starts');
    const period = new Date().toISOString().slice(0, 7);
    const future = await api('POST', '/api/hr/payroll/runs', { token: hrToken, body: { period: '2099-01' } });
    assert(future.status === 400, '6: payroll cannot be run for a future month');
    const runR = await api('POST', '/api/hr/payroll/runs', { token: hrToken, body: { period } });
    assert(runR.status === 201 && runR.json.run.status === 'Draft' && runR.json.run.employeeCount >= 1, '6: HR runs the month\'s payroll');
    const dup = await api('POST', '/api/hr/payroll/runs', { token: hrToken, body: { period } });
    assert(dup.status === 409, '6: one payroll per month');
    const detail = await api('GET', `/api/hr/payroll/runs/${runR.json.run.id}`, { token: ceoToken });
    const line = detail.json.lines.find(l => l.employeeId === 'usr_officer');
    assert(line && line.gross === 50000 && line.paye > 0 && line.nssf > 0 && Math.abs(line.net - (line.gross - line.totalDeductions)) < 0.01, '6: each line has real statutory deductions and net = gross − deductions');
    const mine = await api('GET', `/api/users/me/payroll/${period}`, { token: officerToken });
    assert(mine.status === 200 && Math.abs(mine.json.payslip.netPay - line.net) < 0.01, '6: payroll matches the payslip the employee sees');
    const hrApprove = await api('POST', `/api/hr/payroll/runs/${runR.json.run.id}/status`, { token: hrToken, body: { status: 'Approved' } });
    assert(hrApprove.status === 403, '6: HR cannot approve payroll');
    const earlyPay = await api('POST', `/api/hr/payroll/runs/${runR.json.run.id}/status`, { token: hrToken, body: { status: 'Paid' } });
    assert(earlyPay.status === 400, '6: payroll is approved before it is paid');
    const approve = await api('POST', `/api/hr/payroll/runs/${runR.json.run.id}/status`, { token: ceoToken, body: { status: 'Approved' } });
    assert(approve.status === 200 && approve.json.run.status === 'Approved', '6: the CEO approves the payroll');
    const recompute = await api('POST', `/api/hr/payroll/runs/${runR.json.run.id}/recompute`, { token: hrToken, body: {} });
    assert(recompute.status === 400, '6: an approved payroll can no longer be recomputed');
    const paid = await api('POST', `/api/hr/payroll/runs/${runR.json.run.id}/status`, { token: hrToken, body: { status: 'Paid' } });
    assert(paid.status === 200 && paid.json.run.status === 'Paid', '6: HR marks the approved payroll paid');
  }

  // 7. Departments, lists, leave, visibility
  {
    const d = await api('POST', '/api/hr/departments', { token: hrToken, body: { name: 'Internal Audit' } });
    assert(d.status === 201, '7: HR creates a department');
    const dd = await api('POST', '/api/hr/departments', { token: hrToken, body: { name: 'internal audit' } });
    assert(dd.status === 409, '7: duplicate department names are rejected');
    const rn = await api('PUT', `/api/hr/departments/${d.json.department.id}`, { token: hrToken, body: { name: 'Internal Audit & Risk' } });
    assert(rn.status === 200, '7: HR renames a department');
    const jt = await api('POST', '/api/admin/lookups/job-titles', { token: hrToken, body: { name: 'Senior Loan Officer' } });
    assert(jt.status === 201, '7: HR maintains the job titles list');
    const ct = await api('POST', '/api/admin/lookups/client-types', { token: hrToken, body: { name: 'Business' } });
    assert(ct.status === 403, '7: HR cannot change non-HR configuration lists');
    const lv = await api('POST', '/api/leave-requests', { token: officerToken, body: { leave_type: 'Annual', start_date: '2030-02-01', end_date: '2030-02-05', reason: 'Family' } });
    const dec = await api('POST', `/api/leave-requests/${lv.json.leaveRequest.id}/decide`, { token: hrToken, body: { decision: 'Approved' } });
    assert(dec.status === 200 && dec.json.leaveRequest.status === 'Approved', '7: HR approves leave');
    const all = await api('GET', '/api/leave-requests', { token: hrToken });
    assert(all.json.leaveRequests.some(r => r.id === lv.json.leaveRequest.id), '7: HR sees every leave request');
    const la = await api('GET', '/api/hr/login-activity', { token: hrToken });
    assert(la.status === 200 && la.json.events.length > 0, '7: HR sees staff sign-in activity');
    const pa = await api('GET', '/api/hr/people-audit', { token: hrToken });
    assert(pa.status === 200 && pa.json.entries.some(e => e.module === 'hr'), '7: HR sees the people-change trail');
    assert((await api('GET', '/api/hr/login-activity', { token: officerToken })).status === 403, '7: other staff cannot see it');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
