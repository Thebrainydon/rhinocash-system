// loanEsign.js — digital signing of loan application forms.
//
// When an application is saved from the app, its Loan Application Form is
// generated as a fixed snapshot (what the client and guarantors actually
// sign). The borrower and every guarantor get their own signing link. On
// the link they draw (or upload) a signature and confirm it with a 6-digit
// code sent by SMS to the phone number registered for them. Once everyone
// has signed, the application moves to its first approval step; until
// then nobody can approve it.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run } = require('./../db');
const { requireAuth, requireModule } = require('./../middleware');
const { logAction, notify } = require('./../audit');
const { assertRecordInScope } = require('./../rbac');
const { tokenHash } = require('./../crypto');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', '..', 'data', 'uploads');
const PENDING = 'Pending signatures';
const LINK_DAYS = 14;
const OTP_MINUTES = 10;
const MAX_OTP_FAILURES = 5;
const MAX_OTP_REQUESTS = 6;
const OTP_RESEND_SECONDS = 60;

const num = v => Number(v || 0);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x.toISOString().slice(0, 10); };
function split(total, periods) { const per = Math.round(total / periods); const out = []; for (let i = 1; i < periods; i++) out.push(per); out.push(total - per * (periods - 1)); return out; }
const maskPhone = p => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(0, 4) + '•••' + d.slice(-3) : '•••'; };
const newToken = () => crypto.randomBytes(24).toString('base64url');

// Same repayment rules as the real schedule (loans.js buildSchedule), dated
// from today — the real dates are set when the loan is disbursed.
function projectedSchedule(loan, product) {
  const principal = num(loan.principal), start = new Date().toISOString().slice(0, 10);
  if (product && product.term_weeks) {
    const w = Number(product.term_weeks), p = split(principal, w), i = split(principal * num(loan.rate_pct) / 100, w);
    return p.map((x, k) => ({ period: k + 1, dueDate: addDays(start, (k + 1) * 7), principal: x, interest: i[k], installment: x + i[k] }));
  }
  const term = Number(loan.term_months) || 1, interest = principal * num(loan.rate_pct) / 100 * term;
  return Array.from({ length: term }, (_, k) => ({ period: k + 1, dueDate: addMonths(start, k + 1), principal: principal / term, interest: interest / term, installment: (principal + interest) / term }));
}

async function buildForm(loanId) {
  const loan = await get('SELECT * FROM loans WHERE id = ?', [loanId]);
  const client = await get('SELECT * FROM clients WHERE id = ?', [loan.client_id]);
  const product = await get('SELECT * FROM loan_products WHERE id = ?', [loan.product_id]);
  const branch = await get('SELECT name FROM branches WHERE id = ?', [loan.branch_id]);
  const officer = await get('SELECT name FROM users WHERE id = ?', [loan.officer_id]);
  const org = (await get('SELECT * FROM organization_settings WHERE id = 1').catch(() => null)) || {};
  const collateral = await all('SELECT category, security_type, details, serial_no FROM loan_collaterals WHERE loan_id = ? ORDER BY created_at', [loanId]);
  const charges = num(loan.processing_fee) > 0 ? [{ name: 'Processing Fee', amount: num(loan.processing_fee) }] : [];
  const schedule = projectedSchedule(loan, product);
  return {
    company: { name: org.company_name || org.trading_name || 'Rhinocash Ltd', address: org.address || '', phone: org.phone || '', email: org.email || '' },
    applicationNo: loan.application_no ? String(loan.application_no) : loan.id.slice(3, 11).toUpperCase(),
    applicationDate: String(loan.created_at || '').slice(0, 10),
    client: { name: client.name, idNumber: client.national_id || '', phone: client.phone || '', email: client.email || '', address: client.address || '',
      branch: branch ? branch.name : '', officer: officer ? officer.name : '', businessType: loan.business_type || client.business_type || '' },
    loan: { product: product ? product.name : '', amount: num(loan.principal), duration: product && product.term_weeks ? `${product.term_weeks * 7} days` : `${loan.term_months} month${Number(loan.term_months) > 1 ? 's' : ''}`,
      ratePct: num(loan.rate_pct), category: loan.loan_category || '', purpose: loan.purpose || '', paymentReference: loan.processing_fee_receipt || '',
      charges, totalCharges: charges.reduce((s, c) => s + c.amount, 0), securities: loan.loan_securities || '' },
    schedule, totalRepayable: schedule.reduce((s, r) => s + r.installment, 0),
    guarantors: loan.self_guaranteed ? [] : (loan.guarantor ? [{ name: loan.guarantor, idNumber: loan.guarantor_id_number || '', phone: loan.guarantor_contact || '', relationship: loan.guarantor_relationship || '' }] : []),
    selfGuaranteed: !!loan.self_guaranteed,
    collateral: collateral.map(c => ({ category: c.category, type: c.security_type, details: c.details, serial: c.serial_no || '' })),
    declaration: 'I confirm that the information in this application is true and complete. I agree to repay the loan and charges according to the repayment schedule, and I understand that the securities listed may be recovered if I default. Guarantors confirm that they will repay the loan if the borrower fails to do so.',
  };
}

