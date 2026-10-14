// businessQuality.test.js — the Performance KPI formulas (Arrears Collection %,
// Disbursement Counts %, Portfolio Quality / BQ %) by role scope, on the
// dashboard endpoint and on What-If › Business Quality.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}
const login = async (email, password) => (await api('POST', '/api/auth/login', { body: { email, password } })).json.token;
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

(async () => {
  const db = require('../src/db');
  const t = {
    officer: await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD),
    mgrK: await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD),
    regional: await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD),
    ceo: await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD),
  };
  assert(Object.values(t).every(Boolean), 'setup: officer, branch manager, regional manager and CEO sign in');
  const me = (await api('GET', '/api/auth/me', { token: t.officer })).json.user;
  // A small, known book for the officer: client A's loan is performing
  // (its due installment is paid), client B's loan is in arrears (Ksh 4,000
  // overdue and unpaid). Both disbursed this month.
  const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const prod = await db.get('SELECT id FROM loan_products LIMIT 1');
  const stamp = Date.now();
  const mk = async (tag, paidFirst) => {
    const cid = `cli_bq_${tag}_${stamp}`, lid = `loan_bq_${tag}_${stamp}`;
    await db.run(`INSERT INTO clients (id, name, phone, branch_id, officer_id, status) VALUES (?,?,?,?,?,'Active')`, [cid, `BQ Client ${tag}`, '07' + String(stamp).slice(-8), me.branch_id, me.id]);
    await db.run(`INSERT INTO loans (id, client_id, product_id, principal, term_months, rate_pct, status, branch_id, officer_id, disbursed_at) VALUES (?,?,?,?,?,?,'Active',?,?,?)`,
      [lid, cid, prod.id, 8000, 2, 10, me.branch_id, me.id, new Date().toISOString()]);
    await db.run(`INSERT INTO loan_schedule (loan_id, period, due_date, principal_due, interest_due, total_due, paid_amount, status) VALUES (?,?,?,?,?,?,?,?)`, [lid, 1, day(-3), 3600, 400, 4000, paidFirst ? 4000 : 0, paidFirst ? 'Paid' : 'Pending']);
    await db.run(`INSERT INTO loan_schedule (loan_id, period, due_date, principal_due, interest_due, total_due, paid_amount, status) VALUES (?,?,?,?,?,?,?,?)`, [lid, 2, day(25), 4400, 400, 4800, 0, 'Pending']);
    return lid;
  };
  const before0 = (await api('GET', '/api/kpi/business-quality', { token: t.officer })).json;
  await mk('a', true); await mk('b', false);

  // 1. Scope by role
  const lo = await api('GET', '/api/kpi/business-quality', { token: t.officer });
  assert(lo.status === 200 && lo.json.scope === 'officer' && lo.json.rows.length === 0, '1: a Loan Officer gets their own book only');
  const q0 = before0.portfolioQuality, q1 = lo.json.portfolioQuality;
  assert(q1.activeClients === q0.activeClients + 2 && q1.performing === q0.performing + 1, '2: the officer\'s book: 2 more active clients, 1 more performing loan');
  assert(lo.json.arrearsCollection.outstanding === before0.arrearsCollection.outstanding + 4000, '2: the unpaid overdue installment (Ksh 4,000) is in Current Arrears');
  assert(lo.json.disbursementCounts.count === before0.disbursementCounts.count + 2, '2: both loans count as disbursed this month');
  assert(lo.json.formulas.map(f => f.formula).join(' | ') === '(Arrears Collected ÷ Current Arrears) × 100 | (Disbursement Counts ÷ Target) × 100 | (Performing Loans ÷ Active Clients) × 100', '1: the three formulas are exactly the Performance KPI formulas');
  const mg = await api('GET', '/api/kpi/business-quality', { token: t.mgrK });
  assert(mg.status === 200 && mg.json.scope === 'branch' && mg.json.rows.length >= 1 && mg.json.rows.every(r => r.kind === 'officer'), '1: a branch Manager gets the branch, one row per loan officer');
  assert(mg.json.rows.some(r => r.id === me.id), '1: the officer is in their Manager\'s breakdown');
  const rg = await api('GET', '/api/kpi/business-quality', { token: t.regional });
  assert(rg.status === 200 && rg.json.rows.length >= 1 && rg.json.rows.every(r => r.kind === 'branch'), '1: a Regional Manager gets one row per branch in the region');
  const ce = await api('GET', '/api/kpi/business-quality', { token: t.ceo });
  assert(ce.status === 200 && ce.json.label === 'Company' && ce.json.rows.length >= rg.json.rows.length, '1: the CEO gets the whole company by branch');
  const sumRows = (d, f) => d.rows.reduce((s, r) => s + f(r), 0);
  assert(sumRows(ce.json, r => r.portfolioQuality.activeClients) === ce.json.portfolioQuality.activeClients, '1: branch rows add up to the company total');
  const outside = ce.json.rows.find(r => !rg.json.rows.some(x => x.id === r.id));
  if (outside) assert((await api('GET', `/api/kpi/business-quality?branchId=${outside.id}`, { token: t.regional })).status === 403, '1: a Regional Manager cannot open a branch outside the region');
  const otherOfficer = (await db.get(`SELECT id FROM users WHERE role_id = 'loan_officer' AND branch_id <> ? LIMIT 1`, [me.branch_id]));
  if (otherOfficer) assert((await api('GET', `/api/kpi/business-quality?officerId=${otherOfficer.id}`, { token: t.mgrK })).status === 403, '1: a Manager cannot open an officer of another branch');
  assert((await api('GET', '/api/kpi/business-quality')).status === 401, '1: sign-in is required');

  // 2. The arithmetic
  for (const d of [lo.json, mg.json, ce.json]) {
    const a = d.arrearsCollection, ds = d.disbursementCounts, q = d.portfolioQuality;
    assert(a.current === a.collected + a.outstanding && a.pct === pct(a.collected, a.current), `2: ${d.label}: Arrears Collection % = collected ÷ current arrears × 100`);
    assert(ds.pct === pct(ds.count, ds.target), `2: ${d.label}: Disbursement Counts % = disbursements ÷ target × 100`);
    assert(q.pct === pct(q.performing, q.activeClients) && q.performing <= q.activeClients * 10, `2: ${d.label}: BQ % = performing loans ÷ active clients × 100`);
  }
  // An arrears repayment raises Arrears Collected and the % — the arrears book stays the same.
  const loan = await db.get(`SELECT l.id, l.client_id FROM loans l WHERE l.id = ?`, [`loan_bq_b_${stamp}`]);
  const sched = loan && await db.get('SELECT id, period, due_date FROM loan_schedule WHERE loan_id = ? ORDER BY period LIMIT 1', [loan.id]);
  if (loan && sched) {
    const before = (await api('GET', '/api/kpi/business-quality', { token: t.officer })).json.arrearsCollection;
    const pid = 'pay_bqtest_' + Date.now();
    await db.run(`INSERT INTO payments (id, loan_id, client_id, amount, channel, status) VALUES (?,?,?,?,?,?)`, [pid, loan.id, loan.client_id, 1500, 'Cash', 'Posted']);
    await db.run(`INSERT INTO payment_allocations (payment_id, schedule_id, period, due_date, amount_applied, bucket) VALUES (?,?,?,?,?,?)`, [pid, sched.id, sched.period, sched.due_date, 1500, 'arrears']);
    const after = (await api('GET', '/api/kpi/business-quality', { token: t.officer })).json.arrearsCollection;
    assert(after.pct === pct(after.collected, after.current) && after.pct > 0, '2: … and the officer\'s Arrears Collection % goes up');
    assert(after.collected === before.collected + 1500 && after.current === before.current + 1500, '2: an arrears repayment this month counts as Arrears Collected');
    await db.run('DELETE FROM payment_allocations WHERE payment_id = ?', [pid]); await db.run('DELETE FROM payments WHERE id = ?', [pid]);
  } else assert(false, '2: setup: there is a disbursed loan');
  // A disbursement target set in Targets & Accruals is the denominator.
  const month = new Date().toISOString().slice(0, 7);
  const tg = await api('POST', '/api/targets', { token: t.mgrK, body: { metric: 'new_loans', recipient_user_id: me.id, target_value: 8, period: month, period_type: 'monthly' } });
  const tg2 = await api('POST', '/api/targets', { token: t.mgrK, body: { metric: 'repeat_loans', recipient_user_id: me.id, target_value: 2, period: month, period_type: 'monthly' } });
  assert(tg.status === 201 && tg2.status === 201, '2: setup: the Manager sets the officer\'s New Loans (8) and Repeat Loans (2) targets');
  const lo2 = (await api('GET', '/api/kpi/business-quality', { token: t.officer })).json.disbursementCounts;
  assert(lo2.target === 10 && lo2.pct === pct(lo2.count, 10), '2: the officer\'s target is New + Repeat loans (10)');
  const mg2 = (await api('GET', '/api/kpi/business-quality', { token: t.mgrK })).json;
  assert(mg2.disbursementCounts.target >= 10 && mg2.rows.find(r => r.id === me.id).disbursementCounts.target === 10, '2: the branch target adds up its officers\' targets');

  // 3. What-If › Business Quality, for every role
  const wl = await api('GET', '/api/intelligence/whatif/whatif-business-quality', { token: t.officer });
  assert(wl.status === 200 && wl.json.kind === 'business-quality' && wl.json.portfolioQuality, '3: a Loan Officer opens What-If › Business Quality');
  for (const [k, tok] of Object.entries({ manager: t.mgrK, regional: t.regional, ceo: t.ceo })) {
    assert((await api('GET', '/api/intelligence/whatif/whatif-business-quality', { token: tok })).status === 200, `3: the ${k} opens it too`);
  }
  const lastMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15).toISOString().slice(0, 7);
  const prev = await api('GET', `/api/intelligence/whatif/whatif-business-quality?month=${lastMonth}`, { token: t.mgrK });
  assert(prev.status === 200 && prev.json.period.month === lastMonth, '3: an earlier month can be chosen');
  const granted = await db.all(`SELECT role_id FROM role_intelligence_access WHERE feature_id = 'whatif-business-quality'`);
  const roles = await db.all('SELECT id FROM roles');
  assert(roles.every(r => granted.some(g => g.role_id === r.id)), '3: every role holds Business Quality');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
