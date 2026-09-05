// branchExpansion.test.js — tests the Open New Branch workflow specifically:
// proposal -> approval/rejection -> real branch activation. Run against a
// live server seeded with `node seed.js --demo`.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
}
async function login(email, password) {
  const r = await api('POST', '/api/auth/login', { body: { email, password } });
  return r.json && r.json.token;
}

(async () => {
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const opsMgrToken = await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD);
  const managerToken = await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  assert(adminToken && opsMgrToken && managerToken && ceoToken, 'all needed accounts log in');

  // A plain Manager (no open_new_branch permission) cannot even propose.
  const blocked = await api('POST', '/api/branch-proposals', { token: managerToken, body: { name: 'Nakuru', location: 'Nakuru' } });
  assert(blocked.status === 403, 'a Manager without open_new_branch permission cannot propose a branch');

  // Operational Manager proposes a new branch — no branches row exists yet.
  const branchesBefore = await api('GET', '/api/branches', { token: adminToken });
  const countBefore = branchesBefore.json.branches.length;
  const proposal = await api('POST', '/api/branch-proposals', {
    token: opsMgrToken,
    body: { name: 'Nakuru', location: 'Nakuru Town', justification: 'High loan demand from boda boda operators', budget: 1200000 },
  });
  assert(proposal.status === 201 && proposal.json.proposal.status === 'Proposed', 'Operational Manager proposes a new branch');
  const proposalId = proposal.json.proposal.id;

  const branchesDuring = await api('GET', '/api/branches', { token: adminToken });
  assert(branchesDuring.json.branches.length === countBefore, 'no real branch exists yet — proposal alone does not create one');

  // The proposer cannot approve their own proposal.
  const selfApprove = await api('POST', `/api/branch-proposals/${proposalId}/approve`, { token: opsMgrToken, body: {} });
  assert(selfApprove.status === 403, 'Operational Manager cannot approve their own branch proposal');

  // A Manager (not Admin/CEO) cannot approve either.
  const wrongApprover = await api('POST', `/api/branch-proposals/${proposalId}/approve`, { token: managerToken, body: {} });
  assert(wrongApprover.status === 403, 'an ordinary Manager cannot approve a branch proposal — only Admin/CEO can');

  // CEO approves — this is where the real branch row is created.
  const approved = await api('POST', `/api/branch-proposals/${proposalId}/approve`, { token: ceoToken, body: { reason: 'Approved — strong feasibility case' } });
  assert(approved.status === 200 && approved.json.proposal.status === 'Activated', 'CEO approves the proposal, which activates it');
  assert(approved.json.branch && approved.json.branch.status === 'Active', 'a real, active branch row now exists');
  const newBranchId = approved.json.branch.id;

  const branchesAfter = await api('GET', '/api/branches', { token: adminToken });
  assert(branchesAfter.json.branches.length === countBefore + 1, 'the branch list now genuinely has one more entry');
  assert(branchesAfter.json.branches.some(b => b.id === newBranchId && b.name === 'Nakuru'), 'the new branch is really there with the proposed name');

  // Double-approval is rejected.
  const doubleApprove = await api('POST', `/api/branch-proposals/${proposalId}/approve`, { token: adminToken, body: {} });
  assert(doubleApprove.status === 409, 'an already-activated proposal cannot be approved again');

  // Rejection path, separately.
  const proposal2 = await api('POST', '/api/branch-proposals', { token: opsMgrToken, body: { name: 'Turkana', location: 'Lodwar', justification: 'Speculative — low feasibility' } });
  const rejected = await api('POST', `/api/branch-proposals/${proposal2.json.proposal.id}/reject`, { token: adminToken, body: { reason: 'Feasibility study incomplete' } });
  assert(rejected.status === 200 && rejected.json.proposal.status === 'Rejected', 'Admin can reject a proposal with a reason');
  const branchesAfterReject = await api('GET', '/api/branches', { token: adminToken });
  assert(branchesAfterReject.json.branches.length === countBefore + 1, 'a rejected proposal never creates a branch row');

  // Branch closure blocked while active loans exist; allowed once clear.
  const closeAttempt = await api('POST', `/api/branches/${newBranchId}/close`, { token: adminToken, body: { reason: 'Underperforming' } });
  assert(closeAttempt.status === 200, 'a brand-new branch with zero active loans can be closed');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
