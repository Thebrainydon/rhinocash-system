// staffForms.js — HR › Staff Details Form. One form per employee (personal
// details, emergency contact, next of kin, declaration date), filled in and
// kept by HR, printed or downloaded with the company's letterhead. Empty
// personal fields are offered from the employee's record; saving the form
// never changes the employee record itself.
'use strict';
const { all, get, run } = require('./../db');
const { requireAuth } = require('./../middleware');
const { logAction } = require('./../audit');
const { hasModuleAccess, hasPermission } = require('./../rbac');

async function requireHrView(req, res, next) { return (await hasModuleAccess(req.user, 'hr')) ? next() : next({ status: 403, message: 'Your role does not have HR access' }); }
async function requireHrWrite(req, res, next) {
  return (await hasModuleAccess(req.user, 'hr')) && (await hasPermission(req.user, 'manage_hr')) ? next() : next({ status: 403, message: 'Your role is not allowed to change HR records' });
}

// Every field the paper form has, in its order.
const FORM_FIELDS = [
  'full_name', 'staff_id', 'department', 'branch', 'job_title', 'national_id', 'phone', 'email', 'residential_address',
  'em_name', 'em_relationship', 'em_phone', 'em_alt_phone', 'em_address',
  'nok_name', 'nok_relationship', 'nok_phone', 'nok_alt_phone', 'nok_address',
  'declaration_date',
];
const COMPANY_FIELDS = ['name', 'tagline', 'address', 'phone', 'phone2', 'email', 'website'];
const COMPANY_KEY = 'hr.staff-form-company';
const clean = (v, max) => { if (v === undefined || v === null) return ''; return String(v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max); };
const parse = t => { try { return JSON.parse(t) || {}; } catch { return {}; } };

// The employee's record, as the form's personal details.
async function fromRecord(userId) {
  const u = await get(`SELECT u.id, u.name, u.staff_code, u.job_title, u.national_id, u.phone, u.email, d.name AS department, b.name AS branch
    FROM users u LEFT JOIN departments d ON d.id = u.department_id LEFT JOIN branches b ON b.id = u.branch_id WHERE u.id = ?`, [userId]).catch(() => null)
    || await get('SELECT id, name, staff_code, job_title, national_id, phone, email FROM users WHERE id = ?', [userId]);
  if (!u) return null;
  return { full_name: u.name || '', staff_id: u.staff_code || '', department: u.department || '', branch: u.branch || '', job_title: u.job_title || '',
    national_id: u.national_id || '', phone: u.phone || '', email: u.email || '' };
}
async function company() {
  const org = await get('SELECT * FROM organization_settings WHERE id = 1').catch(() => null) || {};
  const row = await get('SELECT value_json, updated_at FROM admin_settings WHERE key = ?', [COMPANY_KEY]);
  const saved = row ? parse(row.value_json) : {};
  const def = { name: org.company_name || org.trading_name || 'Rhinocash Ltd', tagline: 'Your reliable lending partner', address: org.address || '',
    phone: org.phone || '', phone2: '', email: org.email || '', website: org.website || '' };
  const out = {}; COMPANY_FIELDS.forEach(f => { out[f] = saved[f] !== undefined ? saved[f] : def[f]; });
  return out;
}
const filled = data => FORM_FIELDS.filter(f => String(data[f] || '').trim()).length;

