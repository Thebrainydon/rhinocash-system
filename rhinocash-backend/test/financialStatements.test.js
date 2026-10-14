// financialStatements.test.js — P&L counts every revenue and expense account,
// the comparative statements (month / last month / year to date), balance
// sheet balances, trial balance debit = credit, ratios, and cashflow breakdowns.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.51;

(async () => {
  const db = require('../src/db');
  const acc = (await api('POST', '/api/auth/login', { body: { email: 'accountant@rhinocash.co.ke', password: process.env.SEEDED_ACCOUNTANT_PASSWORD } })).json.token;
  const officer = (await api('POST', '/api/auth/login', { body: { email: 'officer@rhinocash.co.ke', password: process.env.SEEDED_OFFICER_PASSWORD } })).json.token;
  assert(acc, 'setup: the accountant signs in');
  const before = (await api('GET', '/api/accounting/statements', { token: acc })).json;
  const plBefore = (await api('GET', '/api/accounting/profit-and-loss', { token: acc })).json;
  const branch = (await db.get(`SELECT id FROM branches LIMIT 1`)).id;
  const today = new Date().toISOString();
  // Balanced postings this month: rent 3,000 paid in cash; interest 5,000 and penalty 400 received in cash.
  const post = (acct, d, c, ref) => db.run(`INSERT INTO journal_entries (account_id, debit, credit, description, ref_type, ref_id, branch_id, entry_date) VALUES (?,?,?,?,?,?,?,?)`, [acct, d, c, 'statements test', ref, 'fs_' + Date.now(), branch, today]);
  await post('exp_rent', 3000, 0, 'requisition'); await post('cash', 0, 3000, 'requisition');
  await post('cash', 5000, 0, 'payment'); await post('interest_income', 0, 5000, 'payment');
  await post('cash', 400, 0, 'payment'); await post('penalty_income', 0, 400, 'payment');

  // 1. P&L counts every account
  const pl = (await api('GET', '/api/accounting/profit-and-loss', { token: acc })).json;
  assert(near(pl.expenses - plBefore.expenses, 3000), '1: rent posted to its own expense account is counted in P&L expenses');
  assert(near(pl.penaltyIncome - (plBefore.penaltyIncome || 0), 400) && near(pl.totalRevenue - (plBefore.totalRevenue || (plBefore.interestIncome + plBefore.feeIncome)), 5400), '1: penalty income is part of revenue');
  assert(near(pl.netProfit, pl.totalRevenue - pl.expenses), '1: net profit = all revenue − all expenses');

  // 2. Comparative statements
  const st = (await api('GET', '/api/accounting/statements', { token: acc })).json;
  const T = st.income.totals;
  assert(st.month === today.slice(0, 7) && near(T.month.revenue - before.income.totals.month.revenue, 5400) && near(T.month.expenses - before.income.totals.month.expenses, 3000), '2: this month\'s revenue and expenses include the postings');
  assert(near(T.month.net, T.month.revenue - T.month.expenses) && near(T.ytd.net, T.ytd.revenue - T.ytd.expenses), '2: net = revenue − expenses for the month and the year to date');
  const rent = st.income.lines.find(l => l.account === 'exp_rent');
  assert(rent && rent.month >= 3000 && rent.ytd >= rent.month, '2: each account shows this month, last month and the year to date');
  const B = st.balanceSheet.totals;
  assert(near(B.assets, B.liabilities + B.equity), '2: the balance sheet balances (assets = liabilities + equity)');
  assert(st.trialBalance.balanced && near(st.trialBalance.totals.debit, st.trialBalance.totals.credit), '2: trial balance debits equal credits');
  const r = st.ratios;
  assert(r.netMarginPct === (T.month.revenue ? Math.round(T.month.net / T.month.revenue * 1000) / 10 : null) && r.costToIncomePct === (T.month.revenue ? Math.round(T.month.expenses / T.month.revenue * 1000) / 10 : null), '2: net margin and cost-to-income follow their formulas');
  assert(r.provisionShortfall === Math.max(0, Math.round(r.provisionRequired - r.badDebtReserve)), '2: provision shortfall = provision required − bad debt reserve');
  const last = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15).toISOString().slice(0, 7);
  const prev = (await api('GET', `/api/accounting/statements?month=${last}`, { token: acc })).json;
  assert(prev.month === last && near(prev.income.totals.month.revenue, T.prev.revenue), '2: last month\'s figures match when that month is chosen');
  assert((await api('GET', '/api/accounting/statements', { token: officer })).status === 403, '2: a Loan Officer cannot open the statements');

  // 3. Cashflow breakdowns
  const cf = (await api('GET', '/api/accounting/cashflow', { token: acc })).json;
  assert(near(cf.byAccount.reduce((s, a) => s + a.closing, 0), cf.closing) && near(cf.byAccount.reduce((s, a) => s + a.inflows, 0), cf.inflows), '3: cash, bank and M-Pesa add up to the cashflow totals');
  const pay = cf.bySource.find(x => x.source === 'payment');
  assert(pay && pay.inflows >= 5400 && pay.label === 'Loan repayments', '3: inflows are broken down by source');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
