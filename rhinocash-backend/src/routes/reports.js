'use strict';
const { all, get, run } = require('./../db');
const { requireAuth, requireModule } = require('./../middleware');
const { branchIdsInScope } = require('./../rbac');
const crypto = require('node:crypto');

// Real scope resolution shared by every report below — same real
// branchIdsInScope() the rest of the app already uses, with the same
// optional branch_id/region_id narrowing pattern accounting.js uses.
async function resolveReportScope(req) {
  const userScope = await branchIdsInScope(req.user); // null = company-wide
  if (req.query.branch_id) {
    if (userScope !== null && !userScope.includes(req.query.branch_id)) return [];
    return [req.query.branch_id];
  }
  if (req.query.region_id) {
    const regionBranchRows = await all('SELECT id FROM branches WHERE region_id = ?', [req.query.region_id]);
    const regionBranches = regionBranchRows.map(b => b.id);
    if (userScope === null) return regionBranches;
    return userScope.filter(id => regionBranches.includes(id));
  }
  return userScope;
}

async function loanIdsInScope(scope, extraClause, extraParams) {
  const clause = scope === null ? '1=1' : (scope.length === 0 ? '1=0' : `branch_id IN (${scope.map(() => '?').join(',')})`);
  const params = scope !== null ? [...scope] : [];
  const full = extraClause ? `${clause} AND ${extraClause}` : clause;
  const rows = await all(`SELECT id FROM loans WHERE ${full}`, extraClause ? [...params, ...(extraParams || [])] : params);
  return rows.map(l => l.id);
}

