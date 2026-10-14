// smtp.js — a small SMTP client on Node's own net/tls modules (no extra
// dependency), used by email.js for mailbox providers such as Zoho Mail.
//
// Security rules it keeps:
//   - the password is only ever sent over an encrypted connection: port 465
//     is TLS from the start, port 587 must upgrade with STARTTLS first, and
//     a server that does not offer STARTTLS is refused before AUTH;
//   - the server certificate is always verified (Node's default);
//   - the password never appears in a returned message, error or log line.
'use strict';
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const ADDRESS_RE = /^[^@\s<>"',;:()\[\]\\]+@[^@\s<>"',;:()\[\]\\]+\.[^@\s<>"',;:()\[\]\\]+$/;
const isAddress = a => ADDRESS_RE.test(String(a || ''));
const oneLine = s => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim();
// RFC 2047 encoded-word when a header has non-ASCII text (names, subjects).
const encodeWord = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const quoteName = s => (/^[\x20-\x7e]*$/.test(s) ? `"${s.replace(/["\\]/g, '')}"` : encodeWord(s));

// "starttls" (587) or "ssl" (465). Anything else — including plain text —
// is not allowed, because that would send the password unencrypted.
function normalizeSecurity(security, port) {
  const s = String(security || '').trim().toLowerCase();
  if (['starttls', 'tls'].includes(s)) return 'starttls';
  if (['ssl', 'ssl/tls', 'implicit'].includes(s)) return 'ssl';
  if (!s) return Number(port) === 465 ? 'ssl' : 'starttls';
  return null;
}

function buildMessage({ from, fromName, to, subject, text, messageId }) {
  const body = Buffer.from(String(text || '').replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${fromName ? quoteName(oneLine(fromName)) + ' ' : ''}<${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeWord(oneLine(subject))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '', body,
  ].join('\r\n');
}

// Reads SMTP replies (possibly multi-line: "250-..." then "250 ...").
function replyReader(sock) {
  let buf = '', lines = [];
  const queue = [], waiters = [];
  let failure = null;
  const onData = d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: lines.map(l => l.slice(4)), last: line.slice(4) };
        lines = [];
        const w = waiters.shift(); if (w) w.resolve(reply); else queue.push(reply);
      }
    }
  };
  const onEnd = err => { failure = err || new Error('The mail server closed the connection'); while (waiters.length) waiters.shift().reject(failure); };
  sock.on('data', onData);
  sock.on('error', onEnd); sock.once('close', () => onEnd());
  return {
    next: () => (queue.length ? Promise.resolve(queue.shift()) : failure ? Promise.reject(failure) : new Promise((resolve, reject) => waiters.push({ resolve, reject }))),
    detach: () => { sock.removeListener('data', onData); sock.removeAllListeners('error'); sock.removeAllListeners('close'); sock.on('error', () => {}); },
  };
}

class SmtpError extends Error {
  constructor(stage, reply, message) { super(message); this.stage = stage; this.reply = reply; }
}

