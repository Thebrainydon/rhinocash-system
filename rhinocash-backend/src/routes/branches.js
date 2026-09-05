'use strict';
const { all, get, run } = require('./../db');
const { requireAuth, requireModule, requirePermission } = require('./../middleware');
const { logAction } = require('./../audit');
const crypto = require('node:crypto');

const { branchIdsInScope } = require('./../rbac');

function register(router) {
  router.get('/api/branches', requireAuth, (req, res) => {
    const clauses = ['1=1']; const params = [];
    if (req.query.region_id) { clauses.push('region_id = ?'); params.push(req.query.region_id); }
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    if (req.query.manager_id) { clauses.push('manager_id = ?'); params.push(req.query.manager_id); }
    if (req.query.q) { clauses.push('(name LIKE ? OR code LIKE ? OR location LIKE ?)'); const like = `%${req.query.q}%`; params.push(like, like, like); }
    res.json({ branches: all(`SELECT * FROM branches WHERE ${clauses.join(' AND ')} ORDER BY name`, params) });
  });

  // Single-record lookup — the frontend previously had to fetch the
  // entire branch list and find one client-side just to open Branch
  // Details. Real reference data (name/code/location), so no additional
  // scope check beyond authentication, matching the list endpoint above.
  router.get('/api/branches/:id', requireAuth, (req, res, next) => {
    const branch = get('SELECT * FROM branches WHERE id = ?', [req.params.id]);
    if (!branch) return next({ status: 404, message: 'Branch not found' });
    res.json({ branch });
  });

  // Regions are a genuinely small, bounded dataset (a handful of company
  // regions, not thousands of rows) — real search/filter is supported for
  // consistency, but pagination is deliberately not implemented here; it
  // would add complexity with no real benefit at this scale.
  router.get('/api/regions', requireAuth, (req, res) => {
    let rows = all('SELECT * FROM regions ORDER BY name');
    if (req.query.status) rows = rows.filter(r => r.status === req.query.status);
    if (req.query.q) { const q = req.query.q.toLowerCase(); rows = rows.filter(r => r.name.toLowerCase().includes(q)); }
    res.json({ regions: rows });
  });

  router.post('/api/regions', requireAuth, requirePermission('manage_branches'), (req, res, next) => {
    if (!req.body.name) return next({ status: 400, message: 'name is required' });
    if (get('SELECT id FROM regions WHERE name = ?', [req.body.name])) return next({ status: 409, message: 'A region with this name already exists' });
    const id = 'rg_' + req.body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    run('INSERT INTO regions (id, name, status) VALUES (?,?,?)', [id, req.body.name, 'Active']);
    logAction(req, { action: 'Created region', module: 'branches', recordType: 'Region', recordId: id, newValue: { name: req.body.name } });
    res.status(201).json({ region: get('SELECT * FROM regions WHERE id = ?', [id]) });
  });

  router.patch('/api/regions/:id', requireAuth, requirePermission('manage_branches'), (req, res, next) => {
    const region = get('SELECT * FROM regions WHERE id = ?', [req.params.id]);
    if (!region) return next({ status: 404, message: 'Region not found' });
    if (req.body.status === 'Inactive' && region.status === 'Active') {
      const activeBranches = get(`SELECT COUNT(*) as n FROM branches WHERE region_id = ? AND status = 'Active'`, [region.id]).n;
      if (activeBranches > 0) return next({ status: 409, message: `Cannot deactivate a region with ${activeBranches} active branch(es) still assigned to it` });
    }
    run('UPDATE regions SET name = COALESCE(?,name), status = COALESCE(?,status) WHERE id = ?', [req.body.name || null, req.body.status || null, req.params.id]);
    logAction(req, { action: 'Updated region', module: 'branches', recordType: 'Region', recordId: req.params.id, previousValue: region, newValue: req.body });
    res.json({ region: get('SELECT * FROM regions WHERE id = ?', [req.params.id]) });
  });

  // Direct creation stays Admin-only — a true administrative override
  // (initial setup, data migration) that deliberately bypasses the
  // proposal workflow below. Everyone else, including the Operational
  // Manager who normally owns branch expansion, goes through
  // /api/branch-proposals so opening a branch is never just a form.
  router.post('/api/branches', requireAuth, (req, res, next) => {
    if (req.user.role_id !== 'admin') return next({ status: 403, message: 'Direct branch creation is Admin-only — use /api/branch-proposals for the normal Open New Branch workflow' });
    const { name, location, region_id, code, phone } = req.body;
    if (!name) return next({ status: 400, message: 'name is required' });
    if (get('SELECT id FROM branches WHERE name = ?', [name])) return next({ status: 409, message: 'A branch with this name already exists' });
    if (code && get('SELECT id FROM branches WHERE code = ?', [code])) return next({ status: 409, message: 'A branch with this code already exists' });
    if (region_id && !get('SELECT id FROM regions WHERE id = ?', [region_id])) return next({ status: 400, message: 'region_id does not refer to a real region' });
    if (region_id && get('SELECT status FROM regions WHERE id = ?', [region_id]).status !== 'Active') return next({ status: 409, message: 'Cannot open a branch in an inactive region' });
    const id = 'br_' + crypto.randomUUID();
    run('INSERT INTO branches (id, code, name, location, phone, region_id, status) VALUES (?,?,?,?,?,?,?)', [id, code || null, name, location || null, phone || null, region_id || null, 'Active']);
    logAction(req, { action: 'Opened new branch (direct, Admin override)', module: 'branches', recordType: 'Branch', recordId: id, newValue: { name, location } });
    res.status(201).json({ branch: get('SELECT * FROM branches WHERE id = ?', [id]) });
  });

  router.patch('/api/branches/:id', requireAuth, requirePermission('manage_branches'), (req, res, next) => {
    const before = get('SELECT * FROM branches WHERE id = ?', [req.params.id]);
    if (!before) return next({ status: 404, message: 'Branch not found' });
    const scope = branchIdsInScope(req.user);
    if (scope !== null && !scope.includes(before.id)) return next({ status: 403, message: 'You are not authorized to edit a branch outside your scope' });
    const { name, location, phone, region_id, status, manager_id } = req.body;
    if (region_id) {
      const region = get('SELECT * FROM regions WHERE id = ?', [region_id]);
      if (!region) return next({ status: 400, message: 'region_id does not refer to a real region' });
      if (region.status !== 'Active') return next({ status: 409, message: 'Cannot assign a branch to an inactive region' });
    }
    if (manager_id !== undefined && manager_id !== null) {
      const candidate = get('SELECT * FROM users WHERE id = ?', [manager_id]);
      if (!candidate) return next({ status: 400, message: 'manager_id does not refer to a real user' });
      if (candidate.role_id !== 'manager') return next({ status: 400, message: 'Only a user with the Manager role can be assigned as branch manager' });
      if (candidate.status !== 'Active') return next({ status: 409, message: 'Cannot assign an inactive staff member as branch manager' });
      if (candidate.branch_id && candidate.branch_id !== before.id) return next({ status: 409, message: 'This manager is assigned to a different branch — reassign their own branch first' });
    }
    run(
      'UPDATE branches SET name = COALESCE(?,name), location = COALESCE(?,location), phone = COALESCE(?,phone), region_id = COALESCE(?,region_id), status = COALESCE(?,status), manager_id = COALESCE(?,manager_id) WHERE id = ?',
      [name, location, phone, region_id, status, manager_id, req.params.id]
    );
    logAction(req, { action: 'Updated branch', module: 'branches', recordType: 'Branch', recordId: req.params.id, previousValue: before, newValue: req.body });
    res.json({ branch: get('SELECT * FROM branches WHERE id = ?', [req.params.id]) });
  });

  // ==================== Branch Expansion (real workflow) ====================
  // Propose → Approve/Reject → Activate. The `branches` table gets a row
  // only at Approval time; nothing before that pretends a branch exists.
  router.get('/api/branch-proposals', requireAuth, requireModule('staff'), (req, res) => {
    res.json({ proposals: all('SELECT * FROM branch_proposals ORDER BY created_at DESC') });
  });
  router.get('/api/branch-proposals/:id', requireAuth, requireModule('staff'), (req, res, next) => {
    const p = get('SELECT * FROM branch_proposals WHERE id = ?', [req.params.id]);
    if (!p) return next({ status: 404, message: 'Proposal not found' });
    res.json({ proposal: p });
  });

  router.post('/api/branch-proposals', requireAuth, requirePermission('open_new_branch'), (req, res, next) => {
    const b = req.body;
    if (!b.name || !b.location) return next({ status: 400, message: 'name and location are required' });
    if (b.region_id) {
      const region = get('SELECT * FROM regions WHERE id = ?', [b.region_id]);
      if (!region) return next({ status: 400, message: 'region_id does not refer to a real region' });
      if (region.status !== 'Active') return next({ status: 409, message: 'Cannot propose a branch in an inactive region' });
    }
    if (b.proposed_assigned_manager_id) {
      const candidate = get('SELECT * FROM users WHERE id = ?', [b.proposed_assigned_manager_id]);
      if (!candidate) return next({ status: 400, message: 'proposed_assigned_manager_id does not refer to a real user' });
      if (candidate.role_id !== 'manager') return next({ status: 400, message: 'Only a user with the Manager role can be proposed as branch manager' });
      if (candidate.status !== 'Active') return next({ status: 409, message: 'Cannot propose an inactive staff member as branch manager' });
    }
    const id = 'bp_' + crypto.randomUUID();
    run(
      `INSERT INTO branch_proposals (id, name, location, region_id, justification, feasibility_notes, budget, proposed_assigned_manager_id, proposed_by, status)
       VALUES (?,?,?,?,?,?,?,?,?,'Proposed')`,
      [id, b.name, b.location, b.region_id || null, b.justification || null, b.feasibility_notes || null, b.budget || null, b.proposed_assigned_manager_id || null, req.user.id]
    );
    logAction(req, { action: 'Proposed new branch', module: 'branches', recordType: 'BranchProposal', recordId: id, newValue: { name: b.name, location: b.location, budget: b.budget } });
    res.status(201).json({ proposal: get('SELECT * FROM branch_proposals WHERE id = ?', [id]) });
  });

  // Approval sits with Admin or CEO — a real capital-expenditure decision,
  // not the same person who proposed it (self-approval is blocked
  // explicitly, the same principle as the loan approval workflow).
  function requireBranchApprover(req, res, next) {
    if (!['admin', 'ceo'].includes(req.user.role_id)) {
      return next({ status: 403, message: 'Only Admin or CEO can approve a branch opening' });
    }
    next();
  }

  router.post('/api/branch-proposals/:id/approve', requireAuth, requireBranchApprover, (req, res, next) => {
    const proposal = get('SELECT * FROM branch_proposals WHERE id = ?', [req.params.id]);
    if (!proposal) return next({ status: 404, message: 'Proposal not found' });
    if (proposal.status !== 'Proposed') return next({ status: 409, message: `Proposal is already ${proposal.status}` });
    if (proposal.proposed_by === req.user.id) return next({ status: 403, message: 'You cannot approve a branch you proposed yourself' });

    const branchId = 'br_' + crypto.randomUUID();
    const code = 'BR' + Math.floor(Math.random() * 90000 + 10000);
    run('INSERT INTO branches (id, code, name, location, region_id, manager_id, status) VALUES (?,?,?,?,?,?,?)',
      [branchId, code, proposal.name, proposal.location, proposal.region_id, proposal.proposed_assigned_manager_id || null, 'Active']);
    if (proposal.proposed_assigned_manager_id) {
      run('UPDATE users SET branch_id = ? WHERE id = ?', [branchId, proposal.proposed_assigned_manager_id]);
    }
    run('UPDATE branch_proposals SET status = ?, decided_by = ?, decided_at = datetime(\'now\'), decision_reason = ?, branch_id = ? WHERE id = ?',
      ['Activated', req.user.id, req.body.reason || null, branchId, proposal.id]);

    logAction(req, {
      action: 'Approved and activated new branch', module: 'branches', recordType: 'BranchProposal', recordId: proposal.id,
      previousValue: { status: 'Proposed' }, newValue: { status: 'Activated', branchId }, reason: req.body.reason,
    });
    res.json({ proposal: get('SELECT * FROM branch_proposals WHERE id = ?', [proposal.id]), branch: get('SELECT * FROM branches WHERE id = ?', [branchId]) });
  });

  router.post('/api/branch-proposals/:id/reject', requireAuth, requireBranchApprover, (req, res, next) => {
    const proposal = get('SELECT * FROM branch_proposals WHERE id = ?', [req.params.id]);
    if (!proposal) return next({ status: 404, message: 'Proposal not found' });
    if (proposal.status !== 'Proposed') return next({ status: 409, message: `Proposal is already ${proposal.status}` });
    run('UPDATE branch_proposals SET status = ?, decided_by = ?, decided_at = datetime(\'now\'), decision_reason = ? WHERE id = ?',
      ['Rejected', req.user.id, req.body.reason || null, proposal.id]);
    logAction(req, { action: 'Rejected branch proposal', module: 'branches', recordType: 'BranchProposal', recordId: proposal.id, reason: req.body.reason });
    res.json({ proposal: get('SELECT * FROM branch_proposals WHERE id = ?', [proposal.id]) });
  });

  // Branch closure request — the other half of real branch lifecycle
  // management the Operational Manager's menu names ("Branch Closure
  // Requests"). Reuses `status` on the branches row itself rather than a
  // parallel table, since closure has no multi-field proposal content.
  router.post('/api/branches/:id/close', requireAuth, requirePermission('manage_branches'), (req, res, next) => {
    const branch = get('SELECT * FROM branches WHERE id = ?', [req.params.id]);
    if (!branch) return next({ status: 404, message: 'Branch not found' });
    const activeLoans = get(`SELECT COUNT(*) as n FROM loans WHERE branch_id = ? AND status IN ('Active','Disbursed')`, [branch.id]).n;
    if (activeLoans > 0) return next({ status: 409, message: `Cannot close a branch with ${activeLoans} active loan(s) still outstanding` });
    run('UPDATE branches SET status = ? WHERE id = ?', ['Closed', branch.id]);
    logAction(req, { action: 'Closed branch', module: 'branches', recordType: 'Branch', recordId: branch.id, reason: req.body.reason });
    res.json({ branch: get('SELECT * FROM branches WHERE id = ?', [branch.id]) });
  });

  // Branch performance — real numbers from real tables, not invented.
  router.get('/api/branches/:id/performance', requireAuth, requireModule('reports'), (req, res, next) => {
    const scope = branchIdsInScope(req.user);
    if (scope !== null && !scope.includes(req.params.id)) return next({ status: 403, message: 'You do not have access to this branch\'s performance data' });
    const branchId = req.params.id;
    const clients = get('SELECT COUNT(*) as n FROM clients WHERE branch_id = ?', [branchId]).n;
    const activeLoans = all(`SELECT * FROM loans WHERE branch_id = ? AND status IN ('Active','Disbursed')`, [branchId]);
    const portfolio = activeLoans.reduce((s, l) => {
      const sched = all('SELECT * FROM loan_schedule WHERE loan_id = ?', [l.id]);
      const bal = sched.reduce((ss, r) => ss + Math.max(0, r.total_due - r.paid_amount), 0);
      return s + bal;
    }, 0);
    const disbursedMTD = get(
      `SELECT COALESCE(SUM(principal),0) as total FROM loans WHERE branch_id = ? AND disbursed_at IS NOT NULL AND strftime('%Y-%m', disbursed_at) = strftime('%Y-%m','now')`,
      [branchId]
    ).total;
    res.json({ branchId, clients, activeLoanCount: activeLoans.length, outstandingPortfolio: portfolio, disbursedMTD });
  });
}

module.exports = { register };
