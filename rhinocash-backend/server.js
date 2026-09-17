// server.js — entry point. Run with: node server.js
// No framework, no external packages beyond `pg` (PostgreSQL has no
// built-in Node driver) — Node's built-in http server plus the small
// Router in router.js.
'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Router } = require('./src/router');
const { rateLimiter } = require('./src/rateLimit');

const PORT = process.env.PORT || 4000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const router = new Router();

// Security headers (instruction #16). This is an API, not a browser-rendered
// page, so CSP is minimal; the headers that matter here are the ones that
// stop a browser from doing something clever with an API response.
router.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  if (process.env.NODE_ENV === 'production') res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  next();
});

// CORS (the frontend is served separately, e.g. as the existing static HTML app)
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  next();
});

// General rate limiting — separate from (and in addition to) the tighter
// account-lockout throttle already applied specifically to /api/auth/login
// (see routes/auth.js). This one protects every route from abuse.
router.use(rateLimiter({ windowMs: 60000, max: Number(process.env.RATE_LIMIT_PER_MINUTE) || 180 }));

// simple request logger
router.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// Deliberately does not touch the database — a health check that itself
// depends on the DB being up can't tell an operator "the process is alive
// but the DB init failed" from "the process never started"; src/db.js's
// own startup self-test (and its loud, actionable failure message) is
// what surfaces a genuine DB problem.
router.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Instruction #17/#18: never claim these are live until real credentials
// are configured — this is the one place that status is reported from.
router.get('/api/integrations/status', async (req, res) => {
  const mpesa = require('./src/integrations/mpesa');
  const sms = require('./src/integrations/sms');
  const email = require('./src/integrations/email');
  res.json({
    mpesa: (await mpesa.isConfigured()) ? 'CONFIGURED' : 'NOT_CONFIGURED',
    mpesaDetail: {
      sandbox: await mpesa.statusFor('sandbox'),
      production: await mpesa.statusFor('production'),
      active: await mpesa.getActiveEnvironment(),
    },
    sms: sms.isConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED',
    email: email.isConfigured() ? 'CONFIGURED' : 'NOT_CONFIGURED',
  });
});

