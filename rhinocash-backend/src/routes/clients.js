'use strict';
const { all, get, run } = require('./../db');
const { requireAuth, requireModule, requireAnyModule, requirePermission } = require('./../middleware');
const { logAction, notify } = require('./../audit');
const { branchScopeSQL, assertRecordInScope, resolveWriteBranchId } = require('./../rbac');
const crypto = require('node:crypto');

function generateClientCode() {
  return 'CL' + Math.floor(Math.random() * 900000 + 100000);
}

function register(router) {
  // Real server-side search/filter/pagination — was previously a single
  // unfiltered SELECT * with no scope-safe search, no way to page through
  // a large portfolio, and no total count.
  router.get('/api/clients', requireAuth, requireModule('clients'), (req, res) => {
    const scope = branchScopeSQL(req.user);
    const clauses = [scope.clause]; const params = [...scope.params];
    if (req.query.branch_id) {
      // Only honor an explicit branch_id filter if it's within the
      // requester's own real scope — never let the query parameter widen access.
      clauses.push('branch_id = ?'); params.push(req.query.branch_id);
    }
    if (req.query.region_id) {
      const regionBranches = all('SELECT id FROM branches WHERE region_id = ?', [req.query.region_id]).map(b => b.id);
      clauses.push(regionBranches.length ? `branch_id IN (${regionBranches.map(() => '?').join(',')})` : '1=0');
      params.push(...regionBranches);
    }
    if (req.query.officer_id) { clauses.push('officer_id = ?'); params.push(req.query.officer_id); }
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    if (req.query.unfunded === 'true') {
      // Real, computed — not a stored status: a client who has never had
      // a loan reach Disbursed/Active/Completed. Uses NOT EXISTS so it
      // stays accurate under pagination (a client-side filter after
      // fetching one page would silently under/over-count).
      clauses.push(`NOT EXISTS (SELECT 1 FROM loans l WHERE l.client_id = clients.id AND l.status IN ('Disbursed','Active','Completed'))`);
    }
    if (req.query.verification_status) { clauses.push('verification_status = ?'); params.push(req.query.verification_status); }
    if (req.query.q) {
      clauses.push('(name LIKE ? OR phone LIKE ? OR national_id LIKE ? OR client_code LIKE ?)');
      const like = `%${req.query.q}%`; params.push(like, like, like, like);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const total = get(`SELECT COUNT(*) as c FROM clients ${where}`, params).c;
    const rows = all(`SELECT * FROM clients ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    res.json({ clients: rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  });

  router.get('/api/clients/:id', requireAuth, requireModule('clients'), (req, res, next) => {
    const c = get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!c) return next({ status: 404, message: 'Client not found' });
    assertRecordInScope(req.user, c.branch_id, 'client'); // object-level check, not just module-level
    const interactions = all('SELECT * FROM client_interactions WHERE client_id = ? ORDER BY created_at DESC', [c.id]);
    const documents = all('SELECT * FROM client_documents WHERE client_id = ? ORDER BY created_at DESC', [c.id]);
    const loans = all('SELECT * FROM loans WHERE client_id = ? ORDER BY created_at DESC', [c.id]);
    loans.forEach(loan => { loan.schedule = all('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY period', [loan.id]); });
    // Real payment history for this client — the profile's own payments
    // tab, not recalculated, straight from the same table Payments uses.
    const payments = all(
      `SELECT p.* FROM payments p JOIN loans l ON l.id = p.loan_id WHERE l.client_id = ? ORDER BY p.created_at DESC`,
      [c.id]
    );
    res.json({ client: c, interactions, documents, loans, payments });
  });

  router.post('/api/clients', requireAuth, requireModule('clients'), (req, res, next) => {
    const b = req.body;
    if (!b.name || !b.phone) return next({ status: 400, message: 'name and phone are required' });
    // Exact-phone duplicate rejection — a real, documented business rule
    // (this system treats phone as the practical unique contact key;
    // national_id is NOT required to be unique, since shared family/
    // business contacts on a single ID are common and legitimate).
    const dup = get('SELECT id, name FROM clients WHERE phone = ?', [b.phone]);
    if (dup) return next({ status: 409, message: `A client with this phone number already exists: ${dup.name} (${dup.id})` });

    const branchId = resolveWriteBranchId(req.user, b.branch_id); // never trusts b.branch_id blindly for restricted roles

    let officerId = null;
    if (b.officer_id) {
      const officer = get('SELECT * FROM users WHERE id = ?', [b.officer_id]);
      if (!officer) return next({ status: 400, message: 'officer_id does not refer to a real user' });
      if (officer.role_id !== 'loan_officer') return next({ status: 400, message: 'Only a user with the Loan Officer role can be assigned to a client' });
      if (officer.status !== 'Active') return next({ status: 409, message: 'Cannot assign an inactive Loan Officer to a client' });
      if (officer.branch_id && officer.branch_id !== branchId) return next({ status: 409, message: 'This Loan Officer belongs to a different branch than the client is being registered under' });
      officerId = officer.id;
    } else if (req.user.role_id === 'loan_officer') {
      officerId = req.user.id; // an officer registering their own client defaults to themselves
    }

    const id = 'cl_' + crypto.randomUUID();
    const code = generateClientCode();
    run(
      `INSERT INTO clients (id, client_code, name, gender, national_id, phone, email, address, next_of_kin, next_of_kin_phone, business_type, client_type, branch_id, officer_id, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, code, b.name, b.gender || null, b.national_id || null, b.phone, b.email || null, b.address || null,
        b.next_of_kin || null, b.next_of_kin_phone || null, b.business_type || null,
        b.client_type || 'Individual', branchId, officerId, req.user.id]
    );
    logAction(req, { action: 'Created client', module: 'clients', recordType: 'Client', recordId: id, newValue: { name: b.name, branch_id: branchId } });
    res.status(201).json({ client: get('SELECT * FROM clients WHERE id = ?', [id]) });
  });

  router.patch('/api/clients/:id', requireAuth, requireModule('clients'), (req, res, next) => {
    const before = get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!before) return next({ status: 404, message: 'Client not found' });
    assertRecordInScope(req.user, before.branch_id, 'client');
    const fields = ['name', 'gender', 'national_id', 'phone', 'email', 'address', 'next_of_kin', 'next_of_kin_phone', 'business_type', 'client_type', 'status'];
    const sets = []; const params = [];
    if (req.body.phone !== undefined && req.body.phone !== before.phone) {
      const dup = get('SELECT id, name FROM clients WHERE phone = ? AND id != ?', [req.body.phone, before.id]);
      if (dup) return next({ status: 409, message: `Another client already uses this phone number: ${dup.name}` });
    }
    fields.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); } });
    // Moving a client to a different branch is a distinct, deliberately
    // scoped action — not a side effect of an ordinary field edit — and is
    // itself validated against the actor's own scope (can't be used to
    // launder a record into or out of a branch they don't control).
    if (req.body.branch_id !== undefined) {
      const newBranch = resolveWriteBranchId(req.user, req.body.branch_id);
      sets.push('branch_id = ?'); params.push(newBranch);
    }
    if (req.body.officer_id !== undefined) {
      if (req.body.officer_id === null || req.body.officer_id === '') {
        sets.push('officer_id = ?'); params.push(null);
      } else {
        const officer = get('SELECT * FROM users WHERE id = ?', [req.body.officer_id]);
        if (!officer) return next({ status: 400, message: 'officer_id does not refer to a real user' });
        if (officer.role_id !== 'loan_officer') return next({ status: 400, message: 'Only a user with the Loan Officer role can be assigned to a client' });
        if (officer.status !== 'Active') return next({ status: 409, message: 'Cannot assign an inactive Loan Officer to a client' });
        sets.push('officer_id = ?'); params.push(officer.id);
      }
    }
    if (!sets.length) return next({ status: 400, message: 'No recognized fields' });
    params.push(req.params.id);
    run(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`, params);
    logAction(req, { action: 'Updated client', module: 'clients', recordType: 'Client', recordId: req.params.id, previousValue: before, newValue: req.body });
    res.json({ client: get('SELECT * FROM clients WHERE id = ?', [req.params.id]) });
  });

  // KYC verification — a distinct, auditable decision, not a side effect
  // of an ordinary PATCH. Requires real authority (branch-scoped manage
  // authority), not just general 'clients' module access.
  router.post('/api/clients/:id/verify', requireAuth, requireModule('clients'), (req, res, next) => {
    const client = get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    assertRecordInScope(req.user, client.branch_id, 'client');
    const allowedRoles = ['manager', 'regional_manager', 'operational_manager', 'admin', 'accountant'];
    if (!allowedRoles.includes(req.user.role_id)) return next({ status: 403, message: 'Your role is not authorized to change KYC verification status' });
    const decision = req.body.status;
    if (!['Verified', 'Rejected', 'Pending'].includes(decision)) return next({ status: 400, message: 'status must be Verified, Rejected, or Pending' });
    run('UPDATE clients SET verification_status = ?, verified_by = ?, verified_at = datetime(\'now\') WHERE id = ?', [decision, req.user.id, client.id]);
    logAction(req, { action: 'Changed client KYC status', module: 'clients', recordType: 'Client', recordId: client.id, previousValue: { verification_status: client.verification_status }, newValue: { verification_status: decision } });
    res.json({ client: get('SELECT * FROM clients WHERE id = ?', [client.id]) });
  });

  router.post('/api/clients/:id/interactions', requireAuth, requireModule('clients'), (req, res, next) => {
    const client = get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    assertRecordInScope(req.user, client.branch_id, 'client');
    const id = 'int_' + crypto.randomUUID();
    run('INSERT INTO client_interactions (id, client_id, type, note, staff_id) VALUES (?,?,?,?,?)',
      [id, req.params.id, req.body.type || 'Note', req.body.note || '', req.user.id]);
    logAction(req, { action: 'Logged interaction', module: 'clients', recordType: 'Client', recordId: req.params.id, newValue: req.body.type });
    res.status(201).json({ interaction: get('SELECT * FROM client_interactions WHERE id = ?', [id]) });
  });

  // Document metadata only here — actual bytes go through /api/uploads (see server.js).
  router.post('/api/clients/:id/documents', requireAuth, requireModule('clients'), (req, res, next) => {
    const client = get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    assertRecordInScope(req.user, client.branch_id, 'client');
    if (!req.body.file_path) return next({ status: 400, message: 'file_path is required — upload the file via /api/uploads first' });
    const id = 'doc_' + crypto.randomUUID();
    run('INSERT INTO client_documents (id, client_id, name, doc_type, file_path, uploaded_by) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, req.body.name || req.body.doc_type || 'Document', req.body.doc_type || 'Other', req.body.file_path, req.user.id]);
    logAction(req, { action: 'Added client document', module: 'clients', recordType: 'Client', recordId: req.params.id, newValue: req.body.doc_type });
    res.status(201).json({ document: get('SELECT * FROM client_documents WHERE id = ?', [id]) });
  });

  // Leads
  router.get('/api/leads', requireAuth, requireModule('clients'), (req, res) => {
    // Real branch/region scoping — a Loan Officer sees only their own
    // real branch's leads, a Regional Manager their real region, CEO/
    // Admin the real company-wide set. Previously this had no scoping
    // at all, meaning every role saw every lead regardless of branch.
    const scope = branchScopeSQL(req.user);
    const clauses = [scope.clause]; const params = [...scope.params];
    if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
    const rows = all(`SELECT * FROM client_leads WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params);
    res.json({ leads: rows });
  });
  router.post('/api/leads', requireAuth, requireModule('clients'), (req, res, next) => {
    const b = req.body;
    if (!b.name) return next({ status: 400, message: 'name is required' });
    const id = 'lead_' + crypto.randomUUID();
    run('INSERT INTO client_leads (id, name, phone, source, notes, created_by) VALUES (?,?,?,?,?,?)',
      [id, b.name, b.phone || null, b.source || null, b.notes || null, req.user.id]);
    logAction(req, { action: 'Created lead', module: 'clients', recordType: 'Lead', recordId: id, newValue: { name: b.name } });
    res.status(201).json({ lead: get('SELECT * FROM client_leads WHERE id = ?', [id]) });
  });
  router.post('/api/leads/:id/convert', requireAuth, requireModule('clients'), (req, res, next) => {
    const lead = get('SELECT * FROM client_leads WHERE id = ?', [req.params.id]);
    if (!lead) return next({ status: 404, message: 'Lead not found' });
    if (lead.status === 'Converted') return next({ status: 409, message: 'This lead has already been converted — cannot create a duplicate client from it' });
    // Real duplicate protection at conversion time too, same rule as
    // ordinary client creation — a lead's phone might already have become
    // a client through some other path since the lead was created.
    if (lead.phone) {
      const dup = get('SELECT id, name FROM clients WHERE phone = ?', [lead.phone]);
      if (dup) return next({ status: 409, message: `A client with this phone number already exists: ${dup.name} — cannot convert into a duplicate` });
    }
    const branchId = resolveWriteBranchId(req.user, req.body.branch_id);
    const clientId = 'cl_' + crypto.randomUUID();
    const code = generateClientCode();
    const officerId = req.user.role_id === 'loan_officer' ? req.user.id : null;
    run('INSERT INTO clients (id, client_code, name, phone, branch_id, officer_id, created_by) VALUES (?,?,?,?,?,?,?)',
      [clientId, code, lead.name, lead.phone, branchId, officerId, req.user.id]);
    run('UPDATE client_leads SET status = ?, converted_client_id = ? WHERE id = ?', ['Converted', clientId, lead.id]);
    logAction(req, { action: 'Converted lead to client', module: 'clients', recordType: 'Lead', recordId: lead.id, newValue: clientId });
    res.json({ client: get('SELECT * FROM clients WHERE id = ?', [clientId]) });
  });
}

module.exports = { register };
