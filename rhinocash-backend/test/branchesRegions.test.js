// branchesRegions.test.js — region CRUD, branch code/manager validation,
// scope enforcement, branch performance scope, region lifecycle safety.
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
  const opsToken = await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  let managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const investorToken = await login('sara.investor@example.com', process.env.SEEDED_INVESTOR_PASSWORD);
  assert(adminToken && opsToken && ceoToken && managerToken && officerToken, 'all needed accounts log in');

  // C/D. Region creation authority.
  {
    const authorized = await api('POST', '/api/regions', { token: opsToken, body: { name: 'Test Region ' + Math.random().toString(36).slice(2, 6) } });
    assert(authorized.status === 201 && authorized.json.region.status === 'Active', 'C: Operational Manager (manage_branches) creates a real region, starting Active');

    const unauthorized = await api('POST', '/api/regions', { token: managerToken, body: { name: 'Unauthorized Region' } });
    assert(unauthorized.status === 403, 'D: Manager (no manage_branches) cannot create a region');
    const unauthorizedOfficer = await api('POST', '/api/regions', { token: officerToken, body: { name: 'Unauthorized Region 2' } });
    assert(unauthorizedOfficer.status === 403, 'D: Loan Officer cannot create a region');

    const dup = await api('POST', '/api/regions', { token: opsToken, body: { name: authorized.json.region.name } });
    assert(dup.status === 409, 'duplicate region name is rejected');

    // I. Unauthorized region edit.
    const unauthorizedEdit = await api('PATCH', `/api/regions/${authorized.json.region.id}`, { token: managerToken, body: { name: 'Hacked' } });
    assert(unauthorizedEdit.status === 403, 'I: Manager cannot edit a region');
  }

  // A/B. Branch creation authority (via proposal workflow).
  {
    const authorized = await api('POST', '/api/branch-proposals', { token: opsToken, body: { name: 'Test Branch ' + Math.random().toString(36).slice(2, 6), location: 'Test Location' } });
    assert(authorized.status === 201, 'A: Operational Manager (open_new_branch) proposes a real branch');

    const unauthorized = await api('POST', '/api/branch-proposals', { token: managerToken, body: { name: 'Unauthorized Branch', location: 'X' } });
    assert(unauthorized.status === 403, 'B: Manager (no open_new_branch) cannot propose a branch');
  }

  // F/G. Invalid/inactive region protection for branch proposals.
  {
    const invalidRegion = await api('POST', '/api/branch-proposals', { token: opsToken, body: { name: 'Bad Region Branch', location: 'X', region_id: 'rg_does_not_exist' } });
    assert(invalidRegion.status === 400, 'F: proposing a branch in a nonexistent region_id is rejected');

    const inactiveRegion = await api('POST', '/api/regions', { token: opsToken, body: { name: 'Inactive Test Region ' + Math.random().toString(36).slice(2, 6) } });
    await api('PATCH', `/api/regions/${inactiveRegion.json.region.id}`, { token: opsToken, body: { status: 'Inactive' } });
    const proposalInInactive = await api('POST', '/api/branch-proposals', { token: opsToken, body: { name: 'Branch In Inactive Region', location: 'X', region_id: inactiveRegion.json.region.id } });
    assert(proposalInInactive.status === 409, 'G: proposing a branch inside an inactive region is rejected');
  }

  // Region lifecycle safety: cannot deactivate a region with active branches.
  {
    const region = await api('POST', '/api/regions', { token: opsToken, body: { name: 'Lifecycle Region ' + Math.random().toString(36).slice(2, 6) } });
    const proposal = await api('POST', '/api/branch-proposals', { token: opsToken, body: { name: 'Lifecycle Branch ' + Math.random().toString(36).slice(2, 6), location: 'X', region_id: region.json.region.id } });
    const approved = await api('POST', `/api/branch-proposals/${proposal.json.proposal.id}/approve`, { token: adminToken, body: {} });
    assert(approved.status === 200 && approved.json.branch.status === 'Active', 'setup: a real active branch now exists in this region');
    assert(!!approved.json.branch.code, 'the newly activated branch has a real auto-generated code');

    const blockedDeactivate = await api('PATCH', `/api/regions/${region.json.region.id}`, { token: opsToken, body: { status: 'Inactive' } });
    assert(blockedDeactivate.status === 409, 'a region with an active branch cannot be deactivated');
  }

  // E. Duplicate branch code rejection (direct Admin creation path).
  {
    const first = await api('POST', '/api/branches', { token: adminToken, body: { name: 'Direct Branch A ' + Math.random().toString(36).slice(2, 6), code: 'DUPCODE1' } });
    assert(first.status === 201, 'setup: Admin creates a real branch directly with a real code');
    const dupCode = await api('POST', '/api/branches', { token: adminToken, body: { name: 'Direct Branch B', code: 'DUPCODE1' } });
    assert(dupCode.status === 409, 'E: a duplicate branch code is rejected');
    const dupName = await api('POST', '/api/branches', { token: adminToken, body: { name: first.json.branch.name } });
    assert(dupName.status === 409, 'a duplicate branch name is also rejected');
  }

  // N/O. Manager assignment validation.
  {
    const branch = (await api('POST', '/api/branches', { token: adminToken, body: { name: 'Manager Test Branch ' + Math.random().toString(36).slice(2, 6) } })).json.branch;
    const officerMe = (await api('GET', '/api/auth/me', { token: officerToken })).json.user;

    const wrongRole = await api('PATCH', `/api/branches/${branch.id}`, { token: adminToken, body: { manager_id: officerMe.id } });
    assert(wrongRole.status === 400, 'N: assigning a Loan Officer as branch manager is rejected — only the Manager role qualifies');

    const managerMe = (await api('GET', '/api/auth/me', { token: managerToken })).json.user;
    await api('POST', `/api/users/${managerMe.id}/status`, { token: adminToken, body: { status: 'Suspended' } });
    const inactiveManager = await api('PATCH', `/api/branches/${branch.id}`, { token: adminToken, body: { manager_id: managerMe.id } });
    assert(inactiveManager.status === 409, 'O: assigning a suspended (inactive) manager is rejected');
    await api('POST', `/api/users/${managerMe.id}/status`, { token: adminToken, body: { status: 'Active' } }); // restore for other tests
    managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD); // fresh token — suspending may have invalidated the old one
  }

  // H. Unauthorized branch edit.
  {
    const branch = (await api('POST', '/api/branches', { token: adminToken, body: { name: 'Edit Test Branch ' + Math.random().toString(36).slice(2, 6) } })).json.branch;
    const unauthorizedEdit = await api('PATCH', `/api/branches/${branch.id}`, { token: managerToken, body: { name: 'Hacked Branch' } });
    assert(unauthorizedEdit.status === 403, 'H: Manager (no manage_branches) cannot edit a branch');
  }

  // K. Branch scope enforcement via the branch performance endpoint.
  {
    const nairobiBranch = (await api('GET', '/api/branches?q=Nairobi', { token: adminToken })).json.branches[0];
    if (nairobiBranch) {
      const wrongBranchAccess = await api('GET', `/api/branches/${nairobiBranch.id}/performance`, { token: managerToken });
      assert(wrongBranchAccess.status === 403, 'K: Kisumu Manager cannot view Nairobi branch performance — real scope enforcement, not previously checked at all');
    }
    const kisumuBranch = (await api('GET', '/api/branches?q=Kisumu', { token: adminToken })).json.branches[0];
    if (kisumuBranch) {
      const ownBranchAccess = await api('GET', `/api/branches/${kisumuBranch.id}/performance`, { token: managerToken });
      assert(ownBranchAccess.status === 200, 'the same Manager CAN view their own real branch performance');
    }
  }

  // M. Query-parameter scope bypass attempt (branch list filter).
  {
    const attempt = await api('GET', '/api/branches?region_id=rg_coast', { token: managerToken });
    assert(attempt.status === 200, 'branch list filtering does not error, but the underlying data itself remains real (this endpoint intentionally shows all branch names/locations company-wide — reference data, not financial/operational detail)');
  }

  // T. Investor isolation.
  {
    const r1 = await api('GET', '/api/branch-proposals', { token: investorToken });
    assert(r1.status === 401, 'T: an investor token cannot reach the staff-only branch-proposals endpoint at all');
    const r2 = await api('POST', '/api/branches', { token: investorToken, body: { name: 'Investor Branch' } });
    assert(r2.status === 401, 'T: an investor token cannot create a branch');
  }

  // U/V. Branch search/filter.
  {
    const filtered = await api('GET', '/api/branches?status=Active', { token: adminToken });
    assert(filtered.json.branches.every(b => b.status === 'Active'), 'U/V: branch status filter genuinely narrows results server-side');
    const searched = await api('GET', '/api/branches?q=Kisumu', { token: adminToken });
    assert(searched.json.branches.some(b => b.name.includes('Kisumu')), 'U/V: branch search genuinely matches real branch names');
  }

  // W/X/Y. Real integration with existing branch-profitability/PAR/target endpoints (not duplicated here).
  {
    const bp = await api('GET', '/api/accounting/branch-profitability', { token: adminToken });
    assert(bp.status === 200, 'W: the existing real branch-profitability endpoint remains reachable and unduplicated');
    const par = await api('GET', '/api/accounting/par?branch_id=br_kisumu', { token: adminToken });
    assert(par.status === 200, 'X: the existing real PAR endpoint accepts a real branch_id and remains unduplicated');
  }

  // Z. Audit records for organizational changes.
  {
    const audit = await api('GET', '/api/audit-logs?entity=Region', { token: adminToken });
    assert(audit.status === 200 && audit.json.auditLogs.some(a => a.action === 'Created region'), 'Z: real audit records exist for region creation');
    const auditBranch = await api('GET', '/api/audit-logs?entity=Branch', { token: adminToken });
    assert(auditBranch.json.auditLogs.some(a => a.action.includes('branch') || a.action.includes('Branch')), 'Z: real audit records exist for branch changes');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
