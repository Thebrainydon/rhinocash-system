// removedAccounts.js — accounts the System Administrator permanently
// deleted. Only one-way hashes of the login email and username are kept
// (never the address itself), plus the old user id, so a removed person
// trying to sign in again — or a browser still holding their old session —
// can be recognised and shown the "site can't be reached" screen.
'use strict';
const crypto = require('node:crypto');
const { get, run } = require('./db');
const { usernameKey } = require('./usernames');

const h = (kind, v) => crypto.createHash('sha256').update(`${kind}:${v}`).digest('hex');
const loginHash = identifier => {
  const s = String(identifier || '').trim();
  if (!s) return null;
  return s.includes('@') ? h('email', s.toLowerCase()) : h('username', usernameKey(s));
};

async function recordRemoved(userId, loginEmail, username) {
  await run(`INSERT INTO removed_accounts (user_id, email_hash, username_hash) VALUES (?,?,?)
    ON CONFLICT (user_id) DO UPDATE SET email_hash = EXCLUDED.email_hash, username_hash = EXCLUDED.username_hash`,
    [userId, loginEmail ? loginHash(String(loginEmail)) : null, username ? h('username', usernameKey(username)) : null]);
}
async function isRemovedLogin(identifier) {
  const k = loginHash(identifier);
  if (!k) return false;
  return !!(await get('SELECT 1 AS x FROM removed_accounts WHERE email_hash = ? OR username_hash = ? LIMIT 1', [k, k]));
}
async function isRemovedUser(userId) {
  if (!userId) return false;
  return !!(await get('SELECT 1 AS x FROM removed_accounts WHERE user_id = ?', [String(userId)]));
}
// What the removed person is told — the browser's own "can't be reached" wording.
const REMOVED = { message: 'This site can\u2019t be reached', code: 'ACCOUNT_REMOVED' };

module.exports = { recordRemoved, isRemovedLogin, isRemovedUser, REMOVED };
