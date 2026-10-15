// coopbank.js — Co-operative Bank of Kenya "Co-op Connect" API: loan
// disbursements sent from Rhinocash's own Co-op account straight to a
// client's bank account (Co-op to Co-op, or PesaLink to another bank).
//
// Configured through the database (credentials encrypted at rest) from
// Admin › Integrations › Co-op Bank, like M-Pesa. Built to Co-op Connect's
// published API layout (OAuth client-credentials token, then the Funds
// Transfer and Transaction Status APIs); the exact paths and the API host
// are settings, so they can be matched to what Co-op issues at onboarding.
// Nothing here pretends a transfer succeeded: a loan only becomes Active
// once Co-op's own Transaction Status API confirms the money moved.
'use strict';
const crypto = require('node:crypto');
const { get, run, all, transaction } = require('./../db');
const { encryptSecret, decryptSecret, tryDecryptSecret, maskSecret } = require('./../crypto');

const ENVIRONMENTS = ['sandbox', 'production'];
const DEFAULT_BASE_URL = { sandbox: 'https://developer.co-opbank.co.ke:8243', production: '' };
const PATHS = {
  token: '/token',
  internal: '/FundsTransfer/Internal/A2A/2.0.0',
  pesalink: '/FundsTransfer/External/A2A/PesaLink/1.0.0',
  status: '/Enquiry/TransactionStatus/2.0.0',
};
const CO_OP_BANK_CODE = '11';

function publicApiBase() { return require('./mpesa').publicApiBase(); }
function defaultCallbackUrl(environment) { return `${publicApiBase()}/api/bank/coop/callback/${environment}`; }

async function ensureRow(environment) {
  const existing = await get('SELECT * FROM bank_environment_configs WHERE environment = ?', [environment]);
  if (existing) return existing;
  await run('INSERT INTO bank_environment_configs (environment) VALUES (?)', [environment]);
  return get('SELECT * FROM bank_environment_configs WHERE environment = ?', [environment]);
}

async function getActiveEnvironment() {
  const row = await get('SELECT active_environment FROM bank_active_config WHERE id = 1');
  return row ? row.active_environment : null;
}

function baseUrlOf(row, environment) {
  return String((row && row.base_url) || DEFAULT_BASE_URL[environment] || '').trim().replace(/\/+$/, '');
}

// Decrypted, in-memory only, server-side only — never returned by a route.
async function getDecryptedConfig(environment) {
  const row = await get('SELECT * FROM bank_environment_configs WHERE environment = ?', [environment]);
  if (!row) return null;
  for (const f of ['consumer_key_enc', 'consumer_secret_enc']) {
    if (row[f] && !tryDecryptSecret(row[f]).ok) {
      throw Object.assign(new Error(`The saved ${environment} Co-op Bank keys can no longer be read (the server's encryption key changed). Re-enter them under Admin › Integrations › Co-op Bank.`), { status: 409 });
    }
  }
  return {
    environment,
    baseUrl: baseUrlOf(row, environment),
    consumerKey: row.consumer_key_enc ? decryptSecret(row.consumer_key_enc) : null,
    consumerSecret: row.consumer_secret_enc ? decryptSecret(row.consumer_secret_enc) : null,
    sourceAccount: row.source_account,
    callbackUrl: row.callback_url || defaultCallbackUrl(environment),
    configured: !!row.configured,
  };
}

// The only shape that ever leaves the server: secrets masked.
async function getMaskedConfig(environment) {
  const row = (await get('SELECT * FROM bank_environment_configs WHERE environment = ?', [environment])) || {};
  let unreadable = false;
  const mask = enc => { if (!enc) return null; const r = tryDecryptSecret(enc); if (!r.ok) { unreadable = true; return null; } return maskSecret(r.value); };
  return {
    environment,
    provider: 'Co-operative Bank (Co-op Connect)',
    consumerKey: mask(row.consumer_key_enc),
    consumerSecret: mask(row.consumer_secret_enc),
    credentialsUnreadable: unreadable,
    sourceAccount: row.source_account || null,
    baseUrl: row.base_url || null,
    defaultBaseUrl: DEFAULT_BASE_URL[environment] || null,
    callbackUrl: row.callback_url || null,
    defaultCallbackUrl: defaultCallbackUrl(environment),
    configured: !!row.configured,
    lastTestStatus: row.last_test_status || 'Never Tested',
    lastTestAt: row.last_test_at || null,
    lastTestMessage: row.last_test_message || null,
  };
}

