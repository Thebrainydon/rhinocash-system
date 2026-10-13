// acctOps.js — the Accountant's analysis and control pages.
//
//   GET  /api/acct/finance         company-wide figures: month by month,
//                                  per branch, per GL account, receivables,
//                                  payables, fees and penalties
//   GET  /api/acct/controls        verification queues and exceptions
//   GET  /api/acct/client-quality  client records with missing or clashing data
//   GET  /api/acct/daily?date=     one day's money in and out
//   GET/POST/PATCH /api/acct/records  budgets, forecasts, refunds, write-off
//                                  proposals, verifications and exceptions
//
// Who can do what:
//   - view:   Accountant, CEO, Director, System Administrator
//   - record: anyone holding post_accounting_entries (Accountant, Admin)
//   - decide a budget, refund or write-off: CEO, Director or Admin — never
//     the person who raised it. Paying an approved refund and executing an
//     approved write-off post balanced journal entries.
'use strict';
const crypto = require('node:crypto');
const { all, get, run, transaction } = require('./../db');
const { requireAuth } = require('./../middleware');
const { hasPermission } = require('./../rbac');
const { logAction } = require('./../audit');
const { ledgerBalance, assertPeriodOpen } = require('./accounting');
const { glAccountFor } = require('./payments');

const VIEW = ['accountant', 'ceo', 'director', 'admin'];
const DECIDE = ['ceo', 'director', 'admin'];
const KINDS = {
  budget:       { statuses: ['Pending', 'Approved', 'Rejected', 'Closed'], decision: true },
  forecast:     { statuses: ['Active', 'Superseded'] },
  refund:       { statuses: ['Pending', 'Approved', 'Rejected', 'Paid'], decision: true },
  write_off:    { statuses: ['Pending', 'Approved', 'Rejected', 'Written Off'], decision: true },
  verification: { statuses: ['Verified', 'Flagged', 'Resolved'] },
  exception:    { statuses: ['Open', 'Investigating', 'Resolved', 'Dismissed'] },
};
const FORECAST_LINES = ['Disbursements', 'Collections', 'Revenue', 'Expenses'];
const REF_TYPES = ['payment', 'journal', 'loan', 'client'];

const num = v => Number(v || 0);
const round2 = v => Math.round(num(v) * 100) / 100;
const clean = (v, max) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; };
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const parseJson = t => { try { return JSON.parse(t); } catch { return null; } };
const today = () => new Date().toISOString().slice(0, 10);
function lastMonths(n) {
  const out = []; const d = new Date();
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return out;
}
const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / 86400000);

function requireView(req, res, next) { return VIEW.includes(req.user.role_id) ? next() : next({ status: 403, message: 'These finance pages are for the Accountant, CEO, Director and System Administrator' }); }
async function requireWrite(req, res, next) {
  try { return (await hasPermission(req.user, 'post_accounting_entries')) ? next() : next({ status: 403, message: 'You need the Post Accounting Entries permission' }); }
  catch (e) { return next(e); }
}

// Active loans with their outstanding balance and oldest unpaid instalment.
async function activeLoans() {
  const t = today();
  const rows = await all(`SELECT l.id, l.client_id, l.branch_id, l.product_id, l.principal, l.officer_id, l.disbursed_at, l.status, c.name AS client_name,
      COALESCE(SUM(GREATEST(s.total_due - s.paid_amount, 0)), 0) AS outstanding,
      COALESCE(SUM(CASE WHEN s.due_date < ? THEN GREATEST(s.total_due - s.paid_amount, 0) ELSE 0 END), 0) AS overdue,
      COALESCE(SUM(GREATEST(COALESCE(s.penalty_due,0) - COALESCE(s.penalty_paid,0), 0)), 0) AS penalty_outstanding,
      MIN(CASE WHEN s.paid_amount < s.total_due - 0.01 THEN s.due_date END) AS oldest_unpaid
    FROM loans l LEFT JOIN loan_schedule s ON s.loan_id = l.id LEFT JOIN clients c ON c.id = l.client_id
    WHERE l.status IN ('Active','Disbursed') GROUP BY l.id, c.name`, [t]);
  const principalPaid = await all(`SELECT loan_id, COALESCE(SUM(allocated_principal),0) AS p FROM payments WHERE status NOT IN ('Unposted','Reversed') GROUP BY loan_id`);
  const pp = new Map(principalPaid.map(r => [r.loan_id, num(r.p)]));
  return rows.map(l => ({ ...l, outstanding: num(l.outstanding), overdue: num(l.overdue), penaltyOutstanding: num(l.penalty_outstanding), principal: num(l.principal),
    principalOutstanding: Math.max(0, num(l.principal) - (pp.get(l.id) || 0)),
    daysLate: l.oldest_unpaid && l.oldest_unpaid < t ? daysBetween(l.oldest_unpaid, t) : 0 }));
}
const AGEING = [['Current', 0, 0], ['1-30 days', 1, 30], ['31-60 days', 31, 60], ['61-90 days', 61, 90], ['Over 90 days', 91, 1e9]];
const ageing = loans => AGEING.map(([bucket, lo, hi]) => { const xs = loans.filter(l => l.daysLate >= lo && l.daysLate <= hi); return { bucket, loans: xs.length, amount: round2(xs.reduce((s, l) => s + l.outstanding, 0)) }; });

