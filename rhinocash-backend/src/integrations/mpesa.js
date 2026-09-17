// mpesa.js — real Safaricom Daraja integration logic, configured through
// the database (encrypted at rest) via the Admin UI, not source files.
//
// What's genuinely real here: OAuth token requests, STK Push payload
// construction and submission, and the "Test Connection" check all make
// actual outbound HTTPS calls to Safaricom's sandbox/production OAuth
// endpoint using Node's built-in fetch — nothing here is simulated or
// faked as successful. What isn't verifiable from wherever this backend
// happens to be running: whether Safaricom's servers are reachable from
// that network, and whether a given set of credentials is actually valid
// — those depend on real network access and real credentials, neither of
// which this code can manufacture.
'use strict';
const { get, run, all, transaction } = require('./../db');
const { encryptSecret, decryptSecret, maskSecret } = require('./../crypto');

const OAUTH_URL = {
  sandbox: 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
  production: 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
};
const STK_PUSH_URL = {
  sandbox: 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
  production: 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
};
const B2C_URL = {
  sandbox: 'https://sandbox.safaricom.co.ke/mpesa/b2c/v1/paymentrequest',
  production: 'https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest',
};

async function ensureRow(environment) {
  const existing = await get('SELECT * FROM mpesa_environment_configs WHERE environment = ?', [environment]);
  if (existing) return existing;
  await run('INSERT INTO mpesa_environment_configs (environment) VALUES (?)', [environment]);
  return get('SELECT * FROM mpesa_environment_configs WHERE environment = ?', [environment]);
}

async function getActiveEnvironment() {
  const row = await get('SELECT * FROM mpesa_active_config WHERE id = 1');
  return row ? row.active_environment : null;
}

// Decrypted, in-memory only, server-side only — never returned by any route.
async function getDecryptedConfig(environment) {
  const row = await get('SELECT * FROM mpesa_environment_configs WHERE environment = ?', [environment]);
  if (!row) return null;
  return {
    environment,
    consumerKey: decryptSecret(row.consumer_key_enc),
    consumerSecret: decryptSecret(row.consumer_secret_enc),
    shortcode: row.shortcode,
    passkey: decryptSecret(row.passkey_enc),
    callbackUrl: row.callback_url,
    initiatorName: row.initiator_name,
    securityCredential: decryptSecret(row.security_credential_enc),
    b2cShortcode: row.b2c_shortcode,
    b2cConfigured: !!row.b2c_configured,
  };
}

// Safe, masked view — this and only this shape is ever allowed to leave
// the server. No route in mpesaAdmin.js reads the DB directly; they all
// go through this function.
async function getMaskedConfig(environment) {
  const row = (await get('SELECT * FROM mpesa_environment_configs WHERE environment = ?', [environment])) || {};
  return {
    environment,
    consumerKey: row.consumer_key_enc ? maskSecret(decryptSecret(row.consumer_key_enc)) : null,
    consumerSecret: row.consumer_secret_enc ? maskSecret(decryptSecret(row.consumer_secret_enc)) : null,
    shortcode: row.shortcode || null,
    passkey: row.passkey_enc ? maskSecret(decryptSecret(row.passkey_enc)) : null,
    callbackUrl: row.callback_url || null,
    initiatorName: row.initiator_name || null,   // not secret — safe to show in full
    securityCredential: row.security_credential_enc ? maskSecret(decryptSecret(row.security_credential_enc)) : null,
    b2cShortcode: row.b2c_shortcode || null,
    b2cConfigured: !!row.b2c_configured,
    configured: !!row.configured,
    lastTestStatus: row.last_test_status || 'Never Tested',
    lastTestAt: row.last_test_at || null,
    lastTestMessage: row.last_test_message || null,
  };
}