// Blank fields keep what is saved (the admin never sees the stored secret).
async function saveConfig(environment, fields, actorUserId) {
  await ensureRow(environment);
  const sets = []; const params = []; const changedFields = [];
  if (fields.consumerKey) { sets.push('consumer_key_enc = ?'); params.push(encryptSecret(String(fields.consumerKey).trim())); changedFields.push('consumer_key'); }
  if (fields.consumerSecret) { sets.push('consumer_secret_enc = ?'); params.push(encryptSecret(String(fields.consumerSecret).trim())); changedFields.push('consumer_secret'); }
  if (fields.sourceAccount !== undefined) {
    const acct = String(fields.sourceAccount || '').replace(/\s+/g, '');
    if (acct && !/^\d{6,20}$/.test(acct)) throw Object.assign(new Error('The Rhinocash Co-op account number must be 6–20 digits.'), { status: 400 });
    sets.push('source_account = ?'); params.push(acct || null); changedFields.push('source_account');
  }
  if (fields.baseUrl !== undefined) {
    const url = String(fields.baseUrl || '').trim().replace(/\/+$/, '');
    // https only — plain http is accepted for this machine alone (local testing).
    if (url && !/^https:\/\/[^\s/]+/i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(url)) throw Object.assign(new Error('The API address must start with https://'), { status: 400 });
    sets.push('base_url = ?'); params.push(url || null); changedFields.push('base_url');
  }
  if (fields.callbackUrl !== undefined) {
    const url = String(fields.callbackUrl || '').trim();
    if (url && !/^https:\/\/[^\s/]+/i.test(url)) throw Object.assign(new Error('The callback URL must start with https://'), { status: 400 });
    sets.push('callback_url = ?'); params.push(url || null); changedFields.push('callback_url');
  }
  if (sets.length) {
    sets.push('updated_by = ?', 'updated_at = iso_now()');
    params.push(actorUserId, environment);
    await run(`UPDATE bank_environment_configs SET ${sets.join(', ')} WHERE environment = ?`, params);
  }
  const row = await get('SELECT * FROM bank_environment_configs WHERE environment = ?', [environment]);
  const configured = !!(row.consumer_key_enc && row.consumer_secret_enc && row.source_account && baseUrlOf(row, environment));
  await run('UPDATE bank_environment_configs SET configured = ? WHERE environment = ?', [configured ? 1 : 0, environment]);
  return { changedFields, configured };
}

async function setActiveEnvironment(environment) {
  if (environment === null) { await run('DELETE FROM bank_active_config WHERE id = 1'); return; }
  const row = await get('SELECT configured FROM bank_environment_configs WHERE environment = ?', [environment]);
  if (!row || !row.configured) throw Object.assign(new Error(`Cannot switch on ${environment} — enter the keys, the Rhinocash Co-op account and the API address first.`), { status: 409 });
  await run(`INSERT INTO bank_active_config (id, active_environment) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET active_environment = EXCLUDED.active_environment`, [environment]);
}

async function clearConfig(environment) {
  await run('DELETE FROM bank_environment_configs WHERE environment = ?', [environment]);
  if ((await getActiveEnvironment()) === environment) await run('DELETE FROM bank_active_config WHERE id = 1');
}

async function callApi(url, opts, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const body = await res.json().catch(() => null);
    return { ok: true, status: res.status, body };
  } catch (e) {
    return { ok: false, timeout: e.name === 'AbortError' };
  } finally { clearTimeout(t); }
}

// OAuth client-credentials token. The message is always safe to show.
async function requestToken(config) {
  if (!config || !config.consumerKey || !config.consumerSecret) return { ok: false, message: 'Enter the Consumer Key and Consumer Secret first.' };
  if (!config.baseUrl) return { ok: false, message: 'Enter the Co-op API address for this environment first.' };
  const basic = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
  const r = await callApi(config.baseUrl + PATHS.token, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  }, 10000);
  if (!r.ok) return { ok: false, message: r.timeout ? 'Co-op Bank did not answer within 10 seconds.' : 'Could not reach Co-op Bank — check the API address and the server\'s outbound network access.' };
  if (r.status === 200 && r.body && r.body.access_token) return { ok: true, token: r.body.access_token, message: 'Connected — Co-op Bank issued an access token.' };
  if (r.status === 400 || r.status === 401) return { ok: false, message: 'Co-op Bank rejected the keys for this environment.' };
  return { ok: false, message: `Co-op Bank returned an unexpected answer (HTTP ${r.status}).` };
}

async function testConnection(environment) {
  const config = await getDecryptedConfig(environment);
  const result = await requestToken(config);
  const status = result.ok ? 'Connection Successful' : 'Connection Failed';
  await run('UPDATE bank_environment_configs SET last_test_status = ?, last_test_at = iso_now(), last_test_message = ? WHERE environment = ?', [status, result.message, environment]);
  return { status, message: result.message };
}