async function buildFinance(year) {
  const months = lastMonths(12);
  const from = months[0] + '-01';
  const yFrom = `${year}-01-01`, yTo = `${year + 1}-01-01`;
  const accounts = await all('SELECT id, code, name, account_type FROM gl_accounts ORDER BY code');
  const typeOf = new Map(accounts.map(a => [a.id, a.account_type]));
  const nameOf = new Map(accounts.map(a => [a.id, a.name]));

  // Journal movement per month and account (last 12 months) and per account/branch/month for the chosen year.
  const jm = await all(`SELECT to_char(entry_date::timestamptz, 'YYYY-MM') AS m, account_id, COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c
    FROM journal_entries WHERE entry_date >= ? GROUP BY 1, 2`, [from]);
  const jy = await all(`SELECT to_char(entry_date::timestamptz, 'YYYY-MM') AS m, account_id, branch_id, COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c
    FROM journal_entries WHERE entry_date >= ? AND entry_date < ? GROUP BY 1, 2, 3`, [yFrom, yTo]);
  const signed = (r) => { const t = typeOf.get(r.account_id); return ['Asset', 'Expense'].includes(t) ? num(r.d) - num(r.c) : num(r.c) - num(r.d); };
  const sumType = (rows, m, type) => rows.filter(r => r.m === m && typeOf.get(r.account_id) === type).reduce((s, r) => s + signed(r), 0);
  const sumAcct = (rows, m, a) => rows.filter(r => r.m === m && r.account_id === a).reduce((s, r) => s + signed(r), 0);
  const CASH = ['cash', 'bank', 'mpesa'];

  const disb = await all(`SELECT to_char(disbursed_at::timestamptz, 'YYYY-MM') AS m, COUNT(*)::int AS n, COALESCE(SUM(principal),0) AS v FROM loans WHERE disbursed_at IS NOT NULL AND disbursed_at >= ? GROUP BY 1`, [from]);
  const coll = await all(`SELECT to_char(created_at::timestamptz, 'YYYY-MM') AS m, COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS v,
      COALESCE(SUM(allocated_principal),0) AS p, COALESCE(SUM(allocated_interest),0) AS i, COALESCE(SUM(allocated_penalty),0) AS pen
    FROM payments WHERE status NOT IN ('Unposted','Reversed') AND created_at >= ? GROUP BY 1`, [from]);
  const due = await all(`SELECT to_char(due_date::date, 'YYYY-MM') AS m, COALESCE(SUM(total_due),0) AS v FROM loan_schedule s JOIN loans l ON l.id = s.loan_id
    WHERE l.status NOT IN ('Rejected','Pending','Cancelled') AND s.due_date >= ? AND s.due_date <= ? GROUP BY 1`, [from, today()]);
  const fees = await all(`SELECT to_char(COALESCE(confirmed_at, created_at)::timestamptz, 'YYYY-MM') AS m, COUNT(*)::int AS n, COALESCE(SUM(amount),0) AS v FROM loan_fee_payments WHERE status = 'Confirmed' AND COALESCE(confirmed_at, created_at) >= ? GROUP BY 1`, [from]);
  const find = (rows, m) => rows.find(x => x.m === m) || {};

  const monthly = months.map(m => {
    const income = sumType(jm, m, 'Revenue'); const expenses = sumType(jm, m, 'Expense');
    const cashRows = jm.filter(r => r.m === m && CASH.includes(r.account_id));
    const d = find(disb, m), c = find(coll, m);
    const dueV = num(find(due, m).v);
    return { month: m, disbursed: num(d.v), disbursedLoans: num(d.n), collected: num(c.v), payments: num(c.n),
      principalCollected: num(c.p), interestCollected: num(c.i), penaltyCollected: num(c.pen), due: dueV,
      collectionRate: dueV > 0 ? Math.min(999, num(c.v) / dueV * 100) : null,
      interestIncome: sumAcct(jm, m, 'interest_income'), feeIncome: sumAcct(jm, m, 'fee_income'), penaltyIncome: sumAcct(jm, m, 'penalty_income'),
      income, expenses, netProfit: income - expenses,
      cashIn: cashRows.reduce((s, r) => s + num(r.d), 0), cashOut: cashRows.reduce((s, r) => s + num(r.c), 0),
      processingFees: num(find(fees, m).v), processingFeeCount: num(find(fees, m).n) };
  });

  // Per GL account (last 12 months, by month) for revenue and expense accounts.
  const glLines = accounts.filter(a => ['Revenue', 'Expense'].includes(a.account_type)).map(a => {
    const byMonth = months.map(m => round2(sumAcct(jm, m, a.id)));
    const ytd = jy.filter(r => r.account_id === a.id).reduce((s, r) => s + signed(r), 0);
    return { account: a.id, code: a.code, name: a.name, type: a.account_type, byMonth, total12: round2(byMonth.reduce((s, v) => s + v, 0)), ytd: round2(ytd) };
  }).filter(a => a.total12 || a.ytd || a.type === 'Revenue');

  // Year-to-date actuals by account, branch and month (for budgets and variance).
  const actuals = jy.filter(r => ['Revenue', 'Expense'].includes(typeOf.get(r.account_id)))
    .map(r => ({ month: r.m, account: r.account_id, branchId: r.branch_id || null, amount: round2(signed(r)) })).filter(r => r.amount);

  // ---- Branches ----
  const loans = await activeLoans();
  const branches = await all(`SELECT b.id, b.code, b.name, b.status, b.created_at, b.region_id, r.name AS region FROM branches b LEFT JOIN regions r ON r.id = b.region_id ORDER BY b.name`);
  const bClients = await all('SELECT branch_id, COUNT(*)::int AS n FROM clients GROUP BY branch_id');
  const bStaff = await all(`SELECT branch_id, COUNT(*)::int AS n, SUM(CASE WHEN role_id = 'loan_officer' THEN 1 ELSE 0 END)::int AS o FROM users WHERE status <> 'Terminated' GROUP BY branch_id`);
  const bDisb = await all('SELECT branch_id, COUNT(*)::int AS n, COALESCE(SUM(principal),0) AS v FROM loans WHERE disbursed_at IS NOT NULL AND disbursed_at >= ? GROUP BY branch_id', [from]);
  const bColl = await all(`SELECT l.branch_id, COALESCE(SUM(p.amount),0) AS v FROM payments p JOIN loans l ON l.id = p.loan_id WHERE p.status NOT IN ('Unposted','Reversed') AND p.created_at >= ? GROUP BY l.branch_id`, [from]);
  const bDue = await all(`SELECT l.branch_id, COALESCE(SUM(s.total_due),0) AS v FROM loan_schedule s JOIN loans l ON l.id = s.loan_id WHERE l.status NOT IN ('Rejected','Pending','Cancelled') AND s.due_date >= ? AND s.due_date <= ? GROUP BY l.branch_id`, [from, today()]);
  const bJ = await all(`SELECT branch_id, account_id, COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_entries WHERE entry_date >= ? GROUP BY 1, 2`, [from]);
  const byB = (rows, id) => rows.find(r => r.branch_id === id) || {};
  const branchRows = branches.map(b => {
    const xs = loans.filter(l => l.branch_id === b.id); const o = xs.reduce((s, l) => s + l.outstanding, 0);
    const j = bJ.filter(r => r.branch_id === b.id);
    const income = j.filter(r => typeOf.get(r.account_id) === 'Revenue').reduce((s, r) => s + signed(r), 0);
    const expenses = j.filter(r => typeOf.get(r.account_id) === 'Expense').reduce((s, r) => s + signed(r), 0);
    const collected = num(byB(bColl, b.id).v), dueV = num(byB(bDue, b.id).v);
    return { id: b.id, code: b.code, name: b.name, status: b.status, createdAt: b.created_at, regionId: b.region_id, region: b.region || '',
      clients: num(byB(bClients, b.id).n), staff: num(byB(bStaff, b.id).n), officers: num(byB(bStaff, b.id).o),
      activeLoans: xs.length, outstanding: round2(o), par30: o > 0 ? xs.filter(l => l.daysLate > 30).reduce((s, l) => s + l.outstanding, 0) / o * 100 : 0,
      disbursed12: num(byB(bDisb, b.id).v), loans12: num(byB(bDisb, b.id).n), collected12: collected, due12: dueV,
      collectionRate: dueV > 0 ? collected / dueV * 100 : null, income12: round2(income), expenses12: round2(expenses), net12: round2(income - expenses) };
  });

  // ---- Products ----
  const products = await all('SELECT id, name FROM loan_products ORDER BY name');
  const pDisb = await all('SELECT product_id, COUNT(*)::int AS n, COALESCE(SUM(principal),0) AS v, COALESCE(SUM(processing_fee),0) AS f FROM loans WHERE disbursed_at IS NOT NULL AND disbursed_at >= ? GROUP BY product_id', [from]);
  const pColl = await all(`SELECT l.product_id, COALESCE(SUM(p.amount),0) AS v, COALESCE(SUM(p.allocated_interest),0) AS i, COALESCE(SUM(p.allocated_penalty),0) AS pen FROM payments p JOIN loans l ON l.id = p.loan_id WHERE p.status NOT IN ('Unposted','Reversed') AND p.created_at >= ? GROUP BY l.product_id`, [from]);
  const productRows = products.map(p => { const xs = loans.filter(l => l.product_id === p.id); const d = pDisb.find(r => r.product_id === p.id) || {}; const c = pColl.find(r => r.product_id === p.id) || {};
    return { id: p.id, name: p.name, activeLoans: xs.length, outstanding: round2(xs.reduce((s, l) => s + l.outstanding, 0)), disbursed12: num(d.v), loans12: num(d.n),
      processingFees12: num(d.f), collected12: num(c.v), interest12: num(c.i), penalty12: num(c.pen) }; });

  // ---- Penalties ----
  const pen = await get(`SELECT COALESCE(SUM(penalty_due),0) AS due, COALESCE(SUM(penalty_paid),0) AS paid FROM loan_schedule`);
  const penaltyByBranch = branchRows.map(b => ({ branch: b.name, outstanding: round2(loans.filter(l => l.branch_id === b.id).reduce((s, l) => s + l.penaltyOutstanding, 0)) })).filter(b => b.outstanding > 0);

  // ---- Balances ----
  const bal = {};
  for (const a of accounts) bal[a.id] = round2(await ledgerBalance(a.id, null));

  // ---- Receivables ----
  const t = today();
  const interestRecv = await get(`SELECT COALESCE(SUM(GREATEST(s.interest_due - GREATEST(s.paid_amount - s.principal_due, 0), 0)),0) AS v FROM loan_schedule s JOIN loans l ON l.id = s.loan_id
    WHERE l.status IN ('Active','Disbursed') AND s.due_date < ? AND s.paid_amount < s.total_due`, [t]);
  const receivables = { ageing: ageing(loans), outstanding: round2(loans.reduce((s, l) => s + l.outstanding, 0)), overdue: round2(loans.reduce((s, l) => s + l.overdue, 0)),
    principalOutstanding: round2(loans.reduce((s, l) => s + l.principalOutstanding, 0)), interestOverdue: round2(num(interestRecv.v)),
    penaltiesOutstanding: round2(loans.reduce((s, l) => s + l.penaltyOutstanding, 0)), ledgerLoansReceivable: bal.loans_receivable || 0,
    byBranch: branchRows.map(b => ({ branch: b.name, region: b.region, loans: b.activeLoans, outstanding: b.outstanding,
      overdue: round2(loans.filter(l => l.branch_id === b.id).reduce((s, l) => s + l.overdue, 0)) })).filter(b => b.loans) };

  // ---- Payables ----
  const nm = 'LEFT JOIN branches b ON b.id = x.branch_id';
  const payables = {
    expenses: await all(`SELECT x.id, x.category AS item, x.amount, x.status, x.created_at, b.name AS branch FROM expenses x ${nm} WHERE x.status IN ('Pending','Approved') ORDER BY x.created_at`),
    requisitions: await all(`SELECT x.id, x.category AS item, x.amount, x.status, x.created_at, b.name AS branch FROM requisitions x ${nm} WHERE x.status IN ('Pending','Approved') ORDER BY x.created_at`),
    utilities: await all(`SELECT x.id, (x.utility_type || ' — ' || COALESCE(x.provider,'')) AS item, x.amount, x.status, x.created_at, b.name AS branch FROM utility_payments x ${nm} WHERE x.status IN ('Pending','CEO Approved') ORDER BY x.created_at`),
    investorPayouts: await all(`SELECT p.id, (i.name || ' — ' || p.period) AS item, p.investor_profit AS amount, p.status, p.period AS created_at, NULL AS branch FROM investor_payouts p JOIN investors i ON i.id = p.investor_id WHERE p.status <> 'Paid' ORDER BY p.period`),
    refunds: await all(`SELECT x.id, ('Refund — ' || COALESCE(c.name,'')) AS item, x.amount, x.status, x.created_at, b.name AS branch FROM acct_records x LEFT JOIN clients c ON c.id = x.ref_id ${nm} WHERE x.kind = 'refund' AND x.status IN ('Pending','Approved') ORDER BY x.created_at`),
  };
  for (const k of Object.keys(payables)) payables[k] = payables[k].map(r => ({ ...r, amount: num(r.amount), ageDays: r.created_at && /^\d{4}-\d{2}-\d{2}/.test(r.created_at) ? Math.max(0, daysBetween(String(r.created_at).slice(0, 10), t)) : null }));

  return {
    generatedAt: new Date().toISOString(), year, months, monthly, glLines, actuals,
    accounts: accounts.map(a => ({ id: a.id, code: a.code, name: a.name, type: a.account_type, balance: bal[a.id] || 0 })),
    branches: branchRows, products: productRows,
    penalties: { accrued: round2(num(pen.due)), paid: round2(num(pen.paid)), outstanding: round2(num(pen.due) - num(pen.paid)), byBranch: penaltyByBranch },
    cash: { cash: bal.cash || 0, bank: bal.bank || 0, mpesa: bal.mpesa || 0, total: round2((bal.cash || 0) + (bal.bank || 0) + (bal.mpesa || 0)) },
    receivables, payables,
    portfolio: { activeLoans: loans.length, outstanding: receivables.outstanding, par30: receivables.outstanding > 0 ? loans.filter(l => l.daysLate > 30).reduce((s, l) => s + l.outstanding, 0) / receivables.outstanding * 100 : 0 },
    nameOf: Object.fromEntries(nameOf),
  };
}