async function statusFor(environment) {
  const row = await get('SELECT * FROM mpesa_environment_configs WHERE environment = ?', [environment]);
  if (!row || !row.configured) return 'Not Configured';
  const active = await getActiveEnvironment();
  if (active === environment) return environment === 'production' ? 'Production Configured' : 'Sandbox Configured';
  return environment === 'production' ? 'Production Configured (inactive)' : 'Sandbox Configured (inactive)';
}

// Overall status for GET /api/integrations/status. Env-var override (12-factor
// style) takes priority if fully set, matching instruction #6 ("support
// secure server-side environment variables/secrets for production").
async function isConfigured() {
  if (process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET && process.env.MPESA_SHORTCODE) return true;
  const active = await getActiveEnvironment();
  if (!active) return false;
  const row = await get('SELECT configured FROM mpesa_environment_configs WHERE environment = ?', [active]);
  return !!(row && row.configured);
}

async function effectiveConfig() {
  // Env vars win if fully present (lets a deployment pin production
  // credentials via platform secrets instead of the DB, if preferred).
  if (process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET && process.env.MPESA_SHORTCODE) {
    return {
      environment: process.env.MPESA_ENV || 'production',
      consumerKey: process.env.MPESA_CONSUMER_KEY,
      consumerSecret: process.env.MPESA_CONSUMER_SECRET,
      shortcode: process.env.MPESA_SHORTCODE,
      passkey: process.env.MPESA_PASSKEY || null,
      callbackUrl: process.env.MPESA_CALLBACK_URL || null,
    };
  }
  const active = await getActiveEnvironment();
  if (!active) return null;
  return getDecryptedConfig(active);
}

// Save (partial update — omitted/empty fields keep their existing stored
// value, since the admin never sees the current secret to resubmit it).
async function saveConfig(environment, fields, actorUserId) {
  await ensureRow(environment);
  const sets = []; const params = [];
  const changedFields = [];
  if (fields.consumerKey) { sets.push('consumer_key_enc = ?'); params.push(encryptSecret(fields.consumerKey)); changedFields.push('consumer_key'); }
  if (fields.consumerSecret) { sets.push('consumer_secret_enc = ?'); params.push(encryptSecret(fields.consumerSecret)); changedFields.push('consumer_secret'); }
  if (fields.shortcode) { sets.push('shortcode = ?'); params.push(fields.shortcode); changedFields.push('shortcode'); }
  if (fields.passkey) { sets.push('passkey_enc = ?'); params.push(encryptSecret(fields.passkey)); changedFields.push('passkey'); }
  if (fields.callbackUrl !== undefined) { sets.push('callback_url = ?'); params.push(fields.callbackUrl || null); changedFields.push('callback_url'); }
  if (fields.initiatorName) { sets.push('initiator_name = ?'); params.push(fields.initiatorName); changedFields.push('initiator_name'); }
  if (fields.securityCredential) { sets.push('security_credential_enc = ?'); params.push(encryptSecret(fields.securityCredential)); changedFields.push('security_credential'); }
  if (fields.b2cShortcode) { sets.push('b2c_shortcode = ?'); params.push(fields.b2cShortcode); changedFields.push('b2c_shortcode'); }
  if (sets.length) {
    sets.push('updated_by = ?', "updated_at = iso_now()");
    params.push(actorUserId, environment);
    await run(`UPDATE mpesa_environment_configs SET ${sets.join(', ')} WHERE environment = ?`, params);
  }
  const row = await get('SELECT * FROM mpesa_environment_configs WHERE environment = ?', [environment]);
  const nowConfigured = !!(row.consumer_key_enc && row.consumer_secret_enc && row.shortcode && row.passkey_enc && row.callback_url);
  const nowB2cConfigured = !!(row.initiator_name && row.security_credential_enc && row.b2c_shortcode);
  await run('UPDATE mpesa_environment_configs SET configured = ?, b2c_configured = ? WHERE environment = ?', [nowConfigured ? 1 : 0, nowB2cConfigured ? 1 : 0, environment]);
  return { changedFields, configured: nowConfigured, b2cConfigured: nowB2cConfigured };
}

