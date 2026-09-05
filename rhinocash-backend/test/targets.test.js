// targets.test.js — the real target/performance hierarchy: Manager sets
// Loan Officer targets, Regional Manager sets Manager targets, Operational
// Manager sets Regional Manager targets, CEO/Director set management-level
// targets — with real branch/region scope enforcement at every level.
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
  const managerToken = await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD); // Nairobi
  const managerKisumuToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const regionalToken = await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD); // covers Kisumu+Mombasa
  const opsMgrToken = await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD); // Kisumu
  assert(adminToken && managerToken && managerKisumuToken && regionalToken && opsMgrToken && ceoToken && officerToken, 'all needed accounts log in');

  const officerMe = await api('GET', '/api/auth/me', { token: officerToken });
  const officerId = officerMe.json.user.id;
  const managerKisumuMe = await api('GET', '/api/auth/me', { token: managerKisumuToken });
  const managerKisumuId = managerKisumuMe.json.user.id;
  const regionalMe = await api('GET', '/api/auth/me', { token: regionalToken });
  const regionalId = regionalMe.json.user.id;

  const period = new Date().toISOString().slice(0, 7); // current YYYY-MM

  // =========================================================
  // 1. LOAN OFFICER CANNOT SET TARGETS
  // =========================================================
  {
    const attempt = await api('POST', '/api/targets', { token: officerToken, body: { metric: 'disbursement', recipient_user_id: managerKisumuId, target_value: 100000, period } });
    assert(attempt.status === 403, 'Loan Officer cannot set any target (403)');
  }

  // =========================================================
  // 2. MANAGER SETS LOAN OFFICER TARGET — real create, real scope
  // =========================================================
  {
    const wrongBranch = await api('POST', '/api/targets', { token: managerToken, body: { metric: 'disbursement', recipient_user_id: officerId, target_value: 200000, period } });
    assert(wrongBranch.status === 403, 'Nairobi Manager cannot set a target for a Kisumu-branch Loan Officer (out of their branch scope)');

    const created = await api('POST', '/api/targets', { token: managerKisumuToken, body: { metric: 'disbursement', recipient_user_id: officerId, target_value: 250000, period, notes: 'Q3 push' } });
    assert(created.status === 201 && created.json.target.target_value === 250000, 'Kisumu Manager sets a real disbursement target for their own Loan Officer');
    const targetId = created.json.target.id;

    const badMetric = await api('POST', '/api/targets', { token: managerKisumuToken, body: { metric: 'nonsense', recipient_user_id: officerId, target_value: 1000, period } });
    assert(badMetric.status === 400, 'an invalid metric is rejected with a validation error');

    const badValue = await api('POST', '/api/targets', { token: managerKisumuToken, body: { metric: 'disbursement', recipient_user_id: officerId, target_value: -50, period } });
    assert(badValue.status === 400, 'a negative target value is rejected with a validation error');

    const badPeriod = await api('POST', '/api/targets', { token: managerKisumuToken, body: { metric: 'disbursement', recipient_user_id: officerId, target_value: 1000, period: 'not-a-period' } });
    assert(badPeriod.status === 400, 'an invalid period format is rejected with a validation error');

    // A Manager cannot set a target for a Manager (wrong recipient role for their level).
    const wrongRole = await api('POST', '/api/targets', { token: managerKisumuToken, body: { metric: 'disbursement', recipient_user_id: managerKisumuId, target_value: 1000, period } });
    assert(wrongRole.status === 403, 'a Manager cannot set a target for another Manager — only Loan Officers are in their allowed recipient roles');

    // Real persistence + real visibility to the recipient.
    const recipientView = await api('GET', '/api/targets', { token: officerToken });
    assert(recipientView.json.targets.some(t => t.id === targetId), 'the real Loan Officer can see the real target that was set for them');

    // An unrelated Loan Officer (different branch) cannot see it.
    // (No second officer seeded by default in --demo beyond this one branch/role combo,
    // so instead confirm a totally unrelated Manager — not the setter, not the recipient — cannot see it.)
    const unrelatedView = await api('GET', '/api/targets', { token: managerToken });
    assert(!unrelatedView.json.targets.some(t => t.id === targetId), 'a Manager from a different branch does not see this target in their own list');

    // Real audit trail, no secret values needed here but real change record.
    const audit = await api('GET', '/api/audit-logs?entity=Target', { token: adminToken });
    assert(audit.json.auditLogs.some(a => a.record_id === targetId && a.action === 'Set target'), 'a real audit record exists for the target creation');

    // Real notification to the recipient.
    const notifs = await api('GET', '/api/notifications', { token: officerToken });
    assert(notifs.json.notifications.some(n => n.title === 'New target set'), 'the recipient received a real notification when the target was set');

    // Update + cancel, real API.
    const updated = await api('PATCH', `/api/targets/${targetId}`, { token: managerKisumuToken, body: { target_value: 300000 } });
    assert(updated.status === 200 && updated.json.target.target_value === 300000, 'the setter can update the real target value');
    const wrongUpdater = await api('PATCH', `/api/targets/${targetId}`, { token: officerToken, body: { target_value: 1 } });
    assert(wrongUpdater.status === 403, 'the recipient (not the setter) cannot edit the target value');
    const cancelled = await api('POST', `/api/targets/${targetId}/cancel`, { token: managerKisumuToken, body: { reason: 'superseded' } });
    assert(cancelled.status === 200, 'the setter can cancel the target');
    const afterCancel = await api('GET', '/api/targets', { token: officerToken });
    assert(!afterCancel.json.targets.some(t => t.id === targetId), 'a cancelled target no longer appears in the active target list');
  }

  // =========================================================
  // 3. REGIONAL MANAGER SETS MANAGER TARGET
  // =========================================================
  {
    const wrongRegion = await api('POST', '/api/targets', { token: regionalToken, body: { metric: 'collection', recipient_user_id: (await api('GET', '/api/auth/me', { token: managerToken })).json.user.id, target_value: 500000, period } });
    assert(wrongRegion.status === 403, 'Regional Manager (Coast & Western) cannot target the Nairobi (Central region) Manager — out of region scope');

    const created = await api('POST', '/api/targets', { token: regionalToken, body: { metric: 'collection', recipient_user_id: managerKisumuId, target_value: 800000, period } });
    assert(created.status === 201, 'Regional Manager sets a real target for a Manager within their own region');

    const managerSees = await api('GET', '/api/targets', { token: managerKisumuToken });
    assert(managerSees.json.targets.some(t => t.id === created.json.target.id), 'the Manager can see the real target their Regional Manager set for them');
  }

  // =========================================================
  // 4. OPERATIONAL MANAGER SETS REGIONAL MANAGER TARGET
  // =========================================================
  {
    const created = await api('POST', '/api/targets', { token: opsMgrToken, body: { metric: 'portfolio', recipient_user_id: regionalId, target_value: 5000000, period } });
    assert(created.status === 201, 'Operational Manager sets a real target for a Regional Manager (company-wide operational authority)');
    const regionalSees = await api('GET', '/api/targets', { token: regionalToken });
    assert(regionalSees.json.targets.some(t => t.id === created.json.target.id), 'the Regional Manager can see the real target their Operational Manager set for them');

    // Operational Manager cannot target a Loan Officer directly (not in their allowed recipient roles).
    const wrongLevel = await api('POST', '/api/targets', { token: opsMgrToken, body: { metric: 'new_loans', recipient_user_id: officerId, target_value: 10, period } });
    assert(wrongLevel.status === 403, 'Operational Manager cannot set a target directly for a Loan Officer — only for Regional Managers');
  }

  // =========================================================
  // 5. CEO/DIRECTOR — HIGH-LEVEL ORGANIZATIONAL TARGETS
  // =========================================================
  {
    const opsMgrMe = await api('GET', '/api/auth/me', { token: opsMgrToken });
    const created = await api('POST', '/api/targets', { token: ceoToken, body: { metric: 'disbursement', recipient_user_id: opsMgrMe.json.user.id, target_value: 20000000, period_type: 'quarterly', period: period.slice(0,4)+'-Q3' } });
    assert(created.status === 201, 'CEO sets a real high-level target for the Operational Manager, with a quarterly period');
    assert(created.json.target.period_type === 'quarterly', 'quarterly period_type is genuinely stored');

    // Branch/region-aggregate target (no individual recipient).
    const branchTarget = await api('POST', '/api/targets', { token: ceoToken, body: { metric: 'new_clients', branch_id: 'br_kisumu', target_value: 50, period } });
    assert(branchTarget.status === 201 && branchTarget.json.target.branch_id === 'br_kisumu', 'CEO can set a branch-aggregate target with no individual recipient');
  }

  // =========================================================
  // 6. ELIGIBLE RECIPIENTS ENDPOINT — real, scoped
  // =========================================================
  {
    const mgrEligible = await api('GET', '/api/targets/eligible-recipients', { token: managerKisumuToken });
    assert(mgrEligible.json.users.every(u => u.role_id === 'loan_officer' && u.branch_id === 'br_kisumu'), 'Manager\'s eligible-recipients list is real and correctly scoped to their own branch\'s Loan Officers only');
    const officerEligible = await api('GET', '/api/targets/eligible-recipients', { token: officerToken });
    assert(officerEligible.status === 403, 'Loan Officer gets 403 asking who they can set targets for (they cannot set any)');
  }

  // =========================================================
  // 7. REAL ACHIEVEMENT CALCULATION — the actual point of this pass
  // =========================================================
  {
    // Fresh client + loan for a clean, isolated achievement measurement.
    const client = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Achievement Test Client', phone: '0722900555' } });
    const products = await api('GET', '/api/loan-products', { token: officerToken });
    const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: client.json.client.id, product_id: products.json.products[0].id, principal: 40000, term_months: 4 } });
    await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: managerKisumuToken, body: {} });
    await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: regionalToken, body: {} });
    await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: opsMgrToken, body: {} });
    await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: (await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD)), body: {} });
    await api('POST', `/api/loans/${loan.json.loan.id}/disburse`, { token: adminToken, body: { channel: 'Cash' } });
    await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loan.json.loan.id, amount: 12000, channel: 'Cash' } });

    // Individual (Loan Officer) disbursement target — real achievement should reflect the real 40000 disbursed.
    const officerTarget = await api('POST', '/api/targets', { token: managerKisumuToken, body: { metric: 'disbursement', recipient_user_id: officerId, target_value: 100000, period } });
    const officerReload = await api('GET', `/api/targets/${officerTarget.json.target.id}`, { token: officerToken });
    assert(officerReload.json.target.achieved >= 40000, `real disbursement achievement reflects the actual disbursed loan (got ${officerReload.json.target.achieved})`);
    assert(officerReload.json.target.remaining === Math.max(0, 100000 - officerReload.json.target.achieved), 'remaining is correctly derived from target minus real achieved, not a separate stored number');
    assert(Math.abs(officerReload.json.target.achievementPct - (officerReload.json.target.achieved / 100000 * 100)) < 0.01, 'achievement % is mathematically correct: achieved / target * 100');

    // Collection achievement — real payment just recorded (12000).
    const collectionTarget = await api('POST', '/api/targets', { token: managerKisumuToken, body: { metric: 'collection', recipient_user_id: officerId, target_value: 50000, period } });
    const collectionReload = await api('GET', `/api/targets/${collectionTarget.json.target.id}`, { token: managerKisumuToken });
    assert(collectionReload.json.target.achieved >= 12000, `real collection achievement reflects the actual posted payment (got ${collectionReload.json.target.achieved})`);

    // Branch-level (Manager) target — a real branch-aggregate target, achievement summed from ALL loans in the branch, not one officer.
    const branchTarget = await api('POST', '/api/targets', { token: ceoToken, body: { metric: 'disbursement', branch_id: 'br_kisumu', target_value: 1000000, period } });
    const branchReload = await api('GET', `/api/targets/${branchTarget.json.target.id}`, { token: adminToken });
    assert(branchReload.json.target.achieved >= 40000, 'branch-level target achievement aggregates real disbursement across the whole branch, not just one officer');

    // Zero-target / division-by-zero safety.
    let zeroTargetRejected = false;
    try { const r = await api('POST', '/api/targets', { token: managerKisumuToken, body: { metric: 'disbursement', recipient_user_id: officerId, target_value: 0, period } }); zeroTargetRejected = (r.status === 400); } catch(e) {}
    assert(zeroTargetRejected, 'a zero target_value is rejected by validation (target_value must be positive), preventing any downstream division-by-zero');

    // Overachievement (>100%) is represented honestly, not capped/hidden.
    const smallTarget = await api('POST', '/api/targets', { token: managerKisumuToken, body: { metric: 'collection', recipient_user_id: officerId, target_value: 1000, period } });
    const smallReload = await api('GET', `/api/targets/${smallTarget.json.target.id}`, { token: managerKisumuToken });
    assert(smallReload.json.target.achievementPct > 100, `overachievement is reported honestly above 100% (got ${smallReload.json.target.achievementPct.toFixed(1)}%)`);
    assert(smallReload.json.target.remaining === 0, 'remaining floors at 0 once the target is exceeded, never goes negative');

    // A period with no real activity yet shows real zero, not a fabricated number.
    const futurePeriod = String(Number(period.slice(0,4)) + 1) + period.slice(4);
    const futureTarget = await api('POST', '/api/targets', { token: managerKisumuToken, body: { metric: 'disbursement', recipient_user_id: officerId, target_value: 50000, period: futurePeriod } });
    const futureReload = await api('GET', `/api/targets/${futureTarget.json.target.id}`, { token: managerKisumuToken });
    assert(futureReload.json.target.achieved === 0, 'a target for a future period with no real activity yet correctly shows 0 achieved, not a fake value');

    // Cancelled targets preserve their real historical achievement when viewed via history.
    await api('POST', `/api/targets/${smallTarget.json.target.id}/cancel`, { token: managerKisumuToken, body: { reason: 'test' } });
    const historyView = await api('GET', '/api/targets?history=1', { token: managerKisumuToken });
    const cancelledEntry = historyView.json.targets.find(t => t.id === smallTarget.json.target.id);
    assert(cancelledEntry && cancelledEntry.status === 'Cancelled' && cancelledEntry.achievementPct > 100, 'a cancelled target remains visible in history with its real achievement preserved, not deleted or zeroed');
    const activeOnlyView = await api('GET', '/api/targets', { token: managerKisumuToken });
    assert(!activeOnlyView.json.targets.some(t => t.id === smallTarget.json.target.id), 'the default (non-history) view correctly excludes the cancelled target');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
