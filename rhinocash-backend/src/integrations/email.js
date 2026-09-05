// email.js — provider-agnostic email interface, same honesty rule as sms.js:
// nothing is ever claimed to be delivered unless a real provider is wired up.
//
// Where real credentials go:
//   EMAIL_PROVIDER           — e.g. 'sendgrid' | 'ses' | 'smtp'
//   EMAIL_API_KEY             — provider API key (or SMTP_* vars for a raw SMTP adapter)
//   EMAIL_FROM_ADDRESS        — the verified sending address
'use strict';

function isConfigured() {
  return !!(process.env.EMAIL_PROVIDER && process.env.EMAIL_API_KEY && process.env.EMAIL_FROM_ADDRESS);
}

const TEMPLATES = {
  account_invitation: (ctx) => ({
    subject: 'Welcome to Rhinocash',
    body: `Hello ${ctx.name},\n\nYour Rhinocash account has been created.\nEmail: ${ctx.email}\nTemporary password: ${ctx.tempPassword}\n\nYou'll be asked to set a new password on first login.`,
  }),
  password_reset: (ctx) => ({
    subject: 'Your Rhinocash password has been reset',
    body: `Hello ${ctx.name},\n\nYour temporary password is: ${ctx.tempPassword}\nYou'll be asked to change it on next login.\n\nIf you did not request this, contact your System Administrator immediately.`,
  }),
  monthly_statement: (ctx) => ({
    subject: `Your ${ctx.period} statement`,
    body: `Hello ${ctx.name},\n\nYour statement for ${ctx.period} is attached/available in the portal.`,
  }),
  system_notification: (ctx) => ({ subject: ctx.subject, body: ctx.body }),
};

async function send(templateName, toAddress, ctx) {
  if (!TEMPLATES[templateName]) throw new Error(`Unknown email template: ${templateName}`);
  const { subject, body } = TEMPLATES[templateName](ctx);
  if (!isConfigured()) {
    return { status: 'NOT_CONFIGURED', provider: null, to: toAddress, subject, note: 'Set EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM_ADDRESS to enable real delivery.' };
  }
  // Real implementation would branch on process.env.EMAIL_PROVIDER. Not
  // implemented — no provider account/credentials available to build against.
  throw new Error(`Email provider "${process.env.EMAIL_PROVIDER}" adapter is not implemented yet.`);
}

module.exports = { isConfigured, send, TEMPLATES };