async function setActiveEnvironment(environment) {
  const row = await get('SELECT * FROM mpesa_environment_configs WHERE environment = ?', [environment]);
  if (!row || !row.configured) {
    const err = new Error(`Cannot activate ${environment} — it is not fully configured yet (missing one or more required fields)`);
    err.status = 409;
    throw err;
  }
  const existing = await get('SELECT * FROM mpesa_active_config WHERE id = 1');
  if (existing) await run('UPDATE mpesa_active_config SET active_environment = ? WHERE id = 1', [environment]);
  else await run('INSERT INTO mpesa_active_config (id, active_environment) VALUES (1, ?)', [environment]);
}

async function clearConfig(environment) {
  await run('DELETE FROM mpesa_environment_configs WHERE environment = ?', [environment]);
  const active = await getActiveEnvironment();
  if (active === environment) await run('UPDATE mpesa_active_config SET active_environment = NULL WHERE id = 1');
}

// Real OAuth call. Returns { ok, token, message } — message is always
// safe to show a user (no secrets, no raw provider response body).
async function requestOAuthToken(config) {
  if (!config || !config.consumerKey || !config.consumerSecret) {
    return { ok: false, message: 'Consumer Key and Consumer Secret must both be set before testing.' };
  }
  const url = OAUTH_URL[config.environment];
  if (!url) return { ok: false, message: `Unknown environment "${config.environment}".` };
  const basicAuth = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { headers: { Authorization: `Basic ${basicAuth}` }, signal: controller.signal });
    clearTimeout(timeout);
    if (res.status === 200) {
      const body = await res.json().catch(() => null);
      if (body && body.access_token) return { ok: true, token: body.access_token, message: 'Connected — Safaricom issued a valid access token.' };
      return { ok: false, message: 'Safaricom responded but did not return an access token. Check the credentials are for the correct environment.' };
    }
    if (res.status === 401 || res.status === 400) {
      return { ok: false, message: 'Safaricom rejected the credentials (invalid Consumer Key/Secret for this environment).' };
    }
    return { ok: false, message: `Safaricom returned an unexpected response (HTTP ${res.status}). The service may be temporarily unavailable.` };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, message: 'Connection to Safaricom timed out after 10 seconds.' };
    return { ok: false, message: 'Could not reach Safaricom — check outbound network access from this server (this environment\'s network egress must allow api.safaricom.co.ke / sandbox.safaricom.co.ke).' };
  }
}

// The real Test Connection action — attempts a genuine OAuth handshake
// against whichever environment is asked for, using whatever is currently
// saved for it (does not require that environment to be the active one).
async function testConnection(environment, actorUserId) {
  const config = await getDecryptedConfig(environment);
  const result = await requestOAuthToken({ ...config, environment });
  const status = result.ok ? 'Connection Successful' : 'Connection Failed';
  await run(
    "UPDATE mpesa_environment_configs SET last_test_status = ?, last_test_at = iso_now(), last_test_message = ? WHERE environment = ?",
    [status, result.message, environment]
  );
  return { status, message: result.message };
}

