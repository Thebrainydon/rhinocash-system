'use strict';
// regionalOps.js — Regional Operations: the working records a Regional
// Manager runs their region with (action plans, branch requests, staff /
// client transfers, operational issues, escalations), plus the region's
// own activity log.
//
// Scope is the region, enforced server-side on every call:
//   regional_manager      — only branches in their own region; full control
//   operational_manager,
//   ceo, director, admin  — every region (oversight); may act on any record
//   manager               — only their own branch; may raise requests,
//                           issues and transfer requests, never decide them
// Every change is audit-logged.
const crypto = require('node:crypto');
const { all, get, run, transaction } = require('./../db');
const { requireAuth } = require('./../middleware');
const { logAction } = require('./../audit');

const KINDS = {
  action_plan:    { label: 'Action plan',     statuses: ['Planned', 'In Progress', 'Completed', 'Cancelled'], open: ['Planned', 'In Progress'] },
  branch_request: { label: 'Branch request',  statuses: ['Pending', 'Approved', 'Rejected', 'Fulfilled'], open: ['Pending', 'Approved'] },
  transfer:       { label: 'Transfer',        statuses: ['Requested', 'Approved', 'Rejected', 'Completed'], open: ['Requested', 'Approved'] },
  issue:          { label: 'Operational issue', statuses: ['Open', 'In Progress', 'Resolved', 'Closed'], open: ['Open', 'In Progress'] },
  escalation:     { label: 'Escalation',      statuses: ['Open', 'Acknowledged', 'Resolved'], open: ['Open', 'Acknowledged'] },
};
const PRIORITIES = ['Low', 'Normal', 'High', 'Critical'];
const OVERSIGHT = ['operational_manager', 'ceo', 'director', 'admin'];
const ALLOWED = ['regional_manager', 'manager', ...OVERSIGHT];
// Kinds a branch Manager may raise themselves.
const MANAGER_KINDS = ['branch_request', 'issue', 'transfer'];

function clean(v, max) { if (v === undefined || v === null) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; }

async function scopeOf(user) {
  if (OVERSIGHT.includes(user.role_id)) return { all: true, branchIds: null };
  if (user.role_id === 'regional_manager') {
    const rows = await all('SELECT id FROM branches WHERE region_id = ?', [user.region_id]);
    return { all: false, branchIds: rows.map(r => r.id), regionId: user.region_id };
  }
  if (user.role_id === 'manager') return { all: false, branchIds: user.branch_id ? [user.branch_id] : [] };
  return null;
}
function requireOpsRole(req, res, next) {
  if (!ALLOWED.includes(req.user.role_id)) return next({ status: 403, message: 'Regional Operations is not available to your role' });
  next();
}
// A record is visible when its branch is in scope — or, for region-wide
// records with no branch, when it belongs to the viewer's region.
function inScope(scope, row) {
  if (scope.all) return true;
  if (row.branch_id) return scope.branchIds.includes(row.branch_id);
  return !!scope.regionId && row.region_id === scope.regionId;
}
function out(r) {
  return {
    id: r.id, kind: r.kind, regionId: r.region_id, branchId: r.branch_id, title: r.title, details: r.details,
    category: r.category, priority: r.priority, status: r.status, assignedTo: r.assigned_to, assignedToName: r.assigned_name || null,
    dueDate: r.due_date, resolution: r.resolution, subjectType: r.subject_type, subjectId: r.subject_id, subjectName: r.subject_name || null,
    fromBranchId: r.from_branch_id, toBranchId: r.to_branch_id, toOfficerId: r.to_officer_id, relatedId: r.related_id,
    createdBy: r.created_by, createdByName: r.created_name || null, createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at,
    isOpen: KINDS[r.kind] ? KINDS[r.kind].open.includes(r.status) : false,
  };
}
const SELECT = `SELECT o.*, a.name AS assigned_name, c.name AS created_name,
  COALESCE(su.name, sc.name) AS subject_name
  FROM regional_operations o
  LEFT JOIN users a ON a.id = o.assigned_to
  LEFT JOIN users c ON c.id = o.created_by
  LEFT JOIN users su ON o.subject_type = 'staff' AND su.id = o.subject_id
  LEFT JOIN clients sc ON o.subject_type = 'client' AND sc.id = o.subject_id`;