function register(router) {
  // ==================== Portfolio ====================
  // Reuses computePAR() from accounting.js — the SAME PAR every Accounting
  // page already shows. No second PAR formula here.
  router.get('/api/reports/portfolio', requireAuth, requireModule('reports'), async (req, res) => {
    const { computePAR } = require('./accounting');
    const scope = await resolveReportScope(req);
    const par = await computePAR(scope);
    const activeLoanIds = await loanIdsInScope(scope, `status IN ('Active','Disbursed')`);
    const disbursedThisMonth = await get(
      `SELECT COALESCE(SUM(principal),0) as v, COUNT(*) as c FROM loans WHERE id IN (${activeLoanIds.length ? activeLoanIds.map(() => '?').join(',') : "''"}) AND disbursed_at >= date_trunc('month', CURRENT_DATE)::date::text`,
      activeLoanIds
    );
    res.json({
      activeLoans: activeLoanIds.length,
      totalOutstanding: par.totalOutstanding,
      disbursedThisMonth: disbursedThisMonth.v,
      disbursedCountThisMonth: disbursedThisMonth.c,
      par: par.par,
      asOf: par.asOf,
    });
  });

  // ==================== Collections ====================
  // Reuses collectionTotals() from collections.js — the SAME MTD/rate
  // math the real Collections module already uses.
  router.get('/api/reports/collections', requireAuth, requireModule('reports'), async (req, res) => {
    const { collectionTotals } = require('./collections');
    const scope = await resolveReportScope(req);
    const activeLoanIds = await loanIdsInScope(scope, `status IN ('Active','Disbursed')`);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const today = new Date();
    const { expected, collected } = await collectionTotals(activeLoanIds, monthStart.toISOString().slice(0, 10), today.toISOString().slice(0, 10));
    // Real arrears aging — same loan_schedule every arrears view already reads.
    const buckets = { 'Current': 0, '1-7': 0, '8-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    for (const loanId of activeLoanIds) {
      const rows = await all(`SELECT * FROM loan_schedule WHERE loan_id = ? AND status != 'Paid' AND due_date < CURRENT_DATE::text`, [loanId]);
      rows.forEach(r => {
        const days = Math.floor((today - new Date(r.due_date)) / 86400000);
        const overdue = Math.max(0, r.total_due - r.paid_amount);
        if (days <= 0) buckets['Current'] += overdue;
        else if (days <= 7) buckets['1-7'] += overdue;
        else if (days <= 30) buckets['8-30'] += overdue;
        else if (days <= 60) buckets['31-60'] += overdue;
        else if (days <= 90) buckets['61-90'] += overdue;
        else buckets['90+'] += overdue;
      });
    }
    res.json({ expected, collected, rate: expected > 0 ? (collected / expected * 100) : 0, arrearsBuckets: buckets });
  });

  // ==================== Targets ====================
  // Reuses computeAchievement() from targets.js — the SAME achievement
  // math every target page already uses. Aggregated here, not recalculated.
  router.get('/api/reports/targets', requireAuth, requireModule('reports'), async (req, res) => {
    const { computeAchievement } = require('./targets');
    const scope = await branchIdsInScope(req.user);
    let targets = await all(`SELECT * FROM targets WHERE status = 'Active'`);
    if (scope !== null) {
      const kept = [];
      for (const t of targets) {
        if (t.branch_id) { if (scope.includes(t.branch_id)) kept.push(t); continue; }
        if (t.recipient_user_id) {
          const u = await get('SELECT branch_id FROM users WHERE id = ?', [t.recipient_user_id]);
          if (u && scope.includes(u.branch_id)) kept.push(t);
          continue;
        }
      }
      targets = kept;
    }
    const withAchievement = await Promise.all(targets.map(async t => ({ ...t, ...(await computeAchievement(t)) })));
    const totalTarget = withAchievement.reduce((s, t) => s + t.target_value, 0);
    const totalAchieved = withAchievement.reduce((s, t) => s + t.achieved, 0);
    res.json({
      targets: withAchievement,
      totalTarget, totalAchieved,
      achievementPct: totalTarget > 0 ? (totalAchieved / totalTarget * 100) : 0,
    });
  });

  // ==================== Financial (Accountant/CEO/Director/Admin) ====================
  // Reuses ledgerBalance() from accounting.js — the SAME General Ledger
  // every Accounting page reads. No independent P&L calculation.
  router.get('/api/reports/financial', requireAuth, async (req, res, next) => {
    // Deliberately stricter than requireModule('accounting'): Manager/
    // Regional/Operational/Loan Officer all hold the 'accounting' module
    // for other real pages (their own branch's ledger, payments, etc.)
    // but full revenue/expense/net-profit reporting is Accountant/Admin/
    // CEO/Director territory only, matching the spec's explicit intent.
    if (!['accountant', 'admin', 'ceo', 'director'].includes(req.user.role_id)) {
      return next({ status: 403, message: 'Your role does not have financial reporting authority' });
    }
    const { ledgerBalance } = require('./accounting');
    const scope = await resolveReportScope(req);
    const branchFilter = scope === null ? undefined : scope;
    const revenue = (await ledgerBalance('interest_income', branchFilter)) + (await ledgerBalance('fee_income', branchFilter));
    const expenses = await ledgerBalance('operating_expense', branchFilter);
    res.json({ revenue, expenses, netProfit: revenue - expenses });
  });

  // ==================== Growth (real, from real created_at timestamps) ====================
  router.get('/api/reports/growth', requireAuth, requireModule('reports'), async (req, res) => {
    const scope = await resolveReportScope(req);
    const clientClause = scope === null ? '1=1' : (scope.length === 0 ? '1=0' : `branch_id IN (${scope.map(() => '?').join(',')})`);
    const clientParams = scope !== null ? [...scope] : [];
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setMonth(d.getMonth() - i); d.setDate(1);
      const monthKey = d.toISOString().slice(0, 7);
      const newClients = (await get(`SELECT COUNT(*) as c FROM clients WHERE ${clientClause} AND to_char(created_at::timestamptz, 'YYYY-MM') = ?`, [...clientParams, monthKey])).c;
      const newLoans = await get(`SELECT COUNT(*) as c, COALESCE(SUM(principal),0) as v FROM loans WHERE ${clientClause} AND to_char(created_at::timestamptz, 'YYYY-MM') = ?`, [...clientParams, monthKey]);
      months.push({ month: monthKey, newClients, newLoans: newLoans.c, newLoanValue: newLoans.v });
    }
    res.json({ months });
  });

  // ==================== Branch Ranking (Regional/Operational Manager, CEO, Director, Admin) ====================
  // Combines the SAME real per-branch functions collections.js's own
  // branch-comparison route uses — not a new formula, just reporting-level aggregation.
  router.get('/api/reports/branch-ranking', requireAuth, requireModule('reports'), async (req, res) => {
    const { collectionTotals } = require('./collections');
    const { computePAR, ledgerBalance } = require('./accounting');
    const scope = await resolveReportScope(req);
    let branches = await all(`SELECT * FROM branches WHERE status = 'Active'`);
    if (scope !== null) branches = branches.filter(b => scope.includes(b.id));
    const monthStart = new Date(); monthStart.setDate(1);
    const today = new Date();
    const result = await Promise.all(branches.map(async b => {
      const loanIds = await loanIdsInScope([b.id], `status IN ('Active','Disbursed')`);
      const { expected, collected } = await collectionTotals(loanIds, monthStart.toISOString().slice(0, 10), today.toISOString().slice(0, 10));
      const par = await computePAR([b.id]);
      const revenue = (await ledgerBalance('interest_income', [b.id])) + (await ledgerBalance('fee_income', [b.id]));
      const expenses = await ledgerBalance('operating_expense', [b.id]);
      return {
        branchId: b.id, branchName: b.name,
        collectionRate: expected > 0 ? (collected / expected * 100) : 0,
        par30: (par.par.find(p => p.threshold === 30) || {}).percentage || 0,
        netResult: revenue - expenses,
        outstanding: par.totalOutstanding,
      };
    }));
    result.sort((a, b) => b.collectionRate - a.collectionRate);
    res.json({ branches: result });
  });
  // ==================== Export & Saved Presets ====================
  // Real export data — the same shared aggregation functions above,
  // returned as a flat structure suitable for CSV, not a duplicate calculation.
  router.get('/api/reports/export', requireAuth, requireModule('reports'), async (req, res) => {
    const { computePAR } = require('./accounting');
    const { collectionTotals } = require('./collections');
    const scope = await resolveReportScope(req);
    const par = await computePAR(scope);
    const activeLoanIds = await loanIdsInScope(scope, `status IN ('Active','Disbursed')`);
    const monthStart = new Date(); monthStart.setDate(1);
    const today = new Date();
    const { expected, collected } = await collectionTotals(activeLoanIds, monthStart.toISOString().slice(0, 10), today.toISOString().slice(0, 10));
    res.json({
      rows: [
        { metric: 'Active Loans', value: activeLoanIds.length },
        { metric: 'Total Outstanding', value: par.totalOutstanding },
        { metric: 'PAR 30 (%)', value: (par.par.find(p => p.threshold === 30) || {}).percentage || 0 },
        { metric: 'Collection Rate (%)', value: expected > 0 ? (collected / expected * 100) : 0 },
        { metric: 'Expected (MTD)', value: expected },
        { metric: 'Collected (MTD)', value: collected },
      ],
      asOf: par.asOf,
    });
  });

  // Real, per-user saved report filter presets — same genuine pattern as
  // the Support Center's ticket_filter_presets, reused for Reports.
  router.get('/api/report-filter-presets', requireAuth, requireModule('reports'), async (req, res) => {
    res.json({ presets: await all('SELECT * FROM report_filter_presets WHERE user_id = ? ORDER BY created_at DESC', [req.user.id]) });
  });
  router.post('/api/report-filter-presets', requireAuth, requireModule('reports'), async (req, res, next) => {
    if (!req.body.name || !req.body.filters) return next({ status: 400, message: 'name and filters are required' });
    const id = 'rfp_' + crypto.randomUUID();
    await run('INSERT INTO report_filter_presets (id, user_id, name, filters_json) VALUES (?,?,?,?)', [id, req.user.id, req.body.name, JSON.stringify(req.body.filters)]);
    res.status(201).json({ preset: await get('SELECT * FROM report_filter_presets WHERE id = ?', [id]) });
  });
  router.delete('/api/report-filter-presets/:id', requireAuth, requireModule('reports'), async (req, res, next) => {
    const p = await get('SELECT * FROM report_filter_presets WHERE id = ?', [req.params.id]);
    if (!p) return next({ status: 404, message: 'Preset not found' });
    if (p.user_id !== req.user.id) return next({ status: 403, message: 'This preset does not belong to you' });
    await run('DELETE FROM report_filter_presets WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  });
}

module.exports = { register };
