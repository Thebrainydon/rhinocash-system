'use strict';
// hrOps.js — Human Resources: the records HR runs the people side of the
// company with. Everything is audit-logged.
//
//   hr_records        recruitment, performance, benefits, training,
//                     employee relations, compliance, documents, policies,
//                     transfers and access requests — one table, typed by
//                     `kind`, each kind with its own status lifecycle
//   hr_attendance     one row per employee per day
//   payroll_runs /    a month's payroll, computed with the same payslip
//   payroll_lines     engine employees see under My Account › Payroll
//
// HR and Admin write; CEO and Director read (governance). Access requests
// are raised by HR and decided only by the System Administrator, and an
// approved activation/suspension request is applied to the account.
const crypto = require('node:crypto');
const { all, get, run, transaction } = require('./../db');
const { requireAuth } = require('./../middleware');
const { logAction } = require('./../audit');
const { canActOnStaffRecord } = require('./../rbac');
const { computePayslip } = require('./staffProfile');

const KINDS = {
  vacancy:            { statuses: ['Open', 'On Hold', 'Filled', 'Closed'], open: ['Open', 'On Hold'] },
  application:        { statuses: ['Received', 'Shortlisted', 'Interview', 'Offered', 'Hired', 'Rejected', 'Withdrawn'], open: ['Received', 'Shortlisted', 'Interview', 'Offered'] },
  interview:          { statuses: ['Scheduled', 'Completed', 'Cancelled', 'No-show'], open: ['Scheduled'] },
  review:             { statuses: ['Draft', 'Submitted', 'Acknowledged', 'Closed'], open: ['Draft', 'Submitted'], employee: true },
  appraisal:          { statuses: ['Draft', 'Submitted', 'Acknowledged', 'Closed'], open: ['Draft', 'Submitted'], employee: true },
  perf_plan:          { statuses: ['Active', 'Completed', 'Cancelled'], open: ['Active'], employee: true },
  pip:                { statuses: ['Active', 'Extended', 'Successful', 'Unsuccessful', 'Cancelled'], open: ['Active', 'Extended'], employee: true },
  benefit:            { statuses: ['Active', 'Suspended', 'Ended'], open: ['Active', 'Suspended'], employee: true },
  welfare:            { statuses: ['Requested', 'Approved', 'Paid', 'Rejected'], open: ['Requested', 'Approved'], employee: true },
  training_program:   { statuses: ['Planned', 'Ongoing', 'Completed', 'Cancelled'], open: ['Planned', 'Ongoing'] },
  training_request:   { statuses: ['Pending', 'Approved', 'Rejected', 'Completed'], open: ['Pending', 'Approved'], employee: true },
  training_enrolment: { statuses: ['Enrolled', 'Completed', 'Failed', 'Withdrawn'], open: ['Enrolled'], employee: true },
  skill:              { statuses: ['Active', 'Archived'], open: ['Active'], employee: true },
  case_request:       { statuses: ['Open', 'In Progress', 'Resolved', 'Closed', 'Withdrawn'], open: ['Open', 'In Progress'], employee: true },
  case_complaint:     { statuses: ['Open', 'Under Investigation', 'Resolved', 'Closed', 'Withdrawn'], open: ['Open', 'Under Investigation'], employee: true },
  case_grievance:     { statuses: ['Open', 'Under Investigation', 'Hearing', 'Resolved', 'Closed', 'Withdrawn'], open: ['Open', 'Under Investigation', 'Hearing'], employee: true },
  case_disciplinary:  { statuses: ['Open', 'Under Investigation', 'Hearing', 'Resolved', 'Closed'], open: ['Open', 'Under Investigation', 'Hearing'], employee: true },
  employee_document:  { statuses: ['Valid', 'Expired', 'Missing'], open: ['Valid'], employee: true },
  compliance_item:    { statuses: ['Pending', 'Done', 'Missed'], open: ['Pending'] },
  policy:             { statuses: ['Draft', 'Active', 'Retired'], open: ['Draft', 'Active'] },
  policy_ack:         { statuses: ['Acknowledged'], open: [], employee: true },
  hr_document:        { statuses: ['Current', 'Archived'], open: ['Current'] },
  transfer:           { statuses: ['Requested', 'Approved', 'Rejected', 'Completed'], open: ['Requested', 'Approved'], employee: true },
  access_request:     { statuses: ['Pending', 'Approved', 'Rejected'], open: ['Pending'], employee: true },
};
const ACCESS_ACTIONS = ['Activate account', 'Suspend account', 'Deactivate account', 'Change role', 'Grant extra access', 'Reset password'];
const ATTENDANCE_STATUSES = ['Present', 'Late', 'Absent', 'On Leave', 'Half Day', 'Remote'];
const HR_WRITE = ['hr', 'admin'];
const HR_VIEW = ['hr', 'admin', 'ceo', 'director'];
const MAX_DATA = 20000;

