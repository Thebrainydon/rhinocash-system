// perfReports.test.js — Disbursement Report (MET/NEAR/BELOW/NEW), Branch
// Performance (vs own average), MTD Disbursement Performance, branch
// drill-down, and the Loan Officer control plan — each scoped by role.
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:4000';
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }
async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* none */ }
  return { status: res.status, json };
}
const login = async (email, pw) => (await api('POST', '/api/auth/login', { body: { email, password: pw } })).json.token;

(async () => {
  const db = require('../src/db');
  const t = {
    officer: await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD),
    mgrK: await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD),
    regional: await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD),
    ceo: await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD),
  };
  assert(Object.values(t).every(Boolean), 'setup: officer, manager, regional manager and CEO sign in');
  const me = (await api('GET', '/api/auth/me', { token: t.officer })).json.user;
  const prod = await db.get('SELECT id FROM loan_products LIMIT 1');
  const stamp = Date.now();
  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const old = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 10)).toISOString();
  let n = 0;
  const loan = async (branch, officer, principal, when, clientId) => {
    n++; const cid = clientId || `cli_pr_${stamp}_${n}`;
    if (!clientId) await db.run(`INSERT INTO clients (id, name, phone, branch_id, officer_id, status) VALUES (?,?,?,?,?,'Active')`, [cid, `PR Client ${n}`, '07' + String(stamp + n).slice(-8), branch, officer]);
    await db.run(`INSERT INTO loans (id, client_id, product_id, principal, term_months, rate_pct, status, branch_id, officer_id, disbursed_at) VALUES (?,?,?,?,?,?,'Active',?,?,?)`,
      [`loan_pr_${stamp}_${n}`, cid, prod.id, principal, 1, 10, branch, officer, when]);
    return cid;
  };
  // The officer's branch: lending three months ago (established), 1,600,000 this month from 3 loans (one a repeat).
  const c1 = await loan(me.branch_id, me.id, 50000, old);
  await loan(me.branch_id, me.id, 700000, now.toISOString());
  await loan(me.branch_id, me.id, 500000, now.toISOString());
  await loan(me.branch_id, me.id, 400000, now.toISOString(), c1);
  // A brand-new branch whose first loan is this month.
  const nb = `br_pr_${stamp}`;
  await db.run(`INSERT INTO branches (id, code, name, region_id, status) SELECT ?, ?, 'PR New Branch', region_id, 'Active' FROM branches WHERE id = ?`, [nb, 'PR' + String(stamp).slice(-6), me.branch_id]);
  await loan(nb, me.id, 900000, now.toISOString());

  // 1. Disbursement report
  const dr = (await api('GET', '/api/perf/disbursement-report', { token: t.ceo })).json;
  const mine = dr.rows.find(r => r.branchId === me.branch_id);
  assert(mine && mine.actual >= 1600000 && mine.target === 1500000 && mine.status === (mine.actual >= 1500000 ? 'MET' : 'BELOW'), '1: an established branch is measured against KSh 1.5M');
  assert(mine.variance === mine.actual - mine.target && mine.achievementPct === Math.round(mine.actual / mine.target * 1000) / 10, '1: variance and achievement follow the rule');
  const nr = dr.rows.find(r => r.branchId === nb);
  assert(nr && nr.status === 'NEW' && nr.target === 1200000 && nr.achievementPct === 75, '1: a new branch uses KSh 1.2M in its opening month and is marked NEW');
  assert(dr.totals.actual === dr.rows.reduce((s, r) => s + r.actual, 0) && dr.totals.active === dr.rows.length && dr.totals.newThisMonth >= 1, '1: totals and counts add up');
  assert(dr.rows.every((r, i) => i === 0 || dr.rows[i - 1].achievementPct <= r.achievementPct), '1: rows are ordered from lowest achievement');
  const mr = (await api('GET', '/api/perf/disbursement-report', { token: t.mgrK })).json;
  assert(mr.rows.length === 1 && mr.rows[0].branchId === me.branch_id, '1: a branch Manager sees only their branch');
  assert((await api('GET', '/api/perf/disbursement-report', { token: t.officer })).status === 403, '1: a Loan Officer cannot open branch reports');

  // 2. Branch performance (this year)
  const bp = (await api('GET', '/api/perf/branch-performance', { token: t.ceo })).json;
  const bs = bp.snapshot.find(x => x.branchId === me.branch_id);
  assert(bp.months.length === now.getUTCMonth() + 1 && bp.trend.length === bp.months.length, '2: the trend has one bar per month this year');
  const expAvg = Math.round(bs.months.slice(bp.months.findIndex(m => m === old.slice(0, 7)) >= 0 ? bp.months.findIndex(m => m === old.slice(0, 7)) : 0).reduce((s, v) => s + v, 0) / bs.monthsActive);
  assert(bs.average === expAvg && bs.status === (bs.vsAvgPct > 5 ? 'ABOVE AVG' : bs.vsAvgPct < -5 ? 'BELOW AVG' : 'STABLE'), '2: each branch is compared with its own monthly average (±5% band)');

  // 3. MTD performance
  const mt = (await api('GET', '/api/perf/mtd', { token: t.ceo })).json;
  const mm = mt.rows.find(r => r.branchId === me.branch_id);
  assert(mm.loans >= 3 && mm.disbPct === Math.round(mm.amount / 500000 * 1000) / 10 && mm.status === (mm.disbPct >= 75 ? 'ON TRACK' : mm.disbPct >= 40 ? 'PUSH' : 'CRITICAL'), '3: MTD % against KSh 500,000 / 100 loans with ON TRACK / PUSH / CRITICAL');
  assert(mt.rows.every((r, i) => r.rank === i + 1), '3: branches are ranked');

  // 4. Branch drill-down
  const bd = await api('GET', `/api/perf/branch/${me.branch_id}`, { token: t.mgrK });
  assert(bd.status === 200 && bd.json.months.some(m => m.month === month) && bd.json.officers.some(o => o.id === me.id && o.loans >= 3 && o.newloans >= 2 && o.repeatloans >= 1), '4: the branch page shows its months and each officer\'s new and repeat loans');
  assert((await api('GET', `/api/perf/branch/${nb}`, { token: t.mgrK })).status === 403, '4: a Manager cannot open another branch');

  // 5. Officer control plan
  const op = (await api('GET', `/api/perf/officer/${me.id}`, { token: t.officer })).json;
  const k = key => op.kpis.find(x => x.key === key);
  assert(k('newLoans').actual >= 3 && k('repeatLoans').actual >= 1 && k('totalLoans').actual === k('newLoans').actual + k('repeatLoans').actual, '5: new, repeat and total loans this month');
  assert(k('newLoans').month === 30 && k('newLoans').week === 7.5 && k('newLoans').day === 1.5 && k('disbursement').month === 400000 && k('disbursement').week === 100000, '5: monthly targets split into weeks (÷4) and days (÷20)');
  assert(k('bookQuality').actual === Math.round(k('performing').actual / k('activeClients').actual * 1000) / 10, '5: book quality = performing loans ÷ active clients');
  assert(op.checkpoints.length === 4 && op.checkpoints[1].totalLoans === 40, '5: weekly cumulative checkpoints');
  await api('POST', '/api/targets', { token: t.mgrK, body: { metric: 'new_loans', recipient_user_id: me.id, target_value: 12, period: month, period_type: 'monthly' } });
  assert((await api('GET', `/api/perf/officer/${me.id}`, { token: t.officer })).json.kpis.find(x => x.key === 'newLoans').month === 12, '5: an officer target set on Targets & Accruals overrides the default');
  const other = await db.get(`SELECT id FROM users WHERE role_id = 'loan_officer' AND id <> ? LIMIT 1`, [me.id]);
  if (other) assert((await api('GET', `/api/perf/officer/${other.id}`, { token: t.officer })).status === 403, '5: an officer cannot see another officer\'s plan');
  const ol = (await api('GET', '/api/perf/officers', { token: t.mgrK })).json;
  assert(ol.officers.some(o => o.id === me.id && o.total === 15), '5: the Manager sees each officer\'s score across the 15 KPIs');

  // 6. Settings
  assert((await api('PUT', '/api/perf/settings', { token: t.mgrK, body: { establishedTarget: 1 } })).status === 403, '6: a Manager cannot change the report targets');
  const up = await api('PUT', '/api/perf/settings', { token: t.ceo, body: { establishedTarget: 1600000 } });
  assert(up.status === 200 && (await api('GET', '/api/perf/disbursement-report', { token: t.ceo })).json.rows.find(r => r.branchId === me.branch_id).target === 1600000, '6: the CEO changes the established-branch target and the report follows');
  await api('PUT', '/api/perf/settings', { token: t.ceo, body: { establishedTarget: 1500000 } });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