function register(router) {
  router.get('/api/regional-ops', requireAuth, requireOpsRole, async (req, res, next) => {
    const scope = await scopeOf(req.user);
    const clauses = ['1=1']; const params = [];
    if (req.query.kind) { if (!KINDS[req.query.kind]) return next({ status: 400, message: 'Unknown record type' }); clauses.push('o.kind = ?'); params.push(req.query.kind); }
    if (req.query.status) { clauses.push('o.status = ?'); params.push(req.query.status); }
    if (req.query.branch_id) { clauses.push('o.branch_id = ?'); params.push(req.query.branch_id); }
    if (!scope.all) {
      const ph = scope.branchIds.map(() => '?').join(',');
      const branchClause = scope.branchIds.length ? `o.branch_id IN (${ph})` : '1=0';
      if (scope.regionId) { clauses.push(`(${branchClause} OR (o.branch_id IS NULL AND o.region_id = ?))`); params.push(...scope.branchIds, scope.regionId); }
      else { clauses.push(branchClause); params.push(...scope.branchIds); }
    }
    const rows = await all(`${SELECT} WHERE ${clauses.join(' AND ')} ORDER BY o.created_at DESC LIMIT 500`, params);
    res.json({ records: rows.map(out), kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { label: v.label, statuses: v.statuses, open: v.open }])) });
  });

  router.post('/api/regional-ops', requireAuth, requireOpsRole, async (req, res, next) => {
    const b = req.body || {};
    const kind = b.kind;
    if (!KINDS[kind]) return next({ status: 400, message: 'Unknown record type' });
    if (req.user.role_id === 'manager' && !MANAGER_KINDS.includes(kind)) return next({ status: 403, message: `A branch manager cannot create a ${KINDS[kind].label.toLowerCase()}` });
    const title = clean(b.title, 160);
    if (!title) return next({ status: 400, message: 'A title is required' });
    const priority = b.priority || 'Normal';
    if (!PRIORITIES.includes(priority)) return next({ status: 400, message: 'Priority must be Low, Normal, High or Critical' });
    const scope = await scopeOf(req.user);
    let branchId = clean(b.branch_id, 60);
    if (req.user.role_id === 'manager') branchId = req.user.branch_id;
    let regionId = scope.regionId || null;
    if (branchId) {
      const br = await get('SELECT id, region_id FROM branches WHERE id = ?', [branchId]);
      if (!br) return next({ status: 400, message: 'Unknown branch' });
      if (!scope.all && !scope.branchIds.includes(branchId)) return next({ status: 403, message: 'That branch is outside your region' });
      regionId = br.region_id;
    } else if (!regionId) {
      if (!scope.all) return next({ status: 400, message: 'Choose a branch' });
      regionId = clean(b.region_id, 60);
    }
    const assignedTo = clean(b.assigned_to, 60);
    if (assignedTo && !(await get('SELECT id FROM users WHERE id = ?', [assignedTo]))) return next({ status: 400, message: 'Unknown assignee' });
    const dueDate = clean(b.due_date, 10);
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return next({ status: 400, message: 'Due date must be YYYY-MM-DD' });

    let subjectType = null, subjectId = null, fromBranch = null, toBranch = null, toOfficer = null;
    if (kind === 'transfer') {
      subjectType = b.subject_type;
      if (!['staff', 'client'].includes(subjectType)) return next({ status: 400, message: 'Transfer must be for a staff member or a client' });
      subjectId = clean(b.subject_id, 60);
      const subject = subjectType === 'staff'
        ? await get('SELECT id, branch_id FROM users WHERE id = ?', [subjectId])
        : await get('SELECT id, branch_id FROM clients WHERE id = ?', [subjectId]);
      if (!subject) return next({ status: 400, message: `Unknown ${subjectType}` });
      fromBranch = subject.branch_id;
      toBranch = clean(b.to_branch_id, 60);
      if (!toBranch || toBranch === fromBranch) return next({ status: 400, message: 'Choose a different destination branch' });
      if (!(await get('SELECT id FROM branches WHERE id = ?', [toBranch]))) return next({ status: 400, message: 'Unknown destination branch' });
      if (!scope.all && (!scope.branchIds.includes(fromBranch) || (req.user.role_id !== 'manager' && !scope.branchIds.includes(toBranch)))) {
        return next({ status: 403, message: 'Transfers must start in your scope' + (req.user.role_id === 'regional_manager' ? ' and stay within your region' : '') });
      }
      if (subjectType === 'client') {
        toOfficer = clean(b.to_officer_id, 60);
        const off = toOfficer && await get("SELECT id FROM users WHERE id = ? AND branch_id = ? AND role_id = 'loan_officer'", [toOfficer, toBranch]);
        if (!off) return next({ status: 400, message: 'Choose a loan officer at the destination branch' });
      }
      branchId = fromBranch;
      const fb = await get('SELECT region_id FROM branches WHERE id = ?', [fromBranch]);
      regionId = fb ? fb.region_id : regionId;
    }
    const id = 'rop_' + crypto.randomUUID();
    const status = KINDS[kind].statuses[0];
    await run(`INSERT INTO regional_operations (id, kind, region_id, branch_id, title, details, category, priority, status, assigned_to, due_date,
               subject_type, subject_id, from_branch_id, to_branch_id, to_officer_id, related_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, kind, regionId, branchId, title, clean(b.details, 2000), clean(b.category, 60), priority, status, assignedTo, dueDate,
        subjectType, subjectId, fromBranch, toBranch, toOfficer, clean(b.related_id, 60), req.user.id]);
    const row = await get(`${SELECT} WHERE o.id = ?`, [id]);
    await logAction(req, { action: `Created ${KINDS[kind].label.toLowerCase()}`, module: 'regional_ops', recordType: 'RegionalOp', recordId: id, newValue: { kind, title, branchId, priority } });
    res.status(201).json({ record: out(row) });
  });

  router.patch('/api/regional-ops/:id', requireAuth, requireOpsRole, async (req, res, next) => {
    const row = await get('SELECT * FROM regional_operations WHERE id = ?', [req.params.id]);
    if (!row) return next({ status: 404, message: 'Record not found' });
    const scope = await scopeOf(req.user);
    if (!inScope(scope, row)) return next({ status: 404, message: 'Record not found' });
    const b = req.body || {};
    const kind = KINDS[row.kind];
    const isManager = req.user.role_id === 'manager';
    if (isManager && b.status !== undefined) return next({ status: 403, message: 'Only the Regional Manager (or above) can decide or close this' });
    if (isManager && row.created_by !== req.user.id) return next({ status: 403, message: 'You can only edit records you raised' });
    const sets = []; const params = [];
    if (b.status !== undefined) {
      if (!kind.statuses.includes(b.status)) return next({ status: 400, message: `Status must be one of: ${kind.statuses.join(', ')}` });
      if (row.kind === 'transfer' && b.status === 'Completed' && row.status !== 'Approved') return next({ status: 400, message: 'Approve the transfer before completing it' });
      if (!kind.open.includes(row.status) && b.status !== row.status) return next({ status: 400, message: `This ${kind.label.toLowerCase()} is already ${row.status.toLowerCase()}` });
      sets.push('status = ?'); params.push(b.status);
      if (!kind.open.includes(b.status)) sets.push('closed_at = iso_now()');
    }
    if (b.priority !== undefined) { if (!PRIORITIES.includes(b.priority)) return next({ status: 400, message: 'Invalid priority' }); sets.push('priority = ?'); params.push(b.priority); }
    if (b.resolution !== undefined) { sets.push('resolution = ?'); params.push(clean(b.resolution, 2000)); }
    if (b.details !== undefined) { sets.push('details = ?'); params.push(clean(b.details, 2000)); }
    if (b.due_date !== undefined) { const d = clean(b.due_date, 10); if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return next({ status: 400, message: 'Due date must be YYYY-MM-DD' }); sets.push('due_date = ?'); params.push(d); }
    if (b.assigned_to !== undefined) { const a = clean(b.assigned_to, 60); if (a && !(await get('SELECT id FROM users WHERE id = ?', [a]))) return next({ status: 400, message: 'Unknown assignee' }); sets.push('assigned_to = ?'); params.push(a); }
    if (!sets.length) return next({ status: 400, message: 'Nothing to update' });

    const completingTransfer = row.kind === 'transfer' && b.status === 'Completed';
    try {
      await transaction(async () => {
        if (completingTransfer) {
          // A completed transfer really moves the person: the staff member's
          // branch, or the client's branch and loan officer.
          if (row.subject_type === 'staff') {
            // Clients stay with their branch, so an officer still holding a
            // portfolio (dormant clients included) cannot leave it behind.
            const held = await get(`SELECT COUNT(*) AS n FROM clients WHERE officer_id = ?`, [row.subject_id]);
            if (Number(held.n) > 0) throw { status: 400, message: `Reassign or transfer this officer's ${held.n} client(s) first` };
            await run('UPDATE users SET branch_id = ? WHERE id = ?', [row.to_branch_id, row.subject_id]);
          } else {
            await run('UPDATE clients SET branch_id = ?, officer_id = ? WHERE id = ?', [row.to_branch_id, row.to_officer_id, row.subject_id]);
            await run(`UPDATE loans SET branch_id = ?, officer_id = ? WHERE client_id = ? AND status IN ('Pending','Approved','Active','Disbursed')`, [row.to_branch_id, row.to_officer_id, row.subject_id]);
          }
        }
        await run(`UPDATE regional_operations SET ${sets.join(', ')}, updated_by = ?, updated_at = iso_now() WHERE id = ?`, [...params, req.user.id, row.id]);
      });
    } catch (e) {
      if (e && e.status) return next(e);
      throw e;
    }
    const after = await get(`${SELECT} WHERE o.id = ?`, [row.id]);
    await logAction(req, { action: completingTransfer ? `Completed ${row.subject_type} transfer` : `Updated ${kind.label.toLowerCase()}`, module: 'regional_ops', recordType: 'RegionalOp', recordId: row.id,
      previousValue: { status: row.status, priority: row.priority, assignedTo: row.assigned_to }, newValue: b, reason: b.resolution });
    res.json({ record: out(after) });
  });

  // Escalate any open record upward: creates a linked escalation that the
  // Operational Manager (company-wide oversight) sees.
  router.post('/api/regional-ops/:id/escalate', requireAuth, requireOpsRole, async (req, res, next) => {
    const row = await get('SELECT * FROM regional_operations WHERE id = ?', [req.params.id]);
    if (!row) return next({ status: 404, message: 'Record not found' });
    const scope = await scopeOf(req.user);
    if (!inScope(scope, row)) return next({ status: 404, message: 'Record not found' });
    if (row.kind === 'escalation') return next({ status: 400, message: 'This is already an escalation' });
    const reason = clean(req.body && req.body.reason, 2000);
    if (!reason) return next({ status: 400, message: 'Say why this is being escalated' });
    const id = 'rop_' + crypto.randomUUID();
    await run(`INSERT INTO regional_operations (id, kind, region_id, branch_id, title, details, priority, status, related_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, 'escalation', row.region_id, row.branch_id, 'Escalated: ' + row.title, reason, row.priority === 'Critical' ? 'Critical' : 'High', 'Open', row.id, req.user.id]);
    await logAction(req, { action: 'Escalated regional record', module: 'regional_ops', recordType: 'RegionalOp', recordId: row.id, newValue: { escalationId: id }, reason });
    res.status(201).json({ record: out(await get(`${SELECT} WHERE o.id = ?`, [id])) });
  });

  // The region's activity: audit entries made by staff working in the
  // region's branches (or assigned to the region itself).
  router.get('/api/regional-ops/activity', requireAuth, requireOpsRole, async (req, res, next) => {
    const scope = await scopeOf(req.user);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    let rows;
    if (scope.all) {
      rows = await all(`SELECT a.*, u.branch_id FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT ${limit}`);
    } else {
      if (!scope.branchIds.length && !scope.regionId) return res.json({ activity: [] });
      const ph = scope.branchIds.map(() => '?').join(',') || "''";
      const regionClause = scope.regionId ? ' OR u.region_id = ?' : '';
      rows = await all(`SELECT a.*, u.branch_id FROM audit_logs a JOIN users u ON u.id = a.user_id
        WHERE (u.branch_id IN (${ph})${regionClause}) ORDER BY a.created_at DESC LIMIT ${limit}`, [...scope.branchIds, ...(scope.regionId ? [scope.regionId] : [])]);
    }
    res.json({ activity: rows.map(a => ({ id: a.id, at: a.created_at, user: a.user_name, roleId: a.role_id, branchId: a.branch_id, action: a.action, module: a.module, recordType: a.record_type, recordId: a.record_id, reason: a.reason })) });
  });
}

module.exports = { register, KINDS };
