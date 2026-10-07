// menuAccess.test.js — the new per-submenu menu/feature permission system
// (menu_categories/menu_features/role_menu_access/user_menu_access),
// cloned from the existing Intelligence-feature model: a real, granular,
// server-enforced permission per SIDEBAR_MENUS submenu item, seeded today
// for Loan Officer's own full current menu (a lossless baseline, not a new
// restriction) — rolled out role by role. The one real "not yet migrated"
// safety bypass is what makes it safe to gate a route several roles share
// (e.g. GET /api/collections/mtd, used by both Manager and Loan Officer)
// before every one of those roles has individually been reviewed: a role
// with zero role_menu_access rows anywhere is completely unaffected.
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
  let officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  assert(adminToken && managerToken && officerToken, 'setup: all needed pre-existing accounts log in');

  // 0. Real catalog — 6 categories, 31 features, matching Loan Officer's
  // real reviewed SIDEBAR_MENUS item list exactly.
  {
    const r = await api('GET', '/api/menus/catalog', { token: officerToken });
    assert(r.status === 200, '0: the real menu catalog genuinely loads for any authenticated session');
    assert(r.json.categories.length === 6, '0: the real catalog genuinely has 6 categories (Accounting/Clients/LoanBook/Payments/My Account/System & Help)');
    assert(r.json.features.length === 31, '0: the real catalog genuinely has all 31 Loan Officer menu/submenu features');
  }

  // 1. Loan Officer's real effective grant — the full 31-item baseline,
  // surfaced on their own real /api/auth/me (DB.me.finalAccess.menus on
  // the frontend).
  let officerId;
  {
    const r = await api('GET', '/api/auth/me', { token: officerToken });
    officerId = r.json.user.id;
    assert(r.json.user.finalAccess.menus.length === 31, "1: the real Loan Officer's effective menu grant genuinely includes all 31 reviewed items");
    assert(r.json.user.finalAccess.menus.includes('menu-salary-advance') && r.json.user.finalAccess.menus.includes('menu-loan-arrears'), '1: the real grant genuinely includes specific real items from every section');
  }

  // 2. Admin-only role grant endpoints — a real role's current grants,
  // readable and editable only by Admin (manage_users + requireAdminOnly).
  {
    const asManager = await api('GET', '/api/roles/loan_officer/menus', { token: managerToken });
    assert(asManager.status === 403, '2: a non-Admin genuinely cannot read a role\'s real menu-access grants');
    const asAdmin = await api('GET', '/api/roles/loan_officer/menus', { token: adminToken });
    assert(asAdmin.status === 200 && asAdmin.json.featureIds.length === 31, "2: Admin genuinely reads loan_officer's real full 31-item grant");
  }

  // 3. A role with ZERO role_menu_access rows (Manager, not yet migrated
  // onto this system) is genuinely unaffected by requireAnyMenuFeature on
  // a route it shares with Loan Officer — the real "not yet migrated"
  // bypass, not an accidental regression for every other role.
  {
    const r = await api('GET', '/api/collections/mtd', { token: managerToken });
    assert(r.status === 200, "3: Manager (zero role_menu_access rows — not yet reviewed) genuinely still reaches GET /api/collections/mtd unaffected by the new system");
  }

  // 4. Revoking one specific real feature from Loan Officer's grant
  // genuinely blocks only that one real route, leaving every other
  // granted feature's route genuinely unaffected.
  const ALL_31 = [
    'menu-requisitions','menu-utility-payments','menu-cashflow',
    'menu-add-client','menu-create-a-lead','menu-interactions','menu-client-leads','menu-view-client',
    'menu-create-loan-application','menu-loan-application','menu-collection-mtd','menu-disbursements',
    'menu-collection-sheet','menu-collection-report','menu-collection-rates','menu-loan-arrears','menu-view-loans',
    'menu-unposted-payments','menu-processed-payments','menu-prepayments','menu-overpayments','menu-receipts',
    'menu-payin-summary','menu-payments-report','menu-validate-payments',
    'menu-view-details','menu-my-work-plan','menu-salary-advance','menu-update-details',
    'menu-create-a-ticket','menu-raised-ticket',
  ];
  {
    const withoutSalaryAdvance = ALL_31.filter(f => f !== 'menu-salary-advance');
    const put = await api('PUT', '/api/roles/loan_officer/menus', { token: adminToken, body: { featureIds: withoutSalaryAdvance } });
    assert(put.status === 200 && put.json.removed.includes('menu-salary-advance'), "4: Admin genuinely revokes loan_officer's real menu-salary-advance grant");

    const blocked = await api('GET', '/api/salary-advances', { token: officerToken });
    assert(blocked.status === 403, '4: the real Loan Officer genuinely loses access to GET /api/salary-advances once its menu feature is revoked');

    const stillWorks = await api('GET', '/api/collections/mtd', { token: officerToken });
    assert(stillWorks.status === 200, "4: a real, different, still-granted feature's route (GET /api/collections/mtd) is genuinely unaffected by revoking a sibling feature");

    // Restore the full baseline for the remaining assertions below.
    const restore = await api('PUT', '/api/roles/loan_officer/menus', { token: adminToken, body: { featureIds: ALL_31 } });
    assert(restore.status === 200 && restore.json.added.includes('menu-salary-advance'), "4: Admin genuinely restores loan_officer's real full 31-item baseline");
    const restored = await api('GET', '/api/salary-advances', { token: officerToken });
    assert(restored.status === 200, '4: the real Loan Officer genuinely regains access once the grant is restored');
  }

  // 5. Unknown feature id is genuinely rejected, never silently ignored.
  {
    const r = await api('PUT', '/api/roles/loan_officer/menus', { token: adminToken, body: { featureIds: ['menu-does-not-exist'] } });
    assert(r.status === 400, '5: an unknown menu feature id is genuinely rejected (400), not silently written');
  }

  // 6. Per-user override — a real RESTRICTING intersection (same real
  // semantics as the existing Intelligence per-user override), never an
  // additive grant beyond the role baseline.
  {
    const setOverride = await api('PUT', `/api/users/${officerId}/menu-access`, { token: adminToken, body: { featureIds: ['menu-salary-advance'] } });
    assert(setOverride.status === 200 && setOverride.json.featureIds.length === 1, "6: Admin genuinely sets a real per-user override restricting this one officer to a single feature");

    // Re-login: the forced single-session-login model means the existing
    // token is still valid (no password change happened) — reuse it.
    const stillHasSalaryAdvance = await api('GET', '/api/salary-advances', { token: officerToken });
    assert(stillHasSalaryAdvance.status === 200, '6: the real override-granted feature genuinely still works');
    const nowBlockedMtd = await api('GET', '/api/collections/mtd', { token: officerToken });
    assert(nowBlockedMtd.status === 403, "6: a real role-baseline feature NOT included in this officer's own override is genuinely now blocked — a real restricting intersection, not additive");

    // Clearing the override (empty array) genuinely defers back to the
    // full role baseline — the exact same real semantics as the existing
    // Intelligence per-user override.
    const clearOverride = await api('PUT', `/api/users/${officerId}/menu-access`, { token: adminToken, body: { featureIds: [] } });
    assert(clearOverride.status === 200 && clearOverride.json.featureIds.length === 31, '6: clearing the override genuinely defers this officer back to the real full role baseline');
    const mtdWorksAgain = await api('GET', '/api/collections/mtd', { token: officerToken });
    assert(mtdWorksAgain.status === 200, '6: the real role-baseline feature genuinely works again once the override is cleared');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