function requireHrView(req, res, next) { return HR_VIEW.includes(req.user.role_id) ? next() : next({ status: 403, message: 'Your role does not have HR access' }); }
function requireHrWrite(req, res, next) { return HR_WRITE.includes(req.user.role_id) ? next() : next({ status: 403, message: 'Only HR or the System Administrator can change HR records' }); }
const clean = (v, max) => { if (v === undefined || v === null) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; };
const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const parseJson = t => { try { return JSON.parse(t); } catch { return null; } };
const nowIso = () => new Date().toISOString();

function recOut(r) {
  return { id: r.id, kind: r.kind, employeeId: r.employee_id, employeeName: r.employee_name || null, title: r.title, status: r.status,
    category: r.category, startDate: r.start_date, endDate: r.end_date, amount: r.amount != null ? Number(r.amount) : null,
    score: r.score != null ? Number(r.score) : null, relatedId: r.related_id, data: parseJson(r.data_json) || {},
    createdBy: r.created_by, createdByName: r.created_name || null, createdAt: r.created_at, updatedAt: r.updated_at, closedAt: r.closed_at,
    isOpen: KINDS[r.kind] ? KINDS[r.kind].open.includes(r.status) : false };
}
const REC_SELECT = `SELECT r.*, e.name AS employee_name, c.name AS created_name FROM hr_records r
  LEFT JOIN users e ON e.id = r.employee_id LEFT JOIN users c ON c.id = r.created_by`;

