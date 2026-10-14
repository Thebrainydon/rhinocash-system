'use strict';
// One-time codes that confirm a money request came from the signed-in staff
// member's own phone. Shares the requisition_otps table with requisitions
// and utility payments: a code is valid for 5 minutes and is used once.
const crypto = require('node:crypto');
const { get, run } = require('./db');
const { tokenHash } = require('./crypto');

// Record types whose creation must be confirmed with a code.
const OTP_EXEC_KINDS = ['financial_request', 'funding'];
const OTP_ACCT_KINDS = ['refund', 'write_off'];

async function issueOtp(user) {
  const code = String(crypto.randomInt(100000, 1000000));
  await run(`INSERT INTO requisition_otps (id, user_id, code_hash, expires_at) VALUES (?,?,?, iso_offset(interval '5 minutes'))`,
    ['rotp_' + crypto.randomUUID(), user.id, tokenHash(code)]);
  const sms = require('./integrations/sms');
  let result;
  try { result = await sms.send('requisition_otp', user.phone, { code }); }
  catch (e) { result = { status: 'FAILED' }; }
  return {
    status: result.status,
    ...(result.status === 'NOT_CONFIGURED' ? { otpForTesting: code, note: 'SMS is not configured in this environment — the code is returned here instead.' } : {}),
  };
}

// Marks a matching, unexpired, unused code as used. Returns false when the
// code is missing, wrong, expired or already used.
async function consumeOtp(userId, code) {
  if (!code) return false;
  const row = await get(
    `UPDATE requisition_otps SET used = 1
      WHERE id = (SELECT id FROM requisition_otps WHERE user_id = ? AND code_hash = ? AND used = 0 AND expires_at > iso_now() ORDER BY created_at DESC LIMIT 1)
        AND used = 0
      RETURNING id`, [userId, tokenHash(String(code).trim())]);
  return !!row;
}

const OTP_ERROR = { status: 400, message: 'Enter the valid OTP code sent to your phone', code: 'INVALID_OTP' };

module.exports = { issueOtp, consumeOtp, OTP_EXEC_KINDS, OTP_ACCT_KINDS, OTP_ERROR };
