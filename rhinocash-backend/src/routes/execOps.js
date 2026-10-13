// execOps.js — the Director's (and CEO's) own working records: strategy,
// decisions, meetings, governance, risk, capital and requests that need an
// executive decision. Analytics pages read the live loan/payment/accounting
// data elsewhere; this file only stores what executives themselves record.
//
// Who can do what:
//   - view:   Director, CEO, System Administrator
//   - record: Director, CEO
//   - decide a request (financial / company / special approval): Director
//     or CEO — never the person who raised it.
//   - the Accountant sees, raises and pays financial requests only (they
//     reach the Director and CEO for a decision like any other request);
//     the Operational Manager sees and raises them but does not pay them.
'use strict';
const crypto = require('node:crypto');
const { all, get, run } = require('./../db');
const { requireAuth } = require('./../middleware');
const { logAction } = require('./../audit');

const KINDS = {
  action_plan:      { statuses: ['Planned', 'In Progress', 'Completed', 'Cancelled'], open: ['Planned', 'In Progress'] },
  company_request:  { statuses: ['Pending', 'Approved', 'Rejected', 'Fulfilled'], open: ['Pending', 'Approved'], decision: true },
  financial_request:{ statuses: ['Pending', 'Approved', 'Rejected', 'Paid'], open: ['Pending', 'Approved'], decision: true, amount: true },
  special_approval: { statuses: ['Pending', 'Approved', 'Rejected'], open: ['Pending'], decision: true },
  op_task:          { statuses: ['Open', 'In Progress', 'Done', 'Cancelled'], open: ['Open', 'In Progress'] },
  compliance_check: { statuses: ['Scheduled', 'Passed', 'Failed', 'Waived'], open: ['Scheduled'] },
  strategic_plan:   { statuses: ['Draft', 'Active', 'Achieved', 'Abandoned'], open: ['Draft', 'Active'] },
  decision:         { statuses: ['Proposed', 'Approved', 'Rejected', 'Implemented'], open: ['Proposed', 'Approved'] },
  meeting:          { statuses: ['Scheduled', 'Held', 'Cancelled'], open: ['Scheduled'] },
  action_item:      { statuses: ['Open', 'In Progress', 'Done', 'Cancelled'], open: ['Open', 'In Progress'] },
  risk:             { statuses: ['Open', 'Mitigating', 'Accepted', 'Closed'], open: ['Open', 'Mitigating'] },
  regulatory:       { statuses: ['Open', 'In Progress', 'Complied', 'Closed'], open: ['Open', 'In Progress'] },
  board_matter:     { statuses: ['Open', 'Tabled', 'Resolved', 'Deferred'], open: ['Open', 'Tabled', 'Deferred'] },
  policy:           { statuses: ['Draft', 'Active', 'Retired'], open: ['Draft', 'Active'] },
  governance_record:{ statuses: ['Current', 'Archived'], open: ['Current'] },
  investment:       { statuses: ['Proposed', 'Approved', 'Active', 'Exited', 'Rejected'], open: ['Proposed', 'Approved', 'Active'], amount: true },
  capital_plan:     { statuses: ['Draft', 'Approved', 'Executed', 'Cancelled'], open: ['Draft', 'Approved'], amount: true },
  expansion_plan:   { statuses: ['Proposed', 'Approved', 'In Progress', 'Completed', 'Dropped'], open: ['Proposed', 'Approved', 'In Progress'], amount: true },
  partnership:      { statuses: ['Prospect', 'Negotiating', 'Active', 'Ended'], open: ['Prospect', 'Negotiating', 'Active'] },
  strategy_goal:    { statuses: ['On Track', 'At Risk', 'Off Track', 'Achieved'], open: ['On Track', 'At Risk', 'Off Track'] },
  review:           { statuses: ['Scheduled', 'Completed', 'Cancelled'], open: ['Scheduled'] },
  oversight:        { statuses: ['Open', 'Closed'], open: ['Open'] },
  director_action:  { statuses: ['Open', 'Done', 'Cancelled'], open: ['Open'] },
  funding:          { statuses: ['Open', 'Partly Funded', 'Funded', 'Cancelled'], open: ['Open', 'Partly Funded'], amount: true },
  allocation:       { statuses: ['Planned', 'Allocated', 'Spent', 'Cancelled'], open: ['Planned', 'Allocated'], amount: true },
  budget:           { statuses: ['Active', 'Closed'], open: ['Active'], amount: true },
  scheduled_report: { statuses: ['Active', 'Paused'], open: ['Active'] },
};
const PRIORITIES = ['Low', 'Normal', 'High', 'Critical'];
const VIEW = ['director', 'ceo', 'admin'];
const WRITE = ['director', 'ceo'];
const DECIDE = ['director', 'ceo'];
const MAX_DATA = 20000;

const clean = (v, max) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; };
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const parseJson = t => { try { return JSON.parse(t); } catch { return null; } };

