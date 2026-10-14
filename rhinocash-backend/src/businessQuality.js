// businessQuality.js — the three Performance (Business Quality) KPIs:
//
//   1. Arrears Collection %  = (Arrears Collected ÷ Current Arrears) × 100
//   2. Disbursement Counts % = (Disbursement Counts ÷ Target) × 100
//   3. Portfolio Quality (Book Quality – BQ) % = (Performing Loans ÷ Active Clients) × 100
//
// Terms, using the definitions the rest of the app already uses:
//   - Arrears Collected: money applied this month to installments that were
//     already overdue when paid (payment_allocations.bucket = 'arrears').
//   - Current Arrears: the arrears book for the month — what is still overdue
//     today plus what was collected against arrears this month.
//   - Disbursement Counts: loans disbursed this month.
//   - Target: the month's New Loans + Repeat Loans targets (Targets & Accruals).
//   - Performing Loans: running loans with no overdue unpaid installment.
//   - Active Clients: clients with a running loan.
// Scope is always the caller's: a Loan Officer their own book, a Manager
// their branch (per officer), regional/head office their branches (per branch).
'use strict';
const { all, get } = require('./db');
const { branchIdsInScope } = require('./rbac');

function monthRange(month) {
  const m = /^\d{4}-\d{2}$/.test(String(month || '')) ? month : new Date().toISOString().slice(0, 7);
  const [y, mo] = m.split('-').map(Number);
  const start = `${m}-01`;
  const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  return { month: m, start, end: last < today ? last : today };
}
function scopeSql(branchIds, officerId, alias = 'l') {
  const parts = []; const params = [];
  if (branchIds !== null) {
    if (!branchIds.length) parts.push('1=0');
    else { parts.push(`${alias}.branch_id IN (${branchIds.map(() => '?').join(',')})`); params.push(...branchIds); }
  }
  if (officerId) { parts.push(`${alias}.officer_id = ?`); params.push(officerId); }
  return { clause: parts.length ? parts.join(' AND ') : '1=1', params };
}
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

async function targetCount(branchIds, officerId, month) {
  const latest = `SELECT DISTINCT ON (t.recipient_user_id, t.metric) t.target_value FROM targets t JOIN users u ON u.id = t.recipient_user_id
    WHERE t.metric IN ('new_loans','repeat_loans') AND t.period = ? AND t.period_type = 'monthly' AND t.status != 'Cancelled'`;
  if (officerId) {
    const rows = await all(`${latest} AND t.recipient_user_id = ? ORDER BY t.recipient_user_id, t.metric, t.created_at DESC`, [month, officerId]);
    return rows.reduce((s, r) => s + Number(r.target_value), 0);
  }
  const sc = scopeSql(branchIds, null, 'u');
  // Officers' own targets add up to the branch's; a branch-level or
  // Manager's target is used only where officers have none.
  const officers = await all(`${latest} AND u.role_id = 'loan_officer' AND ${sc.clause} ORDER BY t.recipient_user_id, t.metric, t.created_at DESC`, [month, ...sc.params]);
  const officerSum = officers.reduce((s, r) => s + Number(r.target_value), 0);
  if (officerSum > 0) return officerSum;
  const managers = await all(`${latest} AND u.role_id = 'manager' AND ${sc.clause} ORDER BY t.recipient_user_id, t.metric, t.created_at DESC`, [month, ...sc.params]);
  const managerSum = managers.reduce((s, r) => s + Number(r.target_value), 0);
  if (managerSum > 0) return managerSum;
  const bs = scopeSql(branchIds, null, 't');
  const branch = await get(`SELECT COALESCE(SUM(t.target_value),0) AS v FROM targets t WHERE t.recipient_user_id IS NULL AND t.metric IN ('new_loans','repeat_loans')
    AND t.period = ? AND t.period_type = 'monthly' AND t.status != 'Cancelled' AND ${bs.clause}`, [month, ...bs.params]);
  return Number(branch.v) || 0;
}

