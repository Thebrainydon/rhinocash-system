'use strict';
// adminConfig.js — the System Administrator's configuration store behind
// every Admin setup page that has no dedicated table of its own (Company
// Setup, System Configuration, Templates & Numbering, HR & Payroll Setup,
// Client & KYC Setup, Payment & Collection Setup, ...).
//
//   admin_settings          one JSON settings document per page key
//   admin_settings_history  full before/after trail of every save
//   admin_lookups           keyed reference lists (Client Types, Job Grades…)
//
// Writes are Admin-only (requireAdminOnly + manage_system_settings) and
// audit-logged. Settings/history are readable by the same governance tier
// as the rest of System Administration (Admin/CEO/Director). Lookup lists
// are readable by any signed-in staff member, since other roles' forms
// (e.g. Add Client's client type) consume them.
const crypto = require('node:crypto');
const { all, get, run } = require('./../db');
const { requireAuth, requirePermission } = require('./../middleware');
const { logAction } = require('./../audit');
const { recentErrors } = require('./../errorLog');

const KEY_RE = /^[a-z0-9][a-z0-9_.-]{1,79}$/;
const MAX_VALUE_BYTES = 20000;
const LOOKUP_STATUSES = ['Active', 'Inactive'];

function requireAdminOnly(req, res, next) {
  if (req.user.role_id !== 'admin') return next({ status: 403, message: 'Only the System Administrator can change system configuration' });
  next();
}
function requireAdminView(req, res, next) {
  if (['admin', 'ceo', 'director'].includes(req.user.role_id)) return next();
  return next({ status: 403, message: 'Your role does not have System Administration visibility' });
}
const canWrite = [requireAuth, requirePermission('manage_system_settings'), requireAdminOnly];
// HR maintains the people-related reference lists itself; every other list
// stays with the System Administrator.
const HR_LISTS = ['job-titles', 'job-grades', 'employment-types', 'leave-types', 'allowances', 'deductions', 'salary-components', 'training-categories', 'benefit-types'];
async function requireListWriter(req, res, next) {
  if (req.user.role_id === 'hr' && HR_LISTS.includes(req.params.listKey)) return next();
  if (req.user.role_id !== 'admin') return next({ status: 403, message: 'Only the System Administrator can change system configuration' });
  return requirePermission('manage_system_settings')(req, res, next);
}
const canWriteList = [requireAuth, requireListWriter];

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function cleanText(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function lookupOut(r) {
  return { id: r.id, listKey: r.list_key, name: r.name, code: r.code, description: r.description,
    attrs: parseJson(r.attrs_json) || {}, status: r.status, sortOrder: r.sort_order,
    createdAt: r.created_at, updatedAt: r.updated_at };
}

function register(router) {
  // ==================== Settings documents ====================
  router.get('/api/admin/settings', requireAuth, requireAdminView, async (req, res) => {
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
    const rows = await all(
      `SELECT s.key, s.value_json, s.updated_at, u.name AS updated_by_name
       FROM admin_settings s LEFT JOIN users u ON u.id = s.updated_by
       WHERE s.key LIKE ? ORDER BY s.key`, [prefix.replace(/[%_]/g, '') + '%']);
    const settings = {};
    rows.forEach(r => { settings[r.key] = { value: parseJson(r.value_json) || {}, updatedAt: r.updated_at, updatedBy: r.updated_by_name }; });
    res.json({ settings });
  });

  router.put('/api/admin/settings/:key', ...canWrite, async (req, res, next) => {
    const key = req.params.key;
    if (!KEY_RE.test(key)) return next({ status: 400, message: 'Invalid settings key' });
    const value = req.body && req.body.value;
    if (!isPlainObject(value)) return next({ status: 400, message: 'value must be an object of named settings' });
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > MAX_VALUE_BYTES) return next({ status: 400, message: 'Settings document is too large' });
    const before = await get('SELECT value_json FROM admin_settings WHERE key = ?', [key]);
    if (before && before.value_json === json) return res.json({ ok: true, unchanged: true, value });
    await run(
      `INSERT INTO admin_settings (key, value_json, updated_by, updated_at) VALUES (?,?,?, iso_now())
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = iso_now()`,
      [key, json, req.user.id]);
    await run('INSERT INTO admin_settings_history (key, previous_json, new_json, changed_by, changed_by_name) VALUES (?,?,?,?,?)',
      [key, before ? before.value_json : null, json, req.user.id, req.user.name]);
    await logAction(req, { action: 'Updated system configuration', module: 'admin', recordType: 'AdminSettings', recordId: key,
      previousValue: before ? parseJson(before.value_json) : null, newValue: value });
    res.json({ ok: true, value });
  });

  router.get('/api/admin/settings-history', requireAuth, requireAdminView, async (req, res) => {
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix.replace(/[%_]/g, '') : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const rows = await all(
      `SELECT id, key, previous_json, new_json, changed_by_name, changed_at FROM admin_settings_history
       WHERE key LIKE ? ORDER BY id DESC LIMIT ${limit}`, [prefix + '%']);
    res.json({ history: rows.map(r => ({ id: r.id, key: r.key, previous: parseJson(r.previous_json), next: parseJson(r.new_json), changedBy: r.changed_by_name, changedAt: r.changed_at })) });
  });

  // ==================== Reference lists ====================
  router.get('/api/admin/lookups/:listKey', requireAuth, async (req, res, next) => {
    if (!KEY_RE.test(req.params.listKey)) return next({ status: 400, message: 'Invalid list' });
    const rows = await all('SELECT * FROM admin_lookups WHERE list_key = ? ORDER BY sort_order, lower(name)', [req.params.listKey]);
    res.json({ items: rows.map(lookupOut) });
  });

  function readLookupBody(body, existing) {
    const name = body.name !== undefined ? cleanText(body.name, 120) : (existing && existing.name);
    if (!name) return { error: 'Name is required' };
    const status = body.status !== undefined ? body.status : (existing ? existing.status : 'Active');
    if (!LOOKUP_STATUSES.includes(status)) return { error: 'Status must be Active or Inactive' };
    let attrs = existing ? (parseJson(existing.attrs_json) || {}) : {};
    if (body.attrs !== undefined) {
      if (!isPlainObject(body.attrs)) return { error: 'attrs must be an object' };
      attrs = body.attrs;
    }
    const attrsJson = JSON.stringify(attrs);
    if (Buffer.byteLength(attrsJson) > MAX_VALUE_BYTES) return { error: 'Item details are too large' };
    const sortOrder = body.sortOrder !== undefined ? (parseInt(body.sortOrder, 10) || 0) : (existing ? existing.sort_order : 0);
    return {
      name, status, attrsJson, sortOrder,
      code: body.code !== undefined ? cleanText(body.code, 40) : (existing ? existing.code : null),
      description: body.description !== undefined ? cleanText(body.description, 500) : (existing ? existing.description : null),
    };
  }
  async function nameTaken(listKey, name, exceptId) {
    const r = await get('SELECT id FROM admin_lookups WHERE list_key = ? AND lower(name) = lower(?) AND id <> ?', [listKey, name, exceptId || '']);
    return !!r;
  }

  router.post('/api/admin/lookups/:listKey', ...canWriteList, async (req, res, next) => {
    const listKey = req.params.listKey;
    if (!KEY_RE.test(listKey)) return next({ status: 400, message: 'Invalid list' });
    const v = readLookupBody(req.body || {}, null);
    if (v.error) return next({ status: 400, message: v.error });
    if (await nameTaken(listKey, v.name)) return next({ status: 409, message: `"${v.name}" already exists in this list` });
    const id = 'lk_' + crypto.randomUUID();
    await run(`INSERT INTO admin_lookups (id, list_key, name, code, description, attrs_json, status, sort_order, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, listKey, v.name, v.code, v.description, v.attrsJson, v.status, v.sortOrder, req.user.id]);
    const row = await get('SELECT * FROM admin_lookups WHERE id = ?', [id]);
    await logAction(req, { action: 'Added configuration list item', module: 'admin', recordType: 'AdminLookup:' + listKey, recordId: id, newValue: lookupOut(row) });
    res.status(201).json({ item: lookupOut(row) });
  });

  router.put('/api/admin/lookups/:listKey/:id', ...canWriteList, async (req, res, next) => {
    const existing = await get('SELECT * FROM admin_lookups WHERE id = ? AND list_key = ?', [req.params.id, req.params.listKey]);
    if (!existing) return next({ status: 404, message: 'Item not found' });
    const v = readLookupBody(req.body || {}, existing);
    if (v.error) return next({ status: 400, message: v.error });
    if (await nameTaken(existing.list_key, v.name, existing.id)) return next({ status: 409, message: `"${v.name}" already exists in this list` });
    await run(`UPDATE admin_lookups SET name = ?, code = ?, description = ?, attrs_json = ?, status = ?, sort_order = ?, updated_by = ?, updated_at = iso_now() WHERE id = ?`,
      [v.name, v.code, v.description, v.attrsJson, v.status, v.sortOrder, req.user.id, existing.id]);
    const row = await get('SELECT * FROM admin_lookups WHERE id = ?', [existing.id]);
    await logAction(req, { action: 'Updated configuration list item', module: 'admin', recordType: 'AdminLookup:' + existing.list_key, recordId: existing.id, previousValue: lookupOut(existing), newValue: lookupOut(row) });
    res.json({ item: lookupOut(row) });
  });

  router.delete('/api/admin/lookups/:listKey/:id', ...canWriteList, async (req, res, next) => {
    const existing = await get('SELECT * FROM admin_lookups WHERE id = ? AND list_key = ?', [req.params.id, req.params.listKey]);
    if (!existing) return next({ status: 404, message: 'Item not found' });
    await run('DELETE FROM admin_lookups WHERE id = ?', [existing.id]);
    await logAction(req, { action: 'Removed configuration list item', module: 'admin', recordType: 'AdminLookup:' + existing.list_key, recordId: existing.id, previousValue: lookupOut(existing) });
    res.json({ ok: true });
  });

  // ==================== Account security actions ====================
  // Unlock: clears (never deletes) the recent failed attempts that are
  // holding an account in the 15-minute lockout, so the trail survives.
  router.post('/api/admin/accounts/unlock', requireAuth, requirePermission('manage_users'), requireAdminOnly, async (req, res, next) => {
    const email = cleanText(req.body && req.body.email, 200);
    if (!email) return next({ status: 400, message: 'email is required' });
    const result = await run(
      `UPDATE login_attempts SET cleared_at = iso_now() WHERE lower(email) = lower(?) AND success = 0 AND cleared_at IS NULL`, [email]);
    await logAction(req, { action: 'Unlocked account', module: 'users', recordType: 'LoginAttempts', recordId: email, newValue: { cleared: result.changes }, reason: req.body.reason });
    res.json({ ok: true, cleared: result.changes });
  });
  // Force password change: the user keeps their current password but must
  // set a new one at their next sign-in (no temporary password issued).
  router.post('/api/admin/users/:id/force-password-change', requireAuth, requirePermission('manage_users'), requireAdminOnly, async (req, res, next) => {
    const target = await get('SELECT id, must_change_password FROM users WHERE id = ?', [req.params.id]);
    if (!target) return next({ status: 404, message: 'User not found' });
    if (!(await get('SELECT 1 FROM user_accounts WHERE employee_id = ?', [target.id]))) {
      return next({ status: 400, message: 'This employee has no System Account' });
    }
    const required = !(req.body && req.body.required === false);
    await run('UPDATE users SET must_change_password = ? WHERE id = ?', [required ? 1 : 0, target.id]);
    await logAction(req, { action: required ? 'Required password change at next login' : 'Cleared required password change', module: 'users', recordType: 'User', recordId: target.id, previousValue: { mustChangePassword: !!target.must_change_password }, newValue: { mustChangePassword: required } });
    res.json({ ok: true, mustChangePassword: required });
  });

  // ==================== Live system statistics ====================
  // Real numbers for System Monitoring / Database & System pages: table
  // sizes straight from PostgreSQL's own statistics, plus this server
  // process's real uptime and memory — never simulated.
  router.get('/api/admin/system-stats', requireAuth, requireAdminOnly, async (req, res) => {
    const db = await get('SELECT pg_database_size(current_database())::bigint AS size_bytes, current_database() AS name, version() AS version');
    const tables = await all(
      `SELECT relname AS name, n_live_tup::bigint AS rows, pg_total_relation_size(relid)::bigint AS size_bytes
       FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC`);
    const conns = await get(`SELECT count(*)::int AS total, count(*) FILTER (WHERE state = 'active')::int AS active FROM pg_stat_activity WHERE datname = current_database()`);
    const mem = process.memoryUsage();
    res.json({
      database: { name: db.name, version: String(db.version || '').split(',')[0], sizeBytes: Number(db.size_bytes), connections: conns },
      tables: tables.map(t => ({ name: t.name, rows: Number(t.rows), sizeBytes: Number(t.size_bytes) })),
      process: { uptimeSec: Math.round(process.uptime()), rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal, nodeVersion: process.version, platform: process.platform },
      rateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE) || 180,
      generatedAt: new Date().toISOString(),
    });
  });
  router.get('/api/admin/error-log', requireAuth, requireAdminOnly, async (req, res) => {
    res.json(recentErrors());
  });
  // The loan approval chain is data (approval_workflow_steps) — shown on
  // Admin > Workflow & Approvals > Loan Approval Workflow as the live order.
  router.get('/api/admin/loan-workflow', requireAuth, requireAdminView, async (req, res) => {
    res.json({ steps: await all('SELECT s.step_order, s.role_id, s.status_label, r.name AS role_name FROM approval_workflow_steps s LEFT JOIN roles r ON r.id = s.role_id ORDER BY s.step_order') });
  });
}

module.exports = { register, HR_LISTS };