async function buildControls() {
  const t = today();
  const from60 = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  const verRows = await all(`SELECT r.ref_type, r.ref_id, r.status, r.outcome, r.updated_at, u.name AS by_name FROM acct_records r LEFT JOIN users u ON u.id = r.created_by
    WHERE r.kind = 'verification' ORDER BY r.updated_at`);
  const ver = {}; for (const v of verRows) ver[v.ref_type + ':' + v.ref_id] = { status: v.status, note: v.outcome, at: v.updated_at, by: v.by_name };

  // Payments in the last 60 days, with simple risk flags.
  const pays = await all(`SELECT p.id, p.amount, p.channel, p.reference, p.status, p.created_at, p.loan_id, p.allocated_principal, p.allocated_interest, p.allocated_penalty,
      c.name AS client, b.name AS branch, u.name AS recorded_by FROM payments p LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN loans l ON l.id = p.loan_id
      LEFT JOIN branches b ON b.id = l.branch_id LEFT JOIN users u ON u.id = p.recorded_by WHERE p.created_at >= ? ORDER BY p.created_at DESC LIMIT 1500`, [from60]);
  const amts = pays.map(p => num(p.amount)).sort((a, b) => a - b);
  const median = amts.length ? amts[Math.floor(amts.length / 2)] : 0;
  const refCount = new Map(); for (const p of pays) if (p.reference) refCount.set(p.reference, (refCount.get(p.reference) || 0) + 1);
  const payments = pays.map(p => {
    const overpay = Math.max(0, num(p.amount) - num(p.allocated_principal) - num(p.allocated_interest) - num(p.allocated_penalty));
    const flags = [];
    if (p.reference && refCount.get(p.reference) > 1) flags.push('Duplicate reference');
    if (median > 0 && num(p.amount) > median * 5) flags.push('Unusually large');
    if (['Posted', 'Overpayment'].includes(p.status) && overpay > 0.5) flags.push('Overpayment');
    if (p.status === 'Reversed') flags.push('Reversed');
    if (p.status === 'Unposted' && daysBetween(String(p.created_at).slice(0, 10), t) > 2) flags.push('Unposted over 2 days');
    return { id: p.id, amount: num(p.amount), channel: p.channel, reference: p.reference, status: p.status, createdAt: p.created_at, loanId: p.loan_id,
      client: p.client, branch: p.branch, recordedBy: p.recorded_by, overpay: round2(overpay), flags, verification: ver['payment:' + p.id] || null };
  });

  // Journal transactions (grouped by source document) in the last 60 days.
  const tx = await all(`SELECT j.ref_type, j.ref_id, MIN(j.entry_date) AS entry_date, COALESCE(SUM(j.debit),0) AS d, COALESCE(SUM(j.credit),0) AS c, COUNT(*)::int AS lines,
      MIN(j.description) AS description, MIN(b.name) AS branch, MIN(u.name) AS posted_by
    FROM journal_entries j LEFT JOIN branches b ON b.id = j.branch_id LEFT JOIN users u ON u.id = j.posted_by
    WHERE j.entry_date >= ? GROUP BY j.ref_type, j.ref_id ORDER BY MIN(j.entry_date) DESC LIMIT 1500`, [from60]);
  const transactions = tx.map(x => ({ refType: x.ref_type || 'manual', refId: x.ref_id, date: x.entry_date, debit: round2(x.d), credit: round2(x.c), lines: x.lines,
    balanced: Math.abs(num(x.d) - num(x.c)) < 0.01, description: x.description, branch: x.branch, postedBy: x.posted_by,
    verification: ver['journal:' + (x.ref_type || 'manual') + ':' + x.ref_id] || null }));
  const tb = await get('SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_entries');

  // Loan financial validation.
  const loans = await activeLoans();
  const sched = await all(`SELECT loan_id, COUNT(*)::int AS n, COALESCE(SUM(principal_due),0) AS p, SUM(CASE WHEN paid_amount > total_due + COALESCE(penalty_due,0) + 0.5 THEN 1 ELSE 0 END)::int AS over
    FROM loan_schedule GROUP BY loan_id`);
  const sm = new Map(sched.map(s => [s.loan_id, s]));
  const loanIssues = [];
  for (const l of loans) {
    const s = sm.get(l.id); const issues = [];
    if (!s || !s.n) issues.push('No repayment schedule');
    else if (Math.abs(num(s.p) - l.principal) > 1) issues.push(`Schedule principal (${round2(s.p)}) differs from the loan amount`);
    if (!l.disbursed_at) issues.push('Active but no disbursement date');
    if (s && s.n && l.outstanding <= 0.01) issues.push('Fully repaid but still active');
    if (s && s.over) issues.push('An instalment is overpaid');
    if (issues.length) loanIssues.push({ loanId: l.id, client: l.client_name, branchId: l.branch_id, principal: l.principal, outstanding: round2(l.outstanding), issues, verification: ver['loan:' + l.id] || null });
  }
  const branchNames = new Map((await all('SELECT id, name FROM branches')).map(b => [b.id, b.name]));
  for (const x of loanIssues) x.branch = branchNames.get(x.branchId) || '';

  // Suspense: unmatched M-Pesa, unposted payments and client credit balances.
  const unmatched = await all(`SELECT id, trans_id, amount, msisdn, bill_ref_number, created_at FROM mpesa_c2b_transactions WHERE payment_id IS NULL ORDER BY created_at DESC LIMIT 500`);
  const unposted = payments.filter(p => p.status === 'Unposted');
  const overpaid = await all(`SELECT p.client_id, c.name AS client, b.name AS branch,
      COALESCE(SUM(GREATEST(p.amount - COALESCE(p.allocated_principal,0) - COALESCE(p.allocated_interest,0) - COALESCE(p.allocated_penalty,0), 0)),0) AS v
    FROM payments p LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN branches b ON b.id = c.branch_id WHERE p.status IN ('Posted','Overpayment') GROUP BY p.client_id, c.name, b.name`);
  const refunded = await all(`SELECT ref_id, status, COALESCE(SUM(amount),0) AS v FROM acct_records WHERE kind = 'refund' AND status IN ('Pending','Approved','Paid') GROUP BY ref_id, status`);
  const credits = overpaid.filter(o => num(o.v) > 0.5).map(o => {
    const paid = refunded.filter(r => r.ref_id === o.client_id && r.status === 'Paid').reduce((s, r) => s + num(r.v), 0);
    const held = refunded.filter(r => r.ref_id === o.client_id && r.status !== 'Paid').reduce((s, r) => s + num(r.v), 0);
    return { clientId: o.client_id, client: o.client, branch: o.branch, overpaid: round2(o.v), refunded: round2(paid), pendingRefund: round2(held), available: round2(num(o.v) - paid - held) };
  });
  const suspense = {
    overpaymentSuspense: round2(await ledgerBalance('overpayment_suspense', null)), loanOverpayments: round2(await ledgerBalance('loan_overpayments', null)),
    clientsWallet: round2(await ledgerBalance('clients_wallet', null)),
    unmatched: unmatched.map(u => ({ ...u, amount: num(u.amount), ageDays: daysBetween(String(u.created_at).slice(0, 10), t) })),
    unposted, credits };

  // Write-off candidates (over 90 days late) and loans already written off.
  const writeOffCandidates = loans.filter(l => l.daysLate > 90).sort((a, b) => b.daysLate - a.daysLate)
    .map(l => ({ loanId: l.id, client: l.client_name, branch: branchNames.get(l.branch_id) || '', principal: l.principal, outstanding: round2(l.outstanding), principalOutstanding: round2(l.principalOutstanding), daysLate: l.daysLate }));
  const writtenOff = (await all(`SELECT l.id, l.principal, l.written_off_at, c.name AS client, b.name AS branch FROM loans l LEFT JOIN clients c ON c.id = l.client_id LEFT JOIN branches b ON b.id = l.branch_id
    WHERE l.status = 'Written Off' ORDER BY l.written_off_at DESC`)).map(l => ({ ...l, principal: num(l.principal) }));

  // Automatically detected control exceptions.
  const exceptions = [];
  if (Math.abs(num(tb.d) - num(tb.c)) >= 0.01) exceptions.push({ type: 'Ledger', severity: 'High', title: 'Trial balance does not balance', detail: `Debits ${round2(tb.d)} vs credits ${round2(tb.c)}` });
  for (const x of transactions.filter(x => !x.balanced)) exceptions.push({ type: 'Journal', severity: 'High', title: 'Unbalanced transaction', detail: `${x.refType} ${x.refId || ''}: debit ${x.debit} / credit ${x.credit}`, ref: x.refId });
  for (const p of unposted.filter(p => p.flags.includes('Unposted over 2 days'))) exceptions.push({ type: 'Payment', severity: 'Medium', title: 'Payment unposted for over 2 days', detail: `${p.client || ''} — KES ${p.amount} (${p.reference || p.id})`, ref: p.id });
  for (const p of payments.filter(p => p.flags.includes('Duplicate reference'))) exceptions.push({ type: 'Payment', severity: 'Medium', title: 'Duplicate payment reference', detail: `${p.reference} — ${p.client || ''} KES ${p.amount}`, ref: p.id });
  for (const u of suspense.unmatched.filter(u => u.ageDays >= 1)) exceptions.push({ type: 'M-Pesa', severity: 'Medium', title: 'Unmatched M-Pesa payment', detail: `${u.trans_id} — KES ${u.amount} (account ${u.bill_ref_number || '—'})`, ref: u.id });
  for (const l of loanIssues) exceptions.push({ type: 'Loan', severity: 'Medium', title: l.issues[0], detail: `${l.client || ''} — loan ${l.loanId}`, ref: l.loanId });
  for (const a of ['cash', 'bank', 'mpesa']) { const v = await ledgerBalance(a, null); if (v < -0.01) exceptions.push({ type: 'Cash', severity: 'High', title: `Negative ${a === 'mpesa' ? 'M-Pesa' : a} balance`, detail: `Ledger balance ${round2(v)}` }); }
  const staleExp = await all(`SELECT id, category, amount, created_at FROM expenses WHERE status = 'Approved' AND created_at < ?`, [new Date(Date.now() - 7 * 86400000).toISOString()]);
  for (const e of staleExp) exceptions.push({ type: 'Payable', severity: 'Low', title: 'Approved expense unpaid for over 7 days', detail: `${e.category} — KES ${num(e.amount)}`, ref: e.id });

  return { generatedAt: new Date().toISOString(), payments, transactions, trialBalance: { debit: round2(tb.d), credit: round2(tb.c) }, loanIssues, suspense, writeOffCandidates, writtenOff, exceptions };
}