async function computeBusinessQuality({ branchIds = null, officerId = null, month } = {}) {
  const r = monthRange(month);
  const sc = scopeSql(branchIds, officerId);
  const collected = Number((await get(`SELECT COALESCE(SUM(pa.amount_applied),0) AS v FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id JOIN loans l ON l.id = p.loan_id
    WHERE ${sc.clause} AND pa.bucket = 'arrears' AND p.status NOT IN ('Unposted','Reversed')
      AND (p.created_at)::date BETWEEN (?)::date AND (?)::date`, [...sc.params, r.start, r.end])).v);
  const outstanding = Number((await get(`SELECT COALESCE(SUM(s.total_due - s.paid_amount),0) AS v FROM loan_schedule s JOIN loans l ON l.id = s.loan_id
    WHERE ${sc.clause} AND l.disbursed_at IS NOT NULL AND l.status IN ('Active','Disbursed')
      AND (s.due_date)::date < (?)::date AND s.paid_amount < s.total_due`, [...sc.params, r.end])).v);
  const current = collected + outstanding;
  const disbursed = Number((await get(`SELECT COUNT(*)::int AS v FROM loans l WHERE ${sc.clause} AND l.disbursed_at IS NOT NULL
      AND (l.disbursed_at)::date BETWEEN (?)::date AND (?)::date`, [...sc.params, r.start, r.end])).v);
  const target = await targetCount(branchIds, officerId, r.month);
  const running = await get(`SELECT COUNT(DISTINCT l.client_id)::int AS clients,
      COUNT(DISTINCT l.id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM loan_schedule s WHERE s.loan_id = l.id AND (s.due_date)::date < (?)::date AND s.paid_amount < s.total_due))::int AS performing
    FROM loans l WHERE ${sc.clause} AND l.disbursed_at IS NOT NULL AND l.status IN ('Active','Disbursed')`, [r.end, ...sc.params]);
  return {
    period: r,
    arrearsCollection: { collected, outstanding, current, pct: pct(collected, current) },
    disbursementCounts: { count: disbursed, target, pct: pct(disbursed, target) },
    portfolioQuality: { performing: Number(running.performing), activeClients: Number(running.clients), pct: pct(Number(running.performing), Number(running.clients)) },
  };
}

// The caller's own figures plus a breakdown one level down.
async function businessQualityFor(user, { month, branchId, officerId } = {}) {
  if (user.role_id === 'loan_officer') {
    return { scope: 'officer', label: 'My book', ...(await computeBusinessQuality({ officerId: user.id, month })), rows: [] };
  }
  let branches = await branchIdsInScope(user);
  if (user.role_id === 'manager') branches = user.branch_id ? [user.branch_id] : [];
  const allBranches = await all(`SELECT id, name FROM branches WHERE COALESCE(status,'Active') <> 'Closed' ORDER BY name`);
  const inScope = allBranches.filter(b => branches === null || branches.includes(b.id));
  if (officerId) {
    const o = await get('SELECT id, name, branch_id FROM users WHERE id = ?', [officerId]);
    if (!o || !inScope.some(b => b.id === o.branch_id)) { const e = new Error('That officer is outside your branches'); e.status = 403; throw e; }
    return { scope: 'officer', label: o.name, ...(await computeBusinessQuality({ officerId: o.id, month })), rows: [] };
  }
  let ids = branches;
  if (branchId) {
    if (!inScope.some(b => b.id === branchId)) { const e = new Error('That branch is outside your scope'); e.status = 403; throw e; }
    ids = [branchId];
  }
  const total = await computeBusinessQuality({ branchIds: ids, month });
  const oneBranch = ids !== null && ids.length === 1;
  let rows;
  if (oneBranch) {
    const officers = await all(`SELECT id, name FROM users WHERE role_id = 'loan_officer' AND branch_id = ? AND COALESCE(status,'Active') = 'Active' ORDER BY name`, [ids[0]]);
    rows = [];
    for (const o of officers) rows.push({ kind: 'officer', id: o.id, name: o.name, ...(await computeBusinessQuality({ officerId: o.id, month })) });
  } else {
    rows = [];
    for (const b of inScope.filter(b => ids === null || ids.includes(b.id))) rows.push({ kind: 'branch', id: b.id, name: b.name, ...(await computeBusinessQuality({ branchIds: [b.id], month })) });
  }
  const label = oneBranch ? (inScope.find(b => b.id === ids[0]) || {}).name || 'Branch'
    : branches === null ? 'Company' : user.role_id === 'regional_manager' ? 'My region' : 'My branches';
  return { scope: oneBranch ? 'branch' : 'multi', label, ...total, rows };
}

const FORMULAS = [
  { key: 'arrearsCollection', title: 'Arrears Collection %', formula: '(Arrears Collected ÷ Current Arrears) × 100' },
  { key: 'disbursementCounts', title: 'Disbursement Counts %', formula: '(Disbursement Counts ÷ Target) × 100' },
  { key: 'portfolioQuality', title: 'Portfolio Quality (Book Quality – BQ) %', formula: '(Performing Loans ÷ Active Clients) × 100' },
];

module.exports = { computeBusinessQuality, businessQualityFor, monthRange, FORMULAS };