function register(router) {
  // ==================== Generic HR records ====================
  router.get('/api/hr/records', requireAuth, requireHrView, async (req, res, next) => {
    const clauses = ['1=1']; const params = [];
    if (req.query.kind) {
      const kinds = String(req.query.kind).split(',');
      if (kinds.some(k => !KINDS[k])) return next({ status: 400, message: 'Unknown record type' });
      clauses.push(`r.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds);
    }
    if (req.query.employee_id) { clauses.push('r.employee_id = ?'); params.push(req.query.employee_id); }
    if (req.query.status) { clauses.push('r.status = ?'); params.push(req.query.status); }
    if (req.query.related_id) { clauses.push('r.related_id = ?'); params.push(req.query.related_id); }
    const rows = await all(`${REC_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY r.created_at DESC LIMIT 1000`, params);
    res.json({ records: rows.map(recOut) });
  });

  router.post('/api/hr/records', requireAuth, requireHrWrite, async (req, res, next) => {
    const b = req.body || {};
    const def = KINDS[b.kind];
    if (!def) return next({ status: 400, message: 'Unknown record type' });
    const title = clean(b.title, 200);
    if (!title) return next({ status: 400, message: 'A title is required' });
    const employeeId = clean(b.employee_id, 60);
    let employee = null;
    if (def.employee && !employeeId) return next({ status: 400, message: 'Choose the employee this record is for' });
    if (employeeId) {
      employee = await get('SELECT id, role_id, branch_id, name FROM users WHERE id = ?', [employeeId]);
      if (!employee) return next({ status: 400, message: 'Unknown employee' });
    }
    for (const f of ['start_date', 'end_date']) if (b[f] && !isDate(b[f])) return next({ status: 400, message: `${f.replace('_', ' ')} must be YYYY-MM-DD` });
    if (b.start_date && b.end_date && b.end_date < b.start_date) return next({ status: 400, message: 'The end date cannot be before the start date' });
    const status = b.status && def.statuses.includes(b.status) ? b.status : def.statuses[0];
    const data = b.data && typeof b.data === 'object' && !Array.isArray(b.data) ? b.data : {};
    if (b.kind === 'transfer') {
      if (!data.toBranchId || !(await get('SELECT id FROM branches WHERE id = ?', [data.toBranchId]))) return next({ status: 400, message: 'Choose the branch to transfer to' });
      if (data.toBranchId === employee.branch_id) return next({ status: 400, message: 'The employee is already at that branch' });
      if (!canActOnStaffRecord(req.user, employee.role_id)) return next({ status: 403, message: `HR cannot transfer a ${employee.role_id} employee` });
      data.fromBranchId = employee.branch_id;
    }
    if (b.kind === 'access_request' && !ACCESS_ACTIONS.includes(data.action)) return next({ status: 400, message: `Choose what access change is needed (${ACCESS_ACTIONS.join(', ')})` });
    if (b.kind === 'policy_ack') {
      const dup = await get(`SELECT id FROM hr_records WHERE kind = 'policy_ack' AND employee_id = ? AND related_id = ?`, [employeeId, b.related_id]);
      if (dup) return next({ status: 409, message: 'This employee has already acknowledged that policy' });
    }
    const dataJson = JSON.stringify(data);
    if (Buffer.byteLength(dataJson) > MAX_DATA) return next({ status: 400, message: 'Record details are too large' });
    const amount = b.amount === undefined || b.amount === null || b.amount === '' ? null : Number(b.amount);
    if (amount !== null && !Number.isFinite(amount)) return next({ status: 400, message: 'Amount must be a number' });
    const score = b.score === undefined || b.score === null || b.score === '' ? null : Number(b.score);
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) return next({ status: 400, message: 'Score must be between 0 and 100' });
    const id = 'hrr_' + crypto.randomUUID();
    await run(`INSERT INTO hr_records (id, kind, employee_id, title, status, category, start_date, end_date, amount, score, related_id, data_json, created_by)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.kind, employeeId, title, status, clean(b.category, 80), b.start_date || null, b.end_date || null, amount, score, clean(b.related_id, 60), dataJson, req.user.id]);
    await logAction(req, { action: `Created HR ${b.kind.replace(/_/g, ' ')}`, module: 'hr', recordType: 'HrRecord:' + b.kind, recordId: id, newValue: { title, employeeId, status } });
    res.status(201).json({ record: recOut(await get(`${REC_SELECT} WHERE r.id = ?`, [id])) });
  });

  router.patch('/api/hr/records/:id', requireAuth, requireHrWrite, async (req, res, next) => {
    const row = await get('SELECT * FROM hr_records WHERE id = ?', [req.params.id]);
    if (!row) return next({ status: 404, message: 'Record not found' });
    const def = KINDS[row.kind];
    const b = req.body || {};
    const sets = []; const params = [];
    const deciding = b.status !== undefined && b.status !== row.status;
    if (b.status !== undefined) {
      if (!def.statuses.includes(b.status)) return next({ status: 400, message: `Status must be one of: ${def.statuses.join(', ')}` });
      if (row.kind === 'access_request' && deciding && req.user.role_id !== 'admin') return next({ status: 403, message: 'Only the System Administrator decides access requests' });
      if (row.kind === 'access_request' && deciding && row.created_by === req.user.id) return next({ status: 403, message: 'You cannot decide a request you raised' });
      if (row.kind === 'transfer' && b.status === 'Completed' && row.status !== 'Approved') return next({ status: 400, message: 'Approve the transfer before completing it' });
      if (deciding && def.open.length && !def.open.includes(row.status) && row.kind !== 'policy' && row.kind !== 'employee_document') {
        return next({ status: 400, message: `This record is already ${row.status.toLowerCase()}` });
      }
      sets.push('status = ?'); params.push(b.status);
      if (!def.open.includes(b.status)) sets.push('closed_at = iso_now()');
    }
    for (const [f, max] of [['title', 200], ['category', 80]]) if (b[f] !== undefined) { const v = clean(b[f], max); if (f === 'title' && !v) return next({ status: 400, message: 'A title is required' }); sets.push(`${f} = ?`); params.push(v); }
    for (const f of ['start_date', 'end_date']) if (b[f] !== undefined) { if (b[f] && !isDate(b[f])) return next({ status: 400, message: `${f.replace('_', ' ')} must be YYYY-MM-DD` }); sets.push(`${f} = ?`); params.push(b[f] || null); }
    if (b.amount !== undefined) { const a = b.amount === '' || b.amount === null ? null : Number(b.amount); if (a !== null && !Number.isFinite(a)) return next({ status: 400, message: 'Amount must be a number' }); sets.push('amount = ?'); params.push(a); }
    if (b.score !== undefined) { const sc = b.score === '' || b.score === null ? null : Number(b.score); if (sc !== null && (!Number.isFinite(sc) || sc < 0 || sc > 100)) return next({ status: 400, message: 'Score must be between 0 and 100' }); sets.push('score = ?'); params.push(sc); }
    let data = parseJson(row.data_json) || {};
    if (b.data !== undefined) {
      if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) return next({ status: 400, message: 'data must be an object' });
      data = Object.assign({}, data, b.data);
      const dj = JSON.stringify(data);
      if (Buffer.byteLength(dj) > MAX_DATA) return next({ status: 400, message: 'Record details are too large' });
      sets.push('data_json = ?'); params.push(dj);
    }
    if (!sets.length) return next({ status: 400, message: 'Nothing to update' });
    let effect = null;
    try {
      await transaction(async () => {
        if (row.kind === 'transfer' && b.status === 'Completed') {
          const emp = await get('SELECT id, role_id FROM users WHERE id = ?', [row.employee_id]);
          if (!canActOnStaffRecord(req.user, emp.role_id)) throw { status: 403, message: `HR cannot transfer a ${emp.role_id} employee` };
          const held = await get('SELECT COUNT(*) AS n FROM clients WHERE officer_id = ?', [row.employee_id]);
          if (Number(held.n) > 0) throw { status: 400, message: `Reassign or transfer this officer's ${held.n} client(s) first` };
          const toBranch = await get('SELECT id, region_id FROM branches WHERE id = ?', [data.toBranchId]);
          await run('UPDATE users SET branch_id = ?, region_id = COALESCE(?, region_id) WHERE id = ?', [toBranch.id, toBranch.region_id, row.employee_id]);
          effect = { movedTo: toBranch.id };
        }
        if (row.kind === 'access_request' && b.status === 'Approved') {
          const map = { 'Activate account': 'Active', 'Suspend account': 'Suspended', 'Deactivate account': 'Deactivated' };
          const target = map[data.action];
          if (target) {
            const acct = await get('SELECT status FROM user_accounts WHERE employee_id = ?', [row.employee_id]);
            if (!acct) throw { status: 400, message: 'This employee has no System Account — create one under User Management first' };
            await run('UPDATE user_accounts SET status = ? WHERE employee_id = ?', [target, row.employee_id]);
            if (target !== 'Active') await run('UPDATE sessions SET revoked_at = iso_now() WHERE user_id = ? AND revoked_at IS NULL', [row.employee_id]);
            effect = { accountStatus: target };
          }
        }
        await run(`UPDATE hr_records SET ${sets.join(', ')}, updated_by = ?, updated_at = iso_now() WHERE id = ?`, [...params, req.user.id, row.id]);
      });
    } catch (e) { if (e && e.status) return next(e); throw e; }
    await logAction(req, { action: `Updated HR ${row.kind.replace(/_/g, ' ')}${b.status ? ' → ' + b.status : ''}`, module: 'hr', recordType: 'HrRecord:' + row.kind, recordId: row.id,
      previousValue: { status: row.status }, newValue: Object.assign({}, b, effect ? { effect } : {}) });
    res.json({ record: recOut(await get(`${REC_SELECT} WHERE r.id = ?`, [row.id])), effect });
  });

  // ==================== Attendance ====================
  router.get('/api/hr/attendance', requireAuth, requireHrView, async (req, res, next) => {
    const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to || new Date().toISOString().slice(0, 10);
    if (!isDate(from) || !isDate(to)) return next({ status: 400, message: 'from/to must be YYYY-MM-DD' });
    const params = [from, to]; let extra = '';
    if (req.query.employee_id) { extra = ' AND a.employee_id = ?'; params.push(req.query.employee_id); }
    const rows = await all(`SELECT a.*, u.name AS employee_name, u.branch_id FROM hr_attendance a JOIN users u ON u.id = a.employee_id
      WHERE a.date BETWEEN ? AND ?${extra} ORDER BY a.date DESC, u.name LIMIT 5000`, params);
    res.json({ from, to, records: rows.map(r => ({ id: r.id, employeeId: r.employee_id, employeeName: r.employee_name, branchId: r.branch_id, date: r.date, status: r.status,
      checkIn: r.check_in, checkOut: r.check_out, minutesLate: r.minutes_late, note: r.note })) });
  });
  router.post('/api/hr/attendance', requireAuth, requireHrWrite, async (req, res, next) => {
    const { date, entries } = req.body || {};
    if (!isDate(date)) return next({ status: 400, message: 'date must be YYYY-MM-DD' });
    if (date > new Date().toISOString().slice(0, 10)) return next({ status: 400, message: 'Attendance cannot be recorded for a future date' });
    if (!Array.isArray(entries) || !entries.length) return next({ status: 400, message: 'No attendance entries sent' });
    const tm = v => v === undefined || v === null || v === '' ? null : (/^\d{2}:\d{2}$/.test(v) ? v : undefined);
    for (const e of entries) {
      if (!ATTENDANCE_STATUSES.includes(e.status)) return next({ status: 400, message: `Status must be one of: ${ATTENDANCE_STATUSES.join(', ')}` });
      if (tm(e.check_in) === undefined || tm(e.check_out) === undefined) return next({ status: 400, message: 'Times must be HH:MM' });
      if (e.check_in && e.check_out && e.check_out < e.check_in) return next({ status: 400, message: 'Check-out cannot be before check-in' });
    }
    const ids = entries.map(e => e.employee_id);
    const found = await all(`SELECT id FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    if (found.length !== new Set(ids).size) return next({ status: 400, message: 'Unknown employee in the list' });
    let saved = 0;
    await transaction(async () => {
      for (const e of entries) {
        const lateMin = e.status === 'Late' ? Math.max(0, parseInt(e.minutes_late, 10) || 0) : 0;
        await run(`INSERT INTO hr_attendance (id, employee_id, date, status, check_in, check_out, minutes_late, note, recorded_by) VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT (employee_id, date) DO UPDATE SET status = EXCLUDED.status, check_in = EXCLUDED.check_in, check_out = EXCLUDED.check_out,
          minutes_late = EXCLUDED.minutes_late, note = EXCLUDED.note, recorded_by = EXCLUDED.recorded_by, updated_at = iso_now()`,
          ['att_' + crypto.randomUUID(), e.employee_id, date, e.status, tm(e.check_in), tm(e.check_out), lateMin, clean(e.note, 300), req.user.id]);
        saved++;
      }
    });
    await logAction(req, { action: 'Recorded attendance', module: 'hr', recordType: 'Attendance', recordId: date, newValue: { entries: saved } });
    res.json({ ok: true, saved });
  });

  // ==================== Payroll ====================
  async function payrollEmployees() {
    return all(`SELECT * FROM users WHERE status IN ('Active','On Leave') AND basic_salary > 0 ORDER BY name`);
  }
  async function computeRunLines(runId, period) {
    await run('DELETE FROM payroll_lines WHERE run_id = ?', [runId]);
    const emps = await payrollEmployees();
    let gross = 0, deductions = 0, net = 0;
    for (const u of emps) {
      const p = await computePayslip(u, period);
      await run(`INSERT INTO payroll_lines (id, run_id, employee_id, basic, allowances, gross, nssf, shif, paye, salary_advance, other_deductions, total_deductions, net, payslip_ref)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['pl_' + crypto.randomUUID(), runId, u.id, p.basicSalary, p.allowances, p.grossPay, p.nssf, p.shif, p.paye, p.salaryAdvance, p.otherDeductions, p.totalDeductions, p.netPay, p.ref]);
      gross += Number(p.grossPay); deductions += Number(p.totalDeductions); net += Number(p.netPay);
    }
    await run('UPDATE payroll_runs SET employee_count = ?, total_gross = ?, total_deductions = ?, total_net = ?, computed_at = iso_now() WHERE id = ?',
      [emps.length, Math.round(gross * 100) / 100, Math.round(deductions * 100) / 100, Math.round(net * 100) / 100, runId]);
  }
  const runOut = r => r && ({ id: r.id, period: r.period, status: r.status, employeeCount: r.employee_count, totalGross: Number(r.total_gross || 0), totalDeductions: Number(r.total_deductions || 0),
    totalNet: Number(r.total_net || 0), createdBy: r.created_by, createdByName: r.created_name || null, approvedBy: r.approved_by, approvedByName: r.approved_name || null,
    approvedAt: r.approved_at, paidAt: r.paid_at, computedAt: r.computed_at, createdAt: r.created_at });
  const RUN_SELECT = `SELECT r.*, c.name AS created_name, a.name AS approved_name FROM payroll_runs r LEFT JOIN users c ON c.id = r.created_by LEFT JOIN users a ON a.id = r.approved_by`;

  router.get('/api/hr/payroll/runs', requireAuth, requireHrView, async (req, res) => {
    res.json({ runs: (await all(`${RUN_SELECT} ORDER BY r.period DESC`)).map(runOut) });
  });
  router.post('/api/hr/payroll/runs', requireAuth, requireHrWrite, async (req, res, next) => {
    const period = String((req.body || {}).period || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return next({ status: 400, message: 'Choose a month (YYYY-MM)' });
    const thisMonth = new Date().toISOString().slice(0, 7);
    if (period > thisMonth) return next({ status: 400, message: 'Payroll cannot be run for a future month' });
    if (await get('SELECT id FROM payroll_runs WHERE period = ?', [period])) return next({ status: 409, message: `Payroll for ${period} already exists — open it to recompute or approve` });
    const id = 'pr_' + crypto.randomUUID();
    await run('INSERT INTO payroll_runs (id, period, status, created_by) VALUES (?,?,?,?)', [id, period, 'Draft', req.user.id]);
    await computeRunLines(id, period);
    await logAction(req, { action: 'Created payroll run', module: 'hr', recordType: 'PayrollRun', recordId: id, newValue: { period } });
    res.status(201).json({ run: runOut(await get(`${RUN_SELECT} WHERE r.id = ?`, [id])) });
  });
  router.get('/api/hr/payroll/runs/:id', requireAuth, requireHrView, async (req, res, next) => {
    const r = await get(`${RUN_SELECT} WHERE r.id = ?`, [req.params.id]);
    if (!r) return next({ status: 404, message: 'Payroll run not found' });
    const lines = await all(`SELECT l.*, u.name, u.staff_code, u.branch_id, u.job_title, u.kra_pin, u.nssf_no, u.sha_no FROM payroll_lines l JOIN users u ON u.id = l.employee_id WHERE l.run_id = ? ORDER BY u.name`, [r.id]);
    res.json({ run: runOut(r), lines: lines.map(l => ({ id: l.id, employeeId: l.employee_id, name: l.name, staffCode: l.staff_code, branchId: l.branch_id, jobTitle: l.job_title,
      kraPin: l.kra_pin, nssfNo: l.nssf_no, shaNo: l.sha_no, basic: Number(l.basic), allowances: Number(l.allowances), gross: Number(l.gross), nssf: Number(l.nssf), shif: Number(l.shif),
      paye: Number(l.paye), salaryAdvance: Number(l.salary_advance), otherDeductions: Number(l.other_deductions), totalDeductions: Number(l.total_deductions), net: Number(l.net), payslipRef: l.payslip_ref })) });
  });
  router.post('/api/hr/payroll/runs/:id/recompute', requireAuth, requireHrWrite, async (req, res, next) => {
    const r = await get('SELECT * FROM payroll_runs WHERE id = ?', [req.params.id]);
    if (!r) return next({ status: 404, message: 'Payroll run not found' });
    if (r.status !== 'Draft') return next({ status: 400, message: `A ${r.status.toLowerCase()} payroll can no longer be recomputed` });
    await computeRunLines(r.id, r.period);
    await logAction(req, { action: 'Recomputed payroll run', module: 'hr', recordType: 'PayrollRun', recordId: r.id });
    res.json({ run: runOut(await get(`${RUN_SELECT} WHERE r.id = ?`, [r.id])) });
  });
  // Maker-checker: HR prepares the payroll; the CEO, Director or Admin —
  // never the person who prepared it — approves it; HR/Admin marks it paid.
  router.post('/api/hr/payroll/runs/:id/status', requireAuth, requireHrView, async (req, res, next) => {
    const r = await get('SELECT * FROM payroll_runs WHERE id = ?', [req.params.id]);
    if (!r) return next({ status: 404, message: 'Payroll run not found' });
    const to = (req.body || {}).status;
    if (to === 'Approved') {
      if (!['ceo', 'director', 'admin'].includes(req.user.role_id)) return next({ status: 403, message: 'Payroll is approved by the CEO, Director or System Administrator' });
      if (r.status !== 'Draft') return next({ status: 400, message: `Only a draft payroll can be approved (this one is ${r.status.toLowerCase()})` });
      if (r.created_by === req.user.id) return next({ status: 403, message: 'The person who prepared a payroll cannot approve it' });
      await run('UPDATE payroll_runs SET status = ?, approved_by = ?, approved_at = iso_now() WHERE id = ?', ['Approved', req.user.id, r.id]);
    } else if (to === 'Paid') {
      if (!HR_WRITE.includes(req.user.role_id)) return next({ status: 403, message: 'Only HR or the System Administrator marks payroll as paid' });
      if (r.status !== 'Approved') return next({ status: 400, message: 'Payroll must be approved before it is paid' });
      await run('UPDATE payroll_runs SET status = ?, paid_at = iso_now() WHERE id = ?', ['Paid', r.id]);
    } else return next({ status: 400, message: 'status must be Approved or Paid' });
    await logAction(req, { action: `Payroll ${to.toLowerCase()}`, module: 'hr', recordType: 'PayrollRun', recordId: r.id, newValue: { period: r.period, status: to } });
    res.json({ run: runOut(await get(`${RUN_SELECT} WHERE r.id = ?`, [r.id])) });
  });

  // ==================== Departments ====================
  router.get('/api/hr/departments', requireAuth, requireHrView, async (req, res) => {
    const rows = await all(`SELECT d.id, d.name, COUNT(u.id) FILTER (WHERE u.status <> 'Terminated')::int AS headcount
      FROM departments d LEFT JOIN users u ON u.department_id = d.id GROUP BY d.id, d.name ORDER BY d.name`);
    res.json({ departments: rows });
  });
  router.post('/api/hr/departments', requireAuth, requireHrWrite, async (req, res, next) => {
    const name = clean(req.body && req.body.name, 80);
    if (!name) return next({ status: 400, message: 'Department name is required' });
    if (await get('SELECT id FROM departments WHERE lower(name) = lower(?)', [name])) return next({ status: 409, message: `"${name}" already exists` });
    const id = 'dept_' + crypto.randomUUID().slice(0, 8);
    await run('INSERT INTO departments (id, name) VALUES (?,?)', [id, name]);
    await logAction(req, { action: 'Created department', module: 'hr', recordType: 'Department', recordId: id, newValue: { name } });
    res.status(201).json({ department: { id, name, headcount: 0 } });
  });
  router.put('/api/hr/departments/:id', requireAuth, requireHrWrite, async (req, res, next) => {
    const d = await get('SELECT * FROM departments WHERE id = ?', [req.params.id]);
    if (!d) return next({ status: 404, message: 'Department not found' });
    const name = clean(req.body && req.body.name, 80);
    if (!name) return next({ status: 400, message: 'Department name is required' });
    if (await get('SELECT id FROM departments WHERE lower(name) = lower(?) AND id <> ?', [name, d.id])) return next({ status: 409, message: `"${name}" already exists` });
    await run('UPDATE departments SET name = ? WHERE id = ?', [name, d.id]);
    await logAction(req, { action: 'Renamed department', module: 'hr', recordType: 'Department', recordId: d.id, previousValue: { name: d.name }, newValue: { name } });
    res.json({ department: { id: d.id, name } });
  });

  // ==================== Employee HR details ====================
  const HR_FIELDS = { job_title: 'text', department_id: 'dept', job_grade: 'text', employment_type: 'text', basic_salary: 'money',
    contract_start: 'date', contract_end: 'date', probation_end: 'date', kra_pin: 'text', nssf_no: 'text', sha_no: 'text', leave_days_balance: 'int' };
  router.patch('/api/hr/employees/:id', requireAuth, requireHrWrite, async (req, res, next) => {
    const before = await get('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!before) return next({ status: 404, message: 'Employee not found' });
    if (!canActOnStaffRecord(req.user, before.role_id)) return next({ status: 403, message: `HR cannot edit a ${before.role_id} employee's record` });
    const b = req.body || {}; const sets = []; const params = []; const changed = {};
    for (const [f, type] of Object.entries(HR_FIELDS)) {
      if (b[f] === undefined) continue;
      let v = b[f] === '' ? null : b[f];
      if (type === 'money') { v = Number(v || 0); if (!Number.isFinite(v) || v < 0) return next({ status: 400, message: 'Basic salary must be zero or more' }); }
      if (type === 'int') { v = parseInt(v, 10); if (!Number.isFinite(v) || v < 0 || v > 365) return next({ status: 400, message: 'Leave balance must be between 0 and 365 days' }); }
      if (type === 'date' && v !== null && !isDate(v)) return next({ status: 400, message: `${f.replace(/_/g, ' ')} must be YYYY-MM-DD` });
      if (type === 'dept' && v !== null && !(await get('SELECT id FROM departments WHERE id = ?', [v]))) return next({ status: 400, message: 'Unknown department' });
      if (type === 'text' && v !== null) v = clean(v, 80);
      sets.push(`${f} = ?`); params.push(v); changed[f] = v;
    }
    const cs = b.contract_start !== undefined ? changed.contract_start : before.contract_start;
    const ce = b.contract_end !== undefined ? changed.contract_end : before.contract_end;
    if (cs && ce && ce < cs) return next({ status: 400, message: 'The contract cannot end before it starts' });
    if (!sets.length) return next({ status: 400, message: 'Nothing to update' });
    await run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, before.id]);
    const prev = {}; Object.keys(changed).forEach(k => { prev[k] = before[k]; });
    await logAction(req, { action: 'Updated employee HR details', module: 'hr', recordType: 'Employee', recordId: before.id, previousValue: prev, newValue: changed });
    const after = await get(`SELECT id, name, ${Object.keys(HR_FIELDS).join(', ')} FROM users WHERE id = ?`, [before.id]);
    res.json({ employee: after });
  });
  router.get('/api/hr/employees', requireAuth, requireHrView, async (req, res) => {
    const rows = await all(`SELECT u.id, u.staff_code, u.name, u.email, u.phone, u.role_id, u.branch_id, u.region_id, u.department_id, u.job_title, u.job_grade, u.employment_type,
      u.employment_status, u.status, u.gender, u.date_of_birth, u.national_id, u.basic_salary, u.leave_days_balance, u.contract_start, u.contract_end, u.probation_end,
      u.kra_pin, u.nssf_no, u.sha_no, u.reporting_manager_id, u.created_at, u.last_login_at, a.status AS account_status, u.must_change_password
      FROM users u LEFT JOIN user_accounts a ON a.employee_id = u.id ORDER BY u.name`);
    res.json({ employees: rows.map(r => Object.assign({}, r, { basic_salary: Number(r.basic_salary || 0), account_status: r.account_status || 'Not Created', must_change_password: !!r.must_change_password })) });
  });

  // ==================== People history & access visibility ====================
  // HR sees staff sign-in activity and the trail of changes to staff and
  // accounts — never financial or loan audit entries.
  router.get('/api/hr/login-activity', requireAuth, requireHrView, async (req, res) => {
    const rows = await all(`SELECT la.id, la.email, la.success, la.reason, la.ip, la.created_at, u.id AS employee_id, u.name, u.role_id, u.branch_id
      FROM login_attempts la LEFT JOIN user_accounts ua ON lower(ua.login_email) = lower(la.email) LEFT JOIN users u ON u.id = ua.employee_id
      ORDER BY la.created_at DESC LIMIT 500`);
    res.json({ events: rows });
  });
  router.get('/api/hr/people-audit', requireAuth, requireHrView, async (req, res) => {
    const params = [];
    let extra = '';
    if (req.query.employee_id) { extra = ' AND record_id = ?'; params.push(req.query.employee_id); }
    const rows = await all(`SELECT id, user_name, role_id, action, module, record_type, record_id, previous_value, new_value, reason, created_at FROM audit_logs
      WHERE (module IN ('users','hr','auth','staff') OR record_type IN ('User','Employee','Role','Leave','SalaryAdvance'))${extra} ORDER BY created_at DESC LIMIT 500`, params);
    res.json({ entries: rows });
  });
}

module.exports = { register, KINDS, ATTENDANCE_STATUSES, ACCESS_ACTIONS };
