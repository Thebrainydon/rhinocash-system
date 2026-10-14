// portfolioMetrics.js — one place for the portfolio figures the analytics
// pages show, so every page agrees:
//   - per running loan: outstanding, arrears (overdue and unpaid), days the
//     oldest unpaid installment is overdue
//   - PAR-N: outstanding of loans with any installment N+ days overdue ÷
//     total outstanding (same definition as accounting.computePAR)
//   - loan classification and loan-loss provision (Central Bank of Kenya
//     prudential classes): Normal (current) 1%, Watch (1–30 days) 3%,
//     Substandard (31–90) 20%, Doubtful (91–180) 50%, Loss (180+) 100%
//   - month to date: expected (installments due this month so far) vs
//     collected (posted payments this month) → collection rate
'use strict';
const { all } = require('./db');

const CLASSES = [
  { key: 'normal', label: 'Normal (current)', min: -Infinity, max: 0, rate: 1 },
  { key: 'watch', label: 'Watch (1–30 days)', min: 1, max: 30, rate: 3 },
  { key: 'substandard', label: 'Substandard (31–90 days)', min: 31, max: 90, rate: 20 },
  { key: 'doubtful', label: 'Doubtful (91–180 days)', min: 91, max: 180, rate: 50 },
  { key: 'loss', label: 'Loss (over 180 days)', min: 181, max: Infinity, rate: 100 },
];
const classOf = days => CLASSES.find(c => days >= c.min && days <= c.max) || CLASSES[0];

