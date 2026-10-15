// screenProtect.test.js — accounts HR creates cannot take screenshots
// (watermarked, capture-blanking screen); accounts Admin creates can.
// Only Admin changes it per user; capture attempts are recorded.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}
const login = async (email, pw) => (await api('POST', '/api/auth/login', { body: { email, password: pw } })).json;
const stamp = Date.now();

(async () => {
  const admin = (await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD)).token;
  assert(admin, 'setup: Admin signs in');

  // An HR officer, created by Admin.
  const hrMk = await api('POST', '/api/users', { token: admin, body: { name: 'SP HR Officer', email: `sp.hr.${stamp}@rhinocash.co.ke`, role_id: 'hr' } });
  assert(hrMk.status === 201 && hrMk.json.user.screenProtect === false && hrMk.json.user.accountCreatedByRole === 'admin', '1: an account Admin creates may take screenshots (created by Admin)');
  const hr = (await login(`sp.hr.${stamp}@rhinocash.co.ke`, hrMk.json.tempPassword)).token;
  assert(hr, 'setup: the HR officer signs in');

  // HR adds an employee; Admin then gives them a login: protected, because HR registered them.
  const emp = await api('POST', '/api/employees', { token: hr, body: { name: 'SP Officer', email: `sp.lo.${stamp}@rhinocash.co.ke`, role_id: 'loan_officer', branch_id: 'br_kisumu' } });
  if (emp.status !== 201) console.log('HR add employee:', JSON.stringify(emp.json));
  assert(emp.status === 201 && emp.json.employee.created_by_role === 'hr', '2: HR adds an employee (recorded as registered by HR)');
  const loMk = await api('POST', '/api/users', { token: admin, body: { employee_id: emp.json.employee.id, role_id: 'loan_officer', login_email: `sp.lo.${stamp}@rhinocash.co.ke` } });
  if (loMk.status !== 201) console.log('link:', JSON.stringify(loMk.json));
  assert(loMk.status === 201 && loMk.json.user.screenProtect === true && loMk.json.user.accountCreatedByRole === 'admin', '2: someone HR registered cannot take screenshots, even with a login Admin created');
  const loLogin = await login(`sp.lo.${stamp}@rhinocash.co.ke`, loMk.json.tempPassword);
  assert(loLogin.user && loLogin.user.screenProtect === true, '2: the protected user learns it at sign-in');
  const lo = loLogin.token;
  const me = await api('GET', '/api/auth/me', { token: lo });
  assert(me.json.user.screenProtect === true, '2: …and on every page load');
  // A person Admin registers directly is free.
  const adMk = await api('POST', '/api/users', { token: admin, body: { name: 'SP Admin Made', email: `sp.ad.${stamp}@rhinocash.co.ke`, role_id: 'loan_officer', branch_id: 'br_kisumu' } });
  assert(adMk.status === 201 && adMk.json.user.screenProtect === false && adMk.json.user.created_by_role === 'admin', '2: someone Admin registers can take screenshots');

  // Only Admin switches it.
  const loId = loMk.json.user.id;
  assert((await api('POST', `/api/users/${loId}/screen-protection`, { token: hr, body: { enabled: false } })).status === 403, '3: HR cannot lift the protection');
  const off = await api('POST', `/api/users/${loId}/screen-protection`, { token: admin, body: { enabled: false } });
  assert(off.status === 200 && off.json.screenProtect === false && (await api('GET', '/api/auth/me', { token: lo })).json.user.screenProtect === false, '3: Admin allows screenshots for that user');
  const on = await api('POST', `/api/users/${loId}/screen-protection`, { token: admin, body: { enabled: true } });
  assert(on.status === 200 && (await api('GET', `/api/users/${loId}`, { token: admin })).json.user.screenProtect === true, '3: Admin blocks them again');
  const hrId = hrMk.json.user.id;
  assert((await api('POST', `/api/users/${hrId}/screen-protection`, { token: admin, body: { enabled: true } })).status === 200, '3: Admin can protect an Admin-created account too');

  // Attempts are recorded, at most once a minute.
  const a1 = await api('POST', '/api/auth/screen-capture-attempt', { token: lo, body: { kind: 'PrintScreen', page: 'Loan Applications' } });
  await api('POST', '/api/auth/screen-capture-attempt', { token: lo, body: { kind: 'print' } });
  const logs = await api('GET', `/api/audit-logs?limit=50`, { token: admin });
  const mine = ((logs.json && (logs.json.logs || logs.json.auditLogs || logs.json.entries)) || []).filter(l => l.action === 'Screen capture attempt' && (l.user_id === loId || l.userId === loId));
  assert(a1.status === 200 && mine.length === 1, `4: a capture attempt is recorded for Admin, once a minute at most (${mine.length})`);
  assert((await api('POST', '/api/auth/screen-capture-attempt', { body: { kind: 'x' } })).status === 401, '4: only a signed-in user can record an attempt');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
