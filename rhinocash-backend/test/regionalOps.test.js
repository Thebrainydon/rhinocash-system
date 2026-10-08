// regionalOps.test.js — Regional Operations records and region scoping.
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
  const rmToken = await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD);
  const mgrUkunda = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const mgrLikoni = await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD);
  const opsToken = await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const accToken = await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD);
  assert(rmToken && mgrUkunda && mgrLikoni && opsToken && officerToken && accToken, 'setup: all needed accounts log in');
  const rmMe = (await api('GET', '/api/auth/me', { token: rmToken })).json.user;
  assert(rmMe.region_id === 'rg_lower_coast', 'setup: the Regional Manager is assigned to Lower Coast');

  // 1. Access
  {
    const r = await api('GET', '/api/regional-ops', { token: officerToken });
    assert(r.status === 403, '1: a Loan Officer has no access to Regional Operations');
    const a = await api('GET', '/api/regional-ops', { token: accToken });
    assert(a.status === 403, '1: the Accountant has no access to Regional Operations');
  }

  // 2. Action plans — region scoped
  let planId;
  {
    const outside = await api('POST', '/api/regional-ops', { token: rmToken, body: { kind: 'action_plan', title: 'Fix Likoni arrears', branch_id: 'br_nairobi' } });
    assert(outside.status === 403, '2: a Regional Manager cannot create records for a branch outside their region');
    const noTitle = await api('POST', '/api/regional-ops', { token: rmToken, body: { kind: 'action_plan', title: ' ', branch_id: 'br_kisumu' } });
    assert(noTitle.status === 400, '2: a title is required');
    const bad = await api('POST', '/api/regional-ops', { token: rmToken, body: { kind: 'nonsense', title: 'x' } });
    assert(bad.status === 400, '2: an unknown record type is rejected');
    const created = await api('POST', '/api/regional-ops', { token: rmToken, body: { kind: 'action_plan', title: 'Lift Ukunda collection rate to 95%', branch_id: 'br_kisumu', priority: 'High', due_date: '2030-01-31' } });
    assert(created.status === 201 && created.json.record.status === 'Planned' && created.json.record.regionId === 'rg_lower_coast', '2: the Regional Manager creates an action plan in their region');
    planId = created.json.record.id;
    const regionWide = await api('POST', '/api/regional-ops', { token: rmToken, body: { kind: 'action_plan', title: 'Region-wide KYC refresh' } });
    assert(regionWide.status === 201 && regionWide.json.record.branchId === null && regionWide.json.record.regionId === 'rg_lower_coast', '2: a region-wide plan with no branch belongs to the RM\'s own region');
    const mgrPlan = await api('POST', '/api/regional-ops', { token: mgrUkunda, body: { kind: 'action_plan', title: 'Manager plan' } });
    assert(mgrPlan.status === 403, '2: a branch manager cannot create action plans');
    const progress = await api('PATCH', `/api/regional-ops/${planId}`, { token: rmToken, body: { status: 'In Progress' } });
    assert(progress.status === 200 && progress.json.record.status === 'In Progress', '2: the RM moves the plan forward');
    const badStatus = await api('PATCH', `/api/regional-ops/${planId}`, { token: rmToken, body: { status: 'Pending' } });
    assert(badStatus.status === 400, '2: a status that does not belong to action plans is rejected');
  }

  // 3. Branch requests raised by a manager, decided by the RM
  {
    const req = await api('POST', '/api/regional-ops', { token: mgrUkunda, body: { kind: 'branch_request', title: 'Need a second motorbike', branch_id: 'br_nairobi', category: 'Equipment' } });
    assert(req.status === 201 && req.json.record.branchId === 'br_kisumu', '3: a manager\'s request is always tied to their own branch, whatever they send');
    const mgrDecide = await api('PATCH', `/api/regional-ops/${req.json.record.id}`, { token: mgrUkunda, body: { status: 'Approved' } });
    assert(mgrDecide.status === 403, '3: the requesting manager cannot approve their own request');
    const otherMgr = await api('GET', '/api/regional-ops?kind=branch_request', { token: mgrLikoni });
    assert(otherMgr.status === 200 && !otherMgr.json.records.some(r => r.id === req.json.record.id), '3: a manager in another region never sees it');
    const rmList = await api('GET', '/api/regional-ops?kind=branch_request', { token: rmToken });
    assert(rmList.json.records.some(r => r.id === req.json.record.id), '3: the Regional Manager sees requests from their branches');
    const approve = await api('PATCH', `/api/regional-ops/${req.json.record.id}`, { token: rmToken, body: { status: 'Approved', resolution: 'Budget approved' } });
    assert(approve.status === 200 && approve.json.record.status === 'Approved', '3: the RM approves the request');
    const ops = await api('GET', '/api/regional-ops?kind=branch_request', { token: opsToken });
    assert(ops.json.records.some(r => r.id === req.json.record.id), '3: the Operational Manager has oversight of every region');
  }

  // 4. Escalation
  {
    const issue = await api('POST', '/api/regional-ops', { token: rmToken, body: { kind: 'issue', title: 'Paybill outage at Ukunda', branch_id: 'br_kisumu', priority: 'Critical' } });
    const noReason = await api('POST', `/api/regional-ops/${issue.json.record.id}/escalate`, { token: rmToken, body: {} });
    assert(noReason.status === 400, '4: escalating needs a reason');
    const esc = await api('POST', `/api/regional-ops/${issue.json.record.id}/escalate`, { token: rmToken, body: { reason: 'Down for 3 hours' } });
    assert(esc.status === 201 && esc.json.record.kind === 'escalation' && esc.json.record.relatedId === issue.json.record.id && esc.json.record.priority === 'Critical', '4: escalation creates a linked, prioritised escalation record');
    const opsSees = await api('GET', '/api/regional-ops?kind=escalation', { token: opsToken });
    assert(opsSees.json.records.some(r => r.id === esc.json.record.id), '4: the Operational Manager sees the escalation');
  }

  // 5. Transfers really move people — only within the region
  {
    // Staff transfer: the Ukunda loan officer moves to Mombasa (same region).
    const outOfRegion = await api('POST', '/api/regional-ops', { token: rmToken, body: { kind: 'transfer', title: 'Move officer', subject_type: 'staff', subject_id: 'usr_officer', to_branch_id: 'br_nairobi' } });
    assert(outOfRegion.status === 403, '5: a Regional Manager cannot transfer staff out of their region');
    const st = await api('POST', '/api/regional-ops', { token: rmToken, body: { kind: 'transfer', title: 'Officer to Mombasa', subject_type: 'staff', subject_id: 'usr_officer', to_branch_id: 'br_mombasa' } });
    assert(st.status === 201 && st.json.record.fromBranchId === 'br_kisumu' && st.json.record.status === 'Requested', '5: a staff transfer within the region is requested');
    const early = await api('PATCH', `/api/regional-ops/${st.json.record.id}`, { token: rmToken, body: { status: 'Completed' } });
    assert(early.status === 400, '5: a transfer must be approved before it is completed');
    await api('PATCH', `/api/regional-ops/${st.json.record.id}`, { token: rmToken, body: { status: 'Approved' } });
    const done = await api('PATCH', `/api/regional-ops/${st.json.record.id}`, { token: rmToken, body: { status: 'Completed' } });
    assert(done.status === 200 && done.json.record.status === 'Completed', '5: the approved staff transfer is completed');
    const moved = (await api('GET', '/api/users?limit=200', { token: opsToken })).json.users.find(u => u.id === 'usr_officer');
    assert(moved.branch_id === 'br_mombasa', '5: completing the transfer really moves the officer to the new branch');

    // Client transfer: a Ukunda client moves to Mombasa under that officer.
    const c = await api('POST', '/api/clients', { token: opsToken, body: { name: 'Transfer Test Client', phone: '0799123456', branch_id: 'br_kisumu' } });
    const clientId = c.json && (c.json.client ? c.json.client.id : c.json.id);
    assert(c.status === 201 && clientId, '5: setup — a Ukunda client exists');
    const noOfficer = await api('POST', '/api/regional-ops', { token: rmToken, body: { kind: 'transfer', title: 'Client move', subject_type: 'client', subject_id: clientId, to_branch_id: 'br_mombasa' } });
    assert(noOfficer.status === 400, '5: a client transfer must name a loan officer at the destination branch');
    const ct = await api('POST', '/api/regional-ops', { token: rmToken, body: { kind: 'transfer', title: 'Client to Mombasa', subject_type: 'client', subject_id: clientId, to_branch_id: 'br_mombasa', to_officer_id: 'usr_officer' } });
    assert(ct.status === 201, '5: a client transfer within the region is requested');
    await api('PATCH', `/api/regional-ops/${ct.json.record.id}`, { token: rmToken, body: { status: 'Approved' } });
    const cdone = await api('PATCH', `/api/regional-ops/${ct.json.record.id}`, { token: rmToken, body: { status: 'Completed' } });
    const after = (await api('GET', '/api/clients', { token: opsToken })).json.clients.find(x => x.id === clientId);
    assert(cdone.status === 200 && after.branch_id === 'br_mombasa' && after.officer_id === 'usr_officer', '5: completing it really moves the client to the new branch and officer');

    // The officer now has an active client — moving them again is blocked.
    const back = await api('POST', '/api/regional-ops', { token: rmToken, body: { kind: 'transfer', title: 'Officer back', subject_type: 'staff', subject_id: 'usr_officer', to_branch_id: 'br_kisumu' } });
    await api('PATCH', `/api/regional-ops/${back.json.record.id}`, { token: rmToken, body: { status: 'Approved' } });
    const blocked = await api('PATCH', `/api/regional-ops/${back.json.record.id}`, { token: rmToken, body: { status: 'Completed' } });
    assert(blocked.status === 400 && /client\(s\) first/.test(blocked.json.error), '5: an officer still holding clients cannot be moved until their clients are reassigned');
    const still = (await api('GET', '/api/users?limit=200', { token: opsToken })).json.users.find(u => u.id === 'usr_officer');
    assert(still.branch_id === 'br_mombasa', '5: the blocked transfer changed nothing');
  }

  // 6. Activity log is region-only
  {
    const act = await api('GET', '/api/regional-ops/activity', { token: rmToken });
    assert(act.status === 200 && act.json.activity.length > 0, '6: the RM sees their region\'s activity');
    const regionBranches = ['br_kisumu','br_mombasa','br_kwale','br_changamwe','br_msambweni','br_lungalunga','br_kinango','br_minjila'];
    assert(act.json.activity.every(a => !a.branchId || regionBranches.includes(a.branchId)), '6: no activity from outside the region is included');
    assert(!act.json.activity.some(a => a.user === 'Esther Wanjiku' || a.branchId === 'br_nairobi'), '6: activity by staff in other regions is excluded');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