// (Re)generates the form snapshot and gives every signer a fresh link.
// Any earlier signature is cleared, because the form it was given on is gone.
async function generate(loanId, userId) {
  const loan = await get('SELECT * FROM loans WHERE id = ?', [loanId]);
  const client = await get('SELECT name, phone, national_id FROM clients WHERE id = ?', [loan.client_id]);
  const form = await buildForm(loanId);
  const json = JSON.stringify(form);
  await run('UPDATE loans SET esign_required = 1, esign_form_json = ?, esign_form_hash = ?, esign_generated_at = iso_now(), esign_generated_by = ? WHERE id = ?',
    [json, crypto.createHash('sha256').update(json).digest('hex'), userId || null, loanId]);
  await run('DELETE FROM loan_esign_signers WHERE loan_id = ?', [loanId]);
  const signers = [{ role: 'borrower', name: client.name, phone: client.phone, id_number: client.national_id, relationship: 'Borrower' }]
    .concat(form.guarantors.map(g => ({ role: 'guarantor', name: g.name, phone: g.phone, id_number: g.idNumber, relationship: g.relationship })));
  for (const s of signers) {
    await run(`INSERT INTO loan_esign_signers (id, loan_id, role, name, phone, id_number, relationship, token, token_expires_at) VALUES (?,?,?,?,?,?,?,?, iso_offset(interval '${LINK_DAYS} days'))`,
      ['les_' + crypto.randomUUID(), loanId, s.role, s.name, s.phone || null, s.id_number || null, s.relationship || null, newToken()]);
  }
  if (loan.status !== PENDING && ['Waiting for Manager', 'Returned for Correction'].includes(loan.status)) {
    await run('UPDATE loans SET status = ?, current_step = 1 WHERE id = ?', [PENDING, loanId]);
  }
}

const signerOut = (s, withLink) => ({
  id: s.id, role: s.role, name: s.name, phone: s.phone, idNumber: s.id_number, relationship: s.relationship,
  status: s.status, linkSentAt: s.link_sent_at, linkSmsStatus: s.link_sms_status, signedAt: s.signed_at,
  ...(withLink ? { token: s.status === 'Signed' ? null : s.token } : {}),
});