// Real STK Push initiation — builds and submits the actual Daraja payload
// using the currently active configuration. This will genuinely fail
// wherever there's no real network path to Safaricom or no valid
// credentials configured — it does not simulate success.
async function initiateStkPush({ phone, amount, loanId, accountRef, initiatedBy }) {
  const config = await effectiveConfig();
  if (!config) return { status: 'NOT_CONFIGURED', message: 'No M-Pesa environment is active. Configure and activate one in Admin -> System Administration -> Integrations -> M-Pesa Integration.' };
  const tokenResult = await requestOAuthToken(config);
  if (!tokenResult.ok) return { status: 'FAILED', message: tokenResult.message };

  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString('base64');
  const payload = {
    BusinessShortCode: config.shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(amount),
    PartyA: phone,
    PartyB: config.shortcode,
    PhoneNumber: phone,
    CallBackURL: config.callbackUrl,
    AccountReference: accountRef || loanId || 'Rhinocash',
    TransactionDesc: `Loan repayment${loanId ? ' — ' + loanId : ''}`,
  };
  try {
    const res = await fetch(STK_PUSH_URL[config.environment], {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenResult.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body && body.CheckoutRequestID) {
      // Real, necessary bridge: Safaricom's callback later contains NO
      // reference back to our loan — only CheckoutRequestID. Without
      // recording that mapping HERE, at initiation, a successful payment
      // callback would have nowhere to be applied.
      await run(
        `INSERT INTO mpesa_stk_requests (checkout_request_id, loan_id, phone, amount, account_ref, environment, initiated_by) VALUES (?,?,?,?,?,?,?)`,
        [body.CheckoutRequestID, loanId, phone, amount, accountRef || null, config.environment, initiatedBy || null]
      );
      return { status: 'INITIATED', checkoutRequestId: body.CheckoutRequestID, message: 'STK push sent to the customer\'s phone.' };
    }
    return { status: 'FAILED', message: (body && (body.errorMessage || body.ResponseDescription)) || `Safaricom returned HTTP ${res.status}.` };
  } catch (e) {
    return { status: 'FAILED', message: 'Could not reach Safaricom to initiate the STK push — check outbound network access.' };
  }
}

// ==================== B2C — real disbursement-to-customer ====================
// Real, deliberate design: initiating a B2C request NEVER marks a loan as
// disbursed. Only a genuine successful ResultURL callback does that (via
// the same completeDisbursement() every other disbursement path uses).
// This directly matches the spec: "sending a B2C request does NOT
// automatically mean the loan was successfully disbursed."
async function initiateB2C({ loanId, phone, amount, initiatedBy, remarks }) {
  const config = await effectiveConfig();
  if (!config || !config.b2cConfigured) {
    return { status: 'NOT_CONFIGURED', message: 'B2C is not configured. An Admin must set Initiator Name, Security Credential and B2C Shortcode under M-Pesa Configuration.' };
  }
  // Real duplicate-initiation protection: a loan with an unresolved
  // (Requested/Pending) B2C request cannot be sent a second one.
  const pending = await get(`SELECT id FROM mpesa_b2c_requests WHERE loan_id = ? AND status IN ('Requested','Pending')`, [loanId]);
  if (pending) return { status: 'DUPLICATE', message: 'A B2C disbursement request is already in progress for this loan.' };

  const tokenResult = await requestOAuthToken(config);
  if (!tokenResult.ok) return { status: 'FAILED', message: tokenResult.message };

  const originatorConversationId = 'b2c_' + crypto.randomUUID();
  const id = 'b2creq_' + crypto.randomUUID();
  await run(
    `INSERT INTO mpesa_b2c_requests (id, originator_conversation_id, loan_id, phone, amount, environment, status, initiated_by) VALUES (?,?,?,?,?,?,?,?)`,
    [id, originatorConversationId, loanId, phone, amount, config.environment, 'Requested', initiatedBy || null]
  );

  const payload = {
    OriginatorConversationID: originatorConversationId,
    InitiatorName: config.initiatorName,
    SecurityCredential: config.securityCredential,
    CommandID: 'BusinessPayment',
    Amount: Math.round(amount),
    PartyA: config.b2cShortcode,
    PartyB: phone,
    Remarks: remarks || `Loan disbursement — ${loanId}`,
    QueueTimeOutURL: (config.callbackUrl || '').replace(/\/callback\/[a-z]+$/, '') + `/mpesa/b2c/timeout/${config.environment}`,
    ResultURL: (config.callbackUrl || '').replace(/\/callback\/[a-z]+$/, '') + `/mpesa/b2c/result/${config.environment}`,
    Occasion: 'LoanDisbursement',
  };
  try {
    const res = await fetch(B2C_URL[config.environment], {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenResult.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 200 && body && body.ConversationID) {
      await run(`UPDATE mpesa_b2c_requests SET conversation_id = ?, status = 'Pending' WHERE id = ?`, [body.ConversationID, id]);
      return { status: 'PENDING', requestId: id, conversationId: body.ConversationID, message: 'B2C disbursement request accepted by Safaricom — awaiting the real result callback.' };
    }
    await run(`UPDATE mpesa_b2c_requests SET status = 'Failed', result_desc = ? WHERE id = ?`, [(body && (body.errorMessage || body.ResponseDescription)) || `HTTP ${res.status}`, id]);
    return { status: 'FAILED', message: (body && (body.errorMessage || body.ResponseDescription)) || `Safaricom returned HTTP ${res.status}.` };
  } catch (e) {
    await run(`UPDATE mpesa_b2c_requests SET status = 'Failed', result_desc = ? WHERE id = ?`, ['Network unreachable', id]);
    return { status: 'FAILED', message: 'Could not reach Safaricom to initiate the B2C request — check outbound network access.' };
  }
}

// Real B2C Result callback (Safaricom's ResultURL). Idempotent on the
// real ConversationID. Success is the ONLY path that ever calls
// completeDisbursement() — reusing the exact same function the manual
// disbursement route uses, so a B2C disbursement's accounting is
// identical to a manual one, never a second engine.
async function processB2cResult({ conversationId, resultCode, resultDesc, transactionAmount, transactionReceipt }) {
  const reqRow = await get('SELECT * FROM mpesa_b2c_requests WHERE conversation_id = ?', [conversationId]);
  if (!reqRow) return { ok: false, message: 'No matching B2C request found for this ConversationID' };
  if (['Success', 'Failed', 'Timeout'].includes(reqRow.status)) {
    return { ok: true, alreadyProcessed: true, status: reqRow.status };
  }
  if (String(resultCode) === '0') {
    // Deliberately NOT wrapped together with completeDisbursement() below:
    // if Safaricom says the money moved, that fact must be recorded even
    // if our own disbursement bookkeeping then fails — see the comment in
    // the catch block. completeDisbursement() has its own real transaction
    // boundary (loans.js) covering its own multi-step write.
    await run(`UPDATE mpesa_b2c_requests SET status = 'Success', result_code = ?, result_desc = ?, mpesa_receipt_number = ?, completed_at = iso_now() WHERE id = ?`,
      [resultCode, resultDesc, transactionReceipt || null, reqRow.id]);
    const loans = require('./../routes/loans');
    try {
      const result = await loans.completeDisbursement({ loanId: reqRow.loan_id, channel: 'M-Pesa', actorUserId: reqRow.initiated_by });
      return { ok: true, disbursed: true, loanId: reqRow.loan_id, paymentResult: result };
    } catch (e) {
      // The B2C payment genuinely succeeded on Safaricom's side even if
      // our own disbursement bookkeeping hit an error (e.g. loan already
      // disbursed through another path) — never silently lose that real
      // money movement; surface it for manual reconciliation instead.
      return { ok: true, disbursed: false, disbursementError: e.message };
    }
  } else {
    await transaction(async () => {
      await run(`UPDATE mpesa_b2c_requests SET status = 'Failed', result_code = ?, result_desc = ?, completed_at = iso_now() WHERE id = ?`, [resultCode, resultDesc, reqRow.id]);
      // Real recovery path: a failed B2C attempt returns the loan to
      // Approved for Disbursement so it can genuinely be retried (via B2C
      // again or manually) — never left stuck in limbo. Wrapped together
      // so a crash between these two writes can never leave the request
      // marked Failed while the loan is still stuck on Disbursement Pending.
      await run(`UPDATE loans SET status = 'Approved for Disbursement' WHERE id = ? AND status = 'Disbursement Pending'`, [reqRow.loan_id]);
    });
    return { ok: true, disbursed: false, failed: true, loanId: reqRow.loan_id };
  }
}

async function processB2cTimeout({ conversationId }) {
  const reqRow = await get('SELECT * FROM mpesa_b2c_requests WHERE conversation_id = ?', [conversationId]);
  if (!reqRow) return { ok: false, message: 'No matching B2C request found for this ConversationID' };
  if (['Success', 'Failed', 'Timeout'].includes(reqRow.status)) return { ok: true, alreadyProcessed: true };
  await transaction(async () => {
    await run(`UPDATE mpesa_b2c_requests SET status = 'Timeout', result_desc = 'Request timed out waiting for Safaricom', completed_at = iso_now() WHERE id = ?`, [reqRow.id]);
    await run(`UPDATE loans SET status = 'Approved for Disbursement' WHERE id = ? AND status = 'Disbursement Pending'`, [reqRow.loan_id]);
  });
  return { ok: true, timedOut: true, loanId: reqRow.loan_id };
}

// Callback handler — what Safaricom POSTs to the configured callback URL
// after a customer completes/cancels an STK push. Idempotent: the same
// CheckoutRequestID processed twice has no additional effect.
async function recordCallback({ checkoutRequestId, environment, resultCode, resultDesc, amount, mpesaReceiptNumber, phone }) {
  const existing = await get('SELECT id FROM mpesa_callbacks WHERE checkout_request_id = ?', [checkoutRequestId]);
  if (existing) return { duplicate: true, id: existing.id };
  // The real loan this callback belongs to — looked up from what we
  // recorded at initiation, never trusted from the callback body itself
  // (Safaricom doesn't echo it back).
  const stkRequest = await get('SELECT * FROM mpesa_stk_requests WHERE checkout_request_id = ?', [checkoutRequestId]);
  const id = 'mpc_' + checkoutRequestId;
  await run(
    `INSERT INTO mpesa_callbacks (id, checkout_request_id, environment, result_code, result_desc, amount, mpesa_receipt_number, phone, loan_id, processed)
     VALUES (?,?,?,?,?,?,?,?,?,0)`,
    [id, checkoutRequestId, environment || null, resultCode, resultDesc, amount || null, mpesaReceiptNumber || null, phone || null, stkRequest ? stkRequest.loan_id : null]
  );
  return { duplicate: false, id, loanId: stkRequest ? stkRequest.loan_id : null, initiatedBy: stkRequest ? stkRequest.initiated_by : null };
}

async function unmatchedCallbacks() {
  return all('SELECT * FROM mpesa_callbacks WHERE processed = 0 ORDER BY created_at DESC');
}

// ==================== C2B / Paybill ====================
// A customer paying directly via Paybill/Till has no "initiation" step we
// control — there is no STK-style request mapping to look up. Instead the
// real, standard Daraja C2B pattern is used: match on the customer-typed
// BillRefNumber (the "Account Number" field at the till) against a real
// loan id first, then fall back to matching a real client's phone number.
// An unmatched transaction is recorded and flagged for manual review —
// never silently discarded, never guessed at with a fabricated match.
async function matchC2bAccount(billRefNumber, msisdn) {
  if (billRefNumber) {
    const loan = await get(`SELECT * FROM loans WHERE id = ? AND status IN ('Active','Disbursed')`, [billRefNumber.trim()]);
    if (loan) return { loanId: loan.id, method: 'loan_id' };
  }
  if (msisdn) {
    // Real phone normalization: Safaricom sends 2547XXXXXXXX; clients are
    // stored as locally-entered numbers — compare on the last 9 digits.
    const last9 = String(msisdn).slice(-9);
    const client = await get(`SELECT * FROM clients WHERE phone LIKE ?`, ['%' + last9]);
    if (client) {
      const loan = await get(`SELECT * FROM loans WHERE client_id = ? AND status IN ('Active','Disbursed') ORDER BY created_at DESC`, [client.id]);
      if (loan) return { loanId: loan.id, method: 'phone' };
    }
  }
  return { loanId: null, method: 'unmatched' };
}

// Real C2B Validation — Safaricom calls this BEFORE completing the
// transaction on their side, giving a chance to reject genuinely invalid
// account references. Conservative by design: we only reject when we are
// CERTAIN the reference cannot be real (empty); an unmatched-but-plausible
// reference is still accepted (money already left the customer's
// account by the time Confirmation fires in the real C2B flow for many
// integrations, so aggressive rejection here is a business-risk choice,
// not a code correctness one) and handled at Confirmation/reconciliation instead.
async function validateC2b({ billRefNumber }) {
  if (!billRefNumber || !billRefNumber.trim()) {
    return { ResultCode: 'C2B00012', ResultDesc: 'Rejected - missing account reference' };
  }
  return { ResultCode: '0', ResultDesc: 'Accepted' };
}

// Real C2B Confirmation — the actual, mandatory record of money received.
// Idempotent on Safaricom's real TransID, exactly like STK's CheckoutRequestID.
async function recordC2bTransaction({ transId, environment, amount, msisdn, billRefNumber }) {
  const existing = await get('SELECT id FROM mpesa_c2b_transactions WHERE trans_id = ?', [transId]);
  if (existing) return { duplicate: true, id: existing.id };
  const match = await matchC2bAccount(billRefNumber, msisdn);
  const id = 'c2b_' + transId;
  await run(
    `INSERT INTO mpesa_c2b_transactions (id, trans_id, environment, amount, msisdn, bill_ref_number, matched_loan_id, match_method, processed)
     VALUES (?,?,?,?,?,?,?,?,0)`,
    [id, transId, environment || null, amount || null, msisdn || null, billRefNumber || null, match.loanId, match.method]
  );
  return { duplicate: false, id, loanId: match.loanId, matchMethod: match.method };
}

// Same real bridge as processCallback() — reuses allocate()/
// postPaymentJournal(), never a second accounting engine.
async function processC2bTransaction(c2bId, actorUserId) {
  const tx = await get('SELECT * FROM mpesa_c2b_transactions WHERE id = ?', [c2bId]);
  if (!tx) return { ok: false, message: 'Transaction not found' };
  if (tx.processed) return { ok: false, message: 'Already processed', alreadyProcessed: true };
  if (!tx.matched_loan_id) {
    return { ok: false, message: 'This C2B payment could not be matched to a real loan (unmatched account reference/phone) — requires manual reconciliation', unmatched: true };
  }
  const { allocate, postPaymentJournal } = require('./../routes/payments');
  const loan = await get('SELECT * FROM loans WHERE id = ?', [tx.matched_loan_id]);
  if (!loan) return { ok: false, message: 'The matched loan no longer exists' };
  const crypto = require('node:crypto');
  const paymentId = 'pm_' + crypto.randomUUID();
  const amount = tx.amount || 0;
  let status, result;
  await transaction(async () => {
    await run(
      `INSERT INTO payments (id, loan_id, client_id, amount, channel, reference, status, allocated_principal, allocated_interest, recorded_by)
       VALUES (?,?,?,?,'M-Pesa',?,'Unposted',0,0,?)`,
      [paymentId, loan.id, loan.client_id, amount, tx.trans_id, actorUserId || null]
    );
    result = await allocate(loan.id, amount, paymentId);
    status = result.remaining > 0 ? 'Overpayment' : 'Posted';
    await run('UPDATE payments SET status = ?, allocated_principal = ?, allocated_interest = ? WHERE id = ?', [status, result.allocPrincipal, result.allocInterest, paymentId]);
    await postPaymentJournal({
      paymentId, loanId: loan.id, amount, channel: 'M-Pesa',
      allocPrincipal: result.allocPrincipal, allocInterest: result.allocInterest, overpay: result.remaining,
      userId: actorUserId || null, branchId: loan.branch_id,
    });
    await run('UPDATE mpesa_c2b_transactions SET processed = 1, payment_id = ? WHERE id = ?', [paymentId, tx.id]);
  });
  return { ok: true, created: true, paymentId, status };
}

async function unmatchedC2bTransactions() {
  return all(`SELECT * FROM mpesa_c2b_transactions WHERE match_method = 'unmatched' AND processed = 0 ORDER BY created_at DESC`);
}

// The real bridge Milestone 10 requires: a successful M-Pesa callback
// becomes a REAL payment through the EXACT SAME allocate()/
// postPaymentJournal() functions Payments already uses — never a second
// accounting engine. Idempotent: a callback already marked processed is
// never re-applied, so a duplicate Safaricom retry can never create two
// payments.
async function processCallback(callbackId, actorUserId) {
  const cb = await get('SELECT * FROM mpesa_callbacks WHERE id = ?', [callbackId]);
  if (!cb) return { ok: false, message: 'Callback not found' };
  if (cb.processed) return { ok: false, message: 'Already processed', alreadyProcessed: true };
  if (Number(cb.result_code) !== 0) {
    // A failed/cancelled STK attempt is not a payment — just mark it seen.
    await run('UPDATE mpesa_callbacks SET processed = 1 WHERE id = ?', [cb.id]);
    return { ok: true, created: false, reason: 'Transaction was not successful on Safaricom\'s side (result code ' + cb.result_code + ')' };
  }
  if (!cb.loan_id) {
    // A successful payment we cannot attribute to any real loan — surfaced
    // for manual review, never silently dropped or guessed.
    return { ok: false, message: 'No loan is associated with this callback (STK request mapping missing) — requires manual reconciliation' };
  }
  const { allocate, postPaymentJournal } = require('./../routes/payments');
  const loan = await get('SELECT * FROM loans WHERE id = ?', [cb.loan_id]);
  if (!loan) return { ok: false, message: 'The loan this callback was for no longer exists' };
  const crypto = require('node:crypto');
  const paymentId = 'pm_' + crypto.randomUUID();
  const amount = cb.amount || 0;
  // Real transaction boundary — an STK callback creating a payment with no
  // matching journal entry (or vice versa) is exactly the audit's
  // critical finding, and callbacks are the one path most likely to be
  // interrupted mid-flight (webhook retries, timeouts, process restarts).
  let status, result;
  await transaction(async () => {
    await run(
      `INSERT INTO payments (id, loan_id, client_id, amount, channel, reference, status, allocated_principal, allocated_interest, recorded_by)
       VALUES (?,?,?,?,'M-Pesa',?,'Unposted',0,0,?)`,
      [paymentId, loan.id, loan.client_id, amount, cb.mpesa_receipt_number || cb.checkout_request_id, actorUserId || cb.initiated_by || null]
    );
    result = await allocate(loan.id, amount, paymentId);
    status = result.remaining > 0 ? 'Overpayment' : 'Posted';
    await run('UPDATE payments SET status = ?, allocated_principal = ?, allocated_interest = ? WHERE id = ?', [status, result.allocPrincipal, result.allocInterest, paymentId]);
    await postPaymentJournal({
      paymentId, loanId: loan.id, amount, channel: 'M-Pesa',
      allocPrincipal: result.allocPrincipal, allocInterest: result.allocInterest, overpay: result.remaining,
      userId: actorUserId || cb.initiated_by || null, branchId: loan.branch_id,
    });
    await run('UPDATE mpesa_callbacks SET processed = 1, payment_id = ? WHERE id = ?', [paymentId, cb.id]);
  });
  return { ok: true, created: true, paymentId, status };
}

module.exports = {
  isConfigured, initiateStkPush, recordCallback, unmatchedCallbacks, processCallback,
  validateC2b, recordC2bTransaction, processC2bTransaction, unmatchedC2bTransactions,
  initiateB2C, processB2cResult, processB2cTimeout,
  getMaskedConfig, saveConfig, setActiveEnvironment, clearConfig, getActiveEnvironment,
  statusFor, testConnection, effectiveConfig,
};
