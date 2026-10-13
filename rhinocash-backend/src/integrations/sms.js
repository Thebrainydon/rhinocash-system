// sms.js — provider-agnostic SMS interface. No SMS is ever actually sent by
// this file until a real provider adapter is configured; calls are logged
// and returned as NOT_CONFIGURED so nothing pretends to have been delivered.
//
// Supported triggers this app already has real events for: loan approval,
// loan disbursement, payment confirmation, arrears reminders, password reset.
//
// Where real credentials go:
//   SMS_PROVIDER            — e.g. 'africastalking' | 'twilio' (selects the adapter below)
//   SMS_API_KEY / SMS_API_SECRET / SMS_SENDER_ID  — provider-specific
'use strict';
const store = require('./store');

// Configured either by the System Administrator (Admin > Integrations >
// eSMS, stored encrypted in the database) or, as a fallback, by the
// SMS_PROVIDER / SMS_API_KEY / SMS_USERNAME / SMS_SENDER_ID env variables.
function envConfig() {
  if (!(process.env.SMS_PROVIDER && process.env.SMS_API_KEY)) return null;
  return { provider: process.env.SMS_PROVIDER, apiKey: process.env.SMS_API_KEY, username: process.env.SMS_USERNAME || '', senderId: process.env.SMS_SENDER_ID || '' };
}
function isConfigured() {
  const c = store.cached('sms');
  return !!envConfig() || !!(c && c.enabled && c.secret);
}
async function resolveConfig() {
  const db = await store.active('sms').catch(() => null);
  if (db) return { provider: db.provider, apiKey: db.secret, username: db.settings.username || '', senderId: db.settings.senderId || '' };
  return envConfig();
}
// Kenyan numbers in the international format providers expect (+2547…).
function normalizePhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('254')) return '+' + d;
  if (d.startsWith('0')) return '+254' + d.slice(1);
  if (d.length === 9) return '+254' + d;
  return d ? '+' + d : '';
}
// Africa's Talking bulk SMS API. Username "sandbox" uses their sandbox.
async function sendAfricasTalking(cfg, to, message) {
  const base = String(cfg.username).toLowerCase() === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  const form = new URLSearchParams({ username: cfg.username, to, message });
  if (cfg.senderId) form.set('from', cfg.senderId);
  const res = await fetch(base + '/version1/messaging', {
    method: 'POST', headers: { apiKey: cfg.apiKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  const rec = json && json.SMSMessageData && json.SMSMessageData.Recipients && json.SMSMessageData.Recipients[0];
  if (res.ok && rec && /success/i.test(rec.status)) return { ok: true, providerRef: rec.messageId, detail: rec.status };
  const why = (rec && rec.status) || (json && json.SMSMessageData && json.SMSMessageData.Message) || text.slice(0, 160) || `HTTP ${res.status}`;
  return { ok: false, detail: why };
}

const TEMPLATES = {
  loan_approved: (ctx) => `Rhinocash: Your loan application ${ctx.loanId} has been approved. You'll be notified once disbursed.`,
  loan_disbursed: (ctx) => `Rhinocash: KES ${ctx.amount} has been disbursed to your account for loan ${ctx.loanId}. Thank you.`,
  payment_confirmation: (ctx) => `Rhinocash: We've received your payment of KES ${ctx.amount} for loan ${ctx.loanId}. Ref: ${ctx.reference}.`,
  arrears_reminder: (ctx) => `Rhinocash: Your loan ${ctx.loanId} has an overdue payment of KES ${ctx.amount}. Please settle it to avoid further action.`,
  password_reset: (ctx) => `Rhinocash: Your temporary password is ${ctx.tempPassword}. You will be asked to change it on login.`,
  requisition_otp: (ctx) => `Rhinocash: Your requisition confirmation code is ${ctx.code}. It expires in 5 minutes. Do not share this code.`,
  salary_advance_otp: (ctx) => `Dear ${ctx.name}, Use code ${ctx.code} as your system OTP before ${ctx.expiresAt} STOP *456*9*5#`,
  salary_advance_approved: (ctx) => `Hi ${ctx.name}, your advance request of KES ${ctx.amount} has been Approved KES ${ctx.amount} by ${ctx.deciderName} STOP *456*9*5#`,
  salary_advance_rejected: (ctx) => `Hi ${ctx.name}, your advance request of KES ${ctx.amount} has been Rejected by ${ctx.deciderName} STOP *456*9*5#`,
  system_notification: (ctx) => ctx.body,
};

// send() never throws for "not configured" — that's an expected state, not
// an error the caller must handle every time. It DOES throw for an unknown
// template. Every attempt is written to the communication log.
async function send(templateName, phone, ctx, meta) {
  if (!TEMPLATES[templateName]) throw new Error(`Unknown SMS template: ${templateName}`);
  const message = TEMPLATES[templateName](ctx);
  const cfg = await resolveConfig();
  const to = normalizePhone(phone);
  if (!cfg) {
    await store.logAttempt('sms', templateName, to || phone, null, 'NOT_CONFIGURED', meta);
    return { status: 'NOT_CONFIGURED', provider: null, phone, message, note: 'Switch on SMS under Admin > Integrations > eSMS to enable real delivery.' };
  }
  let out;
  try {
    if (!to) out = { ok: false, detail: 'No phone number' };
    else if (cfg.provider === 'africastalking') out = await sendAfricasTalking(cfg, to, message);
    else out = { ok: false, detail: `SMS provider "${cfg.provider}" is not supported` };
  } catch (e) { out = { ok: false, detail: e && e.name === 'TimeoutError' ? 'The SMS provider did not respond in time' : `Could not reach the SMS provider${e && e.cause && e.cause.code ? ' (' + e.cause.code + ')' : ''} — check the server's internet access` }; }
  const status = out.ok ? 'Sent' : 'FAILED';
  await store.logAttempt('sms', templateName, to, null, status, meta);
  return { status, provider: cfg.provider, phone: to, message, providerRef: out.providerRef || null, detail: out.detail || null };
}

module.exports = { isConfigured, send, TEMPLATES, normalizePhone };