function readImageDataUrl(p) {
  if (!p) return null;
  try {
    const full = path.join(UPLOAD_DIR, path.basename(String(p)));
    if (!full.startsWith(UPLOAD_DIR) || !fs.existsSync(full)) return null;
    const buf = fs.readFileSync(full);
    if (buf.length > 2.5 * 1024 * 1024) return null;
    const ext = path.extname(full).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch { return null; }
}
async function clientPhoto(clientId) {
  const d = await get(`SELECT file_path FROM client_documents WHERE client_id = ? AND doc_type = 'Client Photo' ORDER BY created_at DESC LIMIT 1`, [clientId]).catch(() => null);
  return d ? readImageDataUrl(d.file_path) : null;
}

// Everyone has signed → the application starts its approval chain.
async function completeIfAllSigned(loanId) {
  const signers = await all('SELECT status FROM loan_esign_signers WHERE loan_id = ?', [loanId]);
  if (!signers.length || signers.some(s => s.status !== 'Signed')) return false;
  const loan = await get('SELECT * FROM loans WHERE id = ?', [loanId]);
  if (loan.status !== PENDING) return true;
  const { workflowSteps } = require('./loans');
  const steps = await workflowSteps();
  const first = steps[0];
  await run('UPDATE loans SET status = ?, current_step = 1 WHERE id = ?', [first ? first.status_label : 'Waiting for Manager', loanId]);
  await notify(loan.officer_id, 'loan', 'Loan form signed', `All signatures are in for application #${loan.application_no || loan.id}. It is now waiting for approval.`);
  if (first) { // whoever holds the first approval step for this branch
    const { branchIdsInScope } = require('./../rbac');
    for (const u of await all('SELECT * FROM users WHERE role_id = ? AND status = ?', [first.role_id, 'Active'])) {
      const scope = await branchIdsInScope(u);
      if (scope === null || scope.includes(loan.branch_id)) await notify(u.id, 'loan', 'Loan awaiting your approval', `Application #${loan.application_no || loan.id} has been signed and is waiting for you (${first.status_label}).`);
    }
  }
  return true;
}

async function loadLoanForStaff(req) {
  const loan = await get('SELECT * FROM loans WHERE id = ?', [req.params.id]);
  if (!loan) throw Object.assign(new Error('Loan not found'), { status: 404 });
  await assertRecordInScope(req.user, loan.branch_id, 'loan');
  if (req.user.role_id === 'loan_officer' && loan.officer_id !== req.user.id) throw Object.assign(new Error('This loan is not part of your portfolio'), { status: 403 });
  return loan;
}

async function sendLink(signer, loan) {
  const sms = require('./../integrations/sms');
  const base = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  const link = `${base || ''}/#/esign/${signer.token}`;
  const body = `Rhinocash: please review and sign loan application #${loan.application_no || ''} for ${signer.role === 'borrower' ? 'your loan' : 'the loan you are guaranteeing'}: ${link}`;
  let r; try { r = await sms.send('system_notification', signer.phone, { body }, { relatedType: 'Loan', relatedId: loan.id }); } catch { r = { status: 'FAILED' }; }
  await run(`UPDATE loan_esign_signers SET status = CASE WHEN status = 'Signed' THEN status ELSE 'Link sent' END, link_sent_at = iso_now(), link_sms_status = ? WHERE id = ?`, [r.status, signer.id]);
  return r.status;
}

function register(router) {
  // ---- Staff: status of a loan's form and signatures ----
  router.get('/api/loans/:id/esign', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    let loan; try { loan = await loadLoanForStaff(req); } catch (e) { return next(e); }
    const signers = await all('SELECT * FROM loan_esign_signers WHERE loan_id = ? ORDER BY CASE role WHEN \'borrower\' THEN 0 ELSE 1 END, created_at', [loan.id]);
    let form = null; try { form = loan.esign_form_json ? JSON.parse(loan.esign_form_json) : null; } catch { form = null; }
    const generatedBy = loan.esign_generated_by ? await get('SELECT name FROM users WHERE id = ?', [loan.esign_generated_by]) : null;
    res.json({
      required: !!loan.esign_required, status: loan.status, form, generatedAt: loan.esign_generated_at, generatedBy: generatedBy ? generatedBy.name : null,
      signers: signers.map(s => ({ ...signerOut(s, true), signature: s.status === 'Signed' ? readImageDataUrl(s.signature_path) : null })),
      clientPhoto: await clientPhoto(loan.client_id),
      smsConfigured: require('./../integrations/sms').isConfigured(),
    });
  });

  // ---- Staff: (re)generate the form. Only before anyone has signed. ----
  router.post('/api/loans/:id/esign/generate', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    let loan; try { loan = await loadLoanForStaff(req); } catch (e) { return next(e); }
    if (!['Pending signatures', 'Waiting for Manager', 'Returned for Correction'].includes(loan.status) || (loan.current_step > 1)) return next({ status: 409, message: 'The form can no longer be regenerated — approval has already started' });
    const signed = await get(`SELECT COUNT(*)::int AS n FROM loan_esign_signers WHERE loan_id = ? AND status = 'Signed'`, [loan.id]);
    if (signed && signed.n && !req.body.confirmReset) return next({ status: 409, message: 'Someone has already signed this form. Regenerating clears their signature.', code: 'SIGNED_ALREADY' });
    await generate(loan.id, req.user.id);
    await logAction(req, { action: 'Generated loan application form', module: 'loanbook', recordType: 'Loan', recordId: loan.id });
    res.json({ ok: true });
  });

  // ---- Staff: text the borrower their signing link (optional) ----
  router.post('/api/loans/:id/esign/send-borrower', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    let loan; try { loan = await loadLoanForStaff(req); } catch (e) { return next(e); }
    const s = await get(`SELECT * FROM loan_esign_signers WHERE loan_id = ? AND role = 'borrower'`, [loan.id]);
    if (!s) return next({ status: 409, message: 'Generate the loan form first' });
    if (s.status === 'Signed') return next({ status: 409, message: 'The borrower has already signed' });
    const status = await sendLink(s, loan);
    await logAction(req, { action: 'Sent loan form signing link', module: 'loanbook', recordType: 'Loan', recordId: loan.id, newValue: { signer: 'borrower', sms: status } });
    res.json({ sms: status, message: status === 'Sent' ? `Signing link sent to ${maskPhone(s.phone)}` : status === 'NOT_CONFIGURED' ? 'SMS is not switched on — open or copy the link instead' : 'The SMS could not be sent — open or copy the link instead' });
  });

  // ---- Staff: send / remind guarantors (after the borrower has signed) ----
  router.post('/api/loans/:id/esign/send-guarantors', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    let loan; try { loan = await loadLoanForStaff(req); } catch (e) { return next(e); }
    const borrower = await get(`SELECT status FROM loan_esign_signers WHERE loan_id = ? AND role = 'borrower'`, [loan.id]);
    if (!borrower) return next({ status: 409, message: 'Generate the loan form first' });
    if (borrower.status !== 'Signed') return next({ status: 409, message: 'The borrower signs first, then the guarantors' });
    const gs = await all(`SELECT * FROM loan_esign_signers WHERE loan_id = ? AND role = 'guarantor' AND status <> 'Signed'`, [loan.id]);
    if (!gs.length) return next({ status: 409, message: 'All guarantors have already signed' });
    const results = [];
    for (const g of gs) results.push(await sendLink(g, loan));
    await logAction(req, { action: 'Sent guarantor signing links', module: 'loanbook', recordType: 'Loan', recordId: loan.id, newValue: { count: gs.length, sms: results } });
    const sent = results.filter(r => r === 'Sent').length;
    res.json({ sent, total: gs.length, message: sent === gs.length ? `Signing link sent to ${sent} guarantor${sent === 1 ? '' : 's'}` : results.includes('NOT_CONFIGURED') ? 'Links are ready — SMS is not switched on, so open or copy each link' : `${sent} of ${gs.length} SMS sent — open or copy the other links` });
  });

  // ---- Staff: withdraw an application before it is approved ----
  router.delete('/api/loans/:id', requireAuth, requireModule('loanbook'), async (req, res, next) => {
    let loan; try { loan = await loadLoanForStaff(req); } catch (e) { return next(e); }
    if (!['Pending signatures', 'Waiting for Manager', 'Returned for Correction'].includes(loan.status) || loan.current_step > 1) return next({ status: 409, message: 'Only an application that has not been approved yet can be deleted' });
    const canApprove = await require('./../rbac').hasPermission(req.user, 'approve_loans');
    if (loan.officer_id !== req.user.id && loan.created_by !== req.user.id && !canApprove) return next({ status: 403, message: 'Only the loan officer who created it or an approver can delete this application' });
    await run(`UPDATE loans SET status = 'Cancelled', reject_reason = ? WHERE id = ?`, [String((req.body && req.body.reason) || 'Deleted before approval').slice(0, 300), loan.id]);
    await run(`UPDATE loan_fee_payments SET loan_id = NULL WHERE loan_id = ?`, [loan.id]); // the client's fee can be used for a new application
    await run(`UPDATE loan_esign_signers SET status = 'Revoked' WHERE loan_id = ? AND status <> 'Signed'`, [loan.id]);
    await logAction(req, { action: 'Deleted loan application', module: 'loanbook', recordType: 'Loan', recordId: loan.id, previousValue: loan.status, newValue: 'Cancelled', reason: req.body && req.body.reason });
    res.json({ ok: true });
  });

  // ================= Public signing (the link itself is the key) =================
  async function signerByToken(token) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
    return get('SELECT * FROM loan_esign_signers WHERE token = ?', [token]);
  }
  const linkProblem = (s, loan) => {
    if (!s || !loan) return { status: 404, message: 'This signing link is not valid' };
    if (s.status === 'Revoked' || loan.status === 'Cancelled' || loan.status === 'Rejected') return { status: 410, message: 'This signing link has been withdrawn' };
    if (s.status !== 'Signed' && String(s.token_expires_at) < new Date().toISOString()) return { status: 410, message: 'This signing link has expired — ask your loan officer for a new one' };
    return null;
  };

  router.get('/api/esign/:token', async (req, res, next) => {
    const s = await signerByToken(req.params.token);
    const loan = s ? await get('SELECT * FROM loans WHERE id = ?', [s.loan_id]) : null;
    const bad = linkProblem(s, loan); if (bad) return next(bad);
    if (s.role === 'guarantor') {
      const b = await get(`SELECT status FROM loan_esign_signers WHERE loan_id = ? AND role = 'borrower'`, [loan.id]);
      if (!b || b.status !== 'Signed') return next({ status: 409, message: 'The borrower has not signed yet — please try again later' });
    }
    let form = null; try { form = JSON.parse(loan.esign_form_json || 'null'); } catch { form = null; }
    let saved = null;
    if (s.role === 'borrower') {
      const doc = await get(`SELECT file_path FROM client_documents WHERE client_id = ? AND doc_type = 'Client Signature' ORDER BY created_at DESC LIMIT 1`, [loan.client_id]).catch(() => null);
      saved = readImageDataUrl((doc && doc.file_path) || loan.client_signature_path);
    }
    res.json({
      signer: { role: s.role, name: s.name, phone: maskPhone(s.phone), relationship: s.relationship },
      status: s.status === 'Signed' ? 'Signed' : 'Pending', signedAt: s.signed_at,
      form, clientPhoto: await clientPhoto(loan.client_id), savedSignature: saved,
    });
  });

  router.post('/api/esign/:token/otp', async (req, res, next) => {
    const s = await signerByToken(req.params.token);
    const loan = s ? await get('SELECT * FROM loans WHERE id = ?', [s.loan_id]) : null;
    const bad = linkProblem(s, loan); if (bad) return next(bad);
    if (s.status === 'Signed') return next({ status: 409, message: 'This form has already been signed' });
    if (!s.phone) return next({ status: 400, message: 'No phone number is registered for this signer' });
    if (s.otp_sent_at && Date.now() - new Date(s.otp_sent_at).getTime() < OTP_RESEND_SECONDS * 1000) return next({ status: 429, message: `Please wait a minute before requesting another code` });
    if (s.otp_requests >= MAX_OTP_REQUESTS) return next({ status: 429, message: 'Too many codes requested for this link — ask your loan officer for a new link' });
    const code = String(crypto.randomInt(100000, 1000000));
    await run(`UPDATE loan_esign_signers SET otp_hash = ?, otp_expires_at = iso_offset(interval '${OTP_MINUTES} minutes'), otp_sent_at = ?, otp_requests = otp_requests + 1, otp_failures = 0 WHERE id = ?`,
      [tokenHash(code), new Date().toISOString(), s.id]);
    const sms = require('./../integrations/sms');
    let r; try {
      r = await sms.send('system_notification', s.phone, { body: `Rhinocash: your code to sign loan application #${loan.application_no || ''} is ${code}. It expires in ${OTP_MINUTES} minutes. Do not share it with anyone except your loan officer at signing.` }, { relatedType: 'Loan', relatedId: loan.id });
    } catch { r = { status: 'FAILED' }; }
    if (r.status === 'Sent') return res.json({ sent: true, to: maskPhone(s.phone), message: `Code sent to ${maskPhone(s.phone)}` });
    // Until an SMS provider is switched on (Admin › Integrations › SMS) the
    // random code is shown on screen instead, so signing is not blocked.
    // Once SMS is on, the code only ever goes to the signer's phone.
    if (r.status === 'NOT_CONFIGURED') {
      return res.json({ sent: false, to: maskPhone(s.phone), otpForTesting: code, message: 'SMS is not set up yet, so your code is shown here' });
    }
    await run('UPDATE loan_esign_signers SET otp_hash = NULL WHERE id = ?', [s.id]);
    return next({ status: 409, code: 'SMS_UNAVAILABLE', message: r.status === 'NOT_CONFIGURED' ? 'SMS is not switched on, so the code cannot be sent. Ask your System Administrator to switch on SMS (Admin › Integrations › SMS).' : 'The code could not be sent by SMS — please try again' });
  });

  router.post('/api/esign/:token/sign', async (req, res, next) => {
    const s = await signerByToken(req.params.token);
    const loan = s ? await get('SELECT * FROM loans WHERE id = ?', [s.loan_id]) : null;
    const bad = linkProblem(s, loan); if (bad) return next(bad);
    if (s.status === 'Signed') return next({ status: 409, message: 'This form has already been signed' });
    if (loan.status !== PENDING) return next({ status: 409, message: 'This application is no longer waiting for signatures' });
    if (s.role === 'guarantor') {
      const b = await get(`SELECT status FROM loan_esign_signers WHERE loan_id = ? AND role = 'borrower'`, [loan.id]);
      if (!b || b.status !== 'Signed') return next({ status: 409, message: 'The borrower signs first' });
    }
    const b = req.body || {};
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.signature || ''));
    if (!m) return next({ status: 400, message: 'Draw or upload the signature first' });
    const img = Buffer.from(m[2], 'base64');
    if (img.length < 200) return next({ status: 400, message: 'The signature is empty — please sign in the box' });
    if (img.length > 2 * 1024 * 1024) return next({ status: 400, message: 'The signature image is too large (2MB max)' });
    if (s.otp_failures >= MAX_OTP_FAILURES) return next({ status: 429, message: 'Too many wrong codes — request a new code' });
    const code = String(b.otp || '').trim();
    if (!s.otp_hash || !/^\d{6}$/.test(code) || String(s.otp_expires_at) < new Date().toISOString() || tokenHash(code) !== s.otp_hash) {
      await run('UPDATE loan_esign_signers SET otp_failures = otp_failures + 1 WHERE id = ?', [s.id]);
      return next({ status: 400, message: !s.otp_hash || String(s.otp_expires_at) < new Date().toISOString() ? 'The code has expired — request a new one' : 'The code is not correct', code: 'INVALID_OTP' });
    }
    const name = `esign-${crypto.randomUUID()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, name), img);
    const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim().slice(0, 64);
    const done = await get(`UPDATE loan_esign_signers SET status = 'Signed', signature_path = ?, signed_at = iso_now(), signed_ip = ?, signed_user_agent = ?, form_hash = ?, otp_hash = NULL
      WHERE id = ? AND status <> 'Signed' RETURNING id`, [`/uploads/${name}`, ip, String(req.headers['user-agent'] || '').slice(0, 200), loan.esign_form_hash, s.id]);
    if (!done) return next({ status: 409, message: 'This form has already been signed' });
    await logAction(req, { action: `Loan form signed by ${s.role}`, module: 'loanbook', recordType: 'Loan', recordId: loan.id, newValue: { signer: s.name, role: s.role, ip } });
    const allSigned = await completeIfAllSigned(loan.id);
    const left = await get(`SELECT COUNT(*)::int AS n FROM loan_esign_signers WHERE loan_id = ? AND status <> 'Signed'`, [loan.id]);
    res.json({ signed: true, allSigned, remaining: left ? left.n : 0 });
  });
}

module.exports = { register, generate, PENDING };
