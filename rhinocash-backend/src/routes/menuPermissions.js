// menuPermissions.js — menu & submenu permissions.
//
// Every role's sidebar menus (sections) and submenus (items) are permissions.
// They are all granted by default (the role's own menu tree in the app); the
// System Administrator switches individual ones off — or back on — for a
// whole role or for a single user. A user's own setting beats their role's.
// Keys look like "LoanBook›Collection MTD" (one submenu) or "LoanBook›*"
// (the whole menu).
//
// Where a submenu also has a server-side menu feature (the Loan Officer's
// menus, see rbac.js), switching it off is enforced on the server as well.
'use strict';
const { all, get, run } = require('./../db');
const { requireAuth, requirePermission } = require('./../middleware');
const { logAction } = require('./../audit');

const KEY_RE = /^[^›]{1,80}›[^›]{1,120}$/;
const SCOPES = ['role', 'user'];

async function settingsFor(scope, subjectId) {
  const rows = await all('SELECT item_key, allowed FROM menu_permission_settings WHERE scope = ? AND subject_id = ?', [scope, subjectId]);
  const out = {}; rows.forEach(r => { out[r.item_key] = !!r.allowed; });
  return out;
}
// What a signed-in user's own sidebar uses.
async function mySettings(user) {
  return { role: await settingsFor('role', user.role_id), user: await settingsFor('user', user.id) };
}

function register(router) {
  const canView = async (req, res, next) => {
    if (req.user.role_id === 'admin') return next();
    if (await require('./../rbac').hasPermission(req.user, 'manage_users')) return next();
    next({ status: 403, message: 'Only the System Administrator can view menu permissions' });
  };
  router.get('/api/menu-permissions', requireAuth, canView, async (req, res) => {
    const rows = await all('SELECT scope, subject_id, item_key, allowed, updated_at FROM menu_permission_settings ORDER BY scope, subject_id, item_key');
    const settings = { role: {}, user: {} };
    rows.forEach(r => { (settings[r.scope][r.subject_id] = settings[r.scope][r.subject_id] || {})[r.item_key] = !!r.allowed; });
    res.json({ settings });
  });

  router.put('/api/menu-permissions', requireAuth, requirePermission('manage_system_settings'), async (req, res, next) => {
    if (req.user.role_id !== 'admin') return next({ status: 403, message: 'Only the System Administrator can change menu permissions' });
    const b = req.body || {};
    if (!SCOPES.includes(b.scope)) return next({ status: 400, message: 'scope must be role or user' });
    const subjectId = String(b.subjectId || '');
    if (b.scope === 'role' && subjectId !== 'investor' && !(await get('SELECT id FROM roles WHERE id = ?', [subjectId]))) return next({ status: 400, message: 'Unknown role' });
    if (b.scope === 'user' && !(await get('SELECT id FROM users WHERE id = ?', [subjectId]))) return next({ status: 400, message: 'Unknown user' });
    const changes = Array.isArray(b.changes) ? b.changes : [];
    if (!changes.length || changes.length > 2000) return next({ status: 400, message: 'Send between 1 and 2000 changes' });
    for (const c of changes) {
      if (!c || !KEY_RE.test(String(c.key || ''))) return next({ status: 400, message: `Invalid menu key: ${String(c && c.key).slice(0, 60)}` });
      if (!(c.allowed === true || c.allowed === false || c.allowed === null)) return next({ status: 400, message: 'allowed must be true, false or null' });
    }
    for (const c of changes) {
      if (c.allowed === null) await run('DELETE FROM menu_permission_settings WHERE scope = ? AND subject_id = ? AND item_key = ?', [b.scope, subjectId, c.key]);
      else await run(`INSERT INTO menu_permission_settings (scope, subject_id, item_key, allowed, updated_by, updated_at) VALUES (?,?,?,?,?, iso_now())
        ON CONFLICT (scope, subject_id, item_key) DO UPDATE SET allowed = EXCLUDED.allowed, updated_by = EXCLUDED.updated_by, updated_at = iso_now()`, [b.scope, subjectId, c.key, c.allowed ? 1 : 0, req.user.id]);
    }
    await logAction(req, { action: `Changed menu permissions (${b.scope})`, module: 'admin', recordType: b.scope === 'role' ? 'Role' : 'User', recordId: subjectId,
      newValue: { changes: changes.slice(0, 50).map(c => ({ key: c.key, allowed: c.allowed })), count: changes.length }, reason: b.reason });
    res.json({ ok: true, settings: await settingsFor(b.scope, subjectId) });
  });

  // The Investor portal's own menus (investors are not staff users).
  router.get('/api/investor-portal/menu-settings', require('./investors').requireInvestorAuth, async (req, res) => {
    res.json({ role: await settingsFor('role', 'investor'), user: {} });
  });
}

module.exports = { register, mySettings, settingsFor };
