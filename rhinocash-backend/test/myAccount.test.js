// myAccount.test.js — self-update endpoint restrictions, mine=1 target
// filtering, and confirming no self-approval loophole in leave/salary-advance.
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

(async () => {
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  const directorToken = await login('director@rhinocash.co.ke', process.env.SEEDED_DIRECTOR_PASSWORD);
  assert(officerToken && managerToken && adminToken, 'all needed accounts log in');

  // Real self-update: only phone/email change, everything else silently ignored.
  {
    const before = await api('GET', '/api/auth/me', { token: officerToken });
    const update = await api('PATCH', '/api/auth/me', { token: officerToken, body: { phone: '0722555111', email: 'newemail@test.co.ke', role_id: 'admin', branch_id: 'br_nairobi', access_level: 'Full Access', status: 'Active' } });
    assert(update.status === 200 && update.json.user.phone === '0722555111', 'a real self-update changes the permitted phone field');
    assert(update.json.user.role_id === before.json.user.role_id, 'role_id is genuinely unchanged despite being present in the request body — real backend allow-list, not frontend hiding');
    assert(update.json.user.branch_id === before.json.user.branch_id, 'branch_id is genuinely unchanged despite being present in the request body');
    assert(update.json.user.access_level === before.json.user.access_level, 'access_level is genuinely unchanged despite being present in the request body');

    const empty = await api('PATCH', '/api/auth/me', { token: officerToken, body: { role_id: 'admin' } });
    assert(empty.status === 400, 'a self-update request containing only disallowed fields is rejected outright, not silently accepted as a no-op');
  }

  // Cross-user attempt: cannot self-update via another user's token pretending scope.
  {
    const meOfficer = (await api('GET', '/api/auth/me', { token: officerToken })).json.user;
    const meManager = (await api('GET', '/api/auth/me', { token: managerToken })).json.user;
    assert(meOfficer.id !== meManager.id, 'sanity: these are genuinely different real users');
    // PATCH /api/auth/me always targets req.user (the authenticated caller) — there is no id param to manipulate.
    const managerSelfUpdate = await api('PATCH', '/api/auth/me', { token: managerToken, body: { phone: '0733999888' } });
    assert(managerSelfUpdate.json.user.id === meManager.id, 'a self-update always targets the real authenticated caller\'s own record, structurally — there is no id parameter to redirect it elsewhere');
  }

  // Real mine=1 target filtering.
  {
    const allTargets = await api('GET', '/api/targets', { token: adminToken });
    const mineTargets = await api('GET', '/api/targets?mine=1', { token: officerToken });
    assert(mineTargets.status === 200 && Array.isArray(mineTargets.json.targets), 'the real mine=1 filter on /api/targets returns a real array');
    const officerMe = (await api('GET', '/api/auth/me', { token: officerToken })).json.user;
    assert(mineTargets.json.targets.every(t => t.recipient_user_id === officerMe.id), 'every target returned by mine=1 genuinely belongs to the real authenticated caller only');
  }

  // Confirm no self-approval loophole exists for leave/salary-advance (already-existing engine, re-verified here in this module's context).
  {
    const leave = await api('POST', '/api/leave-requests', { token: officerToken, body: { leave_type: 'Annual', start_date: '2026-12-01', end_date: '2026-12-03' } });
    assert(leave.status === 201, 'a real leave request is created');
    const selfDecide = await api('POST', `/api/leave-requests/${leave.json.leaveRequest.id}/decide`, { token: officerToken, body: { decision: 'Approved' } });
    assert(selfDecide.status === 403, 'the real requester cannot approve their own leave request — no self-approval loophole via My Account');

    const advance = await api('POST', '/api/salary-advances', { token: officerToken, body: { amount: 5000 } });
    const selfDecideAdvance = await api('POST', `/api/salary-advances/${advance.json.salaryAdvance.id}/decide`, { token: officerToken, body: { decision: 'Approved' } });
    assert(selfDecideAdvance.status === 403, 'the real requester cannot approve their own salary advance — no self-approval loophole');
  }

  // Real Board Resolutions and Equity Holdings — genuinely new governance backend.
  {
    assert(ceoToken && directorToken, 'CEO and Director accounts log in for the real governance lifecycle test');

    const unauthorizedPropose = await api('POST', '/api/governance/resolutions', { token: adminToken, body: { title: 'Test resolution' } });
    assert(unauthorizedPropose.status === 403, 'Admin cannot propose a board resolution — only CEO/Director hold that authority');
    const unauthorizedView = await api('GET', '/api/governance/resolutions', { token: officerToken });
    assert(unauthorizedView.status === 403, 'a Loan Officer has no governance visibility at all');

    const proposed = await api('POST', '/api/governance/resolutions', { token: ceoToken, body: { title: 'Approve new loan product pilot', description: 'Pilot a group-lending product in Kisumu' } });
    assert(proposed.status === 201 && proposed.json.resolution.status === 'Proposed', 'CEO can propose a real board resolution, starting Proposed');

    const selfDecide = await api('POST', `/api/governance/resolutions/${proposed.json.resolution.id}/decide`, { token: ceoToken, body: { decision: 'Approved' } });
    assert(selfDecide.status === 403, 'the CEO cannot decide on their own proposed resolution — real segregation of duties');

    const managerDecide = await api('POST', `/api/governance/resolutions/${proposed.json.resolution.id}/decide`, { token: managerToken, body: { decision: 'Approved' } });
    assert(managerDecide.status === 403, 'a Manager has no authority to decide on a board resolution at all');

    const decided = await api('POST', `/api/governance/resolutions/${proposed.json.resolution.id}/decide`, { token: directorToken, body: { decision: 'Approved' } });
    assert(decided.status === 200 && decided.json.resolution.status === 'Approved', 'Director, a different real user, can decide on the CEO\'s real resolution');

    const doubleDecide = await api('POST', `/api/governance/resolutions/${proposed.json.resolution.id}/decide`, { token: directorToken, body: { decision: 'Rejected' } });
    assert(doubleDecide.status === 409, 'an already-decided resolution cannot be decided again');

    // Equity Holdings — real percentage-integrity check.
    const equityDenied = await api('POST', '/api/governance/equity', { token: officerToken, body: { holder_name: 'Test', holder_type: 'Founder', percentage: 10 } });
    assert(equityDenied.status === 403, 'a Loan Officer cannot record an equity holding');

    const founder = await api('POST', '/api/governance/equity', { token: directorToken, body: { holder_name: 'Founder A', holder_type: 'Founder', percentage: 60, capital_contributed: 5000000 } });
    assert(founder.status === 201, 'Director can record a real equity holding');

    const overCap = await api('POST', '/api/governance/equity', { token: directorToken, body: { holder_name: 'Investor Pool', holder_type: 'Investor', percentage: 50 } });
    assert(overCap.status === 409, 'recording equity that would push total holdings past 100% is rejected — real accounting integrity check');

    const withinCap = await api('POST', '/api/governance/equity', { token: adminToken, body: { holder_name: 'Investor Pool', holder_type: 'Investor', percentage: 30 } });
    assert(withinCap.status === 201, 'Admin can also record equity within the real remaining headroom');

    const list = await api('GET', '/api/governance/equity', { token: directorToken });
    assert(list.status === 200 && Math.abs(list.json.totalPercentage - 90) < 0.01, 'the real total equity percentage across all real holdings is correctly summed (60 + 30 = 90)');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