const ACCOUNTANT_KINDS = ['financial_request'];
const isAccountant = req => req.user.role_id === 'accountant';
// The Operational Manager raises financial requests too, but never pays them.
const isRequester = req => isAccountant(req) || req.user.role_id === 'operational_manager';
function requireView(req, res, next) { return VIEW.includes(req.user.role_id) || isRequester(req) ? next() : next({ status: 403, message: 'Executive records are for the Director, CEO and System Administrator' }); }
function requireWrite(req, res, next) { return WRITE.includes(req.user.role_id) || isRequester(req) ? next() : next({ status: 403, message: 'Only the Director or CEO can change executive records' }); }

function recOut(r) {
  return { id: r.id, kind: r.kind, title: r.title, details: r.details, category: r.category, priority: r.priority, status: r.status,
    branchId: r.branch_id, ownerId: r.owner_id, ownerName: r.owner_name || null, dueDate: r.due_date, startDate: r.start_date,
    amount: r.amount != null ? Number(r.amount) : null, score: r.score != null ? Number(r.score) : null, relatedId: r.related_id,
    data: parseJson(r.data_json) || {}, outcome: r.outcome,
    createdBy: r.created_by, createdByName: r.created_name || null, createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at,
    decidedBy: r.decided_by, decidedByName: r.decided_name || null, decidedAt: r.decided_at,
    isOpen: KINDS[r.kind] ? KINDS[r.kind].open.includes(r.status) : false };
}
const SELECT = `SELECT r.*, o.name AS owner_name, c.name AS created_name, d.name AS decided_name FROM exec_records r
  LEFT JOIN users o ON o.id = r.owner_id LEFT JOIN users c ON c.id = r.created_by LEFT JOIN users d ON d.id = r.decided_by`;

