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

function isConfigured() {
  return !!(process.env.SMS_PROVIDER && process.env.SMS_API_KEY);
}

const TEMPLATES = {
  loan_approved: (ctx) => `Rhinocash: Your loan application ${ctx.loanId} has been approved. You'll be notified once disbursed.`,
  loan_disbursed: (ctx) => `Rhinocash: KES ${ctx.amount} has been disbursed to your account for loan ${ctx.loanId}. Thank you.`,
  payment_confirmation: (ctx) => `Rhinocash: We've received your payment of KES ${ctx.amount} for loan ${ctx.loanId}. Ref: ${ctx.reference}.`,
  arrears_reminder: (ctx) => `Rhinocash: Your loan ${ctx.loanId} has an overdue payment of KES ${ctx.amount}. Please settle it to avoid further action.`,
  password_reset: (ctx) => `Rhinocash: Your temporary password is ${ctx.tempPassword}. You will be asked to change it on login.`,
  requisition_otp: (ctx) => `Rhinocash: Your requisition confirmation code is ${ctx.code}. It expires in 5 minutes. Do not share this code.`,
  system_notification: (ctx) => ctx.body,
};

// send() never throws for "not configured" — that's an expected state
// during development, not an error condition the caller needs to handle
// specially every time. It DOES throw if called with an unknown template.
async function send(templateName, phone, ctx) {
  if (!TEMPLATES[templateName]) throw new Error(`Unknown SMS template: ${templateName}`);
  const message = TEMPLATES[templateName](ctx);
  if (!isConfigured()) {
    return { status: 'NOT_CONFIGURED', provider: null, phone, message, note: 'Set SMS_PROVIDER and SMS_API_KEY to enable real delivery.' };
  }
  // Real implementation would branch on process.env.SMS_PROVIDER and call
  // that provider's API (e.g. Africa's Talking /messaging endpoint). Not
  // implemented — no provider account/credentials available to build against.
  throw new Error(`SMS provider "${process.env.SMS_PROVIDER}" adapter is not implemented yet.`);
}

module.exports = { isConfigured, send, TEMPLATES };