async function buildClientQuality() {
  const clients = await all(`SELECT c.id, c.client_code, c.name, c.national_id, c.phone, c.address, c.next_of_kin, c.next_of_kin_phone, c.business_type, c.verification_status, c.status, c.created_at,
      b.name AS branch, u.name AS officer, (SELECT COUNT(*) FROM client_documents d WHERE d.client_id = c.id)::int AS docs
    FROM clients c LEFT JOIN branches b ON b.id = c.branch_id LEFT JOIN users u ON u.id = c.officer_id ORDER BY c.created_at DESC`);
  const phoneCount = new Map(), idCount = new Map();
  for (const c of clients) { if (c.phone) phoneCount.set(c.phone, (phoneCount.get(c.phone) || 0) + 1); if (c.national_id) idCount.set(c.national_id, (idCount.get(c.national_id) || 0) + 1); }
  const CHECKS = [
    ['Missing ID number', c => !c.national_id], ['Invalid phone number', c => !/^(\+?254|0)[17]\d{8}$/.test(String(c.phone || '').replace(/\s/g, ''))],
    ['Missing next of kin', c => !c.next_of_kin || !c.next_of_kin_phone], ['Missing address', c => !c.address], ['Missing business type', c => !c.business_type],
    ['No documents', c => !c.docs], ['Not verified', c => c.verification_status !== 'Verified'],
    ['Duplicate phone', c => c.phone && phoneCount.get(c.phone) > 1], ['Duplicate ID number', c => c.national_id && idCount.get(c.national_id) > 1],
  ];
  const rows = clients.map(c => ({ id: c.id, code: c.client_code, name: c.name, branch: c.branch, officer: c.officer, status: c.status, createdAt: c.created_at,
    issues: CHECKS.filter(([, f]) => f(c)).map(([n]) => n) }));
  return { generatedAt: new Date().toISOString(), total: clients.length, checks: CHECKS.map(([n]) => ({ check: n, clients: rows.filter(r => r.issues.includes(n)).length })),
    complete: rows.filter(r => !r.issues.length).length, clients: rows.filter(r => r.issues.length).slice(0, 2000) };
}

