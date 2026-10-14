// usernames.js — every System Account has a username made from the
// person's name ("David Simon" → "david.simon"; "david.simon2" if taken).
// People sign in with it or with their email. Matching ignores case,
// spaces and dots, so "David Simon", "davidsimon" and "david.simon" all work.
'use strict';
const { get } = require('./db');

const usernameKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const baseUsername = name => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 30) || 'user';
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,39}$/;

async function takenBy(key, exceptEmployeeId, q = get) {
  const row = await q(`SELECT employee_id FROM user_accounts WHERE regexp_replace(lower(username), '[^a-z0-9]', '', 'g') = ? AND employee_id <> ?`, [key, exceptEmployeeId || '']);
  return row ? row.employee_id : null;
}
// A free username for this name (or the one asked for, when it is free).
async function uniqueUsername(name, exceptEmployeeId, q = get) {
  const base = baseUsername(name);
  for (let n = 1; n < 500; n++) {
    const cand = n === 1 ? base : `${base}${n}`;
    if (!(await takenBy(usernameKey(cand), exceptEmployeeId, q))) return cand;
  }
  return `${base}${Date.now() % 100000}`;
}
module.exports = { usernameKey, baseUsername, uniqueUsername, takenBy, USERNAME_RE };
