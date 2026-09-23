'use strict';
const { all, get, run, transaction } = require('./../db');
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
  router.get('/api/clients', requireAuth, requireModule('clients'), async (req, res) => {
    const scope = await branchScopeSQL(req.user);
    const clauses = [scope.clause]; const params = [...scope.params];
    if (req.query.branch_id) {
      // Only honor an explicit branch_id filter if it's within the
      // requester's own real scope — never let the query parameter widen access.
      clauses.push('branch_id = ?'); params.push(req.query.branch_id);
    }
    if (req.query.region_id) {
      const regionBranchRows = await all('SELECT id FROM branches WHERE region_id = ?', [req.query.region_id]);
      const regionBranches = regionBranchRows.map(b => b.id);
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
    const total = (await get(`SELECT COUNT(*) as c FROM clients ${where}`, params)).c;
    const rows = await all(`SELECT * FROM clients ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    res.json({ clients: rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  });

  // Registered before /api/clients/:id so "interactions" is never
  // swallowed as a client id by that route's :id param.
  router.get('/api/clients/interactions', requireAuth, requireModule('clients'), async (req, res) => {
    const scope = await branchScopeSQL(req.user, 'c.branch_id');
    const clauses = [scope.clause]; const params = [...scope.params];
    if (req.user.role_id === 'loan_officer') { clauses.push('c.officer_id = ?'); params.push(req.user.id); }
    if (req.query.branch_id) { clauses.push('c.branch_id = ?'); params.push(req.query.branch_id); }
    if (req.query.officer_id && req.user.role_id !== 'loan_officer') { clauses.push('c.officer_id = ?'); params.push(req.query.officer_id); }
    if (req.query.from) { clauses.push('(ci.created_at)::date >= ?'); params.push(req.query.from); }
    if (req.query.to) { clauses.push('(ci.created_at)::date <= ?'); params.push(req.query.to); }
    if (req.query.q) {
      clauses.push('(c.name LIKE ? OR c.phone LIKE ?)');
      const like = `%${req.query.q}%`; params.push(like, like);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const baseQuery = `FROM client_interactions ci
      JOIN clients c ON c.id = ci.client_id
      LEFT JOIN users o ON o.id = c.officer_id
      LEFT JOIN users s ON s.id = ci.staff_id
      ${where}`;
    const total = (await get(`SELECT COUNT(*) as c ${baseQuery}`, params)).c;
    const rows = await all(
      `SELECT ci.id, ci.type, ci.note, ci.created_at,
              c.id as client_id, c.name as client_name, c.phone as client_phone, c.status as client_status,
              c.officer_id, o.name as officer_name, s.name as staff_name
       ${baseQuery} ORDER BY ci.created_at DESC, ci.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({ interactions: rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  });

  router.get('/api/clients/:id', requireAuth, requireModule('clients'), async (req, res, next) => {
    const c = await get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!c) return next({ status: 404, message: 'Client not found' });
    try { await assertRecordInScope(req.user, c.branch_id, 'client'); } catch (e) { return next(e); } // object-level check, not just module-level
    const interactions = await all('SELECT * FROM client_interactions WHERE client_id = ? ORDER BY created_at DESC', [c.id]);
    const documents = await all('SELECT * FROM client_documents WHERE client_id = ? ORDER BY created_at DESC', [c.id]);
    const loans = await all('SELECT * FROM loans WHERE client_id = ? ORDER BY created_at DESC', [c.id]);
    for (const loan of loans) { loan.schedule = await all('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY period', [loan.id]); }
    // Real payment history for this client — the profile's own payments
    // tab, not recalculated, straight from the same table Payments uses.
    const payments = await all(
      `SELECT p.* FROM payments p JOIN loans l ON l.id = p.loan_id WHERE l.client_id = ? ORDER BY p.created_at DESC`,
      [c.id]
    );
    res.json({ client: c, interactions, documents, loans, payments });
  });

  router.post('/api/clients', requireAuth, requireModule('clients'), async (req, res, next) => {
    const b = req.body;
    if (!b.name || !b.phone) return next({ status: 400, message: 'name and phone are required' });
    // Exact-phone duplicate rejection — a real, documented business rule
    // (this system treats phone as the practical unique contact key;
    // national_id is NOT required to be unique, since shared family/
    // business contacts on a single ID are common and legitimate).
    const dup = await get('SELECT id, name FROM clients WHERE phone = ?', [b.phone]);
    if (dup) return next({ status: 409, message: `A client with this phone number already exists: ${dup.name} (${dup.id})` });

    let branchId;
    try { branchId = await resolveWriteBranchId(req.user, b.branch_id); } catch (e) { return next(e); } // never trusts b.branch_id blindly for restricted roles

    let officerId = null;
    if (b.officer_id) {
      const officer = await get('SELECT * FROM users WHERE id = ?', [b.officer_id]);
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
    // A freshly registered client genuinely has no loan/transaction
    // activity yet — real, not the schema's own 'Active' default — so
    // they start Dormant, matching the real View Client "Dormant
    // clients" category filter, until a real loan or transaction moves
    // them to Active. Bulk import and lead-conversion still use the
    // schema default; this is scoped to the single Add Client form only.
    await run(
      `INSERT INTO clients (id, client_code, name, gender, national_id, phone, email, address, next_of_kin, next_of_kin_phone, business_type, client_type, branch_id, officer_id, created_by, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, code, b.name, b.gender || null, b.national_id || null, b.phone, b.email || null, b.address || null,
        b.next_of_kin || null, b.next_of_kin_phone || null, b.business_type || null,
        b.client_type || 'Individual', branchId, officerId, req.user.id, 'Dormant']
    );
    await logAction(req, { action: 'Created client', module: 'clients', recordType: 'Client', recordId: id, newValue: { name: b.name, branch_id: branchId } });
    res.status(201).json({ client: await get('SELECT * FROM clients WHERE id = ?', [id]) });
  });

  // Bulk import — a real CSV template (Name/Contact/Idno/Loan officer/
  // Location/Kin contact/Next of kin/Business type). "Loan officer" is
  // looked up by staff_code (each staff member's real "ID Number ... as
  // in the system") against users with the Loan Officer role — never a
  // free-text name, so a typo can't silently misassign a client. Each row
  // reuses the exact same validation/branch-resolution as a single real
  // POST /api/clients; a bad row is skipped and reported, never allowed
  // to abort rows that were valid.
  router.post('/api/clients/bulk', requireAuth, requireModule('clients'), async (req, res, next) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return next({ status: 400, message: 'No rows to import' });
    const created = [];
    const errors = [];
    await transaction(async () => {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i] || {};
        const rowNum = i + 2; // spreadsheet row 1 is the header
        if (!r.name || !r.phone) { errors.push({ row: rowNum, error: 'Name and Contact (phone) are required' }); continue; }
        const dup = await get('SELECT id, name FROM clients WHERE phone = ?', [r.phone]);
        if (dup) { errors.push({ row: rowNum, error: `A client with this phone number already exists: ${dup.name}` }); continue; }

        let branchId;
        try { branchId = await resolveWriteBranchId(req.user, null); } catch (e) { errors.push({ row: rowNum, error: e.message }); continue; }

        let officerId = null;
        if (r.loan_officer) {
          const officer = await get(`SELECT * FROM users WHERE staff_code = ? AND role_id = 'loan_officer'`, [r.loan_officer]);
          if (!officer) { errors.push({ row: rowNum, error: `Loan officer ID "${r.loan_officer}" was not found` }); continue; }
          if (officer.status !== 'Active') { errors.push({ row: rowNum, error: `Loan officer ID "${r.loan_officer}" is not an active staff member` }); continue; }
          if (officer.branch_id && officer.branch_id !== branchId) { errors.push({ row: rowNum, error: `Loan officer ID "${r.loan_officer}" belongs to a different branch than this import is registering clients under` }); continue; }
          officerId = officer.id;
        } else if (req.user.role_id === 'loan_officer') {
          officerId = req.user.id;
        }

        const id = 'cl_' + crypto.randomUUID();
        const code = generateClientCode();
        await run(
          `INSERT INTO clients (id, client_code, name, national_id, phone, address, next_of_kin, next_of_kin_phone, business_type, branch_id, officer_id, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, code, r.name, r.national_id || null, r.phone, r.location || null, r.next_of_kin || null, r.kin_contact || null, r.business_type || null, branchId, officerId, req.user.id]
        );
        created.push(id);
      }
    });
    await logAction(req, { action: 'Bulk-imported clients', module: 'clients', recordType: 'Client', recordId: null, newValue: { created: created.length, errors: errors.length } });
    res.status(created.length ? 201 : 400).json({ created: created.length, errors });
  });

  router.patch('/api/clients/:id', requireAuth, requireModule('clients'), async (req, res, next) => {
    const before = await get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!before) return next({ status: 404, message: 'Client not found' });
    try { await assertRecordInScope(req.user, before.branch_id, 'client'); } catch (e) { return next(e); }
    const fields = ['name', 'gender', 'national_id', 'phone', 'email', 'address', 'next_of_kin', 'next_of_kin_phone', 'business_type', 'client_type', 'status'];
    const sets = []; const params = [];
    if (req.body.phone !== undefined && req.body.phone !== before.phone) {
      const dup = await get('SELECT id, name FROM clients WHERE phone = ? AND id != ?', [req.body.phone, before.id]);
      if (dup) return next({ status: 409, message: `Another client already uses this phone number: ${dup.name}` });
    }
    fields.forEach(f => { if (req.body[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); } });
    // Moving a client to a different branch is a distinct, deliberately
    // scoped action — not a side effect of an ordinary field edit — and is
    // itself validated against the actor's own scope (can't be used to
    // launder a record into or out of a branch they don't control).
    if (req.body.branch_id !== undefined) {
      let newBranch;
      try { newBranch = await resolveWriteBranchId(req.user, req.body.branch_id); } catch (e) { return next(e); }
      sets.push('branch_id = ?'); params.push(newBranch);
    }
    if (req.body.officer_id !== undefined) {
      if (req.body.officer_id === null || req.body.officer_id === '') {
        sets.push('officer_id = ?'); params.push(null);
      } else {
        const officer = await get('SELECT * FROM users WHERE id = ?', [req.body.officer_id]);
        if (!officer) return next({ status: 400, message: 'officer_id does not refer to a real user' });
        if (officer.role_id !== 'loan_officer') return next({ status: 400, message: 'Only a user with the Loan Officer role can be assigned to a client' });
        if (officer.status !== 'Active') return next({ status: 409, message: 'Cannot assign an inactive Loan Officer to a client' });
        sets.push('officer_id = ?'); params.push(officer.id);
      }
    }
    if (!sets.length) return next({ status: 400, message: 'No recognized fields' });
    params.push(req.params.id);
    await run(`UPDATE clients SET ${sets.join(', ')} WHERE id = ?`, params);
    await logAction(req, { action: 'Updated client', module: 'clients', recordType: 'Client', recordId: req.params.id, previousValue: before, newValue: req.body });
    res.json({ client: await get('SELECT * FROM clients WHERE id = ?', [req.params.id]) });
  });

  // KYC verification — a distinct, auditable decision, not a side effect
  // of an ordinary PATCH. Requires real authority (branch-scoped manage
  // authority), not just general 'clients' module access.
  router.post('/api/clients/:id/verify', requireAuth, requireModule('clients'), async (req, res, next) => {
    const client = await get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    try { await assertRecordInScope(req.user, client.branch_id, 'client'); } catch (e) { return next(e); }
    const allowedRoles = ['manager', 'regional_manager', 'operational_manager', 'admin', 'accountant'];
    if (!allowedRoles.includes(req.user.role_id)) return next({ status: 403, message: 'Your role is not authorized to change KYC verification status' });
    const decision = req.body.status;
    if (!['Verified', 'Rejected', 'Pending'].includes(decision)) return next({ status: 400, message: 'status must be Verified, Rejected, or Pending' });
    await run("UPDATE clients SET verification_status = ?, verified_by = ?, verified_at = iso_now() WHERE id = ?", [decision, req.user.id, client.id]);
    await logAction(req, { action: 'Changed client KYC status', module: 'clients', recordType: 'Client', recordId: client.id, previousValue: { verification_status: client.verification_status }, newValue: { verification_status: decision } });
    res.json({ client: await get('SELECT * FROM clients WHERE id = ?', [client.id]) });
  });

  router.post('/api/clients/:id/interactions', requireAuth, requireModule('clients'), async (req, res, next) => {
    const client = await get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    try { await assertRecordInScope(req.user, client.branch_id, 'client'); } catch (e) { return next(e); }
    const id = 'int_' + crypto.randomUUID();
    await run('INSERT INTO client_interactions (id, client_id, type, note, staff_id) VALUES (?,?,?,?,?)',
      [id, req.params.id, req.body.type || 'Note', req.body.note || '', req.user.id]);
    await logAction(req, { action: 'Logged interaction', module: 'clients', recordType: 'Client', recordId: req.params.id, newValue: req.body.type });
    res.status(201).json({ interaction: await get('SELECT * FROM client_interactions WHERE id = ?', [id]) });
  });

  // Document metadata only here — actual bytes go through /api/uploads (see server.js).
  router.post('/api/clients/:id/documents', requireAuth, requireModule('clients'), async (req, res, next) => {
    const client = await get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    try { await assertRecordInScope(req.user, client.branch_id, 'client'); } catch (e) { return next(e); }
    if (!req.body.file_path) return next({ status: 400, message: 'file_path is required — upload the file via /api/uploads first' });
    const id = 'doc_' + crypto.randomUUID();
    await run('INSERT INTO client_documents (id, client_id, name, doc_type, file_path, uploaded_by) VALUES (?,?,?,?,?,?)',
      [id, req.params.id, req.body.name || req.body.doc_type || 'Document', req.body.doc_type || 'Other', req.body.file_path, req.user.id]);
    await logAction(req, { action: 'Added client document', module: 'clients', recordType: 'Client', recordId: req.params.id, newValue: req.body.doc_type });
    res.status(201).json({ document: await get('SELECT * FROM client_documents WHERE id = ?', [id]) });
  });

  router.delete('/api/clients/:id/documents/:docId', requireAuth, requireModule('clients'), async (req, res, next) => {
    const client = await get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    try { await assertRecordInScope(req.user, client.branch_id, 'client'); } catch (e) { return next(e); }
    const doc = await get('SELECT * FROM client_documents WHERE id = ? AND client_id = ?', [req.params.docId, req.params.id]);
    if (!doc) return next({ status: 404, message: 'Document not found' });
    await run('DELETE FROM client_documents WHERE id = ?', [doc.id]);
    await logAction(req, { action: 'Deleted client document', module: 'clients', recordType: 'Client', recordId: req.params.id, previousValue: { doc_type: doc.doc_type, name: doc.name } });
    res.json({ deleted: true });
  });

  // ==================== Client wallet accounts (Transactional/Investment/Savings) ====================
  const CLIENT_ACCOUNT_TYPES = ['Transactional', 'Investment', 'Savings'];
  const CLIENT_ACCOUNT_TYPE_CODE = { Transactional: '1', Investment: '2', Savings: '3' };
  // Auto-provisions the 3 real accounts a client is entitled to, the
  // first time any of them is requested — never fabricated, just created
  // once with a real generated account number and a real starting
  // balance of 0.
  async function ensureClientAccounts(clientId) {
    for (const type of CLIENT_ACCOUNT_TYPES) {
      const existing = await get('SELECT id FROM client_accounts WHERE client_id = ? AND account_type = ?', [clientId, type]);
      if (!existing) {
        const seq = (await get('SELECT COUNT(*) as n FROM client_accounts WHERE account_type = ?', [type])).n + 1;
        const accountNumber = '00' + CLIENT_ACCOUNT_TYPE_CODE[type] + String(seq).padStart(8, '0');
        await run('INSERT INTO client_accounts (id, client_id, account_type, account_number) VALUES (?,?,?,?)',
          ['acc_' + crypto.randomUUID(), clientId, type, accountNumber]);
      }
    }
    return all('SELECT * FROM client_accounts WHERE client_id = ? ORDER BY account_type', [clientId]);
  }

  router.get('/api/clients/:id/accounts', requireAuth, requireModule('clients'), async (req, res, next) => {
    const client = await get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    try { await assertRecordInScope(req.user, client.branch_id, 'client'); } catch (e) { return next(e); }
    const accounts = await ensureClientAccounts(client.id);
    const withWithdrawals = await Promise.all(accounts.map(async a => {
      const w = await get(`SELECT COALESCE(SUM(amount),0) as total FROM client_account_transactions WHERE account_id = ? AND type = 'Withdrawal' AND approval_status = 'Completed'`, [a.id]);
      return { ...a, withdrawals_total: w.total };
    }));
    res.json({ accounts: withWithdrawals });
  });

  router.get('/api/clients/:id/accounts/:type/transactions', requireAuth, requireModule('clients'), async (req, res, next) => {
    const client = await get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    try { await assertRecordInScope(req.user, client.branch_id, 'client'); } catch (e) { return next(e); }
    if (!CLIENT_ACCOUNT_TYPES.includes(req.params.type)) return next({ status: 400, message: 'Invalid account type' });
    const accounts = await ensureClientAccounts(client.id);
    const account = accounts.find(a => a.account_type === req.params.type);
    const clauses = ['account_id = ?']; const params = [account.id];
    if (req.query.from) { clauses.push('(created_at)::date >= ?'); params.push(req.query.from); }
    if (req.query.to) { clauses.push('(created_at)::date <= ?'); params.push(req.query.to); }
    const rows = await all(`SELECT * FROM client_account_transactions WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params);
    res.json({ account, transactions: rows });
  });

  // Real STK Push initiation for a client wallet deposit — money only
  // ever lands in the wallet once a real completed callback for this
  // request is processed (see mpesa.initiateWalletStkPush's own notes on
  // why this is a genuinely separate path from loan-repayment STK).
  router.post('/api/clients/:id/accounts/:type/deposit', requireAuth, requireModule('clients'), async (req, res, next) => {
    const client = await get('SELECT * FROM clients WHERE id = ?', [req.params.id]);
    if (!client) return next({ status: 404, message: 'Client not found' });
    try { await assertRecordInScope(req.user, client.branch_id, 'client'); } catch (e) { return next(e); }
    if (!CLIENT_ACCOUNT_TYPES.includes(req.params.type)) return next({ status: 400, message: 'Invalid account type' });
    const { phone, amount } = req.body;
    if (!phone) return next({ status: 400, message: 'phone is required' });
    if (!(Number(amount) > 0)) return next({ status: 400, message: 'amount must be a positive number' });
    const accounts = await ensureClientAccounts(client.id);
    const account = accounts.find(a => a.account_type === req.params.type);
    const mpesa = require('./../integrations/mpesa');
    const result = await mpesa.initiateWalletStkPush({ accountId: account.id, accountNumber: account.account_number, phone, amount: Number(amount), initiatedBy: req.user.id });
    await logAction(req, { action: 'Requested wallet deposit STK push', module: 'clients', recordType: 'ClientAccount', recordId: account.id, newValue: { amount, phone, status: result.status } });
    res.json(result);
  });

  // Leads
  router.get('/api/leads', requireAuth, requireModule('clients'), async (req, res) => {
    // Real branch/region scoping — a Loan Officer sees only their own
    // real branch's leads, a Regional Manager their real region, CEO/
    // Admin the real company-wide set. Previously this had no scoping
    // at all, meaning every role saw every lead regardless of branch.
    const scope = await branchScopeSQL(req.user, 'cl.branch_id');
    const clauses = [scope.clause]; const params = [...scope.params];
    // "Unboarded"/"Onboarded" are the real browser categories the Client
    // Leads page filters by (not yet converted vs. already converted to a
    // real client) — plain status values (New/Contacted/Converted) still
    // work too, for any other caller.
    if (req.query.status === 'Unboarded') { clauses.push(`cl.status != 'Converted'`); }
    else if (req.query.status === 'Onboarded') { clauses.push(`cl.status = 'Converted'`); }
    else if (req.query.status) { clauses.push('cl.status = ?'); params.push(req.query.status); }
    if (req.query.from) { clauses.push('(cl.created_at)::date >= ?'); params.push(req.query.from); }
    if (req.query.to) { clauses.push('(cl.created_at)::date <= ?'); params.push(req.query.to); }
    if (req.query.q) {
      clauses.push('(cl.name LIKE ? OR cl.phone LIKE ? OR cl.national_id LIKE ?)');
      const like = `%${req.query.q}%`; params.push(like, like, like);
    }
    const rows = await all(
      `SELECT cl.*, b.name as branch_name, u.name as creator_name,
              (SELECT COUNT(*) FROM client_interactions ci WHERE ci.client_id = cl.converted_client_id) as interactions_count
       FROM client_leads cl
       LEFT JOIN branches b ON b.id = cl.branch_id
       LEFT JOIN users u ON u.id = cl.created_by
       WHERE ${clauses.join(' AND ')} ORDER BY cl.created_at DESC`,
      params
    );
    res.json({ leads: rows });
  });
  router.post('/api/leads', requireAuth, requireModule('clients'), async (req, res, next) => {
    const b = req.body;
    if (!b.name) return next({ status: 400, message: 'name is required' });
    let branchId;
    try { branchId = await resolveWriteBranchId(req.user, b.branch_id); } catch (e) { return next(e); }
    const id = 'lead_' + crypto.randomUUID();
    await run(`INSERT INTO client_leads (id, name, phone, source, notes, branch_id, created_by, national_id, address, client_location, next_of_kin, next_of_kin_phone, business_type)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, b.name, b.phone || null, b.source || null, b.notes || null, branchId, req.user.id,
        b.national_id || null, b.address || null, b.client_location || null, b.next_of_kin || null, b.next_of_kin_phone || null, b.business_type || null]);
    await logAction(req, { action: 'Created lead', module: 'clients', recordType: 'Lead', recordId: id, newValue: { name: b.name } });
    res.status(201).json({ lead: await get('SELECT * FROM client_leads WHERE id = ?', [id]) });
  });
  router.post('/api/leads/:id/convert', requireAuth, requireModule('clients'), async (req, res, next) => {
    const lead = await get('SELECT * FROM client_leads WHERE id = ?', [req.params.id]);
    if (!lead) return next({ status: 404, message: 'Lead not found' });
    if (lead.status === 'Converted') return next({ status: 409, message: 'This lead has already been converted — cannot create a duplicate client from it' });
    // Real duplicate protection at conversion time too, same rule as
    // ordinary client creation — a lead's phone might already have become
    // a client through some other path since the lead was created.
    if (lead.phone) {
      const dup = await get('SELECT id, name FROM clients WHERE phone = ?', [lead.phone]);
      if (dup) return next({ status: 409, message: `A client with this phone number already exists: ${dup.name} — cannot convert into a duplicate` });
    }
    let branchId;
    try { branchId = await resolveWriteBranchId(req.user, req.body.branch_id); } catch (e) { return next(e); }
    const clientId = 'cl_' + crypto.randomUUID();
    const code = generateClientCode();
    const officerId = req.user.role_id === 'loan_officer' ? req.user.id : null;
    // Carry over every real field the lead form captured that the client
    // record has a real matching column for — client_location has none
    // yet, so it stays on the lead only, never silently fabricated onto
    // the new client record.
    await run(`INSERT INTO clients (id, client_code, name, phone, branch_id, officer_id, created_by, national_id, address, next_of_kin, next_of_kin_phone, business_type)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [clientId, code, lead.name, lead.phone, branchId, officerId, req.user.id, lead.national_id, lead.address, lead.next_of_kin, lead.next_of_kin_phone, lead.business_type]);
    await run('UPDATE client_leads SET status = ?, converted_client_id = ? WHERE id = ?', ['Converted', clientId, lead.id]);
    await logAction(req, { action: 'Converted lead to client', module: 'clients', recordType: 'Lead', recordId: lead.id, newValue: clientId });
    res.json({ client: await get('SELECT * FROM clients WHERE id = ?', [clientId]) });
  });
}

module.exports = { register };