async function buildDaily(date) {
  const next = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const disb = await all(`SELECT l.id, l.principal, l.processing_fee, c.name AS client, b.name AS branch, p.name AS product FROM loans l LEFT JOIN clients c ON c.id = l.client_id
    LEFT JOIN branches b ON b.id = l.branch_id LEFT JOIN loan_products p ON p.id = l.product_id WHERE l.disbursed_at >= ? AND l.disbursed_at < ? ORDER BY l.disbursed_at`, [date, next]);
  const coll = await all(`SELECT p.id, p.amount, p.channel, p.status, p.reference, c.name AS client, b.name AS branch FROM payments p LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN loans l ON l.id = p.loan_id LEFT JOIN branches b ON b.id = l.branch_id WHERE p.created_at >= ? AND p.created_at < ? ORDER BY p.created_at`, [date, next]);
  const journal = await all(`SELECT j.account_id, a.name, a.account_type, COALESCE(SUM(j.debit),0) AS d, COALESCE(SUM(j.credit),0) AS c FROM journal_entries j LEFT JOIN gl_accounts a ON a.id = j.account_id
    WHERE j.entry_date >= ? AND j.entry_date < ? GROUP BY j.account_id, a.name, a.account_type ORDER BY a.name`, [date, next]);
  const cashOpen = await get(`SELECT COALESCE(SUM(debit - credit),0) AS v FROM journal_entries WHERE account_id IN ('cash','bank','mpesa') AND entry_date < ?`, [date]);
  const cashClose = await get(`SELECT COALESCE(SUM(debit - credit),0) AS v FROM journal_entries WHERE account_id IN ('cash','bank','mpesa') AND entry_date < ?`, [next]);
  const signed = r => ['Asset', 'Expense'].includes(r.account_type) ? num(r.d) - num(r.c) : num(r.c) - num(r.d);
  const counted = coll.filter(p => !['Unposted', 'Reversed'].includes(p.status));
  return { date, disbursements: disb.map(d => ({ ...d, principal: num(d.principal), processing_fee: num(d.processing_fee) })),
    collections: coll.map(c => ({ ...c, amount: num(c.amount) })),
    totals: { disbursed: disb.reduce((s, d) => s + num(d.principal), 0), loans: disb.length, collected: counted.reduce((s, p) => s + num(p.amount), 0), payments: counted.length,
      unposted: coll.filter(p => p.status === 'Unposted').reduce((s, p) => s + num(p.amount), 0),
      income: journal.filter(r => r.account_type === 'Revenue').reduce((s, r) => s + signed(r), 0), expenses: journal.filter(r => r.account_type === 'Expense').reduce((s, r) => s + signed(r), 0),
      cashOpening: round2(cashOpen.v), cashClosing: round2(cashClose.v) },
    journal: journal.map(r => ({ account: r.account_id, name: r.name, type: r.account_type, debit: round2(r.d), credit: round2(r.c) })) };
}

