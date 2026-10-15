// branchRegions.test.js — branches can move to another region, and staff
// follow their branch's region through transfers and promotions; a
// Regional Manager keeps the region chosen for them.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}
const login = async (email, pw) => (await api('POST', '/api/auth/login', { body: { email, password: pw } })).json.token;

(async () => {
  const { get } = require('../src/db');
  const admin = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const regional = await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD);
  assert(admin && regional, 'setup: Admin and the Regional Manager sign in');
  const user = email => get('SELECT id, role_id, branch_id, region_id FROM users WHERE email = ?', [email]);
  const officer0 = await user('officer@rhinocash.co.ke'), rm0 = await user('regional@rhinocash.co.ke'), mgr0 = await user('manager.kisumu@rhinocash.co.ke');
  const home = (await get('SELECT region_id FROM branches WHERE id = ?', [officer0.branch_id])).region_id;
  const other = (await get('SELECT id FROM regions WHERE id <> ? AND status = ? LIMIT 1', [home, 'Active'])).id;
  const otherBranch = (await get('SELECT id FROM branches WHERE region_id = ? LIMIT 1', [other])).id;

  // 1. Moving a branch to another region moves its staff, not its Regional Manager.
  const mv = await api('PATCH', `/api/branches/${officer0.branch_id}`, { token: admin, body: { region_id: other } });
  assert(mv.status === 200 && mv.json.branch.region_id === other && mv.json.staffMoved >= 1, `1: Admin moves the officer's branch to another region (${mv.json && mv.json.staffMoved} staff moved)`);
  assert((await user('officer@rhinocash.co.ke')).region_id === other, "1: the branch's loan officer now works in the new region");
  assert((await user('regional@rhinocash.co.ke')).region_id === rm0.region_id, '1: a Regional Manager sitting in that branch keeps their own region');
  const back = await api('PATCH', `/api/branches/${officer0.branch_id}`, { token: admin, body: { region_id: home } });
  assert(back.status === 200 && (await user('officer@rhinocash.co.ke')).region_id === home, '1: moving the branch back brings its staff back');

  // 2. Transferring someone to another branch: region follows the branch, whatever was submitted.
  const tr = await api('PATCH', `/api/users/${officer0.id}`, { token: admin, body: { branch_id: otherBranch, region_id: home } });
  const moved = await user('officer@rhinocash.co.ke');
  assert(tr.status === 200 && moved.branch_id === otherBranch && moved.region_id === other, "2: a transfer puts the officer in the new branch's region");
  await api('PATCH', `/api/users/${officer0.id}`, { token: admin, body: { branch_id: officer0.branch_id } });
  assert((await user('officer@rhinocash.co.ke')).region_id === home, '2: transferring back restores the region');

  // 3. Promotion to Regional Manager: the region chosen is kept, whatever their branch.
  const pr = await api('PATCH', `/api/users/${mgr0.id}`, { token: admin, body: { role_id: 'regional_manager', region_id: other } });
  const promoted = await user('manager.kisumu@rhinocash.co.ke');
  assert(pr.status === 200 && promoted.role_id === 'regional_manager' && promoted.region_id === other && promoted.branch_id === mgr0.branch_id, '3: promoted to Regional Manager of another region, they keep that region');
  const dm = await api('PATCH', `/api/users/${mgr0.id}`, { token: admin, body: { role_id: 'manager' } });
  assert(dm.status === 200 && (await user('manager.kisumu@rhinocash.co.ke')).region_id === mgr0.region_id, "3: back as a branch Manager, their region follows the branch again");

  // 4. Assigning a branch's Manager: they move there, and the two records agree.
  const br = id => get('SELECT id, manager_id, region_id FROM branches WHERE id = ?', [id]);
  const target = (await get(`SELECT id FROM branches WHERE id <> ? AND manager_id IS NULL AND status = 'Active' LIMIT 1`, [mgr0.branch_id])).id;
  const as = await api('PATCH', `/api/branches/${target}`, { token: admin, body: { manager_id: mgr0.id } });
  const mgrNow = await user('manager.kisumu@rhinocash.co.ke');
  assert(as.status === 200 && (await br(target)).manager_id === mgr0.id && mgrNow.branch_id === target && mgrNow.region_id === (await br(target)).region_id, '4: assigning a branch Manager moves them to that branch (and its region)');
  assert((await br(mgr0.branch_id)).manager_id !== mgr0.id, '4: …and they stop managing the branch they left');
  const backHome = await api('PATCH', `/api/users/${mgr0.id}`, { token: admin, body: { branch_id: mgr0.branch_id } });
  const homeBr = await br(mgr0.branch_id);
  assert(backHome.status === 200 && (await br(target)).manager_id !== mgr0.id && (homeBr.manager_id === mgr0.id || homeBr.manager_id), "4: moving a Manager on their profile releases the old branch and heads the new one if it has no manager");
  const promo = await api('PATCH', `/api/users/${mgr0.id}`, { token: admin, body: { role_id: 'regional_manager', region_id: mgr0.region_id } });
  assert(promo.status === 200 && !(await get('SELECT 1 AS x FROM branches WHERE manager_id = ?', [mgr0.id])), '4: promoted out of Manager, they no longer head a branch');
  await api('PATCH', `/api/users/${mgr0.id}`, { token: admin, body: { role_id: 'manager', branch_id: mgr0.branch_id } });
  const fresh = await api('POST', '/api/users', { token: admin, body: { name: 'New Branch Head', email: `newhead.${Date.now()}@rhinocash.co.ke`, role_id: 'manager', branch_id: target } });
  assert(fresh.status === 201 && (await br(target)).manager_id === fresh.json.user.id, '4: a new Manager added to a branch without one becomes its manager');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
