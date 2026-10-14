// store.js — Admin-managed settings for outbound integrations (SMS, email).
//
// The System Administrator enters provider credentials on the Integrations
// pages; secrets are encrypted at rest with the same AES-256-GCM helper the
// M-Pesa credentials use and never leave the server unmasked. Each
// integration can be switched on or off without deleting its settings.
// Server environment variables still work as a fallback (see sms.js /
// email.js), so an existing deployment configured that way keeps working.
'use strict';
const { get, run } = require('./../db');
const { encryptSecret, tryDecryptSecret, maskSecret } = require('./../crypto');

const KINDS = {
  sms: { providers: ['africastalking'], secretLabel: 'API key' },
  email: { providers: ['sendgrid', 'mailgun', 'smtp'], secretLabel: 'API key' },
};
// A mailbox password (SMTP, e.g. Zoho Mail) may instead live only in the
// backend's environment, so it never passes through the browser at all.
const ENV_SECRETS = { 'email:smtp': 'SMTP_PASSWORD' };
function envSecret(kind, provider) {
  const name = ENV_SECRETS[`${kind}:${provider}`];
  return name && process.env[name] ? process.env[name] : null;
}
const secretLabel = (kind, provider) => (kind === 'email' && provider === 'smtp' ? 'password' : KINDS[kind].secretLabel);
// Settings that are not secret, per kind (stored as JSON).
const SETTINGS = {
  sms: ['username', 'senderId'],
  email: ['fromAddress', 'fromName', 'domain', 'region', 'smtpHost', 'smtpPort', 'smtpSecurity', 'smtpUsername'],
};

// In-memory copy so isConfigured() can stay synchronous for callers like
// the System Health check. Refreshed on every save and on first use.
const cache = new Map();
let loaded = false;

function parse(row) {
  if (!row) return null;
  let settings = {};
  try { settings = JSON.parse(row.settings_json || '{}') || {}; } catch { settings = {}; }
  const dec = row.secret_enc ? tryDecryptSecret(row.secret_enc) : { ok: true, value: null };
  return {
    kind: row.kind, provider: row.provider, settings, enabled: !!row.enabled,
    secret: dec.ok ? dec.value : null, secretUnreadable: !dec.ok,
    lastTestStatus: row.last_test_status || 'Never Tested', lastTestAt: row.last_test_at || null, lastTestMessage: row.last_test_message || null,
    updatedAt: row.updated_at || null,
  };
}

async function load(kind) {
  const row = await get('SELECT * FROM integration_configs WHERE kind = ?', [kind]);
  const cfg = parse(row);
  cache.set(kind, cfg);
  return cfg;
}
async function loadAll() {
  for (const k of Object.keys(KINDS)) await load(k);
  loaded = true;
}
function cached(kind) {
  if (!loaded) loadAll().catch(() => {});
  return cache.get(kind) || null;
}

// Active, usable configuration from the database, or null.
async function active(kind) {
  const cfg = await load(kind);
  if (!cfg || !cfg.enabled || !cfg.provider) return null;
  const secret = cfg.secret || envSecret(kind, cfg.provider);
  if (!secret) return null;
  return { ...cfg, secret };
}

function masked(cfg, kind) {
  const provider = cfg ? cfg.provider : null;
  const fromEnv = !!(provider && !(cfg && cfg.secret) && envSecret(kind, provider));
  return {
    kind,
    provider: cfg ? cfg.provider : null,
    settings: cfg ? cfg.settings : {},
    enabled: cfg ? cfg.enabled : false,
    // A password is never shown, not even its last characters.
    apiKey: cfg && cfg.secret ? (secretLabel(kind, provider) === 'password' ? 'saved' : maskSecret(cfg.secret)) : fromEnv ? 'from server' : null,
    secretSource: cfg && cfg.secret ? 'saved' : fromEnv ? 'server environment' : null,
    credentialsUnreadable: cfg ? cfg.secretUnreadable : false,
    configured: !!(cfg && cfg.provider && (cfg.secret || fromEnv)),
    lastTestStatus: cfg ? cfg.lastTestStatus : 'Never Tested',
    lastTestAt: cfg ? cfg.lastTestAt : null,
    lastTestMessage: cfg ? cfg.lastTestMessage : null,
    updatedAt: cfg ? cfg.updatedAt : null,
  };
}