function recOut(r) {
  return { id: r.id, kind: r.kind, title: r.title, details: r.details, category: r.category, status: r.status, branchId: r.branch_id, branch: r.branch_name || null,
    period: r.period, amount: r.amount != null ? Number(r.amount) : null, refType: r.ref_type, refId: r.ref_id, refName: r.ref_name || null,
    data: parseJson(r.data_json) || {}, outcome: r.outcome, createdBy: r.created_by, createdByName: r.created_name || null, createdAt: r.created_at, updatedAt: r.updated_at,
    decidedBy: r.decided_by, decidedByName: r.decided_name || null, decidedAt: r.decided_at };
}
const SELECT = `SELECT r.*, b.name AS branch_name, c.name AS created_name, d.name AS decided_name,
    CASE WHEN r.ref_type = 'client' THEN (SELECT name FROM clients WHERE id = r.ref_id) WHEN r.ref_type = 'loan' THEN (SELECT cl.name FROM loans l JOIN clients cl ON cl.id = l.client_id WHERE l.id = r.ref_id) END AS ref_name
  FROM acct_records r LEFT JOIN branches b ON b.id = r.branch_id LEFT JOIN users c ON c.id = r.created_by LEFT JOIN users d ON d.id = r.decided_by`;

async function clientCredit(clientId, excludeId) {
  const o = await get(`SELECT COALESCE(SUM(GREATEST(amount - COALESCE(allocated_principal,0) - COALESCE(allocated_interest,0) - COALESCE(allocated_penalty,0), 0)),0) AS v FROM payments WHERE client_id = ? AND status IN ('Posted','Overpayment')`, [clientId]);
  const r = await get(`SELECT COALESCE(SUM(amount),0) AS v FROM acct_records WHERE kind = 'refund' AND ref_id = ? AND status IN ('Pending','Approved','Paid') AND id <> ?`, [clientId, excludeId || '']);
  return round2(num(o.v) - num(r.v));
}

