// perfReports.js — management performance reports:
//   - Monthly Disbursement Report: per branch actual vs minimum target
//     (established branches KSh 1.5M; a new branch KSh 1.2M in its opening
//     month), variance, achievement %, MET / NEAR / BELOW / NEW.
//   - Branch Performance Report: year-to-date monthly trend, each branch's
//     month vs its own average (ABOVE / STABLE / BELOW AVG).
//   - MTD Disbursement Performance: amount and loan-count targets for a
//     period, gap, ON TRACK / PUSH / CRITICAL.
//   - Loan Officer Targets: the monthly / weekly / daily control plan with
//     actuals, pace and status per KPI.
//   - Branch drill-down: the branch's months and its officers.
// A branch's opening month is the month of its first disbursement; branches
// already lending in the system's first month count as established.
// Scope: Manager — own branch; regional / head office — their branches;
// Loan Officer — only their own control plan.
'use strict';
const { all, get, run } = require('./../db');
const { requireAuth } = require('./../middleware');
const { branchIdsInScope } = require('./../rbac');
const { logAction } = require('./../audit');

const DEFAULTS = {
  establishedTarget: 1500000, newBranchTarget: 1200000, nearPct: 90,
  mtdAmountTarget: 500000, mtdLoanTarget: 100, onTrackPct: 75, criticalPct: 40, stableBandPct: 5,
  officer: { newLoans: 30, repeatLoans: 50, disbursement: 400000, mtdArrearsCeiling: 3000, currentGcFloor: 45, previousGcFloor: 95, duesCrFloor: 95,
    arrearsReductionPct: 30, performingLoans: 75, revenue: 180000, bookQualityPct: 80, activeClients: 110, cleanActiveClients: 95, parCeilingPct: 10, workingDays: 20, weeks: 4 },
};
const EDITORS = ['admin', 'ceo', 'director', 'operational_manager'];

async function getSettings() {
  const row = await get(`SELECT value FROM intelligence_settings WHERE key = 'perf_report_settings'`);
  let s = {}; try { s = row ? JSON.parse(row.value) : {}; } catch { s = {}; }
  return { ...DEFAULTS, ...s, officer: { ...DEFAULTS.officer, ...(s.officer || {}) } };
}
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
const ym = d => d.toISOString().slice(0, 7);
function monthBounds(m) {
  const month = /^\d{4}-\d{2}$/.test(String(m || '')) ? m : ym(new Date());
  const [y, mo] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  return { month, start: `${month}-01`, end, asOf: end < today ? end : today, y, mo };
}
// Monday–Friday working days from the 1st up to and including `asOf` (the plan uses 20 a month).
function workingDaysElapsed(start, asOf) {
  let n = 0; const d = new Date(start + 'T00:00:00Z'); const e = new Date(asOf + 'T00:00:00Z');
  while (d <= e) { const w = d.getUTCDay(); if (w >= 1 && w <= 5) n++; d.setUTCDate(d.getUTCDate() + 1); }
  return n;
}