function register(router) {
  router.get('/api/exec/records', requireAuth, requireView, async (req, res, next) => {
    const clauses = ['1=1']; const params = [];
    if (isRequester(req) && (!req.query.kind || String(req.query.kind).split(',').some(k => !ACCOUNTANT_KINDS.includes(k)))) return next({ status: 403, message: 'You can see financial requests only' });
    if (req.query.kind) {
      const kinds = String(req.query.kind).split(',');
      if (kinds.some(k => !KINDS[k])) return next({ status: 400, message: 'Unknown record type' });
      clauses.push(`r.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds);
    }
    if (req.query.status) { clauses.push('r.status = ?'); params.push(req.query.status); }
    const rows = await all(`${SELECT} WHERE ${clauses.join(' AND ')} ORDER BY r.created_at DESC LIMIT 2000`, params);
    res.json({ records: rows.map(recOut) });
  });

  router.post('/api/exec/records', requireAuth, requireWrite, async (req, res, next) => {
    const b = req.body || {};
    const def = KINDS[b.kind];
    if (!def) return next({ status: 400, message: 'Unknown record type' });
    if (isRequester(req) && !ACCOUNTANT_KINDS.includes(b.kind)) return next({ status: 403, message: 'You can raise financial requests only' });
    const title = clean(b.title, 200);
    if (!title) return next({ status: 400, message: 'A title is required' });
    for (const f of ['due_date', 'start_date']) if (b[f] && !isDate(b[f])) return next({ status: 400, message: `${f.replace('_', ' ')} must be YYYY-MM-DD` });
    const priority = b.priority ? String(b.priority) : 'Normal';
    if (!PRIORITIES.includes(priority)) return next({ status: 400, message: `Priority must be one of: ${PRIORITIES.join(', ')}` });
    if (b.branch_id && !(await get('SELECT id FROM branches WHERE id = ?', [b.branch_id]))) return next({ status: 400, message: 'Unknown branch' });
    if (b.owner_id && !(await get('SELECT id FROM users WHERE id = ?', [b.owner_id]))) return next({ status: 400, message: 'Unknown staff member' });
    const amount = b.amount === undefined || b.amount === null || b.amount === '' ? null : Number(b.amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) return next({ status: 400, message: 'Amount must be zero or more' });
    if (def.amount && ['financial_request', 'funding', 'budget'].includes(b.kind) && !(amount > 0)) return next({ status: 400, message: 'Enter the amount' });
    const score = b.score === undefined || b.score === null || b.score === '' ? null : Number(b.score);
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) return next({ status: 400, message: 'Score must be between 0 and 100' });
    const data = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {};
    if (b.kind === 'risk') {
      for (const f of ['likelihood', 'impact']) { const v = Number(data[f]); if (!(v >= 1 && v <= 5)) return next({ status: 400, message: 'Likelihood and impact are rated 1 to 5' }); data[f] = v; }
    }
    const dataJson = JSON.stringify(data);
    if (Buffer.byteLength(dataJson) > MAX_DATA) return next({ status: 400, message: 'Record details are too large' });
    const status = b.status && def.statuses.includes(b.status) && !def.decision ? b.status : def.statuses[0];
    const id = 'exr_' + crypto.randomUUID();
    await run(`INSERT INTO exec_records (id, kind, title, details, category, priority, status, branch_id, owner_id, due_date, start_date, amount, score, related_id, data_json, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, b.kind, title, clean(b.details, 4000), clean(b.category, 80), priority, status, clean(b.branch_id, 60), clean(b.owner_id, 60),
      b.due_date || null, b.start_date || null, amount, score, clean(b.related_id, 60), dataJson, req.user.id]);
    await logAction(req, { action: `Recorded ${b.kind.replace(/_/g, ' ')}`, module: 'executive', recordType: 'ExecRecord:' + b.kind, recordId: id, newValue: { title, status, amount } });
    res.status(201).json({ record: recOut(await get(`${SELECT} WHERE r.id = ?`, [id])) });
  });

  router.patch('/api/exec/records/:id', requireAuth, requireWrite, async (req, res, next) => {
    const row = await get('SELECT * FROM exec_records WHERE id = ?', [req.params.id]);
    if (!row) return next({ status: 404, message: 'Record not found' });
    const def = KINDS[row.kind]; const b = req.body || {};
    if (req.user.role_id === 'operational_manager') return next({ status: 403, message: 'The Accountant pays approved requests; the CEO or Director decides them' });
    if (isAccountant(req)) {
      if (!ACCOUNTANT_KINDS.includes(row.kind)) return next({ status: 403, message: 'The Accountant can change financial requests only' });
      if (Object.keys(b).some(k => !['status', 'outcome'].includes(k)) || (b.status !== undefined && b.status !== 'Paid')) return next({ status: 403, message: 'The Accountant can only mark an approved request as paid' });
    }
    const sets = []; const params = [];
    if (b.status !== undefined) {
      if (!def.statuses.includes(b.status)) return next({ status: 400, message: `Status must be one of: ${def.statuses.join(', ')}` });
      const deciding = def.decision && ['Approved', 'Rejected'].includes(b.status);
      if (deciding) {
        if (!DECIDE.includes(req.user.role_id)) return next({ status: 403, message: 'Only the Director or CEO decides this request' });
        if (row.created_by === req.user.id) return next({ status: 403, message: 'You cannot decide a request you raised' });
        if (row.status !== 'Pending') return next({ status: 400, message: `This request is already ${row.status.toLowerCase()}` });
        sets.push('decided_by = ?', 'decided_at = iso_now()'); params.push(req.user.id);
      }
      if (def.decision && ['Fulfilled', 'Paid'].includes(b.status) && row.status !== 'Approved') return next({ status: 400, message: 'Approve the request first' });
      sets.push('status = ?'); params.push(b.status);
      sets.push(def.open.includes(b.status) ? 'closed_at = NULL' : 'closed_at = COALESCE(closed_at, iso_now())');
    }
    if (b.outcome !== undefined) { sets.push('outcome = ?'); params.push(clean(b.outcome, 2000)); }
    if (b.title !== undefined) { const t = clean(b.title, 200); if (!t) return next({ status: 400, message: 'A title is required' }); sets.push('title = ?'); params.push(t); }
    if (b.details !== undefined) { sets.push('details = ?'); params.push(clean(b.details, 4000)); }
    if (b.score !== undefined) { const sc = b.score === '' || b.score === null ? null : Number(b.score); if (sc !== null && (!Number.isFinite(sc) || sc < 0 || sc > 100)) return next({ status: 400, message: 'Score must be between 0 and 100' }); sets.push('score = ?'); params.push(sc); }
    if (b.amount !== undefined) { const a = b.amount === '' || b.amount === null ? null : Number(b.amount); if (a !== null && (!Number.isFinite(a) || a < 0)) return next({ status: 400, message: 'Amount must be zero or more' }); sets.push('amount = ?'); params.push(a); }
    if (b.data !== undefined) {
      if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) return next({ status: 400, message: 'data must be an object' });
      const dj = JSON.stringify(Object.assign({}, parseJson(row.data_json) || {}, b.data));
      if (Buffer.byteLength(dj) > MAX_DATA) return next({ status: 400, message: 'Record details are too large' });
      sets.push('data_json = ?'); params.push(dj);
    }
    if (!sets.length) return next({ status: 400, message: 'Nothing to update' });
    await run(`UPDATE exec_records SET ${sets.join(', ')}, updated_at = iso_now() WHERE id = ?`, [...params, row.id]);
    await logAction(req, { action: `Updated ${row.kind.replace(/_/g, ' ')}${b.status ? ' → ' + b.status : ''}`, module: 'executive', recordType: 'ExecRecord:' + row.kind, recordId: row.id,
      previousValue: { status: row.status }, newValue: b });
    res.json({ record: recOut(await get(`${SELECT} WHERE r.id = ?`, [row.id])) });
  });
}

module.exports = { register, KINDS };
