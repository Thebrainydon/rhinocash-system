// employeesExtras.test.js — Manager sidebar additions: Client Groups
// (Clients > Default Groups), System Announcements, and the team-wide
// Daily Workplan view (Employees > Daily Workplan).
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
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const nairobiManagerToken = await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  assert(adminToken && managerToken && nairobiManagerToken && officerToken, 'all needed accounts log in');

  // ---- Client Groups ----
  let kisumuClientId, groupId;
  {
    const phone = '07' + Math.floor(Math.random() * 90000000 + 10000000);
    const r = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Group Member Alpha', phone } });
    assert(r.status === 201, 'setup: a real Kisumu client is created for group membership');
    kisumuClientId = r.json.client.id;
  }
  {
    const r = await api('POST', '/api/client-groups', { token: managerToken, body: { name: 'Test Chama', meeting_day: 'Monday', member_ids: [kisumuClientId] } });
    assert(r.status === 201, 'the Kisumu Manager genuinely creates a real client group');
    assert(r.json.group.branch_id, 'the new group is genuinely persisted with a real branch_id, not left null');
    assert(r.json.group.members.length === 1 && r.json.group.members[0].id === kisumuClientId, 'the real member is genuinely attached to the group');
    groupId = r.json.group.id;
  }
  {
    const r = await api('GET', '/api/client-groups', { token: managerToken });
    assert(r.status === 200 && r.json.groups.some(g => g.id === groupId), 'the Kisumu Manager genuinely sees the real group they just created, from a fresh GET — not just the create response');
  }
  {
    const r = await api('GET', '/api/client-groups', { token: nairobiManagerToken });
    assert(r.status === 200 && !r.json.groups.some(g => g.id === groupId), 'a Nairobi Manager (different branch) genuinely does NOT see the Kisumu group — real branch scope, not a client-side filter');
  }
  {
    const nairobiPhone = '07' + Math.floor(Math.random() * 90000000 + 10000000);
    const rc = await api('POST', '/api/clients', { token: nairobiManagerToken, body: { name: 'Nairobi Outsider', phone: nairobiPhone } });
    const outsiderId = rc.json.client.id;
    const r = await api('POST', '/api/client-groups', { token: managerToken, body: { name: 'Cross-Branch Attempt', member_ids: [outsiderId] } });
    assert(r.status === 403, 'a Manager genuinely cannot add a real client from a different branch into their own group — real scope check, not merely a UI restriction');
  }

  // ---- System Announcements ----
  let annId;
  {
    const r = await api('POST', '/api/announcements', { token: adminToken, body: { title: 'Scheduled Maintenance', body: 'The system will be briefly unavailable Sunday 2am-3am EAT.' } });
    assert(r.status === 201, 'Admin genuinely posts a real system announcement');
    annId = r.json.announcement.id;
  }
  {
    const r = await api('POST', '/api/announcements', { token: managerToken, body: { title: 'Should be blocked', body: 'x' } });
    assert(r.status === 403, 'a Manager (no manage_system_settings) is genuinely rejected posting an announcement — Admin-only, not merely hidden in the UI');
  }
  {
    const r = await api('GET', '/api/announcements', { token: managerToken });
    assert(r.status === 200 && r.json.announcements.some(a => a.id === annId), 'the Manager genuinely sees the real Admin-posted announcement — broadcast to every authenticated user');
  }
  {
    const r = await api('GET', '/api/announcements', { token: officerToken });
    assert(r.status === 200 && r.json.announcements.some(a => a.id === annId), 'a Loan Officer genuinely sees the same real announcement too — truly company-wide, not role-gated');
  }

  // ---- Team Daily Workplan ----
  const today = new Date().toISOString().slice(0, 10);
  {
    const r = await api('POST', '/api/workplans/me', { token: officerToken, body: { date: today, collectionTarget: 5, collectionLocations: 'Kondele Market' } });
    assert(r.status === 201, 'setup: the real Kisumu officer (reports to the Kisumu Manager) saves a real own workplan for today');
  }
  {
    const r = await api('GET', `/api/workplans?date=${today}`, { token: managerToken });
    assert(r.status === 200, 'the Kisumu Manager genuinely loads their real team workplan view');
    const mine = r.json.staff.find(s => s.userName === 'Peter Otieno');
    assert(!!mine, 'the real direct-report officer genuinely appears in the Manager\'s team workplan list');
    assert(mine.collection.target === 5, 'the real target the officer just saved genuinely shows up in the Manager\'s aggregate view, not a stale/fabricated default');
    assert(mine.collection.locations === 'Kondele Market', 'the real planned location genuinely carries through too');
  }
  {
    const r = await api('GET', `/api/workplans?date=${today}`, { token: nairobiManagerToken });
    assert(r.status === 200 && !r.json.staff.some(s => s.userName === 'Peter Otieno'), 'a Nairobi Manager (not this officer\'s reporting manager) genuinely does NOT see the Kisumu officer in their own team view — real reporting-line scope');
  }
  {
    const r = await api('GET', `/api/workplans?date=${today}`, { token: adminToken });
    assert(r.status === 200 && r.json.staff.some(s => s.userName === 'Peter Otieno'), 'an Admin (manage_users) genuinely sees every real active staff member\'s workplan, including this officer\'s');
  }

  // ---- Team Daily Workplan "+ Create" (Manager setting a real workplan on behalf of a direct report) ----
  const officerMe = (await api('GET', '/api/auth/me', { token: officerToken })).json.user;
  {
    const r = await api('POST', `/api/workplans/${officerMe.id}`, { token: managerToken, body: { date: today, onboardingTarget: 3, onboardingLocations: 'Nyalenda' } });
    assert(r.status === 201, 'the Kisumu Manager genuinely creates a real workplan on behalf of their real direct report, through the real "+ Create" endpoint');
    assert(r.json.plan.onboarding.target === 3, 'the real target just set genuinely persists');
  }
  {
    const check = await api('GET', `/api/workplans?date=${today}`, { token: managerToken });
    const mine = check.json.staff.find(s => s.userId === officerMe.id);
    assert(mine.onboarding.target === 3 && mine.onboarding.locations === 'Nyalenda', 'the Manager-set workplan genuinely shows up in a fresh real GET, not just the create response');
  }
  {
    const r = await api('POST', `/api/workplans/${officerMe.id}`, { token: nairobiManagerToken, body: { date: today, onboardingTarget: 9 } });
    assert(r.status === 403, 'a Manager who is NOT this officer\'s real reporting manager is genuinely rejected setting their workplan — real reporting-line authorization, not merely a UI restriction');
  }
  {
    const r = await api('POST', `/api/workplans/${officerMe.id}`, { token: adminToken, body: { date: today, onboardingTarget: 7 } });
    assert(r.status === 201, 'an Admin (manage_users) genuinely can also set any real staff member\'s workplan');
  }
  {
    const r = await api('POST', '/api/workplans/nonexistent-user-id', { token: managerToken, body: { date: today } });
    assert(r.status === 404, 'setting a workplan for a real nonexistent user id is genuinely rejected, not silently accepted');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
