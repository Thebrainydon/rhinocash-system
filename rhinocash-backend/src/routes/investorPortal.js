// investorPortal.js — what an investor sees about the company and their own
// investment. Every figure here is an AGGREGATE (totals, counts, shares,
// per-branch and per-month sums): no client, borrower or staff record ever
// leaves this file. The investor's own rows are always selected by
// req.investor.id, so one investor can never see another's.
'use strict';
const { all, get, run } = require('./../db');
const { requireInvestorAuth } = require('./investors');
const { ledgerBalance } = require('./accounting');
const { logAction } = require('./../audit');

const num = v => Number(v || 0);
const clean = (v, max) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; };
function lastMonths(n) {
  const out = []; const d = new Date(); d.setUTCDate(1);
  for (let i = n - 1; i >= 0; i--) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)); out.push(x.toISOString().slice(0, 7)); }
  return out;
}
function addMonths(dateStr, m) { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); }

async function buildReport(investor) {
  const today = new Date().toISOString().slice(0, 10);
  const months = lastMonths(12);
  const from = months[0] + '-01';

  // ---- Portfolio: one aggregate row per active loan, then only totals leave ----
  const loans = await all(`SELECT l.id, l.branch_id, l.product_id, l.principal,
      COALESCE(SUM(GREATEST(s.total_due - s.paid_amount, 0)), 0) AS outstanding,
      MIN(CASE WHEN s.paid_amount < s.total_due - 0.01 THEN s.due_date END) AS oldest_unpaid
    FROM loans l LEFT JOIN loan_schedule s ON s.loan_id = l.id
    WHERE l.status IN ('Active','Disbursed') GROUP BY l.id, l.branch_id, l.product_id, l.principal`);
  const daysLate = l => (l.oldest_unpaid && l.oldest_unpaid < today) ? Math.floor((new Date(today) - new Date(l.oldest_unpaid)) / 86400000) : 0;
  const buckets = [['Current', 0, 0], ['1-30 days', 1, 30], ['31-60 days', 31, 60], ['61-90 days', 61, 90], ['Over 90 days', 91, 1e9]]
    .map(([bucket, lo, hi]) => { const xs = loans.filter(l => { const d = daysLate(l); return d >= lo && d <= hi; }); return { bucket, loans: xs.length, amount: xs.reduce((s, l) => s + num(l.outstanding), 0) }; });
  const outstanding = loans.reduce((s, l) => s + num(l.outstanding), 0);
  const parAmt = t => loans.filter(l => daysLate(l) > t).reduce((s, l) => s + num(l.outstanding), 0);
  const branches = await all('SELECT b.id, b.name, b.status, r.name AS region FROM branches b LEFT JOIN regions r ON r.id = b.region_id ORDER BY b.name');
  const byBranch = branches.map(b => { const xs = loans.filter(l => l.branch_id === b.id); const o = xs.reduce((s, l) => s + num(l.outstanding), 0);
    return { branch: b.name, region: b.region || '', status: b.status, activeLoans: xs.length, outstanding: o, par30Pct: o > 0 ? xs.filter(l => daysLate(l) > 30).reduce((s, l) => s + num(l.outstanding), 0) / o * 100 : 0 }; });
  const products = await all('SELECT id, name FROM loan_products');
  const byProduct = products.map(p => { const xs = loans.filter(l => l.product_id === p.id); return { product: p.name, activeLoans: xs.length, outstanding: xs.reduce((s, l) => s + num(l.outstanding), 0) }; }).filter(p => p.activeLoans);
  const sizes = [['Under 10k', 0, 10000], ['10k-25k', 10000, 25000], ['25k-50k', 25000, 50000], ['50k-100k', 50000, 100000], ['100k+', 100000, 1e15]]
    .map(([band, lo, hi]) => ({ band, loans: loans.filter(l => num(l.principal) >= lo && num(l.principal) < hi).length }));

  // ---- Month by month ----
  const disb = await all(`SELECT to_char(disbursed_at::timestamptz, 'YYYY-MM') AS m, COUNT(*)::int AS n, COALESCE(SUM(principal),0) AS v FROM loans WHERE disbursed_at IS NOT NULL AND disbursed_at >= ? GROUP BY 1`, [from]);
  const coll = await all(`SELECT to_char(created_at::timestamptz, 'YYYY-MM') AS m, COALESCE(SUM(amount),0) AS v FROM payments WHERE status NOT IN ('Unposted','Reversed') AND created_at >= ? GROUP BY 1`, [from]);
  // Income is every Revenue account (interest, fees, penalties); expenses are
  // every Expense account (operating expenses plus the itemised exp_* ones).
  const led = await all(`SELECT to_char(j.entry_date::timestamptz, 'YYYY-MM') AS m,
      CASE WHEN j.account_id = 'interest_income' THEN 'interest_income' WHEN a.account_type = 'Revenue' THEN 'fee_income' ELSE 'operating_expense' END AS account_id,
      COALESCE(SUM(j.debit),0) AS d, COALESCE(SUM(j.credit),0) AS c
    FROM journal_entries j JOIN gl_accounts a ON a.id = j.account_id
    WHERE a.account_type IN ('Revenue','Expense') AND j.entry_date >= ? GROUP BY 1, 2`, [from]);
  const clientsM = await all(`SELECT to_char(created_at::timestamptz, 'YYYY-MM') AS m, COUNT(*)::int AS n FROM clients WHERE created_at >= ? GROUP BY 1`, [from]);
  const L = (m, a, debitNormal) => { const r = led.find(x => x.m === m && x.account_id === a); return r ? (debitNormal ? num(r.d) - num(r.c) : num(r.c) - num(r.d)) : 0; };
  const monthly = months.map(m => {
    const d = disb.find(x => x.m === m) || {};
    const income = L(m, 'interest_income') + L(m, 'fee_income'); const expenses = L(m, 'operating_expense', true);
    return { month: m, disbursed: num(d.v), disbursedLoans: num(d.n), collected: num((coll.find(x => x.m === m) || {}).v),
      interestIncome: L(m, 'interest_income'), feeIncome: L(m, 'fee_income'), expenses, netProfit: income - expenses, newClients: num((clientsM.find(x => x.m === m) || {}).n) };
  });

  // ---- Company finances (all time) ----
  const glTotals = await get(`SELECT
      COALESCE(SUM(CASE WHEN a.account_type = 'Revenue' AND j.account_id <> 'interest_income' THEN j.credit - j.debit ELSE 0 END),0) AS other_income,
      COALESCE(SUM(CASE WHEN a.account_type = 'Expense' THEN j.debit - j.credit ELSE 0 END),0) AS expenses
    FROM journal_entries j JOIN gl_accounts a ON a.id = j.account_id`);
  const interestIncome = await ledgerBalance('interest_income', null);
  const feeIncome = num(glTotals.other_income);
  const expenses = num(glTotals.expenses);
  const cash = { cash: await ledgerBalance('cash', null), bank: await ledgerBalance('bank', null), mpesa: await ledgerBalance('mpesa', null) };
  const loansReceivable = await ledgerBalance('loans_receivable', null);

  // ---- Company profile (aggregates only) ----
  const org = (await get('SELECT * FROM organization_settings WHERE id = 1')) || {};
  const counts = await get(`SELECT
      (SELECT COUNT(*) FROM regions)::int AS regions,
      (SELECT COUNT(*) FROM branches)::int AS branches,
      (SELECT COUNT(*) FROM branches WHERE status = 'Active')::int AS active_branches,
      (SELECT COUNT(*) FROM users WHERE status <> 'Terminated')::int AS staff,
      (SELECT COUNT(*) FROM users WHERE status <> 'Terminated' AND role_id = 'loan_officer')::int AS officers,
      (SELECT COUNT(*) FROM clients)::int AS clients,
      (SELECT COUNT(DISTINCT client_id) FROM loans WHERE status IN ('Active','Disbursed'))::int AS active_clients,
      (SELECT COALESCE(SUM(principal),0) FROM loans WHERE disbursed_at IS NOT NULL) AS disbursed_all,
      (SELECT COUNT(*) FROM loans WHERE disbursed_at IS NOT NULL)::int AS loans_all,
      (SELECT COUNT(*) FROM investors WHERE status = 'Active')::int AS investors,
      (SELECT COALESCE(SUM(amount),0) FROM investors WHERE status = 'Active') AS investor_capital`);
  const regions = await all(`SELECT r.name, COUNT(b.id)::int AS branches FROM regions r LEFT JOIN branches b ON b.region_id = r.id GROUP BY r.id, r.name ORDER BY r.name`);
  const roles = await all(`SELECT r.name AS role, COUNT(u.id)::int AS staff FROM users u JOIN roles r ON r.id = u.role_id WHERE u.status <> 'Terminated' GROUP BY r.name ORDER BY 2 DESC`);

  // ---- Strategy, capital and risk shared with investors (titles and totals only) ----
  const execRows = await all(`SELECT kind, title, category, status, amount, score, due_date, data_json FROM exec_records
    WHERE kind IN ('strategic_plan','expansion_plan','funding','allocation','strategy_goal','risk','compliance_check','regulatory','investment','capital_plan')`);
  const pick = (kind, statuses) => execRows.filter(r => r.kind === kind && (!statuses || statuses.includes(r.status)))
    .map(r => ({ title: r.title, category: r.category, status: r.status, amount: r.amount != null ? num(r.amount) : null, progress: r.score != null ? num(r.score) : null, due: r.due_date }));
  const risks = execRows.filter(r => r.kind === 'risk' && ['Open', 'Mitigating'].includes(r.status)).map(r => { let d = {}; try { d = JSON.parse(r.data_json || '{}'); } catch { d = {}; } return { category: r.category || 'Other', score: num(d.likelihood) * num(d.impact) }; });
  const riskCats = [...new Set(risks.map(r => r.category))].map(c => { const xs = risks.filter(r => r.category === c); return { category: c, open: xs.length, avgScore: xs.reduce((s, r) => s + r.score, 0) / xs.length, high: xs.filter(r => r.score >= 15).length }; });

  // ---- This investor ----
  const payouts = await all('SELECT period, company_net_profit, investor_profit, status, reference, paid_at FROM investor_payouts WHERE investor_id = ? ORDER BY period', [investor.id]);
  const share = num(investor.profit_share_pct) / 100;
  const elapsed = Math.max(0, Math.round((Date.now() - new Date(investor.start_date + 'T00:00:00Z')) / (30.44 * 86400000)));
  const last12Net = monthly.reduce((s, m) => s + m.netProfit, 0);
  const realized = payouts.filter(p => p.status === 'Paid').reduce((s, p) => s + num(p.investor_profit), 0);
  const pending = payouts.filter(p => p.status !== 'Paid').reduce((s, p) => s + num(p.investor_profit), 0);
  const remaining = Math.max(0, num(investor.term_months) - elapsed);

  return {
    generatedAt: new Date().toISOString(),
    company: { name: org.company_name || org.trading_name || 'Rhinocash Ltd', tradingName: org.trading_name || null, registrationNumber: org.registration_number || null,
      address: org.address || null, phone: org.phone || null, email: org.email || null, website: org.website || null, currency: org.currency || 'KES',
      regions: counts.regions, branches: counts.branches, activeBranches: counts.active_branches, staff: counts.staff, loanOfficers: counts.officers,
      clients: counts.clients, activeClients: counts.active_clients, disbursedAllTime: num(counts.disbursed_all), loansAllTime: counts.loans_all,
      investors: counts.investors, investorCapital: num(counts.investor_capital), regionBranches: regions, staffByRole: roles },
    portfolio: { activeLoans: loans.length, outstanding, averageLoan: loans.length ? loans.reduce((s, l) => s + num(l.principal), 0) / loans.length : 0,
      par30Pct: outstanding > 0 ? parAmt(30) / outstanding * 100 : 0, par90Pct: outstanding > 0 ? parAmt(90) / outstanding * 100 : 0,
      arrears: buckets, byBranch, byProduct, sizes },
    monthly,
    finance: { interestIncome, feeIncome, expenses, netProfit: interestIncome + feeIncome - expenses, cash, cashTotal: cash.cash + cash.bank + cash.mpesa,
      loansReceivable, last12NetProfit: last12Net },
    investment: { capital: num(investor.amount), profitSharePct: num(investor.profit_share_pct), termMonths: num(investor.term_months), startDate: investor.start_date,
      maturityDate: addMonths(investor.start_date, num(investor.term_months)), monthsElapsed: Math.min(elapsed, num(investor.term_months)), monthsRemaining: remaining, status: investor.status,
      realized, pending, expectedAnnual: Math.max(0, last12Net * share), expectedRemaining: Math.max(0, last12Net / 12 * share * remaining),
      currentValue: num(investor.amount) + pending, shareOfInvestorCapital: num(counts.investor_capital) > 0 ? num(investor.amount) / num(counts.investor_capital) * 100 : 100,
      payouts: payouts.map(p => ({ period: p.period, companyNetProfit: num(p.company_net_profit), amount: num(p.investor_profit), status: p.status, reference: p.reference, paidAt: p.paid_at })),
      paymentDetails: { method: investor.payout_method || null, bankName: investor.bank_name || null, bankAccount: investor.bank_account || null, mpesaPhone: investor.mpesa_phone || null },
      reportFrequency: investor.report_frequency || 'None' },
    strategy: { plans: pick('strategic_plan', ['Active', 'Achieved']), goals: pick('strategy_goal'), expansion: pick('expansion_plan', ['Approved', 'In Progress', 'Completed']),
      funding: pick('funding', ['Open', 'Partly Funded', 'Funded']), allocation: pick('allocation', ['Allocated', 'Spent']), investments: pick('investment', ['Approved', 'Active']),
      capitalPlans: pick('capital_plan', ['Approved', 'Executed']) },
    risk: { categories: riskCats, openRisks: risks.length, highRisks: risks.filter(r => r.score >= 15).length,
      compliance: { checksPassed: execRows.filter(r => r.kind === 'compliance_check' && r.status === 'Passed').length, checksFailed: execRows.filter(r => r.kind === 'compliance_check' && r.status === 'Failed').length,
        regulatoryOpen: execRows.filter(r => r.kind === 'regulatory' && ['Open', 'In Progress'].includes(r.status)).length } },
  };
}