// Public: this is where Safaricom itself POSTs the result of an STK push —
// no admin session exists on Safaricom's side, so this cannot require
// requireAuth. Idempotent (see mpesa.recordCallback) and validated to a
// known environment; nothing here ever touches or exposes stored secrets.
router.post('/api/mpesa/callback/:environment', async (req, res) => {
  const mpesa = require('./src/integrations/mpesa');
  const { logAction } = require('./src/audit');
  const env = req.params.environment;
  if (!['sandbox', 'production'].includes(env)) { res.status(400).json({ error: 'Unknown environment' }); return; }
  const body = req.body || {};
  const stk = body.Body && body.Body.stkCallback;
  if (!stk || !stk.CheckoutRequestID) { res.status(400).json({ error: 'Malformed callback payload' }); return; }
  const items = (stk.CallbackMetadata && stk.CallbackMetadata.Item) || [];
  const find = (name) => { const it = items.find(i => i.Name === name); return it ? it.Value : null; };
  const result = await mpesa.recordCallback({
    checkoutRequestId: stk.CheckoutRequestID,
    environment: env,
    resultCode: stk.ResultCode,
    resultDesc: stk.ResultDesc,
    amount: find('Amount'),
    mpesaReceiptNumber: find('MpesaReceiptNumber'),
    phone: find('PhoneNumber'),
  });
  await logAction(req, { action: result.duplicate ? 'Received duplicate M-Pesa callback (ignored)' : 'Received M-Pesa callback', module: 'mpesa', recordType: 'MpesaCallback', recordId: stk.CheckoutRequestID });
  // Real, immediate bridge to Payments — a successful callback becomes a
  // real payment right away, not just a row waiting for someone to notice
  // it. Idempotent (mpesa.processCallback checks `processed` itself), so
  // this is safe even if recordCallback above just returned `duplicate`.
  if (!result.duplicate) {
    const processResult = await mpesa.processCallback(result.id, result.initiatedBy);
    if (processResult.created) {
      await logAction(req, { action: 'M-Pesa callback converted to real payment', module: 'mpesa', recordType: 'Payment', recordId: processResult.paymentId, newValue: { checkoutRequestId: stk.CheckoutRequestID } });
    }
  }
  // Safaricom expects exactly this acknowledgement shape regardless of
  // what we did with the data, or it will retry the callback.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// Real C2B Validation — Safaricom calls this before completing a
// Paybill/Till transaction. No requireAuth, same reasoning as the STK
// callback above: this is Safaricom's server calling ours.
router.post('/api/mpesa/c2b/validation/:environment', async (req, res) => {
  const mpesa = require('./src/integrations/mpesa');
  const env = req.params.environment;
  if (!['sandbox', 'production'].includes(env)) { res.status(400).json({ ResultCode: 'C2B00011', ResultDesc: 'Unknown environment' }); return; }
  const body = req.body || {};
  const result = await mpesa.validateC2b({ billRefNumber: body.BillRefNumber });
  res.json(result);
});

// Real C2B Confirmation — the mandatory record of money actually
// received. Idempotent on Safaricom's real TransID.
router.post('/api/mpesa/c2b/confirmation/:environment', async (req, res) => {
  const mpesa = require('./src/integrations/mpesa');
  const { logAction } = require('./src/audit');
  const env = req.params.environment;
  if (!['sandbox', 'production'].includes(env)) { res.status(400).json({ ResultCode: 'C2B00011', ResultDesc: 'Unknown environment' }); return; }
  const body = req.body || {};
  if (!body.TransID) { res.status(400).json({ ResultCode: 'C2B00012', ResultDesc: 'Missing TransID' }); return; }
  const result = await mpesa.recordC2bTransaction({
    transId: body.TransID, environment: env, amount: body.TransAmount, msisdn: body.MSISDN, billRefNumber: body.BillRefNumber,
  });
  await logAction(req, { action: result.duplicate ? 'Received duplicate M-Pesa C2B transaction (ignored)' : 'Received M-Pesa C2B transaction', module: 'mpesa', recordType: 'MpesaC2b', recordId: body.TransID });
  if (!result.duplicate) {
    const processResult = await mpesa.processC2bTransaction(result.id, null);
    if (processResult.created) {
      await logAction(req, { action: 'M-Pesa C2B transaction converted to real payment', module: 'mpesa', recordType: 'Payment', recordId: processResult.paymentId, newValue: { transId: body.TransID, matchMethod: result.matchMethod } });
    }
  }
  res.json({ ResultCode: '0', ResultDesc: 'Accepted' });
});

// Real B2C Result (ResultURL) — the actual, mandatory confirmation of a
// disbursement outcome. Only a real ResultCode "0" here ever completes a
// loan disbursement — see mpesa.processB2cResult().
router.post('/api/mpesa/b2c/result/:environment', async (req, res) => {
  const mpesa = require('./src/integrations/mpesa');
  const { logAction } = require('./src/audit');
  const env = req.params.environment;
  if (!['sandbox', 'production'].includes(env)) { res.status(400).json({ ResultCode: 1, ResultDesc: 'Unknown environment' }); return; }
  const result = (req.body && req.body.Result) || {};
  if (!result.ConversationID) { res.status(400).json({ ResultCode: 1, ResultDesc: 'Malformed B2C result payload' }); return; }
  const params = (result.ResultParameters && result.ResultParameters.ResultParameter) || [];
  const find = (name) => { const p = params.find(x => x.Key === name); return p ? p.Value : null; };
  const outcome = await mpesa.processB2cResult({
    conversationId: result.ConversationID,
    resultCode: result.ResultCode,
    resultDesc: result.ResultDesc,
    transactionAmount: find('TransactionAmount'),
    transactionReceipt: find('TransactionReceipt'),
  });
  await logAction(req, { action: outcome.disbursed ? 'M-Pesa B2C disbursement confirmed — loan disbursed' : (outcome.failed ? 'M-Pesa B2C disbursement failed' : 'Received M-Pesa B2C result'), module: 'mpesa', recordType: 'Loan', recordId: outcome.loanId || result.ConversationID });
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// Real B2C Timeout (QueueTimeOutURL) — Safaricom calls this if no result
// arrives in time. Reverts the loan so it can genuinely be retried.
router.post('/api/mpesa/b2c/timeout/:environment', async (req, res) => {
  const mpesa = require('./src/integrations/mpesa');
  const { logAction } = require('./src/audit');
  const env = req.params.environment;
  if (!['sandbox', 'production'].includes(env)) { res.status(400).json({ ResultCode: 1, ResultDesc: 'Unknown environment' }); return; }
  const result = (req.body && req.body.Result) || {};
  if (result.ConversationID) {
    const outcome = await mpesa.processB2cTimeout({ conversationId: result.ConversationID });
    await logAction(req, { action: 'M-Pesa B2C request timed out', module: 'mpesa', recordType: 'Loan', recordId: outcome.loanId || result.ConversationID });
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

// Real file upload for avatars/client documents — validated (type + size),
// stored on disk, referenced by path in the DB (never inlined as base64
// blobs in a table). No multipart library available offline, so this
// accepts a raw binary body with a Content-Type + X-Filename header, which
// is enough to be a genuine, working upload endpoint.
router.post('/api/uploads', async (req, res, next) => {
  const { requireAuth } = require('./src/middleware');
  await requireAuth(req, res, async (err) => {
    if (err) return next(err);
    const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
    const contentType = req.headers['content-type'] || '';
    if (!allowedTypes.includes(contentType)) return next({ status: 400, message: 'Unsupported file type' });
    const filename = decodeURIComponent(req.headers['x-filename'] || 'file');
    const ext = path.extname(filename).slice(0, 10) || '';
    const chunks = [];
    let size = 0;
    const MAX = 5 * 1024 * 1024; // 5MB
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX) return next({ status: 413, message: 'File too large (5MB max)' });
      chunks.push(chunk);
    }
    const id = crypto.randomUUID();
    const storedName = `${id}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, storedName), Buffer.concat(chunks));
    const { logAction } = require('./src/audit');
    await logAction(req, { action: 'Uploaded file', module: 'uploads', recordType: 'File', recordId: storedName });
    res.status(201).json({ path: `/uploads/${storedName}`, contentType });
  });
});
router.get('/uploads/:name', async (req, res, next) => {
  const p = path.join(UPLOAD_DIR, req.params.name);
  if (!fs.existsSync(p) || !p.startsWith(UPLOAD_DIR)) return next({ status: 404, message: 'Not found' });
  const { requireAuth } = require('./src/middleware');
  await requireAuth(req, res, async (err) => {
    if (err) return next(err);
    // Real, previously-missing authorization (Production Readiness audit,
    // Phase 3): authentication alone isn't enough — a logged-in user must
    // not be able to fetch another client's KYC document just because the
    // (unguessable, but not access-controlled) filename is known.
    //
    // Resolve what this specific file actually is, then apply the SAME
    // scope check the rest of the app already uses for that record type —
    // no second authorization engine.
    const { get } = require('./src/db');
    const { assertRecordInScope } = require('./src/rbac');
    const filePath = `/uploads/${req.params.name}`;
    const doc = await get('SELECT * FROM client_documents WHERE file_path = ?', [filePath]);
    if (doc) {
      const client = await get('SELECT * FROM clients WHERE id = ?', [doc.client_id]);
      try {
        await assertRecordInScope(req.user, client ? client.branch_id : null, 'client');
      } catch (scopeErr) {
        return next(scopeErr);
      }
      res.end(fs.readFileSync(p));
      return;
    }
    const avatarOwner = await get('SELECT id FROM users WHERE avatar_path = ?', [filePath]);
    if (avatarOwner) {
      // Staff avatars are organizational-directory-level data (like a
      // photo in a staff directory), not per-client sensitive documents —
      // any authenticated staff member may view any staff avatar. This is
      // still real authorization, not "no check": requireAuth above
      // already rejects unauthenticated and investor requests.
      res.end(fs.readFileSync(p));
      return;
    }
    // The file exists on disk but is not referenced by any real record —
    // deny by default rather than serve an unlinked/orphaned file.
    return next({ status: 403, message: 'This file is not accessible' });
  });
});

// Avatar convenience routes — set/clear the current user's avatar_path.
router.post('/api/users/me/avatar', async (req, res, next) => {
  const { requireAuth } = require('./src/middleware');
  await requireAuth(req, res, async (err) => {
    if (err) return next(err);
    const { run } = require('./src/db');
    const { path: avatarPath } = req.body;
    if (!avatarPath) return next({ status: 400, message: 'path is required (upload via /api/uploads first)' });
    await run('UPDATE users SET avatar_path = ? WHERE id = ?', [avatarPath, req.user.id]);
    res.json({ ok: true, avatar_path: avatarPath });
  });
});
router.delete('/api/users/me/avatar', async (req, res, next) => {
  const { requireAuth } = require('./src/middleware');
  await requireAuth(req, res, async (err) => {
    if (err) return next(err);
    const { run } = require('./src/db');
    await run('UPDATE users SET avatar_path = NULL WHERE id = ?', [req.user.id]);
    res.json({ ok: true });
  });
});

[
  './src/routes/auth', './src/routes/users', './src/routes/branches', './src/routes/clients',
  './src/routes/loans', './src/routes/payments', './src/routes/audit', './src/routes/misc',
  './src/routes/accounting', './src/routes/investors', './src/routes/dashboard', './src/routes/mpesaAdmin', './src/routes/targets',
  './src/routes/collections',
  './src/routes/systemHealth',
  './src/routes/reports',
  './src/routes/systemAdmin',
].forEach(mod => require(mod).register(router));

const server = http.createServer((req, res) => {
  router.handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: 'Server error' })); }
  });
});

if (require.main === module) {
  // Wait for the database to actually be ready (schema created, a real
  // write proven to succeed) before accepting a single request — the
  // same "fail loudly at boot, not on a user's first login" principle
  // src/db.js's startup self-test exists for.
  require('./src/db').ready
    .then(() => {
      server.listen(PORT, () => console.log(`Rhinocash API listening on http://localhost:${PORT}`));
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}

module.exports = { server, router };
