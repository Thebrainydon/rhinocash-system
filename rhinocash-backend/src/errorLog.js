// errorLog.js — a bounded, in-memory record of the most recent unexpected
// (5xx) server errors, so the System Administrator can see them on Admin >
// Database & System > Error Logs without shell access. Process-local and
// cleared on restart; the full stack still goes to the server log.
'use strict';
const MAX = 200;
const entries = [];
let total = 0;
function recordError(req, err) {
  total++;
  entries.unshift({
    at: new Date().toISOString(),
    method: req && req.method,
    path: req && req.url ? String(req.url).split('?')[0] : null,
    message: String((err && err.message) || err || 'Unknown error').slice(0, 300),
  });
  if (entries.length > MAX) entries.length = MAX;
}
function recentErrors() { return { errors: entries.slice(), totalSinceStart: total }; }
module.exports = { recordError, recentErrors };
