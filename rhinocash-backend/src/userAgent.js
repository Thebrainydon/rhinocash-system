'use strict';
// A minimal, best-effort User-Agent -> friendly browser name mapping —
// only ever used to tell a blocked second login attempt which real
// browser its own already-active session is running on, never for any
// security decision itself (the actual block is the real sessions row,
// not this string).
function describeBrowser(userAgent) {
  const ua = userAgent || '';
  if (!ua) return 'another device or browser';
  if (/Edg\//.test(ua)) return 'Microsoft Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/CriOS\//.test(ua)) return 'Chrome';
  if (/Chrome\//.test(ua) && !/Chromium\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) return 'Safari';
  return 'another browser';
}

module.exports = { describeBrowser };