async function activeConfig() {
  const env = await getActiveEnvironment();
  if (!env) return null;
  const config = await getDecryptedConfig(env);
  return config && config.configured ? config : null;
}

// Destination checks before anything is sent.
function validateDestination({ rail, bankCode, accountNumber, accountName }) {
  if (!['internal', 'pesalink'].includes(rail)) return 'Choose Co-op Bank account or Other bank (PesaLink).';
  const acct = String(accountNumber || '').replace(/\s+/g, '');
  if (!/^\d{6,20}$/.test(acct)) return 'Enter the client\'s bank account number (6–20 digits).';
  if (!String(accountName || '').trim()) return 'Enter the account name exactly as the bank holds it.';
  if (rail === 'pesalink' && !/^\d{2,4}$/.test(String(bankCode || '').trim())) return 'Choose the client\'s bank.';
  if (rail === 'pesalink' && String(bankCode).trim() === CO_OP_BANK_CODE) return 'For a Co-op Bank account choose "Co-op Bank account", not PesaLink.';
  return null;
}

// Sends a real transfer. The loan is marked "Disbursement Pending"; it is
// only completed once Co-op's Transaction Status API confirms it.
async function initiateTransfer({ loanId, amount, rail, bankCode, accountNumber, accountName, narration, initiatedBy }) {
  const config = await activeConfig();
  if (!config) return { status: 'NOT_CONFIGURED', message: 'Co-op Bank transfers are not switched on. An Admin sets them up under Admin › Integrations › Co-op Bank.' };
  const invalid = validateDestination({ rail, bankCode, accountNumber, accountName });
  if (invalid) return { status: 'INVALID', message: invalid };
  const pending = await get(`SELECT id FROM bank_disbursements WHERE loan_id = ? AND status IN ('Requested','Pending')`, [loanId]);
  if (pending) return { status: 'DUPLICATE', message: 'A bank transfer for this loan is already waiting for the bank\'s confirmation.' };

  const tokenResult = await requestToken(config);
  if (!tokenResult.ok) return { status: 'FAILED', message: tokenResult.message };

  const acct = String(accountNumber).replace(/\s+/g, '');
  const messageReference = 'RC' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
  const id = 'bkd_' + crypto.randomUUID();
  const amt = Math.round(Number(amount) * 100) / 100;
  const text = String(narration || 'Loan disbursement').slice(0, 60);
  await run(`INSERT INTO bank_disbursements (id, message_reference, loan_id, environment, rail, bank_code, account_number, account_name, amount, status, initiated_by)
             VALUES (?,?,?,?,?,?,?,?,?, 'Requested', ?)`,
    [id, messageReference, loanId, config.environment, rail, rail === 'internal' ? CO_OP_BANK_CODE : String(bankCode).trim(), acct, String(accountName).trim(), amt, initiatedBy || null]);
  const destination = { ReferenceNumber: messageReference + '_1', AccountNumber: acct, Amount: amt, TransactionCurrency: 'KES', Narration: text };
  if (rail === 'pesalink') Object.assign(destination, { BankCode: String(bankCode).trim(), AccountName: String(accountName).trim() });
  const payload = {
    MessageReference: messageReference,
    CallBackUrl: config.callbackUrl,
    Source: { AccountNumber: config.sourceAccount, Amount: amt, TransactionCurrency: 'KES', Narration: text },
    Destinations: [destination],
  };
  const r = await callApi(config.baseUrl + PATHS[rail], {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenResult.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (r.ok && r.status >= 200 && r.status < 300 && r.body && String(r.body.MessageCode) === '0') {
    await run(`UPDATE bank_disbursements SET status = 'Pending', result_desc = ? WHERE id = ?`, [r.body.MessageDescription || 'Accepted for processing', id]);
    return { status: 'PENDING', requestId: id, messageReference, message: 'Sent to Co-op Bank — waiting for the bank to confirm the transfer.' };
  }
  // No answer at all: the bank may still have taken it — keep it pending
  // and let the status check settle it, never retry blindly.
  if (!r.ok) {
    await run(`UPDATE bank_disbursements SET status = 'Pending', result_desc = ? WHERE id = ?`, ['No answer from the bank — checking status', id]);
    return { status: 'PENDING', requestId: id, messageReference, message: 'Co-op Bank did not answer. The transfer is held as pending — use "Check with bank" before trying again.' };
  }
  const why = (r.body && (r.body.MessageDescription || r.body.message || r.body.description)) || `HTTP ${r.status}`;
  await run(`UPDATE bank_disbursements SET status = 'Failed', result_code = ?, result_desc = ?, completed_at = iso_now() WHERE id = ?`, [r.body && r.body.MessageCode != null ? String(r.body.MessageCode) : String(r.status), why, id]);
  return { status: 'FAILED', message: `Co-op Bank refused the transfer: ${why}` };
}

// Asks Co-op whether the transfer went through. Returns
// { state: 'success' | 'failed' | 'pending', code, description, bankReference }.
async function queryStatus(row) {
  const config = await getDecryptedConfig(row.environment);
  if (!config) return { state: 'pending', description: 'The bank settings for this environment were removed.' };
  const tokenResult = await requestToken(config);
  if (!tokenResult.ok) return { state: 'pending', description: tokenResult.message };
  const r = await callApi(config.baseUrl + PATHS.status, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenResult.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ MessageReference: row.message_reference }),
  });
  if (!r.ok || !r.body) return { state: 'pending', description: 'Could not reach Co-op Bank to check the transfer.' };
  const b = r.body;
  const dest = Array.isArray(b.Destinations) ? b.Destinations[0] : null;
  const code = String(dest && dest.ResponseCode != null ? dest.ResponseCode : b.MessageCode);
  const description = (dest && (dest.ResponseDescription || dest.TransactionStatus)) || b.MessageDescription || '';
  const bankReference = (dest && (dest.TransactionID || dest.TransactionId)) || b.TransactionID || null;
  if (String(b.MessageCode) === '0' && code === '0' && !/pending|processing|progress/i.test(description)) return { state: 'success', code, description, bankReference };
  if (/pending|processing|progress|queued/i.test(description) || code === '-1') return { state: 'pending', code, description };
  // Anything else that the bank states clearly is a failure.
  if (b.MessageCode != null || (dest && dest.ResponseCode != null)) return { state: 'failed', code, description: description || 'The bank reported the transfer as failed.' };
  return { state: 'pending', code, description };
}

