'use strict';
const { all, get, run } = require('./../db');
const { requireAuth, requirePermission } = require('./../middleware');
const { logAction } = require('./../audit');
const crypto = require('node:crypto');

function requireAdminOnly(req, res, next) {
  if (req.user.role_id !== 'admin') return next({ status: 403, message: 'Only the Master System Administrator can perform this action' });
  next();
}
// View-only visibility for org settings/sessions/maintenance status —
// Admin (owner), CEO/Director (executive/governance visibility), same
// tier used elsewhere in this codebase for adjacent system-level pages.
function requireSystemAdminView(req, res, next) {
  if (['admin', 'ceo', 'director'].includes(req.user.role_id)) return next();
  return next({ status: 403, message: 'Your role does not have System Administration visibility' });
}

async function ensureOrgRow() {
  if (!(await get('SELECT id FROM organization_settings WHERE id = 1'))) {
    await run('INSERT INTO organization_settings (id) VALUES (1)');
  }
}
async function ensureSystemRow() {
  if (!(await get('SELECT id FROM system_settings WHERE id = 1'))) {
    await run('INSERT INTO system_settings (id) VALUES (1)');
  }
}

function register(router) {
  // ==================== Organization Settings ====================
  router.get('/api/system/organization', requireAuth, requireSystemAdminView, async (req, res) => {
    await ensureOrgRow();
    res.json({ organization: await get('SELECT * FROM organization_settings WHERE id = 1') });
  });
  router.put('/api/system/organization', requireAuth, requirePermission('manage_system_settings'), requireAdminOnly, async (req, res, next) => {
    await ensureOrgRow();
    const fields = ['company_name', 'trading_name', 'registration_number', 'address', 'phone', 'email', 'website', 'currency', 'timezone', 'financial_year_start_month'];
    const before = await get('SELECT * FROM organization_settings WHERE id = 1');
    const sets = []; const params = [];
    fields.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); } });
    if (!sets.length) return next({ status: 400, message: 'Nothing to update' });
    sets.push('updated_by = ?', "updated_at = iso_now()");
    params.push(req.user.id);
    await run(`UPDATE organization_settings SET ${sets.join(', ')} WHERE id = 1`, params);
    const after = await get('SELECT * FROM organization_settings WHERE id = 1');
    await logAction(req, { action: 'Updated organization settings', module: 'admin', recordType: 'OrganizationSettings', recordId: '1', previousValue: before, newValue: after });
    res.json({ organization: after });
  });

  // ==================== Active Sessions ====================
  // Real, joined against real users — never exposes token_hash's raw
  // secret (it's already a one-way hash, but even that isn't returned
  // beyond what's needed to target a revoke action).
  router.get('/api/system/sessions', requireAuth, requireAdminOnly, async (req, res) => {
    const rows = await all(
      `SELECT s.token_hash, s.user_id, s.created_at, s.expires_at, s.revoked_at, s.ip, s.user_agent, u.name, u.email, u.role_id
       FROM sessions s LEFT JOIN users u ON u.id = s.user_id
       WHERE s.revoked_at IS NULL AND s.expires_at > iso_now()
       ORDER BY s.created_at DESC LIMIT 200`
    );
    res.json({ sessions: rows.map(r => ({ ...r, token_hash: undefined, id: r.token_hash })) });
  });
  router.post('/api/system/sessions/:id/revoke', requireAuth, requireAdminOnly, async (req, res, next) => {
    const session = await get('SELECT * FROM sessions WHERE token_hash = ?', [req.params.id]);
    if (!session) return next({ status: 404, message: 'Session not found' });
    await run("UPDATE sessions SET revoked_at = iso_now() WHERE token_hash = ?", [req.params.id]);
    await logAction(req, { action: 'Revoked individual session', module: 'admin', recordType: 'Session', recordId: session.user_id });
    res.json({ ok: true });
  });

  // ==================== Maintenance Mode ====================
  router.get('/api/system/maintenance', requireAuth, requireSystemAdminView, async (req, res) => {
    await ensureSystemRow();
    const row = await get('SELECT * FROM system_settings WHERE id = 1');
    res.json({ maintenanceMode: !!row.maintenance_mode, message: row.maintenance_message });
  });

  // Real, configurable session-expiry-warning lead time — previously
  // hardcoded to 5 minutes in the frontend with no way to change it.
  // Reuses the same system_settings row (never a second settings table).
  router.get('/api/system/security-settings', requireAuth, requireSystemAdminView, async (req, res) => {
    await ensureSystemRow();
    const row = await get('SELECT * FROM system_settings WHERE id = 1');
    res.json({ sessionWarningMinutes: row.session_warning_minutes });
  });
  router.put('/api/system/security-settings', requireAuth, requirePermission('manage_system_settings'), requireAdminOnly, async (req, res, next) => {
    await ensureSystemRow();
    const minutes = parseInt(req.body.sessionWarningMinutes, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 60) {
      return next({ status: 400, message: 'sessionWarningMinutes must be a real number between 1 and 60' });
    }
    await run("UPDATE system_settings SET session_warning_minutes = ?, updated_by = ?, updated_at = iso_now() WHERE id = 1", [minutes, req.user.id]);
    await logAction(req, { action: 'Updated session warning lead time', module: 'admin', recordType: 'SystemSettings', recordId: '1', newValue: { sessionWarningMinutes: minutes } });
    res.json({ ok: true, sessionWarningMinutes: minutes });
  });

  router.put('/api/system/maintenance', requireAuth, requirePermission('manage_system_settings'), requireAdminOnly, async (req, res, next) => {
    await ensureSystemRow();
    if (req.body.enabled === undefined) return next({ status: 400, message: 'enabled is required' });
    await run("UPDATE system_settings SET maintenance_mode = ?, maintenance_message = ?, updated_by = ?, updated_at = iso_now() WHERE id = 1",
      [req.body.enabled ? 1 : 0, req.body.message || null, req.user.id]);
    await logAction(req, { action: req.body.enabled ? 'Enabled maintenance mode' : 'Disabled maintenance mode', module: 'admin', recordType: 'SystemSettings', recordId: '1', newValue: { message: req.body.message } });
    res.json({ ok: true, maintenanceMode: !!req.body.enabled });
  });

  // ==================== Backup ====================
  // Real, bounded backup: a genuine JSON snapshot of the actual current
  // data in every real business table, returned directly (this
  // environment has no separate file-storage service to write to) so the
  // frontend can offer it as a real download — never a fabricated
  // "backup completed" with no underlying data.
  const BACKUP_TABLES = [
    'users', 'roles', 'branches', 'regions', 'clients', 'loans', 'loan_schedule', 'payments',
    'journal_entries', 'gl_accounts', 'investors', 'investor_payouts', 'support_tickets',
    'organization_settings', 'system_settings',
  ];
  router.post('/api/system/backup', requireAuth, requireAdminOnly, async (req, res, next) => {
    try {
      const snapshot = {};
      let rowCount = 0;
      for (const t of BACKUP_TABLES) {
        const rows = await all(`SELECT * FROM ${t}`);
        snapshot[t] = rows;
        rowCount += rows.length;
      }
      const json = JSON.stringify({ createdAt: new Date().toISOString(), tables: snapshot });
      const id = 'bak_' + crypto.randomUUID();
      await run('INSERT INTO backups (id, status, table_count, row_count, size_bytes, created_by) VALUES (?,?,?,?,?,?)',
        [id, 'Completed', BACKUP_TABLES.length, rowCount, Buffer.byteLength(json), req.user.id]);
      await logAction(req, { action: 'Created system backup', module: 'admin', recordType: 'Backup', recordId: id, newValue: { tableCount: BACKUP_TABLES.length, rowCount } });
      res.json({ backup: await get('SELECT * FROM backups WHERE id = ?', [id]), snapshot: json });
    } catch (e) {
      const id = 'bak_' + crypto.randomUUID();
      await run('INSERT INTO backups (id, status, created_by) VALUES (?,?,?)', [id, 'Failed', req.user.id]);
      await logAction(req, { action: 'Backup failed', module: 'admin', recordType: 'Backup', recordId: id });
      next({ status: 500, message: 'Backup failed — see audit log' });
    }
  });
  router.get('/api/system/backups', requireAuth, requireAdminOnly, async (req, res) => {
    res.json({ backups: await all('SELECT id, status, table_count, row_count, size_bytes, created_by, created_at FROM backups ORDER BY created_at DESC LIMIT 50') });
  });
}

module.exports = { register };