function scopeSql(scope, officerId, alias = 'l') {
  const parts = []; const params = [];
  if (scope !== null && scope !== undefined) {
    if (!scope.length) parts.push('1=0');
    else { parts.push(`${alias}.branch_id IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
  }
  if (officerId) { parts.push(`${alias}.officer_id = ?`); params.push(officerId); }
  return { clause: parts.length ? parts.join(' AND ') : '1=1', params };
}

// Every running loan in scope with its balances (one query).
async function loanFacts(scope, officerId) {
  const sc = scopeSql(scope, officerId);
  const rows = await all(`SELECT l.id, l.client_id, l.officer_id, l.branch_id, l.product_id, l.principal, l.disbursed_at,
      c.name AS client_name, c.phone AS client_phone, u.name AS officer_name, b.name AS branch_name, b.region_id,
      COALESCE(SUM(GREATEST(s.total_due - s.paid_amount, 0)), 0) AS outstanding,
      COALESCE(SUM(CASE WHEN (s.due_date)::date < CURRENT_DATE AND s.paid_amount < s.total_due THEN s.total_due - s.paid_amount ELSE 0 END), 0) AS arrears,
      COALESCE(SUM(CASE WHEN (s.due_date)::date < CURRENT_DATE AND s.paid_amount < s.total_due - 0.01 THEN 1 ELSE 0 END), 0) AS missed,
      COALESCE(MAX(CASE WHEN s.paid_amount < s.total_due - 0.01 THEN CURRENT_DATE - (s.due_date)::date END), -1) AS days_overdue
    FROM loans l
    LEFT JOIN loan_schedule s ON s.loan_id = l.id
    LEFT JOIN clients c ON c.id = l.client_id
    LEFT JOIN users u ON u.id = l.officer_id
    LEFT JOIN branches b ON b.id = l.branch_id
    WHERE ${sc.clause} AND l.status IN ('Active','Disbursed')
    GROUP BY l.id, c.name, c.phone, u.name, b.name, b.region_id`, sc.params);
  return rows.map(r => {
    const days = Math.max(0, Number(r.days_overdue));
    const cls = classOf(Number(r.days_overdue) > 0 ? days : 0);
    const outstanding = Number(r.outstanding);
    return { ...r, principal: Number(r.principal), outstanding, arrears: Number(r.arrears), missed: Number(r.missed), daysOverdue: Number(r.days_overdue) > 0 ? days : 0,
      classKey: cls.key, classLabel: cls.label, provision: Math.round(outstanding * cls.rate) / 100 };
  });
}

// Month to date expected vs collected, grouped by a loan column.
async function collectionsMTD(scope, officerId, groupCol) {
  const sc = scopeSql(scope, officerId);
  const start = new Date().toISOString().slice(0, 7) + '-01';
  const g = groupCol ? `l.${groupCol}` : `'all'`;
  const expected = await all(`SELECT ${g} AS k, COALESCE(SUM(s.total_due), 0) AS v FROM loan_schedule s JOIN loans l ON l.id = s.loan_id
    WHERE ${sc.clause} AND (s.due_date)::date BETWEEN (?)::date AND CURRENT_DATE GROUP BY 1`, [...sc.params, start]);
  const collected = await all(`SELECT ${g} AS k, COALESCE(SUM(p.amount), 0) AS v FROM payments p JOIN loans l ON l.id = p.loan_id
    WHERE ${sc.clause} AND p.status NOT IN ('Unposted','Reversed') AND (p.created_at)::date BETWEEN (?)::date AND CURRENT_DATE GROUP BY 1`, [...sc.params, start]);
  const map = new Map();
  expected.forEach(r => map.set(r.k, { expected: Number(r.v), collected: 0 }));
  collected.forEach(r => { const m = map.get(r.k) || { expected: 0, collected: 0 }; m.collected = Number(r.v); map.set(r.k, m); });
  return map;
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

function summarize(loans, mtd) {
  const outstanding = loans.reduce((s, l) => s + l.outstanding, 0);
  const par = d => loans.filter(l => l.daysOverdue >= d).reduce((s, l) => s + l.outstanding, 0);
  const exp = mtd ? mtd.expected : 0, col = mtd ? mtd.collected : 0;
  return {
    activeLoans: loans.length,
    clients: new Set(loans.map(l => l.client_id)).size,
    principal: loans.reduce((s, l) => s + l.principal, 0),
    outstanding,
    arrears: loans.reduce((s, l) => s + l.arrears, 0),
    loansInArrears: loans.filter(l => l.daysOverdue > 0).length,
    par1Pct: pct(par(1), outstanding), par30Amount: par(30), par30Pct: pct(par(30), outstanding), par90Pct: pct(par(90), outstanding),
    avgLoanSize: loans.length ? Math.round(loans.reduce((s, l) => s + l.principal, 0) / loans.length) : 0,
    provision: Math.round(loans.reduce((s, l) => s + l.provision, 0)),
    expectedMTD: exp, collectedMTD: col, collectionRate: pct(col, exp),
  };
}

// Per officer / branch / region / product, with every figure above.
async function groupMetrics(by, scope, { officerId = null, names = null } = {}) {
  const col = { officer: 'officer_id', branch: 'branch_id', product: 'product_id', region: 'branch_id' }[by];
  const loans = await loanFacts(scope, officerId);
  const mtd = await collectionsMTD(scope, officerId, col);
  const keyOf = by === 'region' ? (l => l.region_id) : (l => l[col]);
  const groups = new Map();
  for (const l of loans) { const k = keyOf(l); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  // Keep groups with no running loans (e.g. a new officer) when a name list is given.
  if (names) for (const k of Object.keys(names)) if (!groups.has(k)) groups.set(k, []);
  let regionOfBranch = null;
  if (by === 'region') regionOfBranch = new Map(loans.map(l => [l.branch_id, l.region_id]));
  const rows = [];
  for (const [k, ls] of groups) {
    let m;
    if (by === 'region') {
      m = { expected: 0, collected: 0 };
      for (const [bid, v] of mtd) if (regionOfBranch.get(bid) === k) { m.expected += v.expected; m.collected += v.collected; }
    } else m = mtd.get(k);
    rows.push({ id: k, name: (names && names[k]) || (ls[0] && (by === 'officer' ? ls[0].officer_name : by === 'branch' ? ls[0].branch_name : null)) || k || '—', ...summarize(ls, m) });
  }
  rows.sort((a, b) => b.outstanding - a.outstanding || String(a.name).localeCompare(String(b.name)));
  let totalMtd = { expected: 0, collected: 0 };
  for (const v of mtd.values()) { totalMtd.expected += v.expected; totalMtd.collected += v.collected; }
  return { rows, total: summarize(loans, totalMtd), loans };
}

// Classification and provisioning table + the riskiest loans.
async function agingProvision(scope, officerId, topN = 25) {
  const loans = await loanFacts(scope, officerId);
  const total = loans.reduce((s, l) => s + l.outstanding, 0);
  const classes = CLASSES.map(c => {
    const ls = loans.filter(l => l.classKey === c.key);
    const amount = ls.reduce((s, l) => s + l.outstanding, 0);
    return { key: c.key, label: c.label, ratePct: c.rate, loans: ls.length, clients: new Set(ls.map(l => l.client_id)).size, outstanding: amount, sharePct: pct(amount, total), provision: Math.round(amount * c.rate) / 100 };
  });
  const atRisk = loans.filter(l => l.daysOverdue > 0).sort((a, b) => b.daysOverdue - a.daysOverdue || b.arrears - a.arrears).slice(0, topN)
    .map(l => ({ loanId: l.id, client: l.client_name, phone: l.client_phone, officer: l.officer_name, branch: l.branch_name, principal: l.principal, outstanding: l.outstanding, arrears: l.arrears, missed: l.missed, daysOverdue: l.daysOverdue, classLabel: l.classLabel, provision: l.provision }));
  const provision = classes.reduce((s, c) => s + c.provision, 0);
  return { classes, atRisk, totalOutstanding: total, totalProvision: Math.round(provision), provisionCoveragePct: pct(provision, total) };
}

module.exports = { CLASSES, loanFacts, collectionsMTD, groupMetrics, agingProvision, summarize };
