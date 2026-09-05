// rateLimit.js — a minimal in-memory per-IP rate limiter. Good enough for a
// single-process deployment; a multi-instance production deployment should
// replace the in-memory Map with a shared store (Redis, or a Postgres table)
// so limits are enforced across all instances, not per-process. That swap
// only touches this file.
'use strict';

function rateLimiter({ windowMs = 60000, max = 120 } = {}) {
  const hits = new Map(); // ip -> [timestamps]
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, times] of hits) {
      const kept = times.filter(t => t > cutoff);
      if (kept.length) hits.set(ip, kept); else hits.delete(ip);
    }
  }, windowMs).unref();

  return (req, res, next) => {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;
    const times = (hits.get(ip) || []).filter(t => t > cutoff);
    times.push(now);
    hits.set(ip, times);
    if (times.length > max) {
      return next({ status: 429, message: 'Too many requests — slow down and try again shortly.' });
    }
    next();
  };
}

module.exports = { rateLimiter };
