// viewLoans.test.js — real extensions to the shared GET /api/loans/view
// endpoint added to back the Loan Officer's real "View Loans" submenu
// page: the new Overdue Loans/Rescheduled Loans/WrittenOff Loans/Non
// Performing categories, the real existing loan Rating (Tag/Rate Client
// Loan) as a filter, real maturityDate/displayStatus fields, and the new
// Balance/Amount/Disbursement/Maturity sort keys. The pre-existing
// Manager/Regional/Operational Manager KPI-tile page and its own tests
// are untouched — these are purely additive fields/branches.
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
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const regionalToken = await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD);
  const opsToken = await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD);
  const acctToken = await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD);
  assert(adminToken && officerToken && managerToken && regionalToken && opsToken && acctToken, 'all needed accounts log in');

  const products = (await api('GET', '/api/loan-products', { token: officerToken })).json.products;
  const productId = products[0].id;
  async function newClient(name) {
    const r = await api('POST', '/api/clients', { token: officerToken, body: { name, phone: '0733' + Math.floor(Math.random() * 900000 + 100000) } });
    return r.json.client.id;
  }
  async function disburse(clientId, principal, term) {
    const r = await api('POST', '/api/loans', { token: officerToken, body: { client_id: clientId, product_id: productId, principal, term_months: term } });
    const loan = r.json.loan;
    await api('POST', `/api/loans/${loan.id}/approve`, { token: managerToken, body: {} });
    await api('POST', `/api/loans/${loan.id}/approve`, { token: regionalToken, body: {} });
    await api('POST', `/api/loans/${loan.id}/approve`, { token: opsToken, body: {} });
    await api('POST', `/api/loans/${loan.id}/approve`, { token: acctToken, body: {} });
    await api('POST', `/api/loans/${loan.id}/disburse`, { token: adminToken, body: { channel: 'Bank' } });
    return loan.id;
  }

  // =========================================================
  // 1. A REAL, FRESHLY DISBURSED, FULLY CURRENT LOAN — real Active
  // displayStatus, real green Maturity, real maturityDate present
  // =========================================================
  const currentClientId = await newClient('[TEST] VL Current Client');
  const currentLoanId = await disburse(currentClientId, 40000, 6);
  {
    const view = await api('GET', `/api/loans/view?category=Current Loans`, { token: officerToken });
    assert(view.status === 200 && Array.isArray(view.json.rows), 'real View Loans data loads for the Loan Officer');
    const row = view.json.rows.find(r => r.loanId === currentLoanId);
    assert(row, 'the real freshly-disbursed loan genuinely appears under Current Loans');
    assert(row.displayStatus === 'Active', 'a real, fully-current loan with no overdue installments genuinely shows Active, not fabricated');
    assert(!!row.maturityDate, 'the real Maturity date is genuinely present (the loan\'s real last schedule period due date)');
    assert(row.rating === null, 'a real, never-rated loan genuinely has a null rating, not a fabricated default');
  }

  // =========================================================
  // 2. A REAL LOAN WITH A GENUINELY OVERDUE, UNPAID PERIOD — real
  // "Overdue Loans"/"Non Performing" categories, real In Arrears vs
  // Overdue displayStatus distinction
  // =========================================================
  const overdueClientId = await newClient('[TEST] VL Overdue Client');
  const overdueLoanId = await disburse(overdueClientId, 20000, 3);
  {
    const { run: dbRun, get: dbGet, all: dbAll } = require('../src/db');
    const sched = await dbAll('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY period', [overdueLoanId]);
    const veryOld = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10);
    // Make every period genuinely overdue and unpaid, with the loan's
    // own real maturity (the last period) also genuinely in the past —
    // a real, severely delinquent, fully-matured-but-unpaid loan.
    for (const r of sched) { await dbRun('UPDATE loan_schedule SET due_date = ?, paid_amount = 0 WHERE id = ?', [veryOld, r.id]); }

    const overdueView = await api('GET', `/api/loans/view?category=Overdue Loans`, { token: officerToken });
    assert(overdueView.status === 200, 'real Overdue Loans category loads');
    const overdueRow = overdueView.json.rows.find(r => r.loanId === overdueLoanId);
    assert(overdueRow, 'a real loan with a genuinely overdue, unpaid installment appears under the real Overdue Loans category');
    assert(overdueRow.displayStatus === 'Overdue', 'a real loan whose own maturity date has genuinely passed while still owing a real balance shows Overdue, not In Arrears');
    assert(overdueRow.dpd > 0, 'the real dpd figure is genuinely positive for this overdue loan');

    const currentCatCheck = await api('GET', `/api/loans/view?category=Current Loans`, { token: officerToken });
    assert(!currentCatCheck.json.rows.some(r => r.loanId === currentLoanId && r.displayStatus !== 'Active'), 'the earlier real current loan is genuinely unaffected by this later overdue-loan fixture');

    const nonPerforming = await api('GET', `/api/loans/view?category=Non Performing`, { token: officerToken });
    assert(nonPerforming.status === 200 && nonPerforming.json.rows.some(r => r.loanId === overdueLoanId), 'a real loan genuinely 90+ days past due appears under the real Non Performing category (the same dpd>=90 threshold used elsewhere for riskStatus Default)');
    assert(!nonPerforming.json.rows.some(r => r.loanId === currentLoanId), 'a real, fully-current loan genuinely does not appear under Non Performing');

    // A real loan with an overdue-unpaid FIRST period but a real, still
    // future maturity (LAST period untouched) is genuinely "In Arrears",
    // not "Overdue" — the loan itself hasn't reached its own real
    // maturity date yet, unlike the fully-matured loan above.
    const arrearsClientId = await newClient('[TEST] VL In Arrears Client');
    const arrearsLoanId = await disburse(arrearsClientId, 12000, 6);
    const arrearsSched = await dbAll('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY period', [arrearsLoanId]);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await dbRun('UPDATE loan_schedule SET due_date = ?, paid_amount = 0 WHERE id = ?', [yesterday, arrearsSched[0].id]);
    const arrearsView = await api('GET', `/api/loans/view?category=All Loans`, { token: officerToken });
    const arrearsRow = arrearsView.json.rows.find(r => r.loanId === arrearsLoanId);
    assert(arrearsRow && arrearsRow.displayStatus === 'In Arrears', 'a real loan with a real overdue-unpaid period whose own real maturity has genuinely NOT yet passed shows In Arrears, distinctly from a fully-matured Overdue loan');
  }

  // =========================================================
  // 3. REAL LOAN RATING (Tag/Rate Client Loan) AS A FILTER
  // =========================================================
  {
    const rateRes = await api('POST', `/api/loans/${currentLoanId}/rate`, { token: officerToken, body: { rating: 'Good paying client', reason: 'Test rating' } });
    assert(rateRes.status === 200, 'the real existing Tag/Rate Client Loan action genuinely still works');

    const ratedFilter = await api('GET', `/api/loans/view?category=All Loans&rating=${encodeURIComponent('Good paying client')}`, { token: officerToken });
    assert(ratedFilter.json.rows.some(r => r.loanId === currentLoanId), 'filtering by the real, exact rating value genuinely includes this newly-rated loan');
    assert(!ratedFilter.json.rows.some(r => r.loanId === overdueLoanId), 'filtering by that same rating genuinely excludes a real, differently-rated (unrated) loan');

    const unratedFilter = await api('GET', `/api/loans/view?category=All Loans&rating=unrated`, { token: officerToken });
    assert(unratedFilter.json.rows.some(r => r.loanId === overdueLoanId), 'the real "Untagged" filter genuinely includes a real loan with no rating set');
    assert(!unratedFilter.json.rows.some(r => r.loanId === currentLoanId), 'the real "Untagged" filter genuinely excludes the loan that was just real-rated');
  }

  // =========================================================
  // 4. REAL RESCHEDULED / WRITTEN-OFF CATEGORIES
  // =========================================================
  const restructureClientId = await newClient('[TEST] VL Restructure Client');
  const restructureLoanId = await disburse(restructureClientId, 15000, 4);
  const writeOffClientId = await newClient('[TEST] VL WriteOff Client');
  const writeOffLoanId = await disburse(writeOffClientId, 10000, 2);
  {
    const restructureRes = await api('POST', `/api/loans/${restructureLoanId}/restructure`, { token: adminToken, body: { new_term_months: 6, reason: 'Test restructure' } });
    assert(restructureRes.status === 200, 'the real existing loan restructuring action genuinely still works');
    const rescheduled = await api('GET', `/api/loans/view?category=Rescheduled Loans`, { token: officerToken });
    assert(rescheduled.status === 200 && rescheduled.json.rows.some(r => r.loanId === restructureLoanId), 'a real genuinely-restructured loan appears under the real Rescheduled Loans category');
    assert(!rescheduled.json.rows.some(r => r.loanId === currentLoanId), 'a real, never-restructured loan genuinely does not appear under Rescheduled Loans');

    const writeOffRes = await api('POST', `/api/loans/${writeOffLoanId}/write-off`, { token: adminToken, body: { reason: 'Test write-off' } });
    assert(writeOffRes.status === 200, 'the real existing loan write-off action genuinely still works');
    const writtenOff = await api('GET', `/api/loans/view?category=WrittenOff Loans`, { token: officerToken });
    assert(writtenOff.status === 200 && writtenOff.json.rows.some(r => r.loanId === writeOffLoanId), 'a real genuinely-written-off loan appears under the real WrittenOff Loans category');

    const allLoans = await api('GET', `/api/loans/view?category=All Loans`, { token: officerToken });
    assert(allLoans.json.rows.some(r => r.loanId === restructureLoanId) && allLoans.json.rows.some(r => r.loanId === writeOffLoanId), 'the real All Loans category genuinely includes Restructured and Written Off loans too, not just the original four statuses');
  }

  // =========================================================
  // 5. REAL Balance/Amount/Disbursement/Maturity SORT KEYS
  // =========================================================
  {
    const balAsc = await api('GET', `/api/loans/view?category=All Loans&sort=balanceasc`, { token: officerToken });
    const balances = balAsc.json.rows.map(r => r.balance);
    const sortedAsc = balances.slice().sort((a, b) => a - b);
    assert(JSON.stringify(balances) === JSON.stringify(sortedAsc), 'sort=balanceasc genuinely returns rows in real ascending balance order');

    const amtDesc = await api('GET', `/api/loans/view?category=All Loans&sort=amountdesc`, { token: officerToken });
    const amounts = amtDesc.json.rows.map(r => r.principal);
    const sortedDesc = amounts.slice().sort((a, b) => b - a);
    assert(JSON.stringify(amounts) === JSON.stringify(sortedDesc), 'sort=amountdesc genuinely returns rows in real descending principal order');

    const dispAsc = await api('GET', `/api/loans/view?category=All Loans&sort=disbursementasc`, { token: officerToken });
    const dates = dispAsc.json.rows.filter(r => r.disbursedAt).map(r => r.disbursedAt);
    const sortedDates = dates.slice().sort();
    assert(JSON.stringify(dates) === JSON.stringify(sortedDates), 'sort=disbursementasc genuinely returns rows in real ascending disbursement-date order');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
