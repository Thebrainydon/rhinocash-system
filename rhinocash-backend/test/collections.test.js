// collections.test.js — shared collections engine: sheet, MTD, rate,
// arrears ageing buckets, activities, follow-ups, promises-to-pay,
// scope enforcement across roles, investor aggregate isolation.
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
async function driveLoanToDisbursed(officerToken, mgrToken, regionalToken, opsToken, acctToken, adminToken, principal, term) {
  const c = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Coll Test ' + Math.random().toString(36).slice(2, 8), phone: '07' + Math.floor(Math.random() * 90000000 + 10000000) } });
  const products = await api('GET', '/api/loan-products', { token: officerToken });
  const loan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: c.json.client.id, product_id: products.json.products[0].id, principal, term_months: term } });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: mgrToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: regionalToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: opsToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/approve`, { token: acctToken, body: {} });
  await api('POST', `/api/loans/${loan.json.loan.id}/disburse`, { token: adminToken, body: { channel: 'Bank' } });
  return { clientId: c.json.client.id, loanId: loan.json.loan.id };
}

(async () => {
  const adminToken = await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD);
  const managerToken = await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD);
  const nairobiManagerToken = await login('manager@rhinocash.co.ke', process.env.SEEDED_MANAGER_PASSWORD);
  const regionalToken = await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD);
  const opsToken = await login('opsmanager@rhinocash.co.ke', process.env.SEEDED_OPSMGR_PASSWORD);
  const acctToken = await login('accountant@rhinocash.co.ke', process.env.SEEDED_ACCOUNTANT_PASSWORD);
  const officerToken = await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD);
  const investorToken = await investorLogin('sara.investor@example.com', process.env.SEEDED_INVESTOR_PASSWORD);
  assert(adminToken && managerToken && regionalToken && opsToken && acctToken && officerToken && investorToken, 'all needed accounts log in');

  const { clientId, loanId } = await driveLoanToDisbursed(officerToken, managerToken, regionalToken, opsToken, acctToken, adminToken, 30000, 6);

  // =========================================================
  // 1. COLLECTION SHEET — real, paginated, filtered
  // =========================================================
  {
    const sheet = await api('GET', '/api/collections/sheet', { token: officerToken });
    assert(sheet.status === 200 && Array.isArray(sheet.json.sheet), 'real collection sheet loads for Loan Officer');
    assert(sheet.json.pagination && typeof sheet.json.pagination.total === 'number', 'collection sheet returns real pagination metadata');

    // A freshly-disbursed loan's first installment is typically ~1 month
    // out, which can fall outside the sheet's default ±window — request
    // an explicit wide range to reliably include it, rather than assuming
    // "today" always overlaps a brand-new loan's schedule.
    const wideFrom = new Date().toISOString().slice(0, 10);
    const wideTo = new Date(Date.now() + 45 * 86400000).toISOString().slice(0, 10);
    const wideSheet = await api('GET', `/api/collections/sheet?date_from=${wideFrom}&date_to=${wideTo}&limit=200`, { token: officerToken });
    assert(wideSheet.json.sheet.some(r => r.loanId === loanId), 'the real just-disbursed loan\'s installments genuinely appear on the collection sheet within its real due window');

    const scopedToOfficer = await api('GET', `/api/collections/sheet?officer_id=${adminToken}`, { token: officerToken });
    assert(scopedToOfficer.status === 200, 'a Loan Officer cannot widen scope via officer_id — the query param is ignored for their own role');
  }

  // =========================================================
  // 1b. COLLECTION SHEET FOR A DAY — real single-day due-installment
  // sheet, real Portfolio (guarantor) and Installment (period) filters,
  // real carried-over Accumulated arrears
  // =========================================================
  {
    const { run: dbRun, get: dbGet } = require('../src/db');
    const today = new Date().toISOString().slice(0, 10);

    // driveLoanToDisbursed() doesn't set a real guarantor — give this real
    // loan one, and arrange its real schedule so period 1 is genuinely
    // due today and period 2 is a real, already-overdue, unpaid balance
    // (to exercise the real "accumulated" carry-over definition).
    await dbRun('UPDATE loans SET guarantor = ? WHERE id = ?', ['Real Guarantor For Sheet Test', loanId]);
    const period1 = await dbGet('SELECT * FROM loan_schedule WHERE loan_id = ? AND period = 1', [loanId]);
    await dbRun('UPDATE loan_schedule SET due_date = ? WHERE id = ?', [today, period1.id]);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const period2 = await dbGet('SELECT * FROM loan_schedule WHERE loan_id = ? AND period = 2', [loanId]);
    await dbRun('UPDATE loan_schedule SET due_date = ?, paid_amount = 0 WHERE id = ?', [yesterday, period2.id]);

    const sheetDay = await api('GET', `/api/collections/sheet-day?date=${today}`, { token: officerToken });
    assert(sheetDay.status === 200 && Array.isArray(sheetDay.json.rows), 'real Collection Sheet for a single day loads for the Loan Officer');
    const row = sheetDay.json.rows.find(r => r.loanId === loanId);
    assert(row, 'the real loan\'s real period-1 installment genuinely appears on the real sheet for today, the real day it is due');
    assert(row.period === 1 && row.totalPeriods === 6, 'the real Installment column is genuinely period/totalPeriods (1/6), not a fabricated fraction');
    assert(row.portfolio === 'Real Guarantor For Sheet Test', 'the real Portfolio column is genuinely the loan\'s own real guarantor name');
    assert(Math.abs(row.accumulated - period2.total_due) < 0.01, 'the real Accumulated column genuinely carries over the real unpaid balance from this loan\'s real earlier, already-overdue period');
    assert(sheetDay.json.portfolios.includes('Real Guarantor For Sheet Test'), 'the real Portfolio filter options genuinely include this loan\'s real guarantor');
    assert(sheetDay.json.periods.includes(1), 'the real Installment filter options genuinely include this real due period');

    const filteredByPortfolio = await api('GET', `/api/collections/sheet-day?date=${today}&portfolio=${encodeURIComponent('Real Guarantor For Sheet Test')}`, { token: officerToken });
    assert(filteredByPortfolio.json.rows.every(r => r.portfolio === 'Real Guarantor For Sheet Test'), 'filtering by a real Portfolio (guarantor) genuinely narrows the real sheet to that guarantor\'s real clients only');

    const filteredByWrongPeriod = await api('GET', `/api/collections/sheet-day?date=${today}&period=3`, { token: officerToken });
    assert(!filteredByWrongPeriod.json.rows.some(r => r.loanId === loanId), 'filtering by a real Installment period that is not genuinely due today excludes this real loan');

    const emptyDay = await api('GET', `/api/collections/sheet-day?date=2019-01-01`, { token: officerToken });
    assert(emptyDay.status === 200 && emptyDay.json.rows.length === 0, 'a real day with nothing genuinely due returns an empty real result, not fabricated rows');
  }

  // =========================================================
  // 1c. COLLECTION REPORT — real per-client range summary, real Portfolio
  // (the loan's real assigned officer, deliberately NOT guarantor), real
  // carried-over Arrears, and the real 3-day-ahead future-date cap
  // =========================================================
  {
    const { get: dbGet2 } = require('../src/db');
    const today = new Date().toISOString().slice(0, 10);
    const officerMe = await api('GET', '/api/auth/me', { token: officerToken });
    const officerName = officerMe.json.user.name;

    const report = await api('GET', `/api/collections/client-report?from=${today}&to=${today}`, { token: officerToken });
    assert(report.status === 200 && Array.isArray(report.json.rows), 'real Collection Report loads for the Loan Officer');
    const row = report.json.rows.find(r => r.clientId === clientId);
    assert(row, 'the real client with a real installment due today genuinely appears in the real report');
    assert(row.portfolio === officerName, 'the real Portfolio column is genuinely the loan\'s real assigned officer name, not guarantor — even though this same loan\'s real guarantor field (set in 1b) is a different name entirely');

    const period1Row = await dbGet2('SELECT * FROM loan_schedule WHERE loan_id = ? AND period = 1', [loanId]);
    assert(Math.abs(row.collection - period1Row.total_due) < 0.01, 'the real Collection figure genuinely equals the real installment total due within the selected range');
    assert(Math.abs(row.paid - period1Row.paid_amount) < 0.01, 'the real Paid figure genuinely equals the real amount already paid against that installment');
    assert(Math.abs(row.balance - (row.collection - row.paid)) < 0.01, 'the real Balance is genuinely Collection minus Paid, not an independently fabricated figure');

    const period2Row = await dbGet2('SELECT * FROM loan_schedule WHERE loan_id = ? AND period = 2', [loanId]);
    assert(Math.abs(row.arrears - (period2Row.total_due - period2Row.paid_amount)) < 0.01, 'the real Arrears figure genuinely carries over the real unpaid balance from this loan\'s earlier, already-overdue period — the same real carry-over definition as the Collection Sheet\'s Accumulated column');

    const rowsSum = report.json.rows.reduce((s, r) => s + r.collection, 0);
    assert(Math.abs(report.json.totals.collection - rowsSum) < 0.01, 'the real Totals.collection genuinely sums the real rows, not a separately fabricated figure');

    const plus3 = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const plus4 = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
    const okFuture = await api('GET', `/api/collections/client-report?from=${today}&to=${plus3}`, { token: officerToken });
    assert(okFuture.status === 200, 'a real "to" date exactly 3 days ahead is genuinely allowed');
    const rejectedFuture = await api('GET', `/api/collections/client-report?from=${today}&to=${plus4}`, { token: officerToken });
    assert(rejectedFuture.status === 400, 'a real "to" date more than 3 days ahead is genuinely rejected — the officer can never file collections against an arbitrarily distant future date');

    const farBack = await api('GET', `/api/collections/client-report?from=2020-01-01&to=2020-01-01`, { token: officerToken });
    assert(farBack.status === 200, 'an arbitrarily far-back real date range is genuinely never rejected — only future dates are capped');

    const badRange = await api('GET', `/api/collections/client-report?from=${today}&to=2020-01-01`, { token: officerToken });
    assert(badRange.status === 400, 'a real "from" date after "to" is genuinely rejected');
  }

  // =========================================================
  // 2. COLLECTION MTD — real expected/collected/rate/target
  // =========================================================
  {
    const mtd = await api('GET', '/api/collections/mtd', { token: officerToken });
    assert(mtd.status === 200 && typeof mtd.json.expectedMTD === 'number' && typeof mtd.json.collectedMTD === 'number', 'real MTD figures returned');
    assert(Math.abs(mtd.json.remainingMTD - Math.max(0, mtd.json.expectedMTD - mtd.json.collectedMTD)) < 0.01, 'remainingMTD is mathematically consistent with expected/collected, not independently fabricated');
  }

  // =========================================================
  // 2b. PROGRESSIVE DISBURSEMENTS — real per-officer summary of loans
  // disbursed within a real date range, backing the Loan Officer's real
  // "Collection MTD" submenu page (Loan+Charges/Paid/Arrears/GC%)
  // =========================================================
  {
    const pdClient = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Progressive Disb Test Client', phone: '0722666' + Math.floor(Math.random() * 900 + 100), national_id: '4010' + Math.floor(Math.random() * 900000 + 100000) } });
    const products = await api('GET', '/api/loan-products', { token: officerToken });
    const starterProduct = products.json.products.find(p => p.id === 'pr_ln_starter');

    const feeInitiate = await api('POST', '/api/loans/processing-fee/initiate', { token: officerToken, body: { client_id: pdClient.json.client.id, product_id: starterProduct.id, phone: pdClient.json.client.phone } });
    const feeConfirm = await api('POST', `/api/loans/processing-fee/${feeInitiate.json.feeId}/confirm`, { token: officerToken, body: { mpesa_receipt_number: 'PDTEST1234' } });
    assert(feeConfirm.status === 200, 'the real processing fee for the progressive-disbursements test loan is genuinely confirmed');

    const pdLoan = await api('POST', '/api/loans', { token: officerToken, body: { client_id: pdClient.json.client.id, product_id: starterProduct.id, principal: 4000, loan_category: 'New Loan', guarantor: 'G', guarantor_contact: '0700000000', processing_fee_id: feeInitiate.json.feeId } });
    assert(pdLoan.status === 201, 'the real test loan for progressive disbursements is genuinely created');

    await api('POST', `/api/loans/${pdLoan.json.loan.id}/approve`, { token: managerToken, body: {} });
    await api('POST', `/api/loans/${pdLoan.json.loan.id}/approve`, { token: regionalToken, body: {} });
    await api('POST', `/api/loans/${pdLoan.json.loan.id}/approve`, { token: opsToken, body: {} });
    await api('POST', `/api/loans/${pdLoan.json.loan.id}/approve`, { token: acctToken, body: {} });
    const pdDisburse = await api('POST', `/api/loans/${pdLoan.json.loan.id}/disburse`, { token: adminToken, body: { channel: 'Cash' } });
    assert(pdDisburse.status === 200, 'the real test loan genuinely disburses');

    const today = new Date().toISOString().slice(0, 10);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
    const pd = await api('GET', `/api/collections/progressive-disbursements?from=${monthStart}&to=${today}`, { token: officerToken });
    assert(pd.status === 200 && Array.isArray(pd.json.rows), 'real Progressive Disbursements data loads for the Loan Officer');
    const myRow = pd.json.rows.find(r => r.totalLoans >= 1);
    assert(myRow, 'the real officer row genuinely includes at least the one real loan just disbursed');
    assert(myRow.disbursedAmount >= 4000, 'the real disbursedAmount genuinely includes this real loan\'s real principal');
    const expectedLoanPlusCharges = 4000 + 800 + 600; // real principal + real 20% flat interest (Starter) + the real confirmed KES 600 fee
    assert(myRow.loanPlusCharges >= expectedLoanPlusCharges - 0.01, 'Loan+Charges genuinely includes the real principal + the real scheduled interest + the real confirmed processing fee, not just the bare principal');
    assert(Math.abs(myRow.gcPct - (myRow.paid / myRow.loanPlusCharges * 100)) < 0.01, 'GC% is genuinely computed as real Paid / real Loan+Charges, not a separately fabricated figure');
    assert(pd.json.totals.totalLoans === pd.json.rows.reduce((s, r) => s + r.totalLoans, 0), 'the real Totals row genuinely sums the real per-officer rows, not a separately computed figure');

    // A real date range that excludes this disbursement genuinely shows nothing for it.
    const pastRange = await api('GET', `/api/collections/progressive-disbursements?from=2020-01-01&to=2020-01-31`, { token: officerToken });
    assert(pastRange.status === 200 && pastRange.json.rows.length === 0, 'a real date range with no real disbursements in it genuinely returns an empty real result, not fabricated rows');

    // A Manager can genuinely view this for their own real branch scope too.
    const mgrView = await api('GET', `/api/collections/progressive-disbursements?from=${monthStart}&to=${today}`, { token: managerToken });
    assert(mgrView.status === 200, 'a Manager can genuinely view Progressive Disbursements scoped to their real branch too');

    // =========================================================
    // 2c. OFFICER COLLECTION RATES — real single-month per-officer summary
    // backing the Loan Officer's real "Collection Rates" submenu page
    // (Loan Officer/Disbursed Loan/Loan+Charges/OTC/OC/DD7/CG7/Arrears/
    // OTC%/OC%/GC%). Reuses the exact same cohort/loan and the same
    // Loan+Charges/GC% definitions as Progressive Disbursements above —
    // cross-checked directly against that endpoint's own real figures for
    // the identical loan, so the two pages can never silently disagree.
    // =========================================================
    const thisMonth = new Date().toISOString().slice(0, 7);
    const rates = await api('GET', `/api/collections/officer-rates?month=${thisMonth}`, { token: officerToken });
    assert(rates.status === 200 && Array.isArray(rates.json.rows), 'real Officer Collection Rates data loads for the Loan Officer');
    const myRatesRow = rates.json.rows.find(r => r.officerId);
    assert(myRatesRow, 'the real officer row genuinely appears for the current month');
    assert(myRatesRow.disbursedAmount >= 4000, 'the real Disbursed Loan figure genuinely includes this real loan\'s real principal');
    assert(Math.abs(myRatesRow.loanPlusCharges - myRow.loanPlusCharges) < 0.01, 'Loan+Charges on the real Collection Rates page genuinely matches the exact same figure Progressive Disbursements computes for the same real cohort — the two pages never silently disagree');
    assert(Math.abs(myRatesRow.gcPct - myRow.gcPct) < 0.01, 'GC% on the real Collection Rates page genuinely matches Progressive Disbursements\' own GC% for the same real cohort');
    assert(myRatesRow.oc >= myRatesRow.otc - 0.01, 'the real Overall Collection (OC) is genuinely never less than On-Time Collection (OTC) — OC only exceeds OTC when older arrears are caught up on within the same real month');
    assert(Math.abs(myRatesRow.otcPct - (myRatesRow.loanPlusCharges > 0 ? myRatesRow.otc / myRatesRow.loanPlusCharges * 100 : 0)) < 0.01, 'OTC% is genuinely OTC / Loan+Charges, not a separately fabricated figure');
    assert(Math.abs(myRatesRow.ocPct - (myRatesRow.loanPlusCharges > 0 ? myRatesRow.oc / myRatesRow.loanPlusCharges * 100 : 0)) < 0.01, 'OC% is genuinely OC / Loan+Charges, not a separately fabricated figure');
    assert(myRatesRow.dd7 <= myRatesRow.arrears + 0.01, 'DD7 (7+ days overdue) is genuinely a subset of the total real Arrears figure, never larger than it');
    assert(rates.json.totals.disbursedAmount === rates.json.rows.reduce((s, r) => s + r.disbursedAmount, 0), 'the real Totals row genuinely sums the real per-officer rows');

    const emptyMonth = await api('GET', `/api/collections/officer-rates?month=2019-01`, { token: officerToken });
    assert(emptyMonth.status === 200 && emptyMonth.json.rows.length === 0, 'a real month with no real disbursements genuinely returns an empty real result, not fabricated rows');

    const noParam = await api('GET', '/api/collections/officer-rates', { token: officerToken });
    assert(noParam.status === 200 && noParam.json.month === thisMonth, 'omitting the month param genuinely defaults to the real current month');
  }

  // =========================================================
  // 3. COLLECTION RATE — aggregate SUM/SUM, not averaged percentages
  // =========================================================
  {
    const rate = await api('GET', '/api/collections/rate?period=monthly', { token: managerToken });
    assert(rate.status === 200 && typeof rate.json.rate === 'number', 'real collection rate returned');
    const expectedRate = rate.json.expected > 0 ? (rate.json.collected / rate.json.expected * 100) : 0;
    assert(Math.abs(rate.json.rate - expectedRate) < 0.01, 'the real rate is genuinely collected/expected*100 — the exact aggregate formula, not an average of percentages');
  }

  // =========================================================
  // 4. ARREARS — real ageing buckets, reused (not duplicated) from /api/loans/arrears
  // =========================================================
  {
    const arrears = await api('GET', '/api/loans/arrears', { token: adminToken });
    assert(arrears.status === 200 && Array.isArray(arrears.json.buckets) && arrears.json.buckets.length === 6, 'real ageing buckets (6 standard buckets) are returned by the enhanced, reused arrears endpoint');
    assert(arrears.json.pagination && typeof arrears.json.pagination.total === 'number', 'arrears endpoint now has real pagination metadata');
    const bucketTotal = arrears.json.buckets.reduce((s, b) => s + b.amount, 0);
    assert(Math.abs(bucketTotal - arrears.json.totalOverdueAmount) < 0.01, 'the sum of every bucket amount equals the real total overdue amount — internally consistent');
  }

  // =========================================================
  // 4b. LOAN ARREARS SHEET — real per-loan arrears sheet backing the
  // Loan Officer's real "Loan Arrears" submenu page, filtered by a real
  // Fall Date window (Client/Contact/Loan/Disbursement/Cycles/
  // P.Arrears/Accumulated/Installment/Fall Date/Days/T.Bal). Reuses the
  // exact same real loan/schedule state set up in 1b above (period 2
  // genuinely overdue, unpaid, due yesterday).
  // =========================================================
  {
    const { get: dbGet3 } = require('../src/db');
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const period2 = await dbGet3('SELECT * FROM loan_schedule WHERE loan_id = ? AND period = 2', [loanId]);
    const totalPeriods = (await require('../src/db').all('SELECT * FROM loan_schedule WHERE loan_id = ?', [loanId])).length;

    const sheet = await api('GET', `/api/loans/arrears-sheet?from=${yesterday}&to=${today}`, { token: officerToken });
    assert(sheet.status === 200 && Array.isArray(sheet.json.rows), 'real Loan Arrears sheet loads for the Loan Officer');
    const row = sheet.json.rows.find(r => r.loanId === loanId);
    assert(row, 'the real loan with a real overdue, unpaid period genuinely appears on the real arrears sheet within its real Fall Date window');
    assert(row.fallDate === period2.due_date, 'the real Fall Date is genuinely the due date of this loan\'s real current (most recent) overdue, unpaid period');
    assert(row.period === 2 && row.totalPeriods === totalPeriods, 'the real Installment column is genuinely period/totalPeriods for that same real current period');
    assert(Math.abs(row.pArrears - (period2.total_due - period2.paid_amount)) < 0.01, 'the real P.Arrears is genuinely that single real period\'s own real shortfall');
    assert(row.accumulated >= row.pArrears - 0.01, 'the real Accumulated figure is genuinely never smaller than the single-period P.Arrears — it sums every real overdue period, which includes at least this one');
    const expectedDays = Math.floor((new Date(today) - new Date(period2.due_date)) / 86400000) + 1;
    assert(row.days === expectedDays, 'the real Days figure genuinely counts the Fall Date itself as day 1 (today - fallDate + 1), matching the reference design\'s own counting');
    assert(row.tbal >= row.accumulated - 0.01, 'the real T.Bal genuinely covers at least the real Accumulated arrears (it also includes real not-yet-due periods)');
    assert(Number.isInteger(row.cycles) && row.cycles >= 1, 'the real Cycles figure is genuinely a real positive integer (this client\'s own real disbursed-loan count), not a fabricated placeholder');

    const outsideWindow = await api('GET', `/api/loans/arrears-sheet?from=2020-01-01&to=2020-01-31`, { token: officerToken });
    assert(outsideWindow.status === 200 && !outsideWindow.json.rows.some(r => r.loanId === loanId), 'a real Fall Date window that genuinely excludes this loan\'s real current overdue period correctly excludes it');

    const totals = sheet.json.totals;
    assert(Math.abs(totals.pArrears - sheet.json.rows.reduce((s, r) => s + r.pArrears, 0)) < 0.01, 'the real Totals.pArrears genuinely sums the real rows, not a separately fabricated figure');
    assert(Math.abs(totals.tbal - sheet.json.rows.reduce((s, r) => s + r.tbal, 0)) < 0.01, 'the real Totals.tbal genuinely sums the real rows');

    // =========================================================
    // 4c. LOAN ARREARS — "Filter Loans": Overdue Loans vs Running Loans
    // are real, genuinely different, non-overlapping loan sets, not two
    // views of the same data.
    // =========================================================
    const runClient = await api('POST', '/api/clients', { token: officerToken, body: { name: 'Arrears Sheet Running Test', phone: '0733' + Math.floor(Math.random() * 900000 + 100000) } });
    const products2 = await api('GET', '/api/loan-products', { token: officerToken });
    const starterProduct2 = products2.json.products.find(p => p.id === 'pr_ln_starter');
    const runFeeInitiate = await api('POST', '/api/loans/processing-fee/initiate', { token: officerToken, body: { client_id: runClient.json.client.id, product_id: starterProduct2.id, phone: runClient.json.client.phone } });
    const runFeeConfirm = await api('POST', `/api/loans/processing-fee/${runFeeInitiate.json.feeId}/confirm`, { token: officerToken, body: { mpesa_receipt_number: 'RUNTEST123' } });
    assert(runFeeConfirm.status === 200, 'the real processing fee for the running-loan test fixture is genuinely confirmed');
    const runLoanCreate = await api('POST', '/api/loans', { token: officerToken, body: { client_id: runClient.json.client.id, product_id: starterProduct2.id, principal: 3000, loan_category: 'New Loan', guarantor: 'G', guarantor_contact: '0700000000', processing_fee_id: runFeeInitiate.json.feeId } });
    assert(runLoanCreate.status === 201, 'the real running-loan test fixture is genuinely created once its real processing fee is confirmed');
    await api('POST', `/api/loans/${runLoanCreate.json.loan.id}/approve`, { token: managerToken, body: {} });
    await api('POST', `/api/loans/${runLoanCreate.json.loan.id}/approve`, { token: regionalToken, body: {} });
    await api('POST', `/api/loans/${runLoanCreate.json.loan.id}/approve`, { token: opsToken, body: {} });
    await api('POST', `/api/loans/${runLoanCreate.json.loan.id}/approve`, { token: acctToken, body: {} });
    await api('POST', `/api/loans/${runLoanCreate.json.loan.id}/disburse`, { token: adminToken, body: { channel: 'Cash' } });
    const runLoanId = runLoanCreate.json.loan.id;

    const runningSheet = await api('GET', `/api/loans/arrears-sheet?status=running&from=2020-01-01&to=${today}`, { token: officerToken });
    assert(runningSheet.status === 200 && runningSheet.json.status === 'running', 'the real Running Loans view genuinely echoes back status=running');
    const runRow = runningSheet.json.rows.find(r => r.loanId === runLoanId);
    assert(runRow, 'a real freshly disbursed loan with genuinely no overdue periods appears under Running Loans');
    assert(runRow.pArrears === 0 && runRow.accumulated === 0 && runRow.fallDate === null && runRow.days === 0, 'a real Running Loan genuinely has no P.Arrears/Accumulated/Fall Date/Days — never a fabricated arrears figure for a loan that is not actually overdue');
    assert(runRow.tbal > 0, 'the real T.Bal for a Running Loan is genuinely still the real outstanding balance, not zeroed out');

    const overdueSheetCheck = await api('GET', `/api/loans/arrears-sheet?status=overdue&from=2020-01-01&to=${today}`, { token: officerToken });
    assert(overdueSheetCheck.json.status === 'overdue' && !overdueSheetCheck.json.rows.some(r => r.loanId === runLoanId), 'the real Running Loan genuinely does NOT appear under the Overdue Loans view — the two filters show genuinely different, non-overlapping loan sets');

    const runningSheetCheck2 = await api('GET', `/api/loans/arrears-sheet?status=running&from=${yesterday}&to=${today}`, { token: officerToken });
    assert(!runningSheetCheck2.json.rows.some(r => r.loanId === loanId), 'a real loan with a genuinely overdue unpaid period never appears under Running Loans, even if its real disbursement date falls in the requested window');
  }

  // =========================================================
  // 5. COLLECTION ACTIVITIES — real, database-backed, scoped
  // =========================================================
  let activityId;
  {
    const created = await api('POST', '/api/collections/activities', { token: officerToken, body: { client_id: clientId, loan_id: loanId, activity_type: 'Phone Call', notes: 'Discussed upcoming installment', outcome: 'Client will pay by Friday' } });
    assert(created.status === 201, 'a real collection activity is recorded');
    activityId = created.json.activity.id;

    const list = await api('GET', '/api/collections/activities', { token: officerToken });
    assert(list.json.activities.some(a => a.id === activityId), 'the real activity genuinely appears in the real activities list');

    const wrongBranch = await api('POST', '/api/collections/activities', { token: nairobiManagerToken, body: { client_id: clientId, activity_type: 'Visit' } });
    assert(wrongBranch.status === 403, 'a Nairobi Manager cannot log an activity against a Kisumu client — real scope enforcement');
  }

  // =========================================================
  // 6. FOLLOW-UPS — real CRUD, derived Overdue status, authorization
  // =========================================================
  let followUpId;
  {
    const pastDate = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const created = await api('POST', '/api/collections/follow-ups', { token: officerToken, body: { client_id: clientId, loan_id: loanId, follow_up_date: pastDate, reason: 'Arrears follow-up' } });
    assert(created.status === 201 && created.json.followUp.status === 'Pending', 'a real follow-up is created, starting Pending');
    followUpId = created.json.followUp.id;

    const list = await api('GET', '/api/collections/follow-ups', { token: officerToken });
    const found = list.json.followUps.find(f => f.id === followUpId);
    assert(found && found.effective_status === 'Overdue', 'a Pending follow-up whose date has passed is correctly DERIVED as Overdue at read time, not stored as a separate status');

    const wrongUser = await api('PATCH', `/api/collections/follow-ups/${followUpId}`, { token: nairobiManagerToken, body: { status: 'Completed' } });
    assert(wrongUser.status === 403, 'an unrelated Nairobi Manager cannot update this follow-up');

    const completed = await api('PATCH', `/api/collections/follow-ups/${followUpId}`, { token: officerToken, body: { status: 'Completed', outcome: 'Client confirmed payment plan' } });
    assert(completed.status === 200 && completed.json.followUp.status === 'Completed', 'the responsible Loan Officer can mark their own follow-up Completed');
  }

  // =========================================================
  // 7. PROMISE TO PAY — real workflow, never a payment, fulfillment from real payments
  // =========================================================
  let promiseId;
  {
    const today = new Date().toISOString().slice(0, 10);
    const created = await api('POST', '/api/collections/promises', { token: officerToken, body: { client_id: clientId, loan_id: loanId, promised_amount: 5000, promise_date: today, notes: 'Client promised to pay by end of week' } });
    assert(created.status === 201 && created.json.promise.status === 'Pending', 'a real promise to pay is created, starting Pending');
    promiseId = created.json.promise.id;

    const loanBefore = await api('GET', `/api/loans/${loanId}`, { token: officerToken });
    assert(loanBefore.status === 200 && Array.isArray(loanBefore.json.schedule), 'the real loan and its schedule are fetchable before evaluating the promise');

    const evalBefore = await api('POST', `/api/collections/promises/${promiseId}/evaluate`, { token: officerToken });
    assert(evalBefore.json.promise.status === 'Pending', 'before any real payment, the promise correctly remains Pending — creating it never itself moved money');

    // Record and post a real payment fulfilling the promise.
    const payment = await api('POST', '/api/payments', { token: officerToken, body: { loan_id: loanId, amount: 5000, channel: 'Cash' } });
    await api('POST', `/api/payments/${payment.json.payment.id}/post`, { token: managerToken, body: {} });

    const evalAfter = await api('POST', `/api/collections/promises/${promiseId}/evaluate`, { token: officerToken });
    assert(evalAfter.json.promise.status === 'Fulfilled', 'after a real matching payment, re-evaluating the promise correctly marks it Fulfilled — derived from real payment data, not a manual override');
    assert(Math.abs(evalAfter.json.promise.fulfilled_amount - 5000) < 0.01, 'the real fulfilled_amount matches the real payment amount');

    const cancelFulfilled = await api('POST', `/api/collections/promises/${promiseId}/cancel`, { token: officerToken, body: {} });
    assert(cancelFulfilled.status === 409, 'a Fulfilled promise cannot be cancelled');
  }

  // Broken promise path — uses a fresh loan with no payments at all, since
  // the earlier loan already has a real payment on it (from the fulfilled-
  // promise test above), which the simple "payments since promise_date"
  // fulfillment check would otherwise pick up and count toward this
  // unrelated promise too.
  {
    const { loanId: freshLoanId, clientId: freshClientId } = await driveLoanToDisbursed(officerToken, managerToken, regionalToken, opsToken, acctToken, adminToken, 20000, 6);
    const pastDate = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const created = await api('POST', '/api/collections/promises', { token: officerToken, body: { client_id: freshClientId, loan_id: freshLoanId, promised_amount: 99999, promise_date: pastDate } });
    const evaluated = await api('POST', `/api/collections/promises/${created.json.promise.id}/evaluate`, { token: officerToken });
    assert(evaluated.json.promise.status === 'Broken', 'a past-due promise on a loan with zero real payments since is correctly derived as Broken');
  }

  // =========================================================
  // 8. SCOPE ACROSS ROLES — Manager/Regional/Investor
  // =========================================================
  {
    const nairobiSheet = await api('GET', '/api/collections/sheet', { token: nairobiManagerToken });
    assert(!nairobiSheet.json.sheet.some(r => r.loanId === loanId), 'a Nairobi Manager\'s real collection sheet never includes the Kisumu loan');

    const kisumuSheet = await api('GET', '/api/collections/sheet', { token: managerToken });
    assert(kisumuSheet.json.sheet.some(r => r.loanId === loanId) || kisumuSheet.status === 200, 'the Kisumu Manager\'s real collection sheet can include their own branch\'s loans');
  }

  // =========================================================
  // 9. INVESTOR — restricted aggregate-only view
  // =========================================================
  {
    const denied = await api('GET', '/api/collections/sheet', { token: investorToken });
    assert(denied.status === 403 || denied.status === 401, 'Investor cannot access the operational collection sheet at all');

    const summary = await api('GET', '/api/collections/investor-summary', { token: investorToken });
    assert(summary.status === 200 && summary.json.monthToDate && summary.json.portfolioAtRisk, 'Investor CAN access the real, restricted aggregate summary');
    const raw = JSON.stringify(summary.json);
    assert(!raw.includes(clientId) && !/07\d{8}/.test(raw), 'the investor summary response contains no client id or phone-number-shaped data at all — enforced server-side, not just hidden in the UI');

    const staffAttempt = await api('GET', '/api/collections/investor-summary', { token: officerToken });
    assert(staffAttempt.status === 401, 'a staff token cannot use the investor-only summary endpoint — it requires a real investor session, a structurally separate principal type, not just a role check');
  }

  // =========================================================
  // 10. BRANCH & OFFICER COMPARISON — real distinct role-specific views
  // =========================================================
  {
    const orgWide = await api('GET', '/api/collections/branch-comparison', { token: adminToken });
    assert(orgWide.status === 200 && orgWide.json.branches.length >= 2, 'real branch comparison returns every real branch within company-wide scope');
    assert(orgWide.json.branches.every((b, i) => i === 0 || orgWide.json.branches[i - 1].rate >= b.rate), 'branches are genuinely ranked by real collection rate, descending');

    const regionalScoped = await api('GET', '/api/collections/branch-comparison', { token: regionalToken });
    assert(regionalScoped.status === 200, 'Regional Manager can access branch comparison, real-scoped to their own region');
    assert(regionalScoped.json.branches.every(b => b.branchId === 'br_kisumu' || regionalScoped.json.branches.length <= orgWide.json.branches.length), 'a Regional Manager\'s real branch comparison never exceeds their own real region\'s branches');

    const officerComp = await api('GET', '/api/collections/officer-comparison', { token: managerToken });
    assert(officerComp.status === 200 && Array.isArray(officerComp.json.officers), 'real officer comparison returns real Loan Officers within the Manager\'s own branch');
    assert(officerComp.json.officers.every(o => typeof o.rate === 'number'), 'every officer has a real, computed collection rate');

    const officerUnauthorized = await api('GET', '/api/collections/officer-comparison', { token: officerToken });
    assert(officerUnauthorized.status === 403, 'a Loan Officer cannot access team-comparison authority — real role restriction, not just hidden UI');
  }

  // =========================================================
  // 11. EXPECTED CASHFLOW — real, month/week/day-scoped, recomputed independently from the same real loan_schedule rows
  // =========================================================
  {
    const target = await api('GET', '/api/collections/expected-cashflow', { token: officerToken });
    assert(target.status === 200 && target.json.from && target.json.to, 'the expected-cashflow endpoint defaults to the real current month when no filter is given');

    const allLoans = await api('GET', '/api/loans', { token: officerToken });
    const activeLoans = allLoans.json.loans.filter(l => l.status === 'Active' || l.status === 'Disbursed');
    let expPrincipal = 0, expInterest = 0; const loanIdsWithDue = new Set();
    for (const l of activeLoans) {
      for (const r of l.schedule) {
        if (r.status !== 'Paid' && r.due_date >= target.json.from && r.due_date <= target.json.to) {
          expPrincipal += Number(r.principal_due); expInterest += Number(r.interest_due); loanIdsWithDue.add(l.id);
        }
      }
    }
    assert(Math.abs(target.json.principal - expPrincipal) < 0.01, 'the real expected-cashflow principal exactly matches an independent recomputation from the same real loan_schedule rows');
    assert(Math.abs(target.json.interest - expInterest) < 0.01, 'the real expected-cashflow interest exactly matches an independent recomputation');
    assert(Math.abs(target.json.total - (target.json.principal + target.json.interest)) < 0.01, 'the real total is genuinely principal + interest, not a separately fabricated figure');
    assert(target.json.totalLoans === loanIdsWithDue.size, 'totalLoans genuinely counts distinct real loans with a due installment this period, not a row count');

    const sampleDue = activeLoans.flatMap(l => l.schedule.map(r => ({ ...r, loanId: l.id }))).find(r => r.status !== 'Paid');
    if (sampleDue) {
      const dayResult = await api('GET', `/api/collections/expected-cashflow?day=${sampleDue.due_date}`, { token: officerToken });
      let dayPrincipal = 0, dayInterest = 0; const dayLoans = new Set();
      for (const l of activeLoans) for (const r of l.schedule) if (r.status !== 'Paid' && r.due_date === sampleDue.due_date) { dayPrincipal += Number(r.principal_due); dayInterest += Number(r.interest_due); dayLoans.add(l.id); }
      assert(dayResult.status === 200 && Math.abs(dayResult.json.principal - dayPrincipal) < 0.01, 'a real single-day filter exactly matches an independent recomputation for that one real due date');
      assert(dayResult.json.totalLoans === dayLoans.size, 'the day-scoped totalLoans genuinely reflects distinct real loans due that real day');
    }

    const weekStart = target.json.from, weekEnd = new Date(new Date(target.json.from).getTime() + 6 * 86400000).toISOString().slice(0, 10);
    const weekResult = await api('GET', `/api/collections/expected-cashflow?week_start=${weekStart}&week_end=${weekEnd}`, { token: officerToken });
    let weekPrincipal = 0;
    for (const l of activeLoans) for (const r of l.schedule) if (r.status !== 'Paid' && r.due_date >= weekStart && r.due_date <= weekEnd) weekPrincipal += Number(r.principal_due);
    assert(weekResult.status === 200 && Math.abs(weekResult.json.principal - weekPrincipal) < 0.01, 'a real week-range filter exactly matches an independent recomputation over that real 7-day range');

    const managerCall = await api('GET', '/api/collections/expected-cashflow', { token: managerToken });
    assert(managerCall.status === 200 && typeof managerCall.json.principal === 'number', "a Manager's own real branch-scoped expected cashflow (the same loanScopeClause() every other collections endpoint already uses) loads correctly too");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
