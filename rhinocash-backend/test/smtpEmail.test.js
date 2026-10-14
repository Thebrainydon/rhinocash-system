// smtpEmail.test.js — email through an SMTP mailbox (e.g. Zoho Mail) on the
// existing Admin > Integrations > Email settings. A local mail server with
// its own test certificate stands in for Zoho, so nothing real is sent.
'use strict';
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; console.log('OK:', msg); } else { fail++; console.error('FAIL:', msg); } }

const ENV_PASSWORD = 'Env-Zoho-App-Pass-7781';
const DB_PASSWORD = 'Saved-Zoho-Pass-4410';
const b64 = s => Buffer.from(s).toString('base64');
const leaks = (text, secret) => [secret, b64(secret), b64(`\0hr@rhinocash.co.ke\0${secret}`)].some(s => String(text).includes(s));

// A test certificate authority and a certificate for "localhost".
function makeCerts(dir) {
  const o = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'ignore' });
  o('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Rhinocash Test CA');
  o('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', '/CN=localhost');
  fs.writeFileSync(path.join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  o('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '2', '-extfile', 'ext.cnf');
  return { ca: fs.readFileSync(path.join(dir, 'ca.pem')), key: fs.readFileSync(path.join(dir, 'srv.key')), cert: fs.readFileSync(path.join(dir, 'srv.pem')) };
}

// Minimal mail server: STARTTLS (or TLS from the start), AUTH, MAIL/RCPT/DATA.
function fakeMailServer({ key, cert, implicitTls = false, offerStartTls = true, mechs = 'PLAIN LOGIN' }) {
  const st = { user: 'hr@rhinocash.co.ke', pass: ENV_PASSWORD, plain: '', messages: [], authInPlain: 0, authOk: 0, authFail: 0 };
  const serve = (sock, secure) => {
    let buf = '', inData = false, data = [], env = {}, loginStep = 0, loginUser = '';
    const w = l => sock.write(l + '\r\n');
    const checkAuth = (u, p) => { if (u === st.user && p === st.pass) { st.authOk++; w('235 2.7.0 Authentication succeeded'); } else { st.authFail++; w('535 Authentication Failed'); } };
    sock.on('data', d => {
      if (!secure) st.plain += d.toString('utf8');
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; st.messages.push({ ...env, raw: data.join('\r\n') }); data = []; w('250 Ok queued as TESTREF123'); } else data.push(line); continue; }
        if (loginStep === 1) { loginUser = Buffer.from(line, 'base64').toString(); loginStep = 2; w('334 UGFzc3dvcmQ6'); continue; }
        if (loginStep === 2) { loginStep = 0; checkAuth(loginUser, Buffer.from(line, 'base64').toString()); continue; }
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') {
          const caps = [];
          if (!secure && offerStartTls) caps.push('STARTTLS');
          if (secure) caps.push('AUTH ' + mechs);
          w('250-test.mail.local' + (caps.length ? '' : '')); caps.forEach((c, n) => w((n === caps.length - 1 ? '250 ' : '250-') + c)); if (!caps.length) w('250 OK');
        } else if (cmd === 'STARTTLS') {
          w('220 Ready to start TLS');
          sock.removeAllListeners('data');
          const t = new tls.TLSSocket(sock, { isServer: true, key, cert });
          t.on('error', () => {});
          serve(t, true);
          return;
        } else if (cmd === 'AUTH') {
          if (!secure) st.authInPlain++;
          const [, mech, arg] = line.split(' ');
          if (/^PLAIN$/i.test(mech)) { const [, u, p] = Buffer.from(arg || '', 'base64').toString().split('\0'); checkAuth(u, p); }
          else { loginStep = 1; w('334 VXNlcm5hbWU6'); }
        } else if (cmd === 'MAIL') { env = { from: line.slice(10) }; w(/<hr@rhinocash\.co\.ke>/.test(line) ? '250 Ok' : '553 Sender is not allowed to relay emails'); }
        else if (cmd === 'RCPT') { env.to = line.slice(8); w('250 Ok'); }
        else if (cmd === 'DATA') { inData = true; w('354 End data with <CR><LF>.<CR><LF>'); }
        else if (cmd === 'QUIT') { w('221 Bye'); sock.end(); }
        else w('502 Command not implemented');
      }
    });
    sock.on('error', () => {});
    if (!(secure && !implicitTls)) w('220 test.mail.local ESMTP ready');
  };
  const server = implicitTls
    ? tls.createServer({ key, cert }, s => serve(s, true))
    : net.createServer(s => serve(s, false));
  return new Promise(r => server.listen(0, () => r({ st, port: server.address().port, close: () => server.close() })));
}