// Turns what happened into a short, safe explanation for the admin.
function explain(err, cfg) {
  const where = `${cfg.host}:${cfg.port}`;
  const said = err.reply ? ` (server said: ${err.reply.code} ${oneLine(err.reply.last).slice(0, 120)})` : '';
  if (err instanceof SmtpError) {
    if (err.stage === 'auth') return `The mail server rejected the username or password${said}. Use the full mailbox address as the username; if two-factor authentication is on, use an application-specific password.`;
    if (err.stage === 'from') return `The mail server refused the From address ${cfg.from}${said}. It must be the signed-in mailbox or one of its aliases.`;
    if (err.stage === 'rcpt') return `The mail server refused the recipient address${said}.`;
    return err.message + said;
  }
  const code = err && (err.code || (err.cause && err.cause.code));
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Could not find the mail server ${cfg.host} — check the SMTP host.`;
  if (code === 'ECONNREFUSED') return `The mail server ${where} refused the connection — check the host and port.`;
  if (code === 'ETIMEDOUT' || code === 'SMTP_TIMEOUT' || code === 'ENETUNREACH') return `Could not connect to ${where} in time. The server may block outgoing mail ports (Render's free instance type blocks ports 25, 465 and 587).`;
  if (code && /CERT|SELF_SIGNED|ERR_TLS|VERIFY|HOSTNAME|ALTNAME/i.test(code)) return `The secure connection to ${cfg.host} failed (${code}) — check the SMTP host name.`;
  if (code === 'EPROTO' || (err && /wrong version number|ssl3_get_record|packet length/i.test(err.message || ''))) return `The secure connection to ${where} failed — use port 587 with STARTTLS or port 465 with SSL.`;
  return `Could not send through ${where}${code ? ' (' + code + ')' : ''}.`;
}

// Sends one plain-text email. Resolves { ok, providerRef } or { ok:false, detail }.
// `cfg`: host, port, security, username, password, from, fromName.
// `extraTls` is for tests only (a private CA); production uses the system CAs.
async function sendMail(cfg, { to, subject, text }, { timeoutMs = 20000, extraTls = {} } = {}) {
  const host = String(cfg.host || '').trim(), port = Number(cfg.port) || 587;
  const security = normalizeSecurity(cfg.security, port);
  const safeCfg = { host, port, from: cfg.from };
  if (!host) return { ok: false, detail: 'Enter the SMTP host' };
  if (!security) return { ok: false, detail: 'Security must be STARTTLS (port 587) or SSL (port 465) — the password is never sent unencrypted' };
  if (!cfg.username || !cfg.password) return { ok: false, detail: 'The SMTP username and password are both needed' };
  if (!isAddress(cfg.from)) return { ok: false, detail: 'Enter a valid From address' };
  if (!isAddress(to)) return { ok: false, detail: 'Enter a valid recipient email address' };

  let sock = null, timer = null;
  const fromDomain = String(cfg.from).split('@')[1];
  const messageId = `<${crypto.randomUUID()}@${fromDomain}>`;
  const run = async () => {
    const tlsOpts = { host, port, servername: host, minVersion: 'TLSv1.2', ...extraTls };
    sock = security === 'ssl' ? tls.connect(tlsOpts) : net.connect({ host, port });
    await new Promise((resolve, reject) => { sock.once(security === 'ssl' ? 'secureConnect' : 'connect', resolve); sock.once('error', reject); });
    sock.removeAllListeners('error');
    let rd = replyReader(sock);
    const send = async (line, okCodes, stage, label) => {
      if (line !== null) sock.write(line + '\r\n');
      const r = await rd.next();
      if (!okCodes.includes(r.code)) throw new SmtpError(stage, r, `The mail server did not accept ${label}`);
      return r;
    };
    await send(null, [220], 'greeting', 'the connection');
    const me = 'rhinocash.localdomain';
    let ehlo = await send(`EHLO ${me}`, [250], 'ehlo', 'EHLO');
    if (security === 'starttls') {
      if (!ehlo.lines.some(l => /^STARTTLS\b/i.test(l))) throw new SmtpError('starttls', null, `${host}:${port} does not offer STARTTLS, so the password was not sent`);
      await send('STARTTLS', [220], 'starttls', 'STARTTLS');
      rd.detach();
      const plain = sock;
      sock = tls.connect({ socket: plain, servername: host, minVersion: 'TLSv1.2', ...extraTls });
      await new Promise((resolve, reject) => { sock.once('secureConnect', resolve); sock.once('error', reject); });
      sock.removeAllListeners('error');
      rd = replyReader(sock);
      ehlo = await send(`EHLO ${me}`, [250], 'ehlo', 'EHLO');
    }
    const authLine = ehlo.lines.find(l => /^AUTH[ =]/i.test(l)) || '';
    const user = String(cfg.username), pass = String(cfg.password);
    if (/\bPLAIN\b/i.test(authLine) || !/\bLOGIN\b/i.test(authLine)) {
      await send('AUTH PLAIN ' + Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64'), [235], 'auth', 'the login');
    } else {
      await send('AUTH LOGIN', [334], 'auth', 'the login');
      await send(Buffer.from(user, 'utf8').toString('base64'), [334], 'auth', 'the login');
      await send(Buffer.from(pass, 'utf8').toString('base64'), [235], 'auth', 'the login');
    }
    await send(`MAIL FROM:<${cfg.from}>`, [250], 'from', 'the From address');
    await send(`RCPT TO:<${to}>`, [250, 251], 'rcpt', 'the recipient');
    await send('DATA', [354], 'data', 'the message');
    await send(buildMessage({ from: cfg.from, fromName: cfg.fromName, to, subject, text, messageId }) + '\r\n.', [250], 'data', 'the message');
    try { sock.write('QUIT\r\n'); } catch { /* the message is already accepted */ }
    return { ok: true, providerRef: messageId };
  };
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'SMTP_TIMEOUT' })), timeoutMs); });
  try {
    const work = run(); work.catch(() => {}); // a late failure after a timeout is already reported
    return await Promise.race([work, timeout]);
  } catch (e) {
    return { ok: false, detail: explain(e, safeCfg) };
  } finally {
    clearTimeout(timer);
    if (sock) { try { sock.end(); } catch { /* ignore */ } setTimeout(() => { try { sock.destroy(); } catch { /* ignore */ } }, 1000).unref(); }
  }
}

module.exports = { sendMail, normalizeSecurity, isAddress, buildMessage };