async function scopeBranches(user) {
  let ids = await branchIdsInScope(user);
  if (user.role_id === 'manager') ids = user.branch_id ? [user.branch_id] : [];
  const rows = await all(`SELECT b.id, b.name, b.region_id, r.name AS region FROM branches b LEFT JOIN regions r ON r.id = b.region_id WHERE COALESCE(b.status,'Active') <> 'Closed' ORDER BY b.name`);
  return rows.filter(b => ids === null || ids.includes(b.id));
}
// Month each branch started lending, and the system's first month.
async function openingMonths() {
  const rows = await all(`SELECT branch_id, MIN(substr(disbursed_at,1,7)) AS m FROM loans WHERE disbursed_at IS NOT NULL GROUP BY branch_id`);
  const map = new Map(rows.map(r => [r.branch_id, r.m]));
  const first = rows.reduce((a, r) => (!a || r.m < a ? r.m : a), null);
  return { map, first };
}
// Disbursed principal and loan count per branch between two dates.
async function disbursedByBranch(from, to, branchIds) {
  if (!branchIds.length) return new Map();
  const rows = await all(`SELECT branch_id, COALESCE(SUM(principal),0) AS amt, COUNT(*)::int AS n FROM loans
    WHERE disbursed_at IS NOT NULL AND (disbursed_at)::date BETWEEN (?)::date AND (?)::date AND branch_id IN (${branchIds.map(() => '?').join(',')}) GROUP BY branch_id`, [from, to, ...branchIds]);
  return new Map(rows.map(r => [r.branch_id, { amount: Number(r.amt), loans: r.n }]));
}
// Branch disbursement targets set on the Targets Register (by a Regional
// Manager or above) for one month; they replace the report's default.
async function registerBranchTargets(month) {
  const rows = await all(`SELECT DISTINCT ON (branch_id) branch_id, target_value FROM targets
    WHERE metric = 'disbursement' AND recipient_user_id IS NULL AND branch_id IS NOT NULL AND period = ? AND status = 'Active'
    ORDER BY branch_id, created_at DESC`, [month]);
  return new Map(rows.map(r => [r.branch_id, Number(r.target_value)]));
}
function monthStatus(ach, isNew, nearPct) {
  if (isNew) return 'NEW';
  return ach >= 100 ? 'MET' : ach >= nearPct ? 'NEAR' : 'BELOW';
}

async function disbursementReport(user, month) {
  const s = await getSettings();
  const b = monthBounds(month);
  const branches = await scopeBranches(user);
  const { map: opened, first } = await openingMonths();
  const act = await disbursedByBranch(b.start, b.end, branches.map(x => x.id));
  const set = await registerBranchTargets(b.month);
  const rows = [];
  for (const br of branches) {
    const o = opened.get(br.id);
    if (!o || o > b.month) continue; // not lending yet in this month
    const isNew = o === b.month && o !== first;
    const target = set.has(br.id) ? set.get(br.id) : isNew ? s.newBranchTarget : s.establishedTarget;
    const actual = (act.get(br.id) || { amount: 0 }).amount, loans = (act.get(br.id) || { loans: 0 }).loans;
    const ach = pct(actual, target) || 0;
    rows.push({ branchId: br.id, branch: br.name, region: br.region, actual, loans, target, targetSource: set.has(br.id) ? 'register' : 'default', variance: actual - target, achievementPct: ach, status: monthStatus(ach, isNew, s.nearPct), isNew });
  }
  rows.sort((a, c) => a.achievementPct - c.achievementPct);
  const actual = rows.reduce((t, r) => t + r.actual, 0), target = rows.reduce((t, r) => t + r.target, 0);
  const count = st => rows.filter(r => r.status === st).length;
  // A new branch is also counted as met / near / below by its achievement.
  const band = r => r.achievementPct >= 100 ? 'MET' : r.achievementPct >= s.nearPct ? 'NEAR' : 'BELOW';
  return { month: b.month, asOf: b.asOf, rows, totals: { actual, target, achievementPct: pct(actual, target), active: rows.length, loans: rows.reduce((t, r) => t + r.loans, 0),
    met: rows.filter(r => band(r) === 'MET').length, near: rows.filter(r => band(r) === 'NEAR').length, below: rows.filter(r => band(r) === 'BELOW').length, newThisMonth: count('NEW') },
    rule: { establishedTarget: s.establishedTarget, newBranchTarget: s.newBranchTarget, nearPct: s.nearPct, firstMonth: first } };
}