function register(router) {
  router.get('/api/hr/staff-forms', requireAuth, requireHrView, async (req, res) => {
    const rows = await all(`SELECT u.id, u.name, u.staff_code, u.role_id, u.branch_id, u.status, f.data, f.updated_at, ub.name AS updated_by_name
      FROM users u LEFT JOIN staff_detail_forms f ON f.user_id = u.id LEFT JOIN users ub ON ub.id = f.updated_by ORDER BY u.name`);
    res.json({ total: FORM_FIELDS.length, forms: rows.map(r => ({ userId: r.id, name: r.name, staffCode: r.staff_code, roleId: r.role_id, branchId: r.branch_id, status: r.status,
      filled: r.data ? filled(parse(r.data)) : 0, saved: !!r.data, updatedAt: r.updated_at || null, updatedBy: r.updated_by_name || null })) });
  });

  router.get('/api/hr/staff-forms/company', requireAuth, requireHrView, async (req, res) => { res.json({ company: await company() }); });

  router.put('/api/hr/staff-forms/company', requireAuth, requireHrWrite, async (req, res) => {
    const b = req.body || {};
    const value = {}; COMPANY_FIELDS.forEach(f => { value[f] = clean(b[f], f === 'address' ? 200 : 120); });
    if (!value.name) value.name = (await company()).name;
    const before = await get('SELECT value_json FROM admin_settings WHERE key = ?', [COMPANY_KEY]);
    const json = JSON.stringify(value);
    await run(`INSERT INTO admin_settings (key, value_json, updated_by, updated_at) VALUES (?,?,?, iso_now())
      ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = iso_now()`, [COMPANY_KEY, json, req.user.id]);
    await run('INSERT INTO admin_settings_history (key, previous_json, new_json, changed_by, changed_by_name) VALUES (?,?,?,?,?)',
      [COMPANY_KEY, before ? before.value_json : null, json, req.user.id, req.user.name]);
    await logAction(req, { action: 'Updated staff form company details', module: 'hr', recordType: 'AdminSettings', recordId: COMPANY_KEY,
      previousValue: before ? parse(before.value_json) : null, newValue: value });
    res.json({ company: value });
  });

  router.get('/api/hr/staff-forms/:userId', requireAuth, requireHrView, async (req, res, next) => {
    const rec = await fromRecord(req.params.userId);
    if (!rec) return next({ status: 404, message: 'Employee not found' });
    const f = await get(`SELECT f.*, ub.name AS updated_by_name FROM staff_detail_forms f LEFT JOIN users ub ON ub.id = f.updated_by WHERE f.user_id = ?`, [req.params.userId]);
    const saved = f ? parse(f.data) : {};
    const form = {}; FORM_FIELDS.forEach(k => { form[k] = saved[k] !== undefined && saved[k] !== '' ? saved[k] : (rec[k] || ''); });
    res.json({ userId: req.params.userId, form, saved: !!f, updatedAt: f ? f.updated_at : null, updatedBy: f ? f.updated_by_name : null, record: rec, company: await company() });
  });

  router.put('/api/hr/staff-forms/:userId', requireAuth, requireHrWrite, async (req, res, next) => {
    const rec = await fromRecord(req.params.userId);
    if (!rec) return next({ status: 404, message: 'Employee not found' });
    const b = (req.body && req.body.form) || {};
    const data = {}; FORM_FIELDS.forEach(k => { data[k] = clean(b[k], /address/.test(k) ? 200 : 120); });
    if (data.declaration_date && !/^\d{4}-\d{2}-\d{2}$/.test(data.declaration_date)) return next({ status: 400, message: 'Declaration date must be a date' });
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return next({ status: 400, message: 'Email address is not valid' });
    const before = await get('SELECT data FROM staff_detail_forms WHERE user_id = ?', [req.params.userId]);
    await run(`INSERT INTO staff_detail_forms (user_id, data, updated_by, updated_at) VALUES (?,?,?, iso_now())
      ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = iso_now()`, [req.params.userId, JSON.stringify(data), req.user.id]);
    await logAction(req, { action: before ? 'Updated staff details form' : 'Filled in staff details form', module: 'hr', recordType: 'User', recordId: req.params.userId,
      previousValue: before ? parse(before.data) : null, newValue: data });
    res.json({ ok: true, form: data, filled: filled(data), total: FORM_FIELDS.length });
  });
}

module.exports = { register, FORM_FIELDS };
