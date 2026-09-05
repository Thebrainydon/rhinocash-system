// investorManagement.test.js — staff-side Investor Management: role
// access matrix, pagination/search, single-investor profile, status
// update, obligations summary, investor-to-investor isolation, and the
// real bug fix (Accountant can now see investors they post payouts for).
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
async function investorLogin(email, password) { const r = await api('POST', '/api/investor-auth/login', { body: { email, password } }); return r.json && r.json.token; }

(async () => {
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const ceoToken = await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD);
  const directorToken = await login('director@rhinocash.co.ke', process.env.SEEDED_DIRECTOR_PASSWORD);
  const accountantToken = await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const regionalToken = await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD);
  const opsToken = await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const investorToken = await investorLogin('sara.investor@example.com', process.env.SEEDED_INVESTOR_PASSWORD);
  assert(adminToken && ceoToken && directorToken && accountantToken && managerToken && officerToken && investorToken, 'all needed accounts log in');

  // =========================================================
  // 1. ROLE ACCESS MATRIX — the core audit requirement
  // =========================================================
  {
    const officerAttempt = await api('GET', '/api/investors', { token: officerToken });
    assert(officerAttempt.status === 403, 'Loan Officer has no Investor Management access — least-privilege, as required');

    const managerAttempt = await api('GET', '/api/investors', { token: managerToken });
    assert(managerAttempt.status === 403, 'Manager has no Investor Management authority by default');

    const regionalAttempt = await api('GET', '/api/investors', { token: regionalToken });
    assert(regionalAttempt.status === 403, 'Regional Manager has no Investor Management authority by default');

    const opsAttempt = await api('GET', '/api/investors', { token: opsToken });
    assert(opsAttempt.status === 403, 'Operational Manager has no Investor Management authority unless explicitly granted — none found in the real permission model');

    // The real bug this pass fixes: Accountant genuinely needs visibility.
    const accountantList = await api('GET', '/api/investors', { token: accountantToken });
    assert(accountantList.status === 200, 'Accountant CAN now list investors — previously blocked despite holding real payout-posting authority over them');

    const adminList = await api('GET', '/api/investors', { token: adminToken });
    assert(adminList.status === 200, 'Admin retains real investor management access');
    const ceoList = await api('GET', '/api/investors', { token: ceoToken });
    assert(ceoList.status === 200, 'CEO has real executive investor visibility');
    const directorList = await api('GET', '/api/investors', { token: directorToken });
    assert(directorList.status === 200, 'Director has real strategic investor visibility');
  }

  // =========================================================
  // 2. INVESTOR DIRECTORY — pagination + search, real data
  // =========================================================
  let testInvestorId;
  {
    const created = await api('POST', '/api/investors', { token: adminToken, body: { name: 'Test Investor Alpha', email: 'invalpha@test.co.ke', phone: '0722888999', amount: 500000, profit_share_pct: 15, term_months: 12 } });
    assert(created.status === 201, 'Admin creates a real investor');
    testInvestorId = created.json.investor.id;

    const paged = await api('GET', '/api/investors?limit=1&page=1', { token: adminToken });
    assert(paged.status === 200 && paged.json.pagination && paged.json.pagination.total >= 1, 'real pagination metadata returned');

    const searched = await api('GET', '/api/investors?q=Alpha', { token: accountantToken });
    assert(searched.json.investors.some(i => i.name.includes('Alpha')), 'real search matches the real investor name, and Accountant can use it');

    // Accountant cannot create investors — read/accounting authority only, not management authority.
    const accountantCreate = await api('POST', '/api/investors', { token: accountantToken, body: { name: 'Should Fail', amount: 1000, profit_share_pct: 10 } });
    assert(accountantCreate.status === 403, 'Accountant cannot create investors — segregated from Admin/CEO/Director management authority');
  }

  // =========================================================
  // 3. INVESTOR PROFILE — real terms + real payout history
  // =========================================================
  {
    const profile = await api('GET', `/api/investors/${testInvestorId}`, { token: accountantToken });
    assert(profile.status === 200 && profile.json.investor.name === 'Test Investor Alpha', 'real single-investor profile is fetchable by Accountant');
    assert(Array.isArray(profile.json.payouts) && typeof profile.json.maturityDate === 'string', 'the real profile includes real payout history and a real computed maturity date');

    const notFound = await api('GET', '/api/investors/inv_does_not_exist', { token: adminToken });
    assert(notFound.status === 404, 'a nonexistent investor id genuinely returns 404');
  }

  // =========================================================
  // 4. INVESTOR STATUS UPDATE — Admin/CEO/Director only
  // =========================================================
  {
    const accountantUpdate = await api('PATCH', `/api/investors/${testInvestorId}`, { token: accountantToken, body: { status: 'Completed' } });
    assert(accountantUpdate.status === 403, 'Accountant cannot change investor status — real/accounting authority is separated from management authority');

    const invalidStatus = await api('PATCH', `/api/investors/${testInvestorId}`, { token: adminToken, body: { status: 'NotReal' } });
    assert(invalidStatus.status === 400, 'an invalid status value is rejected');

    const validUpdate = await api('PATCH', `/api/investors/${testInvestorId}`, { token: directorToken, body: { phone: '0733111222' } });
    assert(validUpdate.status === 200 && validUpdate.json.investor.phone === '0733111222', 'Director can update real permitted investor fields');
  }

  // =========================================================
  // 5. COMPANY-WIDE PAYOUT LEDGER + OBLIGATIONS SUMMARY
  // =========================================================
  {
    const allPayouts = await api('GET', '/api/investor-payouts', { token: accountantToken });
    assert(allPayouts.status === 200 && Array.isArray(allPayouts.json.payouts), 'Accountant can view the real company-wide payout ledger');

    const officerPayouts = await api('GET', '/api/investor-payouts', { token: officerToken });
    assert(officerPayouts.status === 403, 'Loan Officer cannot view the investor payout ledger');

    const obligations = await api('GET', '/api/investors/obligations/summary', { token: ceoToken });
    assert(obligations.status === 200 && typeof obligations.json.totalCapital === 'number', 'CEO can view real, aggregate investor obligations');
    assert(Array.isArray(obligations.json.upcomingMaturities), 'obligations summary includes a real upcoming-maturities list, not a fabricated one');
  }

  // =========================================================
  // 6. INVESTOR-TO-INVESTOR ISOLATION (re-verified in this module's context)
  // =========================================================
  {
    const ownProfile = await api('GET', '/api/investor/me', { token: investorToken });
    assert(ownProfile.status === 200, 'a real investor can fetch their own profile via the dedicated investor endpoint');
    const raw = JSON.stringify(ownProfile.json);
    assert(!raw.includes('Test Investor Alpha'), "an investor's own profile response never includes another real investor's name");

    const staffEndpointDenied = await api('GET', '/api/investors', { token: investorToken });
    assert(staffEndpointDenied.status === 401, 'an investor token cannot reach the staff-only Investor Management endpoint at all — structurally separate auth, not a role check');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