async function branchPerformance(user, month) {
  const s = await getSettings();
  const b = monthBounds(month);
  const branches = await scopeBranches(user);
  const ids = branches.map(x => x.id);
  const months = []; for (let m = 1; m <= b.mo; m++) months.push(`${b.y}-${String(m).padStart(2, '0')}`);
  const rows = ids.length ? await all(`SELECT branch_id, substr(disbursed_at,1,7) AS m, COALESCE(SUM(principal),0) AS amt FROM loans
    WHERE disbursed_at IS NOT NULL AND disbursed_at >= ? AND disbursed_at < ? AND branch_id IN (${ids.map(() => '?').join(',')}) GROUP BY 1, 2`, [`${b.y}-01-01`, `${b.end}T99`, ...ids]) : [];
  const byBranch = new Map();
  for (const r of rows) { if (!byBranch.has(r.branch_id)) byBranch.set(r.branch_id, {}); byBranch.get(r.branch_id)[r.m] = Number(r.amt); }
  const trend = months.map(m => ({ month: m, amount: rows.filter(r => r.m === m).reduce((t, r) => t + Number(r.amt), 0) }));
  const cur = trend[trend.length - 1] ? trend[trend.length - 1].amount : 0;
  const prev = trend.length > 1 ? trend[trend.length - 2].amount : 0;
  const globalAvg = trend.length ? Math.round(trend.reduce((t, x) => t + x.amount, 0) / trend.length) : 0;
  const snapshot = [];
  for (const br of branches) {
    const mm = byBranch.get(br.id) || {};
    // Average over the months the branch was lending (from its first month this year).
    const active = months.filter(m => Object.keys(mm).some(k => k <= m));
    if (!active.length) continue;
    const vals = active.map(m => mm[m] || 0);
    const avg = Math.round(vals.reduce((t, v) => t + v, 0) / vals.length);
    const curB = mm[b.month] || 0;
    const vsAvg = avg ? Math.round((curB - avg) / avg * 1000) / 10 : null;
    snapshot.push({ branchId: br.id, branch: br.name, current: curB, previous: mm[months[months.length - 2]] || 0, average: avg, monthsActive: active.length, vsAvgPct: vsAvg,
      status: vsAvg == null ? 'STABLE' : vsAvg > s.stableBandPct ? 'ABOVE AVG' : vsAvg < -s.stableBandPct ? 'BELOW AVG' : 'STABLE', months: months.map(m => mm[m] || 0) });
  }
  snapshot.sort((a, c) => c.current - a.current);
  return { month: b.month, months, trend, global: { current: cur, previous: prev, average: globalAvg, vsPrevious: cur - prev, vsAvgPct: globalAvg ? Math.round((cur - globalAvg) / globalAvg * 1000) / 10 : null },
    snapshot, counts: { above: snapshot.filter(x => x.status === 'ABOVE AVG').length, stable: snapshot.filter(x => x.status === 'STABLE').length, below: snapshot.filter(x => x.status === 'BELOW AVG').length },
    stableBandPct: s.stableBandPct };
}

async function mtdPerformance(user, from, to) {
  const s = await getSettings();
  const today = new Date().toISOString().slice(0, 10);
  const f = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? from : today.slice(0, 8) + '01';
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? to : today;
  const amountTarget = Number(s.mtdAmountTarget), loanTarget = Number(s.mtdLoanTarget);
  const branches = await scopeBranches(user);
  const { map: opened } = await openingMonths();
  const act = await disbursedByBranch(f, t, branches.map(x => x.id));
  const rows = branches.filter(br => opened.has(br.id) && opened.get(br.id) <= t.slice(0, 7)).map(br => {
    const a = act.get(br.id) || { amount: 0, loans: 0 };
    const dp = pct(a.amount, amountTarget) || 0, lp = pct(a.loans, loanTarget) || 0;
    return { branchId: br.id, branch: br.name, amount: a.amount, disbPct: dp, loans: a.loans, loanPct: lp, gap: Math.max(0, amountTarget - a.amount), loanGap: Math.max(0, loanTarget - a.loans),
      status: dp >= s.onTrackPct ? 'ON TRACK' : dp >= s.criticalPct ? 'PUSH' : 'CRITICAL' };
  }).sort((a, c) => c.disbPct - a.disbPct || c.amount - a.amount);
  rows.forEach((r, i) => { r.rank = i + 1; });
  const amt = rows.reduce((x, r) => x + r.amount, 0), loans = rows.reduce((x, r) => x + r.loans, 0);
  return { from: f, to: t, targets: { amount: amountTarget, loans: loanTarget, onTrackPct: s.onTrackPct, criticalPct: s.criticalPct }, rows,
    totals: { amount: amt, loans, disbPct: pct(amt, amountTarget * rows.length), loanPct: pct(loans, loanTarget * rows.length), gap: rows.reduce((x, r) => x + r.gap, 0),
      onTrack: rows.filter(r => r.status === 'ON TRACK').length, push: rows.filter(r => r.status === 'PUSH').length, critical: rows.filter(r => r.status === 'CRITICAL').length } };
}

