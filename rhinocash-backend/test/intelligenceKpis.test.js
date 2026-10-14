// intelligenceKpis.test.js — the Intelligence pages' calculations: loan
// classification & provisioning, per-officer portfolio figures, trends with
// history and run-rate, collection priority, HR attendance and turnover,
// and that each role only sees its own scope.
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
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.51;

(async () => {
  const db = require('../src/db');
  const t = {
    officer: await login('officer@rhinocash.co.ke', process.env.SEEDED_OFFICER_PASSWORD),
    mgrK: await login('manager.kisumu@rhinocash.co.ke', process.env.SEEDED_MANAGER_KISUMU_PASSWORD),
    regional: await login('regional@rhinocash.co.ke', process.env.SEEDED_REGIONAL_PASSWORD),
    ceo: await login('ceo@rhinocash.co.ke', process.env.SEEDED_CEO_PASSWORD),
    admin: await login('admin@rhinocash.co.ke', process.env.SEEDED_ADMIN_PASSWORD),
  };
  assert(Object.values(t).every(Boolean), 'setup: officer, manager, regional manager, CEO and admin sign in');
  const me = (await api('GET', '/api/auth/me', { token: t.officer })).json.user;

  // A known book: loan A current (first installment paid), loan B 45 days overdue (Substandard).
  const day = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const prod = await db.get('SELECT id FROM loan_products LIMIT 1');
  const stamp = Date.now();
  const mk = async (tag, firstDue, paid) => {
    const cid = `cli_ix_${tag}_${stamp}`, lid = `loan_ix_${tag}_${stamp}`;
    await db.run(`INSERT INTO clients (id, name, phone, branch_id, officer_id, status) VALUES (?,?,?,?,?,'Active')`, [cid, `IX Client ${tag}`, '07' + String(stamp + tag.charCodeAt(0)).slice(-8), me.branch_id, me.id]);
    await db.run(`INSERT INTO loans (id, client_id, product_id, principal, term_months, rate_pct, status, branch_id, officer_id, disbursed_at) VALUES (?,?,?,?,?,?,'Active',?,?,?)`,
      [lid, cid, prod.id, 10000, 2, 10, me.branch_id, me.id, new Date(Date.now() - 80 * 86400000).toISOString()]);
    await db.run(`INSERT INTO loan_schedule (loan_id, period, due_date, principal_due, interest_due, total_due, paid_amount, status) VALUES (?,?,?,?,?,?,?,?)`, [lid, 1, day(firstDue), 5000, 500, 5500, paid ? 5500 : 0, paid ? 'Paid' : 'Pending']);
    await db.run(`INSERT INTO loan_schedule (loan_id, period, due_date, principal_due, interest_due, total_due, paid_amount, status) VALUES (?,?,?,?,?,?,?,?)`, [lid, 2, day(firstDue + 30), 5000, 500, 5500, 0, 'Pending']);
    return lid;
  };
  await mk('a', -10, true); const lidB = await mk('b', -45, false);

  // 1. Risk: classification and provisioning (the officer's own book)
  const r1 = (await api('GET', '/api/intelligence/predictive/pred-client-risk-indicators', { token: t.officer })).json;
  assert(r1 && r1.kind === 'risk' && Array.isArray(r1.classes) && r1.classes.length === 5, '1: risk pages carry the five CBK loan classes');
  const sumOut = r1.classes.reduce((s, c) => s + c.outstanding, 0);
  assert(near(sumOut, r1.totalOutstanding), '1: the classes add up to the total outstanding');
  const sub = r1.classes.find(c => c.key === 'substandard');
  assert(sub.loans >= 1 && sub.ratePct === 20 && near(sub.provision, sub.outstanding * 0.2), '1: a loan 45 days overdue is Substandard, provisioned at 20%');
  assert(near(r1.totalProvision, r1.classes.reduce((s, c) => s + c.provision, 0)), '1: total provision is the sum of the classes');
  const b = r1.atRisk.find(x => x.loanId === lidB);
  assert(b && b.daysOverdue >= 45 && b.missed === 2 && near(b.arrears, 11000) && near(b.outstanding, 11000), '1: the overdue loan is listed with days overdue, missed installments, arrears and balance');
  const p30 = r1.par.find(p => p.threshold === 30);
  assert(p30.loans >= 1 && p30.clients >= 1, '1: each PAR line shows how many loans and clients are behind it');
  const ew = (await api('GET', '/api/intelligence/predictive/pred-early-warning-signals', { token: t.officer })).json;
  assert(near(ew.totalOutstanding, r1.totalOutstanding), '1: a Loan Officer\'s Early Warning Signals cover their own book only');

  // 2. Per-officer figures for the branch Manager
  const ol = (await api('GET', '/api/intelligence/predictive/pred-officer-performance-prediction', { token: t.mgrK })).json;
  const row = ol && (ol.officers || []).find(o => o.id === me.id);
  assert(row && row.activeLoans >= 2 && row.outstanding >= 16500 && row.arrears >= 11000, '2: Officer Performance shows the officer\'s loans, balance and arrears');
  assert(near(row.par30Pct, Math.round(row.par30Amount / row.outstanding * 1000) / 10) && row.provision > 0, '2: … with PAR 30 = at-risk balance ÷ balance, and the provision');
  assert(ol.total && ol.total.activeLoans === ol.officers.reduce((s, o) => s + o.activeLoans, 0), '2: the total row adds up the officers');

  // 3. Trends: six months, run-rate
  const tr = (await api('GET', '/api/intelligence/predictive/pred-branch-collection-forecast', { token: t.mgrK })).json;
  assert(tr.kind === 'trend' && tr.history.length === 6 && tr.history[5].month === new Date().toISOString().slice(0, 7), '3: trends show the last six months ending this month');
  assert(tr.runRate === Math.round(tr.thisPeriod / tr.daysElapsed * tr.daysInMonth), '3: the month-end run-rate = so far ÷ days elapsed × days in month');

  // 4. Collection priority (explainable)
  const pr = (await api('GET', '/api/intelligence/explain/explain-collection-priority-explanation', { token: t.officer })).json;
  const pb = pr && (pr.items || []).find(i => i.loanId === lidB);
  const expectScore = Math.round(60 * Math.min(pb ? pb.daysoverdue : 0, 90) / 90 + 40 * (11000 / 11000));
  assert(pb && pb.score === expectScore && /days overdue/.test(pb.reason), '4: each overdue loan gets a priority score and a plain reason');

  // 5. Scope: a Regional Manager only sees their region
  const dr = await api('GET', '/api/intelligence/drilldown/drill-region', { token: t.regional });
  const allRegions = (await db.get('SELECT COUNT(*)::int AS n FROM regions')).n;
  assert(dr.status === 200 && dr.json.regions.length >= 1 && (allRegions <= 1 || dr.json.regions.length < allRegions), '5: Region drill-down shows a Regional Manager their region, not every region');
  const ceoR = (await api('GET', '/api/intelligence/drilldown/drill-region', { token: t.ceo })).json;
  assert(ceoR.regions.length >= dr.json.regions.length, '5: the CEO sees every region with loans');

  // 6. HR: attendance and turnover (granted to the Admin for this test)
  await db.run(`INSERT INTO role_intelligence_access (role_id, feature_id) VALUES ('admin','pred-attendance-trends'),('admin','pred-turnover-prediction') ON CONFLICT DO NOTHING`);
  const emp = await db.get(`SELECT id FROM users WHERE role_id = 'loan_officer' LIMIT 1`);
  const today = new Date().toISOString().slice(0, 10);
  const d2 = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const d3 = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  if (today.slice(0, 7) === d3.slice(0, 7)) {
    for (const [d, st] of [[today, 'Present'], [d2, 'Late'], [d3, 'Absent']]) await db.run(`INSERT INTO hr_attendance (id, employee_id, date, status, minutes_late) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING`, [`att_${stamp}_${d}`, emp.id, d, st, st === 'Late' ? 20 : 0]);
    const at = (await api('GET', '/api/intelligence/predictive/pred-attendance-trends', { token: t.admin })).json;
    const cur = at.months[at.months.length - 1];
    assert(at.kind === 'attendance' && cur.present >= 1 && cur.late >= 1 && cur.absent >= 1 && cur.ratePct === Math.round((cur.present + cur.late + cur.remote + cur.halfday / 2) / (cur.present + cur.late + cur.absent + cur.halfday + cur.remote) * 1000) / 10, '6: attendance rate = (present + late + remote + ½ half day) ÷ days recorded');
  } else assert(true, '6: (month boundary — attendance check skipped)');
  await db.run(`INSERT INTO audit_logs (user_id, action, record_type, record_id) VALUES (?, 'Set employment status to Terminated', 'Employee', 'usr_test_leaver')`, [emp.id]);
  const to = (await api('GET', '/api/intelligence/predictive/pred-turnover-prediction', { token: t.admin })).json;
  const curT = to.months[to.months.length - 1];
  assert(to.kind === 'turnover' && to.months.length === 12 && curT.leavers >= 1 && curT.turnoverPct > 0, '6: turnover counts this month\'s leavers against the average headcount');

  // 7. Fraud ranking is scoped
  await db.run(`INSERT INTO role_intelligence_access (role_id, feature_id) VALUES ('regional_manager','fraud-branch-risk-ranking') ON CONFLICT DO NOTHING`);
  const fr = (await api('GET', '/api/intelligence/fraud/fraud-branch-risk-ranking', { token: t.regional })).json;
  const frCeo = (await api('GET', '/api/intelligence/fraud/fraud-branch-risk-ranking', { token: t.ceo })).json;
  assert(fr.branches.length >= 1 && fr.branches.length <= frCeo.branches.length && fr.branches.every(x => typeof x.riskscore === 'number'), '7: Branch Risk Ranking only ranks the caller\'s branches, with a risk score');
  await db.run(`DELETE FROM role_intelligence_access WHERE role_id = 'regional_manager' AND feature_id = 'fraud-branch-risk-ranking'`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
