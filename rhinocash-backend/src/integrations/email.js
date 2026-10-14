// email.js — provider-agnostic email interface, same honesty rule as sms.js:
// nothing is ever claimed to be delivered unless a real provider is wired up.
//
// Where real credentials go:
//   EMAIL_PROVIDER           — 'sendgrid' | 'mailgun' | 'smtp' (e.g. Zoho Mail)
//   EMAIL_API_KEY             — provider API key (SendGrid / Mailgun)
//   SMTP_HOST, SMTP_PORT, SMTP_SECURITY, SMTP_USERNAME, SMTP_PASSWORD — SMTP mailbox
//   EMAIL_FROM_ADDRESS        — the verified sending address
'use strict';
const store = require('./store');
const smtp = require('./smtp');

// Configured by the System Administrator (Admin > Integrations > Email,
// stored encrypted) or, as a fallback, by EMAIL_PROVIDER / EMAIL_API_KEY /
// EMAIL_FROM_ADDRESS (+ EMAIL_DOMAIN for Mailgun) env variables.
const smtpEnv = () => ({ smtpHost: process.env.SMTP_HOST || '', smtpPort: process.env.SMTP_PORT || '', smtpSecurity: process.env.SMTP_SECURITY || '', smtpUsername: process.env.SMTP_USERNAME || '' });
function envConfig() {
  const e = process.env;
  if (e.EMAIL_PROVIDER === 'smtp') {
    if (!(e.SMTP_HOST && e.SMTP_PASSWORD && e.EMAIL_FROM_ADDRESS)) return null;
    return { provider: 'smtp', apiKey: e.SMTP_PASSWORD, fromAddress: e.EMAIL_FROM_ADDRESS, fromName: e.EMAIL_FROM_NAME || 'Rhinocash', ...smtpEnv() };
  }
  if (!(e.EMAIL_PROVIDER && e.EMAIL_API_KEY && e.EMAIL_FROM_ADDRESS)) return null;
  return { provider: process.env.EMAIL_PROVIDER, apiKey: process.env.EMAIL_API_KEY, fromAddress: process.env.EMAIL_FROM_ADDRESS, fromName: process.env.EMAIL_FROM_NAME || 'Rhinocash', domain: process.env.EMAIL_DOMAIN || '', region: process.env.EMAIL_REGION || '' };
}
function isConfigured() {
  const c = store.cached('email');
  return !!envConfig() || !!(c && c.enabled && (c.secret || store.envSecret('email', c.provider)));
}
async function resolveConfig() {
  const db = await store.active('email').catch(() => null);
  if (db) {
    const env = smtpEnv(), st = db.settings;
    return { provider: db.provider, apiKey: db.secret, fromAddress: st.fromAddress, fromName: st.fromName || 'Rhinocash', domain: st.domain || '', region: st.region || '',
      smtpHost: st.smtpHost || env.smtpHost, smtpPort: st.smtpPort || env.smtpPort, smtpSecurity: st.smtpSecurity || env.smtpSecurity, smtpUsername: st.smtpUsername || env.smtpUsername };
  }
  return envConfig();
}
async function deliver(cfg, to, subject, body) {
  const signal = AbortSignal.timeout(15000);
  if (cfg.provider === 'sendgrid') {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', { method: 'POST', signal,
      headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: cfg.fromAddress, name: cfg.fromName }, subject, content: [{ type: 'text/plain', value: body }] }) });
    if (res.status === 202 || res.ok) return { ok: true, providerRef: res.headers.get('x-message-id') };
    const t = await res.text(); let why = t.slice(0, 160); try { why = JSON.parse(t).errors.map(e => e.message).join('; '); } catch { /* keep text */ }
    return { ok: false, detail: why || `HTTP ${res.status}` };
  }
  if (cfg.provider === 'mailgun') {
    const host = String(cfg.region).toLowerCase() === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net';
    const form = new URLSearchParams({ from: `${cfg.fromName} <${cfg.fromAddress}>`, to, subject, text: body });
    const res = await fetch(`${host}/v3/${encodeURIComponent(cfg.domain)}/messages`, { method: 'POST', signal,
      headers: { Authorization: 'Basic ' + Buffer.from('api:' + cfg.apiKey).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch { /* not JSON */ }
    if (res.ok) return { ok: true, providerRef: json && json.id };
    return { ok: false, detail: (json && json.message) || t.slice(0, 160) || `HTTP ${res.status}` };
  }
  if (cfg.provider === 'smtp') {
    return smtp.sendMail({ host: cfg.smtpHost, port: Number(cfg.smtpPort) || 587, security: cfg.smtpSecurity, username: cfg.smtpUsername || cfg.fromAddress,
      password: cfg.apiKey, from: cfg.fromAddress, fromName: cfg.fromName }, { to, subject, text: body });
  }
  return { ok: false, detail: `Email provider "${cfg.provider}" is not supported` };
}

// Public address of the Rhinocash web app (APP_BASE_URL), added to emails
// so people know where to sign in. Left out when it isn't configured.
const signInLine = () => { const u = String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, ''); return u ? `\n\nSign in at ${u}` : ''; };
const TEMPLATES = {
  account_invitation: (ctx) => ({
    subject: 'Welcome to Rhinocash',
    body: `Hello ${ctx.name},\n\nYour Rhinocash account has been created.\nEmail: ${ctx.email}\nTemporary password: ${ctx.tempPassword}\n\nYou'll be asked to set a new password on first login.${signInLine()}`,
  }),
  password_reset: (ctx) => ({
    subject: 'Your Rhinocash password has been reset',
    body: `Hello ${ctx.name},\n\nYour temporary password is: ${ctx.tempPassword}\nYou'll be asked to change it on next login.${signInLine()}\n\nIf you did not request this, contact your System Administrator immediately.`,
  }),
  monthly_statement: (ctx) => ({
    subject: `Your ${ctx.period} statement`,
    body: `Hello ${ctx.name},\n\nYour statement for ${ctx.period} is attached/available in the portal.${signInLine()}`,
  }),
  system_notification: (ctx) => ({ subject: ctx.subject, body: ctx.body }),
};

async function send(templateName, toAddress, ctx, meta) {
  if (!TEMPLATES[templateName]) throw new Error(`Unknown email template: ${templateName}`);
  const { subject, body } = TEMPLATES[templateName](ctx);
  const cfg = await resolveConfig();
  if (!cfg) {
    await store.logAttempt('email', templateName, toAddress, subject, 'NOT_CONFIGURED', meta);
    return { status: 'NOT_CONFIGURED', provider: null, to: toAddress, subject, note: 'Switch on Email under Admin > Integrations > Email to enable real delivery.' };
  }
  let out;
  try { out = toAddress ? await deliver(cfg, toAddress, subject, body) : { ok: false, detail: 'No email address' }; }
  catch (e) { out = { ok: false, detail: e && e.name === 'TimeoutError' ? 'The email provider did not respond in time' : `Could not reach the email provider${e && e.cause && e.cause.code ? ' (' + e.cause.code + ')' : ''} — check the server's internet access` }; }
  const status = out.ok ? 'Sent' : 'FAILED';
  await store.logAttempt('email', templateName, toAddress, subject, status, meta);
  return { status, provider: cfg.provider, to: toAddress, subject, providerRef: out.providerRef || null, detail: out.detail || null };
}

module.exports = { isConfigured, send, TEMPLATES };