// ---- Loan Officer control plan ----
async function officerTargets(officerId, month, s) {
  const rows = await all(`SELECT DISTINCT ON (metric) metric, target_value FROM targets WHERE recipient_user_id = ? AND period = ? AND period_type = 'monthly' AND status != 'Cancelled' ORDER BY metric, created_at DESC`, [officerId, month]);
  const t = Object.fromEntries(rows.map(r => [r.metric, Number(r.target_value)]));
  const o = s.officer;
  return { newLoans: t.new_loans || o.newLoans, repeatLoans: t.repeat_loans || o.repeatLoans, disbursement: t.disbursement || o.disbursement, performingLoans: t.performing || o.performingLoans,
    revenue: t.collection || o.revenue, fromTargetsPage: rows.map(r => r.metric) };
}
async function officerPlan(officerId, month) {
  const s = await getSettings();
  const b = monthBounds(month);
  const o = s.officer;
  const tg = await officerTargets(officerId, b.month, s);
  const P = [officerId];
  const prevStart = new Date(Date.UTC(b.y, b.mo - 2, 1)).toISOString().slice(0, 10), prevEnd = new Date(Date.UTC(b.y, b.mo - 1, 0)).toISOString().slice(0, 10);
  const loans = await all(`SELECT l.id, l.client_id, l.principal, l.processing_fee, l.disbursed_at,
      EXISTS (SELECT 1 FROM loans p WHERE p.client_id = l.client_id AND p.disbursed_at IS NOT NULL AND p.disbursed_at < l.disbursed_at) AS repeat
    FROM loans l WHERE l.officer_id = ? AND l.disbursed_at IS NOT NULL AND (l.disbursed_at)::date BETWEEN (?)::date AND (?)::date`, [...P, b.start, b.asOf]);
  const newLoans = loans.filter(l => !l.repeat).length, repeatLoans = loans.filter(l => l.repeat).length;
  const disbursement = loans.reduce((t, l) => t + Number(l.principal), 0);
  const sumRows = async (from, to) => get(`SELECT COALESCE(SUM(s.total_due),0) AS due, COALESCE(SUM(LEAST(s.paid_amount, s.total_due)),0) AS paid,
      COALESCE(SUM(CASE WHEN (s.due_date)::date < (?)::date AND s.paid_amount < s.total_due THEN s.total_due - s.paid_amount ELSE 0 END),0) AS unpaid_overdue
    FROM loan_schedule s JOIN loans l ON l.id = s.loan_id WHERE l.officer_id = ? AND l.disbursed_at IS NOT NULL AND (s.due_date)::date BETWEEN (?)::date AND (?)::date`, [b.asOf, ...P, from, to]);
  const cur = await sumRows(b.start, b.end);
  const prv = await sumRows(prevStart, prevEnd);
  const today = await sumRows(b.asOf, b.asOf);
  // Arrears that were already overdue at the start of the month, then and now.
  const oldNow = Number((await get(`SELECT COALESCE(SUM(s.total_due - s.paid_amount),0) AS v FROM loan_schedule s JOIN loans l ON l.id = s.loan_id
    WHERE l.officer_id = ? AND l.disbursed_at IS NOT NULL AND (s.due_date)::date < (?)::date AND s.paid_amount < s.total_due`, [...P, b.start])).v);
  const recovered = Number((await get(`SELECT COALESCE(SUM(pa.amount_applied),0) AS v FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id JOIN loans l ON l.id = p.loan_id
    WHERE l.officer_id = ? AND (pa.due_date)::date < (?)::date AND p.status NOT IN ('Unposted','Reversed') AND (p.created_at)::date BETWEEN (?)::date AND (?)::date`, [...P, b.start, b.start, b.asOf])).v);
  const openingArrears = oldNow + recovered;
  const running = await all(`SELECT l.id, l.client_id,
      COALESCE(SUM(GREATEST(s.total_due - s.paid_amount,0)),0) AS outstanding,
      COALESCE(MAX(CASE WHEN s.paid_amount < s.total_due - 0.01 THEN CURRENT_DATE - (s.due_date)::date END), -1) AS days
    FROM loans l LEFT JOIN loan_schedule s ON s.loan_id = l.id WHERE l.officer_id = ? AND l.status IN ('Active','Disbursed') AND l.disbursed_at IS NOT NULL GROUP BY l.id`, P);
  const performing = running.filter(r => Number(r.days) <= 0).length;
  const clients = new Set(running.map(r => r.client_id));
  const dirty = new Set(running.filter(r => Number(r.days) > 0).map(r => r.client_id));
  const outstanding = running.reduce((t, r) => t + Number(r.outstanding), 0);
  const par30 = running.filter(r => Number(r.days) >= 30).reduce((t, r) => t + Number(r.outstanding), 0);
  const revRow = await get(`SELECT COALESCE(SUM(p.allocated_interest + p.allocated_penalty),0) AS v FROM payments p JOIN loans l ON l.id = p.loan_id
    WHERE l.officer_id = ? AND p.status NOT IN ('Unposted','Reversed') AND (p.created_at)::date BETWEEN (?)::date AND (?)::date`, [...P, b.start, b.asOf]);
  const revenue = Number(revRow.v) + loans.reduce((t, l) => t + Number(l.processing_fee || 0), 0);

  const wd = Math.min(o.workingDays, workingDaysElapsed(b.start, b.asOf));
  const share = o.workingDays ? wd / o.workingDays : 0;
  const week = Math.max(1, Math.min(o.weeks, Math.ceil(wd / 5)));
  // kind: 'flow' (paced over the month), 'floor' (≥ always), 'ceiling' (≤ always), 'constant' (≥ count always)
  const kpi = (key, label, kind, monthT, actual, unit, note) => {
    const weekT = kind === 'flow' ? monthT / o.weeks : monthT, dayT = kind === 'flow' ? monthT / o.workingDays : monthT;
    const paceT = kind === 'flow' ? monthT * share : monthT;
    let status;
    if (actual == null) status = 'NO DATA';
    else if (kind === 'ceiling') status = actual <= monthT ? 'OK' : 'OVER';
    else if (kind === 'flow') status = actual >= monthT ? 'MET' : actual >= paceT ? 'ON PACE' : actual >= paceT * 0.8 ? 'BEHIND' : 'OFF PACE';
    else status = actual >= monthT ? 'MET' : 'BELOW';
    return { key, label, kind, unit, month: monthT, week: weekT, day: dayT, paceTarget: Math.round(paceT * 10) / 10, actual, status, note,
      progressPct: monthT ? (kind === 'ceiling' ? null : Math.round(actual / monthT * 1000) / 10) : null };
  };
  const arrearsReduction = openingArrears > 0 ? Math.round((openingArrears - oldNow) / openingArrears * 1000) / 10 : null;
  const kpis = [
    kpi('newLoans', 'New loans', 'flow', tg.newLoans, newLoans, 'count'),
    kpi('repeatLoans', 'Repeat loans', 'flow', tg.repeatLoans, repeatLoans, 'count'),
    kpi('totalLoans', 'Total loans', 'flow', tg.newLoans + tg.repeatLoans, newLoans + repeatLoans, 'count'),
    kpi('disbursement', 'Disbursement', 'flow', tg.disbursement, disbursement, 'money'),
    kpi('mtdArrears', 'MTD arrears', 'ceiling', o.mtdArrearsCeiling, Number(cur.unpaid_overdue), 'money', 'Installments due this month that are overdue and unpaid'),
    kpi('currentGc', 'Current GC%', 'floor', o.currentGcFloor, pct(Number(cur.paid), Number(cur.due)), 'pct', 'Collected ÷ all installments due this month'),
    kpi('previousGc', 'Previous GC%', 'floor', o.previousGcFloor, pct(Number(prv.paid), Number(prv.due)), 'pct', 'Collected ÷ installments due last month'),
    kpi('duesCr', 'Dues Cr', 'floor', o.duesCrFloor, pct(Number(today.paid), Number(today.due)), 'pct', `Collected ÷ due on ${b.asOf} (Monday–Saturday)`),
    kpi('arrearsReduction', 'Arrears reduction', 'floor', o.arrearsReductionPct, arrearsReduction, 'pct',
      `Opening arrears ${Math.round(openingArrears)} → ${Math.round(oldNow)}; pace ${Math.round(o.arrearsReductionPct / o.workingDays * 10) / 10}% per working day, ${o.arrearsReductionPct}% by month end`),
    kpi('performing', 'Performing loans', 'constant', tg.performingLoans, performing, 'count'),
    kpi('revenue', 'Revenue', 'flow', tg.revenue, Math.round(revenue), 'money', 'Interest and penalties collected plus processing fees'),
    kpi('bookQuality', 'Book quality', 'floor', o.bookQualityPct, pct(performing, clients.size), 'pct', 'Performing loans ÷ active clients'),
    kpi('activeClients', 'Active clients', 'constant', o.activeClients, clients.size, 'count'),
    kpi('cleanActiveClients', 'Clean active clients', 'constant', o.cleanActiveClients, clients.size - dirty.size, 'count', 'Active clients with nothing overdue'),
    kpi('par', 'PAR (30 days)', 'ceiling', o.parCeilingPct, pct(par30, outstanding) || 0, 'pct', 'Balance 30+ days overdue ÷ outstanding'),
  ];
  // The arrears-reduction line keeps the monthly 30% as its target while pacing 1.5%/day.
  const ar = kpis.find(k => k.key === 'arrearsReduction');
  ar.week = o.arrearsReductionPct / o.weeks; ar.day = Math.round(o.arrearsReductionPct / o.workingDays * 10) / 10;
  ar.paceTarget = Math.round(Math.min(o.arrearsReductionPct, ar.day * wd) * 10) / 10; ar.kind = 'cumulative';
  if (ar.actual != null) ar.status = ar.actual >= o.arrearsReductionPct ? 'MET' : ar.actual >= ar.paceTarget ? 'ON PACE' : 'BEHIND';
  else ar.status = 'NO ARREARS';
  const checkpoints = []; for (let w = 1; w <= o.weeks; w++) checkpoints.push({ week: w, newLoans: tg.newLoans / o.weeks * w, repeatLoans: tg.repeatLoans / o.weeks * w, totalLoans: (tg.newLoans + tg.repeatLoans) / o.weeks * w, disbursement: tg.disbursement / o.weeks * w });
  const onTrack = kpis.filter(k => ['MET', 'ON PACE', 'OK'].includes(k.status)).length;
  return { month: b.month, asOf: b.asOf, workingDaysElapsed: wd, workingDays: o.workingDays, currentWeek: week, kpis, checkpoints, onTrack, total: kpis.length,
    scorePct: Math.round(onTrack / kpis.length * 1000) / 10, targetsFromTargetsPage: tg.fromTargetsPage };
}

