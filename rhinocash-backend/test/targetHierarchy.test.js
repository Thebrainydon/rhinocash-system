// targetHierarchy.test.js — the target hierarchy (CEO/Director → company,
// Operational Manager → region, Regional Manager → branch in their region,
// Manager → their Loan Officers), editing and deleting targets set by
// mistake, and appeals/comments by the person a target was set for.
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
  const t = {
    officer: await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD),
    mgrK: await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD),
    regional: await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD),
    ops: await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD),
    ceo: await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD),
    director: await login('director@rhinocash.co.ke', process.env.SEEDED_DIRECTOR_PASSWORD),
    admin: await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD),
  };
  assert(Object.values(t).every(Boolean), 'setup: every role signs in');
  const me = async tok => (await api('GET', '/api/auth/me', { token: tok })).json.user;
  const officer = await me(t.officer), mgrK = await me(t.mgrK), regional = await me(t.regional), ops = await me(t.ops);
  const period = new Date().toISOString().slice(0, 7);

  // 1. Who may set which level
  const opt = async tok => (await api('GET', '/api/target-setter-options', { token: tok })).json;
  const oc = await opt(t.ceo), oo = await opt(t.ops), orm = await opt(t.regional), om = await opt(t.mgrK), ol = await opt(t.officer);
  assert(oc.levels.includes('company') && (await opt(t.director)).levels.includes('company'), '1: CEO and Director may set company targets');
  assert(oo.levels.includes('region') && !oo.levels.includes('company'), '1: Operational Manager sets region targets, not company ones');
  assert(orm.levels.join() === 'branch' && orm.branches.length > 0 && orm.branches.every(b => b.region_id === regional.region_id), '1: a Regional Manager sets branch targets, only for branches in their region');
  assert(om.levels.join() === 'person' && om.people.length > 0 && om.people.every(p => p.role_id === 'loan_officer' && p.branch_id === mgrK.branch_id), "1: a Manager sets targets for their own branch's Loan Officers");
  assert(ol.levels.length === 0, '1: a Loan Officer sets no targets');

  const company = await api('POST', '/api/targets', { token: t.ceo, body: { level: 'company', metric: 'disbursement', target_value: 50000000, period } });
  assert(company.status === 201 && !company.json.target.recipient_user_id && !company.json.target.branch_id && !company.json.target.region_id, '1: the CEO sets a company target');
  assert((await api('POST', '/api/targets', { token: t.director, body: { level: 'company', metric: 'disbursement', target_value: 1, period } })).status === 409, '1: the same company target twice is refused (edit it instead)');
  assert((await api('POST', '/api/targets', { token: t.ops, body: { level: 'company', metric: 'new_loans', target_value: 10, period } })).status === 403, '1: the Operational Manager cannot set a company target');
  const region = await api('POST', '/api/targets', { token: t.ops, body: { metric: 'collection', region_id: regional.region_id, target_value: 9000000, period } });
  assert(region.status === 201 && region.json.target.region_id === regional.region_id, '1: the Operational Manager sets a region target');
  assert((await api('POST', '/api/targets', { token: t.regional, body: { metric: 'collection', region_id: regional.region_id, target_value: 1, period: '2030-01' } })).status === 403, '1: a Regional Manager cannot set a region target');
  const branch = await api('POST', '/api/targets', { token: t.regional, body: { metric: 'new_loans', branch_id: mgrK.branch_id, target_value: 40, period } });
  assert(branch.status === 201, "1: the Regional Manager sets a target for a branch in their region");
  const outside = (await api('GET', '/api/branches', { token: t.admin })).json.branches.find(b => b.region_id !== regional.region_id);
  if (outside) assert((await api('POST', '/api/targets', { token: t.regional, body: { metric: 'new_loans', branch_id: outside.id, target_value: 5, period } })).status === 403, '1: …but not for a branch outside their region');
  const lo = await api('POST', '/api/targets', { token: t.mgrK, body: { metric: 'new_loans', recipient_user_id: officer.id, target_value: 12, period } });
  assert(lo.status === 201, '1: the Manager sets a Loan Officer target');

  // 2. The register: levels, names and flags
  const list = async tok => (await api('GET', '/api/targets', { token: tok })).json.targets;
  const ceoList = await list(t.ceo);
  const c = ceoList.find(x => x.id === company.json.target.id);
  assert(c && c.level === 'company' && c.set_by_name && c.can_manage === true, '2: the register labels the level, setter and whether you may manage it');
  const rmList = await list(t.regional);
  assert(rmList.some(x => x.id === region.json.target.id && x.can_appeal && !x.can_manage), "2: a Regional Manager sees their region's target and may appeal it");
  assert(rmList.some(x => x.id === lo.json.target.id && x.can_manage), "2: a Regional Manager sees officer targets in their region and, being senior to the Manager, may manage them");
  const mList = await list(t.mgrK);
  assert(mList.some(x => x.id === branch.json.target.id && x.can_appeal && !x.can_manage), "2: the branch Manager sees their branch's target and may appeal it");
  const oList = await list(t.officer);
  const mine = oList.find(x => x.id === lo.json.target.id);
  assert(mine && mine.can_appeal && !mine.can_manage && !oList.some(x => x.id === company.json.target.id), '2: a Loan Officer sees their own target only, and may appeal it');
  assert((await list(t.ops)).some(x => x.id === company.json.target.id && x.can_appeal), '2: Operations may appeal a company target');

  // 3. Edit and delete
  assert((await api('PATCH', `/api/targets/${lo.json.target.id}`, { token: t.officer, body: { target_value: 1 } })).status === 403, '3: the person a target is for cannot edit it');
  const ed = await api('PATCH', `/api/targets/${lo.json.target.id}`, { token: t.regional, body: { target_value: 14, notes: 'raised' } });
  assert(ed.status === 200 && Number(ed.json.target.target_value) === 14, "3: someone senior to the setter (in reach) can edit it");
  assert((await api('PATCH', `/api/targets/${branch.json.target.id}`, { token: t.mgrK, body: { target_value: 1 } })).status === 403, '3: a Manager cannot edit the target their Regional Manager set');
  const wrong = await api('POST', '/api/targets', { token: t.mgrK, body: { metric: 'arrears', recipient_user_id: officer.id, target_value: 999, period } });
  assert((await api('DELETE', `/api/targets/${wrong.json.target.id}`, { token: t.officer })).status === 403, '3: the person a target is for cannot delete it');
  assert((await api('DELETE', `/api/targets/${wrong.json.target.id}`, { token: t.mgrK })).status === 200, '3: the setter deletes a wrong target');
  assert((await api('GET', `/api/targets/${wrong.json.target.id}`, { token: t.mgrK })).status === 404, '3: a deleted target is gone');

  // 4. Appeals and comments
  assert((await api('POST', `/api/targets/${lo.json.target.id}/appeals`, { token: t.mgrK, body: { kind: 'appeal', message: 'x' } })).status === 403, '4: only the person a target is for can appeal it');
  assert((await api('POST', `/api/targets/${lo.json.target.id}/appeals`, { token: t.officer, body: { kind: 'appeal', message: '' } })).status === 400, '4: an appeal needs a message');
  const ap = await api('POST', `/api/targets/${lo.json.target.id}/appeals`, { token: t.officer, body: { kind: 'appeal', message: 'Two of my groups are on leave', proposed_value: 10 } });
  assert(ap.status === 201 && ap.json.appeal.status === 'Open' && Number(ap.json.appeal.proposed_value) === 10, '4: a Loan Officer appeals with a proposed figure');
  const cm = await api('POST', `/api/targets/${lo.json.target.id}/appeals`, { token: t.officer, body: { kind: 'comment', message: 'Noted, will push' } });
  assert(cm.status === 201 && cm.json.appeal.status === 'Noted', '4: a comment is recorded as noted');
  const mApps = (await api('GET', '/api/target-appeals', { token: t.mgrK })).json.appeals;
  const row = mApps.find(a => a.id === ap.json.appeal.id);
  assert(row && row.can_respond && row.user_name, '4: the setter sees the appeal and may answer it');
  assert(!(await api('GET', '/api/target-appeals', { token: t.officer })).json.appeals.find(a => a.id === ap.json.appeal.id).can_respond, '4: the officer cannot answer their own appeal');
  assert((await api('POST', `/api/target-appeals/${ap.json.appeal.id}/respond`, { token: t.officer, body: { decision: 'Accepted' } })).status === 403, '4: …and is refused if they try');
  const acc = await api('POST', `/api/target-appeals/${ap.json.appeal.id}/respond`, { token: t.mgrK, body: { decision: 'Accepted', response: 'Agreed' } });
  assert(acc.status === 200 && acc.json.appeal.status === 'Accepted' && acc.json.targetValue === 10, '4: accepting an appeal sets the target to the proposed figure');
  assert(Number((await api('GET', `/api/targets/${lo.json.target.id}`, { token: t.mgrK })).json.target.target_value) === 10, '4: the target now reads the new figure');
  assert((await api('POST', `/api/target-appeals/${ap.json.appeal.id}/respond`, { token: t.mgrK, body: { decision: 'Rejected' } })).status === 409, '4: an answered appeal cannot be answered again');
  const ap2 = await api('POST', `/api/targets/${branch.json.target.id}/appeals`, { token: t.mgrK, body: { kind: 'appeal', message: 'Market day moved', proposed_value: 30 } });
  const rej = await api('POST', `/api/target-appeals/${ap2.json.appeal.id}/respond`, { token: t.regional, body: { decision: 'Rejected', response: 'Keep 40' } });
  assert(rej.status === 200 && rej.json.targetValue === 40, '4: rejecting an appeal leaves the target unchanged');
  const ap3 = await api('POST', `/api/targets/${region.json.target.id}/appeals`, { token: t.regional, body: { kind: 'appeal', message: 'Too high', proposed_value: 8000000 } });
  const keep = await api('POST', `/api/target-appeals/${ap3.json.appeal.id}/respond`, { token: t.ops, body: { decision: 'Accepted', new_value: null } });
  assert(keep.status === 200 && keep.json.targetValue === 9000000, '4: accepting while keeping the figure leaves the target as it was');
  const notes = (await api('GET', '/api/notifications', { token: t.officer })).json.notifications;
  assert(notes.some(n => /appeal accepted/i.test(n.title)), '4: the officer is notified of the answer');
  const reg = await list(t.mgrK);
  assert(reg.find(x => x.id === lo.json.target.id).appeals_total === 2, '2: the register counts appeals and comments per target');

  // 5. Deleting a target removes its appeals; a senior can delete
  assert((await api('DELETE', `/api/targets/${lo.json.target.id}`, { token: t.ceo })).status === 200, '5: the CEO can delete a Manager-set target');
  assert(!(await api('GET', '/api/target-appeals', { token: t.mgrK })).json.appeals.some(a => a.target_id === lo.json.target.id), "5: its appeals go with it");

  // 6. Creating a user with a branch; giving an existing user a branch
  const emp = await api('POST', '/api/employees', { token: t.admin, body: { name: 'Branch Less', email: `branchless${Date.now()}@example.com`, phone: '0711222333', role_id: 'loan_officer' } });
  if (emp.status === 201) {
    const id = emp.json.employee ? emp.json.employee.id : emp.json.user.id;
    const acct = await api('POST', '/api/users', { token: t.admin, body: { employee_id: id, role_id: 'loan_officer', branch_id: mgrK.branch_id, login_email: `bl${Date.now()}@example.com` } });
    assert(acct.status === 201 && acct.json.user.branch_id === mgrK.branch_id, '6: Create User (existing employee) saves the chosen branch');
    const p = await api('PATCH', `/api/users/${id}`, { token: t.admin, body: { branch_id: officer.branch_id } });
    assert(p.status === 200 && p.json.user.branch_id === officer.branch_id && p.json.user.region_id, "6: Admin can change a user's branch and the region follows");
  } else assert(false, '6: setup employee: ' + emp.status + ' ' + JSON.stringify(emp.json));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