function register(router) {
  router.get('/api/acct/finance', requireAuth, requireView, async (req, res, next) => {
    const year = req.query.year ? Number(req.query.year) : new Date().getUTCFullYear();
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return next({ status: 400, message: 'Year must be a four-digit year' });
    res.json(await buildFinance(year));
  });
  router.get('/api/acct/controls', requireAuth, requireView, async (req, res) => res.json(await buildControls()));
  router.get('/api/acct/client-quality', requireAuth, requireView, async (req, res) => res.json(await buildClientQuality()));
  router.get('/api/acct/daily', requireAuth, requireView, async (req, res, next) => {
    const date = req.query.date || today();
    if (!isDate(date)) return next({ status: 400, message: 'Date must be YYYY-MM-DD' });
    res.json(await buildDaily(date));
  });

  router.get('/api/acct/records', requireAuth, requireView, async (req, res, next) => {
    const clauses = ['1=1']; const params = [];
    if (req.query.kind) {
      const kinds = String(req.query.kind).split(',');
      if (kinds.some(k => !KINDS[k])) return next({ status: 400, message: 'Unknown record type' });
      clauses.push(`r.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds);
    }
    const rows = await all(`${SELECT} WHERE ${clauses.join(' AND ')} ORDER BY r.created_at DESC LIMIT 3000`, params);
    res.json({ records: rows.map(recOut) });
  });

  router.post('/api/acct/records', requireAuth, requireView, requireWrite, async (req, res, next) => {
    const b = req.body || {};
    const def = KINDS[b.kind];
    if (!def) return next({ status: 400, message: 'Unknown record type' });
    const amount = b.amount === undefined || b.amount === null || b.amount === '' ? null : Number(b.amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) return next({ status: 400, message: 'Amount must be zero or more' });
    if (b.branch_id && !(await get('SELECT id FROM branches WHERE id = ?', [b.branch_id]))) return next({ status: 400, message: 'Unknown branch' });
    let title = clean(b.title, 200), category = clean(b.category, 80), period = clean(b.period, 7), refType = clean(b.ref_type, 20), refId = clean(b.ref_id, 80);
    let status = def.statuses[0]; let finalAmount = amount; const data = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {};

    if (b.kind === 'budget') {
      if (!category || !(await get(`SELECT id FROM gl_accounts WHERE id = ? AND account_type IN ('Revenue','Expense')`, [category]))) return next({ status: 400, message: 'Choose an income or expense account' });
      if (!/^\d{4}(-(0[1-9]|1[0-2]))?$/.test(period || '')) return next({ status: 400, message: 'Budget period must be a year (YYYY) or a month (YYYY-MM)' });
      if (!(amount > 0)) return next({ status: 400, message: 'Enter the budget amount' });
      const dup = await get(`SELECT id FROM acct_records WHERE kind = 'budget' AND category = ? AND period = ? AND COALESCE(branch_id,'') = ? AND status IN ('Pending','Approved')`, [category, period, b.branch_id || '']);
      if (dup) return next({ status: 409, message: 'A budget for this account, period and branch already exists' });
      title = title || `${(await get('SELECT name FROM gl_accounts WHERE id = ?', [category])).name} — ${period}`;
    } else if (b.kind === 'forecast') {
      if (!FORECAST_LINES.includes(category)) return next({ status: 400, message: `Forecast line must be one of: ${FORECAST_LINES.join(', ')}` });
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '')) return next({ status: 400, message: 'Forecast month must be YYYY-MM' });
      if (!(amount >= 0) || amount === null) return next({ status: 400, message: 'Enter the forecast amount' });
      await run(`UPDATE acct_records SET status = 'Superseded', updated_at = iso_now() WHERE kind = 'forecast' AND category = ? AND period = ? AND COALESCE(branch_id,'') = ? AND status = 'Active'`, [category, period, b.branch_id || '']);
      title = title || `${category} forecast — ${period}`;
    } else if (b.kind === 'refund') {
      if (refType !== 'client' || !refId || !(await get('SELECT id FROM clients WHERE id = ?', [refId]))) return next({ status: 400, message: 'Choose the client to refund' });
      if (!(amount > 0)) return next({ status: 400, message: 'Enter the refund amount' });
      const avail = await clientCredit(refId);
      if (amount > avail + 0.01) return next({ status: 400, message: `The client only has KES ${avail} of overpayment available to refund` });
      const method = String(data.method || 'M-Pesa');
      if (!['Cash', 'Bank', 'M-Pesa'].includes(method)) return next({ status: 400, message: 'Refund method must be Cash, Bank or M-Pesa' });
      data.method = method;
      const cl = await get('SELECT name, branch_id FROM clients WHERE id = ?', [refId]);
      title = title || `Refund to ${cl.name}`; if (!b.branch_id) b.branch_id = cl.branch_id;
    } else if (b.kind === 'write_off') {
      const loan = refType === 'loan' && refId ? await get('SELECT * FROM loans WHERE id = ?', [refId]) : null;
      if (!loan) return next({ status: 400, message: 'Choose the loan to write off' });
      if (!['Active', 'Disbursed'].includes(loan.status)) return next({ status: 400, message: 'Only an active loan can be written off' });
      if (await get(`SELECT id FROM acct_records WHERE kind = 'write_off' AND ref_id = ? AND status IN ('Pending','Approved')`, [loan.id])) return next({ status: 409, message: 'A write-off for this loan is already in progress' });
      if (!clean(b.details, 4000)) return next({ status: 400, message: 'Give the reason for the write-off' });
      const pp = await get(`SELECT COALESCE(SUM(allocated_principal),0) AS p FROM payments WHERE loan_id = ? AND status NOT IN ('Unposted','Reversed')`, [loan.id]);
      finalAmount = round2(Math.max(0, num(loan.principal) - num(pp.p)));
      const cl = await get('SELECT name FROM clients WHERE id = ?', [loan.client_id]);
      title = title || `Write off ${cl ? cl.name : loan.id}`; if (!b.branch_id) b.branch_id = loan.branch_id;
    } else if (b.kind === 'verification') {
      if (!REF_TYPES.includes(refType) || !refId) return next({ status: 400, message: 'Say what is being verified' });
      status = def.statuses.includes(b.status) ? b.status : 'Verified';
      if (status === 'Flagged' && !clean(b.outcome, 2000)) return next({ status: 400, message: 'Say why it is flagged' });
      const existing = await get(`SELECT id FROM acct_records WHERE kind = 'verification' AND ref_type = ? AND ref_id = ?`, [refType, refId]);
      if (existing) {
        await run(`UPDATE acct_records SET status = ?, outcome = ?, created_by = ?, updated_at = iso_now() WHERE id = ?`, [status, clean(b.outcome, 2000), req.user.id, existing.id]);
        await logAction(req, { action: `Marked ${refType} ${status.toLowerCase()}`, module: 'accounting', recordType: 'Verification', recordId: refId, newValue: { status } });
        return res.json({ record: recOut(await get(`${SELECT} WHERE r.id = ?`, [existing.id])) });
      }
      title = title || `${refType} ${refId}`;
    } else if (b.kind === 'exception') {
      if (!title) return next({ status: 400, message: 'A title is required' });
    }
    const id = 'acr_' + crypto.randomUUID();
    await run(`INSERT INTO acct_records (id, kind, title, details, category, status, branch_id, period, amount, ref_type, ref_id, data_json, outcome, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, b.kind, title, clean(b.details, 4000), category, status, clean(b.branch_id, 60), period, finalAmount, refType, refId, JSON.stringify(data), clean(b.outcome, 2000), req.user.id]);
    await logAction(req, { action: `Recorded ${b.kind.replace(/_/g, ' ')}`, module: 'accounting', recordType: 'AcctRecord:' + b.kind, recordId: id, newValue: { title, status, amount: finalAmount } });
    res.status(201).json({ record: recOut(await get(`${SELECT} WHERE r.id = ?`, [id])) });
  });

  router.patch('/api/acct/records/:id', requireAuth, requireView, async (req, res, next) => {
    const row = await get('SELECT * FROM acct_records WHERE id = ?', [req.params.id]);
    if (!row) return next({ status: 404, message: 'Record not found' });
    const def = KINDS[row.kind]; const b = req.body || {};
    const canWrite = await hasPermission(req.user, 'post_accounting_entries');
    const sets = []; const params = [];
    if (b.status !== undefined && b.status !== row.status) {
      if (!def.statuses.includes(b.status)) return next({ status: 400, message: `Status must be one of: ${def.statuses.join(', ')}` });
      const deciding = def.decision && ['Approved', 'Rejected'].includes(b.status);
      if (deciding) {
        if (!DECIDE.includes(req.user.role_id)) return next({ status: 403, message: 'Only the CEO, Director or System Administrator decides this' });
        if (row.created_by === req.user.id) return next({ status: 403, message: 'You cannot decide something you raised' });
        if (row.status !== 'Pending') return next({ status: 400, message: `This is already ${row.status.toLowerCase()}` });
        sets.push('decided_by = ?', 'decided_at = iso_now()'); params.push(req.user.id);
      } else if (!canWrite) return next({ status: 403, message: 'You need the Post Accounting Entries permission' });
      if (row.kind === 'refund' && b.status === 'Paid') {
        if (row.status !== 'Approved') return next({ status: 400, message: 'Approve the refund first' });
        try { await assertPeriodOpen(); } catch (e) { return next(e); }
        const data = parseJson(row.data_json) || {};
        const funding = glAccountFor(data.method === 'Bank' ? 'bank' : data.method === 'Cash' ? 'cash' : 'mpesa');
        await transaction(async () => {
          await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('overpayment_suspense', ?, 0, ?, 'refund', ?, ?, ?)`, [row.amount, row.title, row.id, row.branch_id, req.user.id]);
          await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES (?, 0, ?, ?, 'refund', ?, ?, ?)`, [funding, row.amount, row.title, row.id, row.branch_id, req.user.id]);
        });
      }
      if (row.kind === 'write_off' && b.status === 'Written Off') {
        if (row.status !== 'Approved') return next({ status: 400, message: 'Approve the write-off first' });
        const loan = await get('SELECT * FROM loans WHERE id = ?', [row.ref_id]);
        if (!loan || !['Active', 'Disbursed'].includes(loan.status)) return next({ status: 409, message: 'This loan is no longer active' });
        try { await assertPeriodOpen(); } catch (e) { return next(e); }
        await transaction(async () => {
          await run(`UPDATE loans SET status = 'Written Off', written_off_at = iso_now() WHERE id = ?`, [loan.id]);
          if (num(row.amount) > 0) {
            await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('bad_debt_reserve', ?, 0, ?, 'write_off', ?, ?, ?)`, [row.amount, row.title, loan.id, loan.branch_id, req.user.id]);
            await run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, posted_by) VALUES ('loans_receivable', 0, ?, ?, 'write_off', ?, ?, ?)`, [row.amount, row.title, loan.id, loan.branch_id, req.user.id]);
          }
        });
      }
      if (def.decision && !deciding && ['Pending'].includes(b.status)) return next({ status: 400, message: 'This cannot go back to pending' });
      sets.push('status = ?'); params.push(b.status);
    } else if (!canWrite) return next({ status: 403, message: 'You need the Post Accounting Entries permission' });
    if (b.outcome !== undefined) { sets.push('outcome = ?'); params.push(clean(b.outcome, 2000)); }
    if (b.details !== undefined) { sets.push('details = ?'); params.push(clean(b.details, 4000)); }
    if (b.amount !== undefined && ['budget', 'forecast', 'exception'].includes(row.kind)) {
      if (row.kind === 'budget' && row.status === 'Approved') return next({ status: 400, message: 'An approved budget cannot be changed — raise a new one' });
      const a = Number(b.amount); if (!Number.isFinite(a) || a < 0) return next({ status: 400, message: 'Amount must be zero or more' });
      sets.push('amount = ?'); params.push(a);
    }
    if (!sets.length) return next({ status: 400, message: 'Nothing to update' });
    await run(`UPDATE acct_records SET ${sets.join(', ')}, updated_at = iso_now() WHERE id = ?`, [...params, row.id]);
    await logAction(req, { action: `Updated ${row.kind.replace(/_/g, ' ')}${b.status ? ' → ' + b.status : ''}`, module: 'accounting', recordType: 'AcctRecord:' + row.kind, recordId: row.id,
      previousValue: { status: row.status }, newValue: b });
    res.json({ record: recOut(await get(`${SELECT} WHERE r.id = ?`, [row.id])) });
  });
}

module.exports = { register, KINDS };