function register(router) {
  const noLO = (req, next) => { if (req.user.role_id === 'loan_officer') { next({ status: 403, message: 'Branch reports are for supervisors' }); return true; } return false; };
  router.get('/api/perf/settings', requireAuth, async (req, res) => res.json({ settings: await getSettings(), canEdit: EDITORS.includes(req.user.role_id) }));
  router.put('/api/perf/settings', requireAuth, async (req, res, next) => {
    if (!EDITORS.includes(req.user.role_id)) return next({ status: 403, message: 'Only Admin, CEO, Director or the Operational Manager can change report targets' });
    const cur = await getSettings(); const b = req.body || {};
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };
    const next_ = { ...cur };
    for (const k of ['establishedTarget', 'newBranchTarget', 'nearPct', 'mtdAmountTarget', 'mtdLoanTarget', 'onTrackPct', 'criticalPct', 'stableBandPct']) if (b[k] !== undefined) next_[k] = num(b[k], cur[k]);
    next_.officer = { ...cur.officer };
    for (const k of Object.keys(DEFAULTS.officer)) if (b.officer && b.officer[k] !== undefined) next_.officer[k] = num(b.officer[k], cur.officer[k]);
    if (!next_.officer.workingDays || !next_.officer.weeks) return next({ status: 400, message: 'Working days and weeks must be more than zero' });
    if (next_.criticalPct >= next_.onTrackPct) return next({ status: 400, message: 'The critical level must be below the on-track level' });
    await run(`INSERT INTO intelligence_settings (key, value, updated_by, updated_at) VALUES ('perf_report_settings', ?, ?, iso_now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`, [JSON.stringify(next_), req.user.id]);
    await logAction(req, { action: 'Changed performance report targets', module: 'reports', recordType: 'Settings', recordId: 'perf_report_settings', previousValue: cur, newValue: next_ });
    res.json({ settings: next_ });
  });
  router.get('/api/perf/disbursement-report', requireAuth, async (req, res, next) => { if (noLO(req, next)) return; res.json(await disbursementReport(req.user, req.query.month)); });
  router.get('/api/perf/branch-performance', requireAuth, async (req, res, next) => { if (noLO(req, next)) return; res.json(await branchPerformance(req.user, req.query.month)); });
  router.get('/api/perf/mtd', requireAuth, async (req, res, next) => { if (noLO(req, next)) return; res.json(await mtdPerformance(req.user, req.query.from, req.query.to)); });
  // One branch: its months this year against target, and its officers this month.
  router.get('/api/perf/branch/:id', requireAuth, async (req, res, next) => {
    if (noLO(req, next)) return;
    const branches = await scopeBranches(req.user);
    const br = branches.find(x => x.id === req.params.id);
    if (!br) return next({ status: 403, message: 'That branch is outside your scope' });
    const s = await getSettings(); const b = monthBounds(req.query.month);
    const { map: opened, first } = await openingMonths();
    const o = opened.get(br.id);
    const months = [];
    for (let m = 1; m <= b.mo; m++) {
      const key = `${b.y}-${String(m).padStart(2, '0')}`;
      if (!o || o > key) continue;
      const end = new Date(Date.UTC(b.y, m, 0)).toISOString().slice(0, 10);
      const a = (await disbursedByBranch(`${key}-01`, end, [br.id])).get(br.id) || { amount: 0, loans: 0 };
      const isNew = o === key && o !== first; const set = await registerBranchTargets(key);
      const target = set.has(br.id) ? set.get(br.id) : isNew ? s.newBranchTarget : s.establishedTarget;
      const ach = pct(a.amount, target) || 0;
      months.push({ month: key, actual: a.amount, loans: a.loans, target, variance: a.amount - target, achievementPct: ach, status: monthStatus(ach, isNew, s.nearPct) });
    }
    const officers = await all(`SELECT u.id, u.name, COUNT(l.id)::int AS loans, COALESCE(SUM(l.principal),0) AS amount,
        COUNT(l.id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM loans p WHERE p.client_id = l.client_id AND p.disbursed_at IS NOT NULL AND p.disbursed_at < l.disbursed_at))::int AS newloans
      FROM users u LEFT JOIN loans l ON l.officer_id = u.id AND l.disbursed_at IS NOT NULL AND (l.disbursed_at)::date BETWEEN (?)::date AND (?)::date
      WHERE u.role_id = 'loan_officer' AND u.branch_id = ? AND u.status = 'Active' GROUP BY u.id, u.name ORDER BY amount DESC`, [b.start, b.end, br.id]);
    const total = officers.reduce((t, x) => t + Number(x.amount), 0);
    const recent = await all(`SELECT l.id, l.application_no, l.principal, l.disbursed_at, c.name AS client, u.name AS officer FROM loans l JOIN clients c ON c.id = l.client_id LEFT JOIN users u ON u.id = l.officer_id
      WHERE l.branch_id = ? AND l.disbursed_at IS NOT NULL AND (l.disbursed_at)::date BETWEEN (?)::date AND (?)::date ORDER BY l.disbursed_at DESC LIMIT 50`, [br.id, b.start, b.end]);
    res.json({ branch: { id: br.id, name: br.name, region: br.region, openingMonth: o || null }, month: b.month, months,
      officers: officers.map(x => ({ ...x, amount: Number(x.amount), repeatloans: x.loans - x.newloans, sharePct: pct(Number(x.amount), total) })), recent,
      ytd: { actual: months.reduce((t, m) => t + m.actual, 0), target: months.reduce((t, m) => t + m.target, 0), loans: months.reduce((t, m) => t + m.loans, 0) } });
  });
  // Officers in scope with their control-plan score (a Loan Officer: just themself).
  router.get('/api/perf/officers', requireAuth, async (req, res) => {
    let officers;
    if (req.user.role_id === 'loan_officer') officers = [{ id: req.user.id, name: req.user.name, branch_id: req.user.branch_id }];
    else {
      const ids = (await scopeBranches(req.user)).map(b => b.id);
      officers = ids.length ? await all(`SELECT id, name, branch_id FROM users WHERE role_id = 'loan_officer' AND status = 'Active' AND branch_id IN (${ids.map(() => '?').join(',')}) ORDER BY name`, ids) : [];
    }
    const out = [];
    for (const o of officers.slice(0, 200)) { const p = await officerPlan(o.id, req.query.month); out.push({ id: o.id, name: o.name, branchId: o.branch_id, scorePct: p.scorePct, onTrack: p.onTrack, total: p.total, kpis: Object.fromEntries(p.kpis.map(k => [k.key, { actual: k.actual, month: k.month, status: k.status }])) }); }
    out.sort((a, b) => b.scorePct - a.scorePct);
    res.json({ month: monthBounds(req.query.month).month, officers: out });
  });
  router.get('/api/perf/officer/:id', requireAuth, async (req, res, next) => {
    const o = await get(`SELECT id, name, branch_id, role_id FROM users WHERE id = ?`, [req.params.id]);
    if (!o || o.role_id !== 'loan_officer') return next({ status: 404, message: 'Loan officer not found' });
    if (req.user.role_id === 'loan_officer' && o.id !== req.user.id) return next({ status: 403, message: 'You can only see your own targets' });
    if (req.user.role_id !== 'loan_officer' && !(await scopeBranches(req.user)).some(b => b.id === o.branch_id)) return next({ status: 403, message: 'That officer is outside your branches' });
    res.json({ officer: { id: o.id, name: o.name, branchId: o.branch_id }, ...(await officerPlan(o.id, req.query.month)) });
  });
}

module.exports = { register, getSettings, DEFAULTS };