async function save(kind, body, userId) {
  const def = KINDS[kind];
  const existing = await get('SELECT * FROM integration_configs WHERE kind = ?', [kind]);
  const provider = body.provider !== undefined ? String(body.provider || '').trim() : (existing && existing.provider) || def.providers[0];
  if (!def.providers.includes(provider)) throw Object.assign(new Error(`Provider must be one of: ${def.providers.join(', ')}`), { status: 400 });
  let settings = {};
  try { settings = existing ? JSON.parse(existing.settings_json || '{}') : {}; } catch { settings = {}; }
  for (const k of SETTINGS[kind]) if (body[k] !== undefined) settings[k] = String(body[k] || '').trim().slice(0, 200);
  if (kind === 'email' && settings.fromAddress && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(settings.fromAddress)) throw Object.assign(new Error('Enter a valid From address'), { status: 400 });
  if (kind === 'email' && provider === 'mailgun' && body.enabled && !settings.domain) throw Object.assign(new Error('Mailgun needs your sending domain'), { status: 400 });
  if (kind === 'email' && provider === 'smtp') {
    const { normalizeSecurity, isAddress } = require('./smtp');
    if (settings.smtpPort && !(/^\d{1,5}$/.test(settings.smtpPort) && +settings.smtpPort >= 1 && +settings.smtpPort <= 65535)) throw Object.assign(new Error('Enter a valid SMTP port, e.g. 587'), { status: 400 });
    if (settings.smtpHost && !/^[A-Za-z0-9.-]+$/.test(settings.smtpHost)) throw Object.assign(new Error('Enter a valid SMTP host, e.g. smtppro.zoho.com'), { status: 400 });
    const sec = normalizeSecurity(settings.smtpSecurity, settings.smtpPort || 587);
    if (!sec) throw Object.assign(new Error('Security must be STARTTLS (port 587) or SSL (port 465)'), { status: 400 });
    settings.smtpSecurity = sec;
    if (settings.smtpUsername && !isAddress(settings.smtpUsername)) throw Object.assign(new Error('The SMTP username is the full mailbox address, e.g. hr@rhinocash.co.ke'), { status: 400 });
    if (body.enabled && !(settings.smtpHost || process.env.SMTP_HOST)) throw Object.assign(new Error('Enter the SMTP host, e.g. smtppro.zoho.com'), { status: 400 });
  }
  // A blank API key / password keeps the stored one (unless it can no longer be read).
  // Another provider's key is never reused (e.g. a SendGrid key as a mailbox password).
  let secretEnc = existing && existing.provider === provider ? existing.secret_enc : null;
  const newSecret = body.apiKey || body.password;
  if (newSecret) secretEnc = encryptSecret(String(newSecret).trim());
  const enabled = body.enabled !== undefined ? (body.enabled ? 1 : 0) : (existing ? existing.enabled : 0);
  const label = secretLabel(kind, provider);
  if (enabled && !secretEnc && !envSecret(kind, provider)) throw Object.assign(new Error(`Enter the ${label} before switching this on${provider === 'smtp' ? ' (or set SMTP_PASSWORD on the backend server)' : ''}`), { status: 400 });
  if (enabled && secretEnc && !tryDecryptSecret(secretEnc).ok) throw Object.assign(new Error(`Re-enter the ${label} — the saved one can no longer be read`), { status: 400 });
  if (enabled && kind === 'sms' && !settings.username) throw Object.assign(new Error("Enter your Africa's Talking username ('sandbox' for testing)"), { status: 400 });
  if (enabled && kind === 'email' && !settings.fromAddress) throw Object.assign(new Error('Enter the From address'), { status: 400 });
  await run(`INSERT INTO integration_configs (kind, provider, settings_json, secret_enc, enabled, updated_by, updated_at) VALUES (?,?,?,?,?,?, iso_now())
    ON CONFLICT (kind) DO UPDATE SET provider = EXCLUDED.provider, settings_json = EXCLUDED.settings_json, secret_enc = EXCLUDED.secret_enc,
    enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = iso_now()`,
  [kind, provider, JSON.stringify(settings), secretEnc, enabled, userId || null]);
  return load(kind);
}

async function clear(kind) {
  await run('DELETE FROM integration_configs WHERE kind = ?', [kind]);
  cache.delete(kind);
}

async function recordTest(kind, status, message) {
  await run('UPDATE integration_configs SET last_test_status = ?, last_test_at = iso_now(), last_test_message = ? WHERE kind = ?', [status, String(message || '').slice(0, 300), kind]);
  await load(kind);
}

// Every attempt is written to the communication log (Integration Logs).
async function logAttempt(channel, template, recipient, subject, status, meta) {
  try {
    await run('INSERT INTO communication_log (id, channel, template, recipient, subject, status, related_type, related_id, sent_by) VALUES (?,?,?,?,?,?,?,?,?)',
      ['cml_' + require('node:crypto').randomUUID(), channel, template, recipient || null, subject ? String(subject).slice(0, 200) : null, status,
        (meta && meta.relatedType) || null, (meta && meta.relatedId) || null, (meta && meta.sentBy) || null]);
  } catch { /* logging must never break sending */ }
}

module.exports = { KINDS, SETTINGS, envSecret, active, cached, load, loadAll, masked, save, clear, recordTest, logAttempt };