const PAYOUT_METHODS = ['Bank transfer', 'M-Pesa', 'Cheque'];
const REPORT_FREQUENCIES = ['None', 'Monthly', 'Quarterly', 'Annually'];

function register(router) {
  router.get('/api/investor/report', requireInvestorAuth, async (req, res) => {
    const inv = await get('SELECT * FROM investors WHERE id = ?', [req.investor.id]);
    res.json(await buildReport(inv));
  });
  // The investor keeps their own payout details and statement preference.
  router.put('/api/investor/payment-details', requireInvestorAuth, async (req, res, next) => {
    const b = req.body || {};
    const method = clean(b.method, 40);
    if (!PAYOUT_METHODS.includes(method)) return next({ status: 400, message: `Choose how you want to be paid (${PAYOUT_METHODS.join(', ')})` });
    const bankName = clean(b.bankName, 80), bankAccount = clean(b.bankAccount, 40), mpesaPhone = clean(b.mpesaPhone, 20);
    if (method === 'Bank transfer' && (!bankName || !bankAccount)) return next({ status: 400, message: 'Enter the bank name and account number' });
    if (method === 'M-Pesa' && !/^(\+?254|0)?[17]\d{8}$/.test(String(mpesaPhone || '').replace(/\s/g, ''))) return next({ status: 400, message: 'Enter a valid M-Pesa phone number' });
    await run('UPDATE investors SET payout_method = ?, bank_name = ?, bank_account = ?, mpesa_phone = ? WHERE id = ?', [method, bankName, bankAccount, mpesaPhone, req.investor.id]);
    await logAction(req, { action: 'Investor updated payment details', module: 'investors', recordType: 'Investor', recordId: req.investor.id, newValue: { method } });
    res.json({ ok: true });
  });
  router.put('/api/investor/report-preferences', requireInvestorAuth, async (req, res, next) => {
    const f = clean((req.body || {}).frequency, 20);
    if (!REPORT_FREQUENCIES.includes(f)) return next({ status: 400, message: `Frequency must be one of: ${REPORT_FREQUENCIES.join(', ')}` });
    await run('UPDATE investors SET report_frequency = ? WHERE id = ?', [f, req.investor.id]);
    res.json({ ok: true, frequency: f });
  });
}

module.exports = { register, buildReport };
