// customDomain.test.js — production custom domain: CORS_ORIGIN may list
// several web-app origins (new domain + the original Render URL as a
// backup), and emails tell people where to sign in (APP_BASE_URL).
'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }

const PORT = 4097;
const BASE = `http://127.0.0.1:${PORT}`;
const NEW_DOMAIN = 'https://cbs.rhinocash.co.ke';
const OLD_DOMAIN = 'https://rhinocash-app.onrender.com';

(async () => {
  // A second server for this suite only, configured like production.
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', CORS_ORIGIN: `${NEW_DOMAIN}, ${OLD_DOMAIN}/`, RATE_LIMIT_PER_MINUTE: '10000' },
    stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(BASE + '/api/health')).ok; } catch { await new Promise(r => setTimeout(r, 250)); } }
    assert(up, 'setup: a production-style server starts with a two-origin CORS_ORIGIN');

    const origin = async (o, method = 'GET') => {
      const res = await fetch(BASE + (method === 'OPTIONS' ? '/api/auth/login' : '/api/health'), {
        method, headers: { Origin: o, ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type, Authorization' } : {}) },
      });
      return { status: res.status, allow: res.headers.get('access-control-allow-origin'), vary: res.headers.get('vary'), hsts: res.headers.get('strict-transport-security') };
    };
    const a = await origin(NEW_DOMAIN);
    assert(a.allow === NEW_DOMAIN && /Origin/.test(a.vary || ''), 'the new domain is allowed to call the API');
    const b = await origin(OLD_DOMAIN);
    assert(b.allow === OLD_DOMAIN, 'the original Render URL keeps working as a backup (trailing slash in the setting is ignored)');
    const c = await origin('https://evil.example.com');
    assert(c.allow !== 'https://evil.example.com' && c.allow !== '*', 'an origin that is not listed is not allowed');
    const d = await origin(NEW_DOMAIN, 'OPTIONS');
    assert(d.status === 204 && d.allow === NEW_DOMAIN, 'the login preflight from the new domain succeeds');
    assert(/max-age=\d+/.test(a.hsts || ''), 'HTTPS is still enforced with Strict-Transport-Security in production');
  } finally {
    server.kill();
  }

  // Emails say where to sign in, using APP_BASE_URL when it is set.
  const email = require('../src/integrations/email');
  delete process.env.APP_BASE_URL;
  const plain = email.TEMPLATES.password_reset({ name: 'Jane', tempPassword: 'x' }).body;
  assert(!/Sign in at/.test(plain), 'without APP_BASE_URL emails are unchanged');
  process.env.APP_BASE_URL = NEW_DOMAIN + '/';
  for (const t of ['account_invitation', 'password_reset', 'monthly_statement']) {
    const body = email.TEMPLATES[t]({ name: 'Jane', email: 'jane@example.com', tempPassword: 'x', period: 'October 2026' }).body;
    assert(body.includes(`Sign in at ${NEW_DOMAIN}`) && !body.includes('onrender.com'), `the ${t} email points people to ${NEW_DOMAIN}`);
  }
  delete process.env.APP_BASE_URL;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