(async () => {
  fs.mkdirSync(path.join(__dirname, 'tmp'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(__dirname, 'tmp', 'smtp-'));
  const certs = makeCerts(dir);
  const smtp = require('../src/integrations/smtp');
  const cfgFor = (port, extra = {}) => ({ host: 'localhost', port, security: 'starttls', username: 'hr@rhinocash.co.ke', password: ENV_PASSWORD, from: 'hr@rhinocash.co.ke', fromName: 'Rhinocash HR', ...extra });
  const opts = { extraTls: { ca: certs.ca }, timeoutMs: 8000 };

  // ---- the SMTP client on its own ----
  const s1 = await fakeMailServer(certs);
  const r1 = await smtp.sendMail(cfgFor(s1.port), { to: 'jane@example.com', subject: 'Hello\r\nBcc: spy@evil.example', text: 'Line one\nLine two' }, opts);
  assert(r1.ok && /^<[^>]+@rhinocash\.co\.ke>$/.test(r1.providerRef), 'port 587 style: sends after upgrading to TLS with STARTTLS');
  assert(s1.st.authInPlain === 0 && s1.st.authOk === 1, 'the login is only sent after the connection is encrypted');
  assert(!leaks(s1.st.plain, ENV_PASSWORD), 'the password never crosses the wire unencrypted');
  const m = s1.st.messages[0] || { raw: '' };
  const [head, body] = m.raw.split('\r\n\r\n');
  assert(m.to === '<jane@example.com>' && /^From: "Rhinocash HR" <hr@rhinocash\.co\.ke>$/m.test(head) && /^Message-ID: <[^>]+@rhinocash\.co\.ke>$/m.test(head), 'the message has the right From, To and Message-ID');
  assert(!/^Bcc:/mi.test(head) && /^Subject: Hello Bcc: spy@evil\.example$/m.test(head), 'line breaks in the subject cannot add extra headers');
  assert(Buffer.from((body || '').replace(/\r\n/g, ''), 'base64').toString() === 'Line one\r\nLine two', 'the body arrives intact');

  s1.st.pass = 'something-else';
  const r2 = await smtp.sendMail(cfgFor(s1.port), { to: 'jane@example.com', subject: 'x', text: 'x' }, opts);
  assert(!r2.ok && /username or password/.test(r2.detail) && /application-specific password/.test(r2.detail) && !leaks(r2.detail, ENV_PASSWORD), 'a wrong password gives a clear reason without repeating the password');
  s1.st.pass = ENV_PASSWORD;
  const r3 = await smtp.sendMail(cfgFor(s1.port, { from: 'ceo@other.example' }), { to: 'jane@example.com', subject: 'x', text: 'x' }, opts);
  assert(!r3.ok && /refused the From address/.test(r3.detail), 'a From address the mailbox may not use is explained');

  const s2 = await fakeMailServer({ ...certs, offerStartTls: false });
  const r4 = await smtp.sendMail(cfgFor(s2.port), { to: 'jane@example.com', subject: 'x', text: 'x' }, opts);
  assert(!r4.ok && /does not offer STARTTLS/.test(r4.detail) && s2.st.authInPlain === 0 && !leaks(s2.st.plain, ENV_PASSWORD), 'a server without STARTTLS never receives the password');

  const s3 = await fakeMailServer({ ...certs, implicitTls: true, mechs: 'LOGIN' });
  const r5 = await smtp.sendMail(cfgFor(s3.port, { security: 'ssl' }), { to: 'jane@example.com', subject: 'x', text: 'x' }, opts);
  assert(r5.ok && s3.st.authOk === 1, 'port 465 style: TLS from the start, AUTH LOGIN');

  const r6 = await smtp.sendMail(cfgFor(s1.port), { to: 'jane@example.com', subject: 'x', text: 'x' }, { timeoutMs: 8000 });
  assert(!r6.ok && /secure connection/.test(r6.detail), 'an untrusted certificate is refused (the certificate is always checked)');
  assert(!(await smtp.sendMail(cfgFor(s1.port, { security: 'none' }), { to: 'a@b.co', subject: 'x', text: 'x' }, opts)).ok, 'unencrypted SMTP is not allowed');
  const closed = await new Promise(r => { const t = net.createServer(); t.listen(0, () => { const p = t.address().port; t.close(() => r(p)); }); });
  const r7 = await smtp.sendMail(cfgFor(closed), { to: 'jane@example.com', subject: 'x', text: 'x' }, opts);
  assert(!r7.ok && /refused the connection/.test(r7.detail), 'a wrong port is explained');
  assert(smtp.normalizeSecurity('', 465) === 'ssl' && smtp.normalizeSecurity('', 587) === 'starttls' && smtp.normalizeSecurity('STARTTLS', 587) === 'starttls', 'security defaults follow the port');

  // ---- through Admin > Integrations > Email, like production ----
  const PORT = 4096, BASE = `http://127.0.0.1:${PORT}`;
  let serverLog = '';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), NODE_EXTRA_CA_CERTS: path.join(dir, 'ca.pem'), SMTP_PASSWORD: ENV_PASSWORD, RATE_LIMIT_PER_MINUTE: '10000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => { serverLog += d; }); server.stderr.on('data', d => { serverLog += d; });
  const api = async (method, p, { token, body } = {}) => {
    const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  };
  let adminToken = null, managerToken = null;
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(BASE + '/api/health')).ok; } catch { await new Promise(r => setTimeout(r, 250)); } }
    assert(up, 'setup: backend starts with SMTP_PASSWORD set in its environment');
    adminToken = (await api('POST', '/api/auth/login', { body: { email: 'admin@rhinocash.co.ke', password: process.env.SEEDED_ADMIN_PASSWORD } })).json.token;
    managerToken = (await api('POST', '/api/auth/login', { body: { email: 'manager@rhinocash.co.ke', password: process.env.SEEDED_MANAGER_PASSWORD } })).json.token;

    const before = await api('GET', '/api/admin/integrations', { token: adminToken });
    assert(before.status === 200 && before.json.email.smtpPasswordOnServer === true && !leaks(before.text, ENV_PASSWORD), 'Admin can see that a server password is set, but never the password');

    // an old SendGrid key must not be reused as the mailbox password
    assert((await api('PUT', '/api/admin/integrations/email', { token: adminToken, body: { provider: 'sendgrid', apiKey: 'SG.old-key-1234', fromAddress: 'hr@rhinocash.co.ke', enabled: false } })).status === 200, 'setup: an older SendGrid key is saved');
    const settings = { provider: 'smtp', smtpHost: 'localhost', smtpPort: String(s1.port), smtpSecurity: 'STARTTLS', smtpUsername: 'hr@rhinocash.co.ke', fromAddress: 'hr@rhinocash.co.ke', fromName: 'Rhinocash', enabled: true };
    assert((await api('PUT', '/api/admin/integrations/email', { token: adminToken, body: { ...settings, smtpPort: 'abc' } })).status === 400, 'a bad port is rejected');
    assert((await api('PUT', '/api/admin/integrations/email', { token: adminToken, body: { ...settings, smtpSecurity: 'none' } })).status === 400, 'unencrypted SMTP cannot be chosen');
    assert((await api('PUT', '/api/admin/integrations/email', { token: adminToken, body: { ...settings, smtpUsername: 'hr' } })).status === 400, 'the username must be the full mailbox address');
    assert((await api('PUT', '/api/admin/integrations/email', { token: managerToken, body: settings })).status === 403, 'only the System Administrator can change email settings');

    const saved = await api('PUT', '/api/admin/integrations/email', { token: adminToken, body: settings });
    const integ = saved.json && saved.json.integration;
    assert(saved.status === 200 && integ.provider === 'smtp' && integ.configured && integ.secretSource === 'server environment' && integ.settings.smtpSecurity === 'starttls', 'SMTP is switched on using the password from the server environment');

    assert((await api('POST', '/api/admin/integrations/email/test', { token: managerToken, body: { to: 'jane@example.com' } })).status === 403, 'only the System Administrator can send a test email');
    const before1 = s1.st.messages.length;
    const t1 = await api('POST', '/api/admin/integrations/email/test', { token: adminToken, body: { to: 'jane@example.com' } });
    assert(t1.status === 200 && t1.json.ok && t1.json.status === 'Sent' && s1.st.messages.length === before1 + 1 && /Rhinocash test email/.test(s1.st.messages[before1].raw), 'Send test email delivers through the mail server');
    const after1 = (await api('GET', '/api/admin/integrations', { token: adminToken })).json.email;
    assert(after1.lastTestStatus === 'Success', 'the last test result is recorded');
    const health = await api('GET', '/api/system/health', { token: adminToken });
    assert(health.status === 200 && health.json.integrations.email === 'CONFIGURED', 'System Health shows email as configured');

    // a password typed on the page is stored encrypted and takes over
    s1.st.pass = DB_PASSWORD;
    const saved2 = await api('PUT', '/api/admin/integrations/email', { token: adminToken, body: { ...settings, password: DB_PASSWORD } });
    assert(saved2.status === 200 && saved2.json.integration.apiKey === 'saved' && saved2.json.integration.secretSource === 'saved' && !leaks(saved2.text, DB_PASSWORD), 'a saved password is never sent back, not even partly');
    const t2 = await api('POST', '/api/admin/integrations/email/test', { token: adminToken, body: { to: 'jane@example.com' } });
    assert(t2.json && t2.json.ok, 'the saved password is used for sending');
    s1.st.pass = 'changed-at-zoho';
    const t3 = await api('POST', '/api/admin/integrations/email/test', { token: adminToken, body: { to: 'jane@example.com' } });
    const after3 = (await api('GET', '/api/admin/integrations', { token: adminToken })).json.email;
    assert(t3.json && !t3.json.ok && /username or password/.test(t3.json.message) && after3.lastTestStatus === 'Failed' && !leaks(t3.text, DB_PASSWORD), 'a rejected password shows Failed with the reason, and no password');

    const { get, all } = require('../src/db');
    const row = await get("SELECT secret_enc, settings_json FROM integration_configs WHERE kind = 'email'");
    assert(row && row.secret_enc && !leaks(row.secret_enc, DB_PASSWORD) && !leaks(row.settings_json, DB_PASSWORD), 'the password is encrypted at rest');
    const audits = await all("SELECT new_value FROM audit_logs WHERE record_type = 'Integration' AND record_id = 'email'");
    assert(audits.length >= 3 && audits.every(a => !leaks(a.new_value, DB_PASSWORD) && !leaks(a.new_value, ENV_PASSWORD)), 'the audit trail records the change without the password');
    const logs = await all("SELECT recipient, subject, status FROM communication_log WHERE channel = 'email'");
    assert(logs.some(l => l.status === 'Sent') && logs.some(l => l.status === 'FAILED') && logs.every(l => !leaks(JSON.stringify(l), DB_PASSWORD)), 'sent and failed emails appear in the email log');

    // other integrations are untouched
    const sms = (await api('GET', '/api/admin/integrations', { token: adminToken })).json.sms;
    assert(sms && sms.configured === false, 'SMS settings are unaffected');
    assert((await api('DELETE', '/api/admin/integrations/email', { token: adminToken })).status === 200, 'email settings can be removed');
    await api('POST', '/api/auth/logout', { token: adminToken }); await api('POST', '/api/auth/logout', { token: managerToken });
  } finally {
    server.kill();
    [s1, s2, s3].forEach(s => s.close());
  }
  await new Promise(r => setTimeout(r, 300));
  assert(!leaks(serverLog, ENV_PASSWORD) && !leaks(serverLog, DB_PASSWORD), 'the server log never contains the password');
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