// Settles a pending transfer from Co-op's own status answer (a callback is
// only ever a prompt to ask — its contents are never trusted).
async function settle(rowId, actorUserId) {
  const row = await get('SELECT * FROM bank_disbursements WHERE id = ?', [rowId]);
  if (!row) return { ok: false, message: 'Bank transfer not found' };
  if (['Completed', 'Failed'].includes(row.status)) return { ok: true, alreadySettled: true, status: row.status };
  const s = await queryStatus(row);
  if (s.state === 'success') {
    // Claimed atomically so two simultaneous checks can't both complete it.
    const claimed = await get(`UPDATE bank_disbursements SET status = 'Completed', result_code = ?, result_desc = ?, bank_reference = ?, completed_at = iso_now()
                               WHERE id = ? AND status IN ('Requested','Pending') RETURNING id`, [s.code || '0', s.description || 'Completed', s.bankReference || null, row.id]);
    if (!claimed) return { ok: true, alreadySettled: true };
    const loans = require('./../routes/loans');
    try {
      await loans.completeDisbursement({ loanId: row.loan_id, channel: 'Bank', actorUserId: row.initiated_by || actorUserId || null });
      return { ok: true, status: 'Completed', disbursed: true, loanId: row.loan_id };
    } catch (e) {
      // The money left the bank even if our bookkeeping failed — surface it.
      return { ok: true, status: 'Completed', disbursed: false, disbursementError: e.message, loanId: row.loan_id };
    }
  }
  if (s.state === 'failed') {
    await transaction(async () => {
      await run(`UPDATE bank_disbursements SET status = 'Failed', result_code = ?, result_desc = ?, completed_at = iso_now() WHERE id = ? AND status IN ('Requested','Pending')`, [s.code || null, s.description || 'Failed', row.id]);
      await run(`UPDATE loans SET status = 'Approved for Disbursement' WHERE id = ? AND status = 'Disbursement Pending'`, [row.loan_id]);
    });
    return { ok: true, status: 'Failed', loanId: row.loan_id, message: s.description };
  }
  await run(`UPDATE bank_disbursements SET result_desc = ? WHERE id = ?`, [s.description || 'Waiting for the bank', row.id]);
  return { ok: true, status: 'Pending', message: s.description || 'The bank has not confirmed it yet.' };
}

async function listForLoans(loanIds) {
  if (!loanIds.length) return [];
  return all(`SELECT * FROM bank_disbursements WHERE loan_id IN (${loanIds.map(() => '?').join(',')}) ORDER BY created_at DESC`, loanIds);
}

module.exports = {
  ENVIRONMENTS, DEFAULT_BASE_URL, PATHS, CO_OP_BANK_CODE,
  getActiveEnvironment, getMaskedConfig, saveConfig, setActiveEnvironment, clearConfig, testConnection,
  activeConfig, validateDestination, initiateTransfer, queryStatus, settle, listForLoans, defaultCallbackUrl,
};
