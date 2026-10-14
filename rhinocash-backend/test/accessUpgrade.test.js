// accessUpgrade.test.js — menu & submenu permissions (Role Permissions),
// signing in with a username, and the Intelligence catalog migration.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
const tokens = new Map();
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}
async function login(id, password) {
  let r = await api('POST', '/api/auth/login', { body: { email: id, password } });
  if (r.status === 409 && tokens.get(password)) { await api('POST', '/api/auth/logout', { token: tokens.get(password) }); r = await api('POST', '/api/auth/login', { body: { email: id, password } }); }
  if (r.json && r.json.token) tokens.set(password, r.json.token);
  return r;
}
const logout = t => api('POST', '/api/auth/logout', { token: t });

(async () => {
  const admin = (await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD)).json.token;
  const manager = (await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD)).json.token;
  let officer = (await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD)).json.token;
  assert(admin && manager && officer, 'setup: admin, manager and officer sign in');

  // 1. Menu & submenu permissions
  assert((await api('GET', '/api/menu-permissions', { token: admin })).status === 200, '1: the Admin reads menu permissions');
  assert((await api('GET', '/api/menu-permissions', { token: officer })).status === 403, '1: a Loan Officer cannot read them');
  assert((await api('PUT', '/api/menu-permissions', { token: manager, body: { scope: 'role', subjectId: 'loan_officer', changes: [{ key: 'LoanBook›Collection MTD', allowed: false }] } })).status === 403, '1: only the Admin changes them');
  assert((await api('PUT', '/api/menu-permissions', { token: admin, body: { scope: 'role', subjectId: 'loan_officer', changes: [{ key: 'no-separator', allowed: false }] } })).status === 400, '1: a malformed menu key is refused');
  assert((await api('PUT', '/api/menu-permissions', { token: admin, body: { scope: 'role', subjectId: 'not_a_role', changes: [{ key: 'A›B', allowed: false }] } })).status === 400, '1: an unknown role is refused');
  assert((await api('GET', '/api/collections/mtd', { token: officer })).status === 200, '1: before: the officer opens Collection MTD');
  const off = await api('PUT', '/api/menu-permissions', { token: admin, body: { scope: 'role', subjectId: 'loan_officer', changes: [{ key: 'LoanBook›Collection MTD', allowed: false }] } });
  assert(off.status === 200 && off.json.settings['LoanBook›Collection MTD'] === false, '1: the Admin switches Collection MTD off for Loan Officers');
  const me = (await api('GET', '/api/auth/me', { token: officer })).json.user;
  assert(me.finalAccess.menuSettings.role['LoanBook›Collection MTD'] === false, '1: the officer\'s own access carries the switched-off menu (their sidebar hides it)');
  assert((await api('GET', '/api/collections/mtd', { token: officer })).status === 403, '1: the server also refuses that page for Loan Officers');
  await api('PUT', '/api/menu-permissions', { token: admin, body: { scope: 'role', subjectId: 'loan_officer', changes: [{ key: 'LoanBook›Collection MTD', allowed: null }] } });
  assert((await api('GET', '/api/collections/mtd', { token: officer })).status === 200, '1: switching it back on restores access');
  const offId = me.id;
  await api('PUT', '/api/menu-permissions', { token: admin, body: { scope: 'user', subjectId: offId, changes: [{ key: 'Clients›*', allowed: false }] } });
  const cl = await api('POST', '/api/clients', { token: officer, body: { name: 'Menu Test', phone: '0700' + Math.floor(Math.random() * 900000 + 100000) } });
  assert(cl.status === 403, '1: a whole menu switched off for one user blocks its pages for that user');
  await api('PUT', '/api/menu-permissions', { token: admin, body: { scope: 'user', subjectId: offId, changes: [{ key: 'Clients›*', allowed: null }] } });
  const all = (await api('GET', '/api/menu-permissions', { token: admin })).json.settings;
  assert(!(all.user[offId] && all.user[offId]['Clients›*'] !== undefined), '1: clearing the setting returns the user to the role default');
  assert((await api('PUT', '/api/menu-permissions', { token: admin, body: { scope: 'role', subjectId: 'investor', changes: [{ key: 'Statements›*', allowed: false }] } })).status === 200, '1: the Investor role\'s menus can be switched too');
  await api('PUT', '/api/menu-permissions', { token: admin, body: { scope: 'role', subjectId: 'investor', changes: [{ key: 'Statements›*', allowed: null }] } });

  // 2. Username sign-in
  await logout(officer);
  let r = await login('Peter Otieno', process.env.SEEDED_OFFICER_PASSWORD);
  assert(r.status === 200, '2: the officer signs in with their name as username ("Peter Otieno")');
  officer = r.json.token;
  assert(r.json.user.username === 'peter.otieno', '2: their username is made from the name (peter.otieno)');
  await logout(officer);
  r = await login('PETER.OTIENO', process.env.SEEDED_OFFICER_PASSWORD);
  assert(r.status === 200, '2: the username ignores case and dots');
  await logout(r.json.token);
  assert((await login('peter.otieno', 'wrong-password')).status === 401, '2: a wrong password with the username is refused');
  const roles = (await api('GET', '/api/roles', { token: admin })).json.roles;
  const created = await api('POST', '/api/users', { token: admin, body: { name: 'Jane Wambui', email: `jane.${Date.now()}@example.com`, role_id: 'loan_officer', branch_id: 'br_kisumu', phone: '0722' + Math.floor(Math.random() * 900000 + 100000) } });
  assert(created.status === 201 && created.json.user.username && created.json.user.username.startsWith('jane.wambui'), '2: a new user gets a username from their name');
  const dupe = await api('POST', '/api/users', { token: admin, body: { name: 'Another Person', email: `ap.${Date.now()}@example.com`, role_id: 'loan_officer', branch_id: 'br_kisumu', username: created.json.user.username } });
  assert(dupe.status === 409, '2: a username already taken is refused');
  const jl = await login(created.json.user.username, created.json.tempPassword);
  assert(jl.status === 200, '2: the new user signs in with their username and temporary password');
  if (jl.json && jl.json.token) await logout(jl.json.token);
  assert(roles && roles.length, 'setup: roles listed');

  // 3. Intelligence catalog is in place (startup migration)
  const { get } = require('../src/db');
  const mig = await get(`SELECT 1 AS ok FROM app_migrations WHERE id = 'intelligence-catalog-v1'`);
  const grants = await get(`SELECT COUNT(*)::int AS n FROM role_intelligence_access WHERE role_id = 'manager'`);
  assert(mig && grants.n > 0, '3: the Intelligence catalog and role grants are set up by the startup migration');
  const mme = (await api('GET', '/api/auth/me', { token: manager })).json.user;
  assert((mme.finalAccess.intelligence || []).length > 0, '3: a Manager holds Intelligence menus');

  await logout(admin); await logout(manager);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
