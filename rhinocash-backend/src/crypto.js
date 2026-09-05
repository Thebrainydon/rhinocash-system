// crypto.js — password hashing and session tokens using only Node's built-in
// `node:crypto`. No bcrypt/jsonwebtoken package required (none are
// installable in this offline environment, and honestly scrypt is a fine,
// modern, memory-hard choice for password storage).
'use strict';
const crypto = require('node:crypto');

const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const stored = Buffer.from(hash, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

function generateTempPassword() {
  // 12 random bytes -> readable base32-ish password, no ambiguous chars.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#';
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// Session secret: read from env if provided (production), otherwise generate
// one at process start and persist it to disk so restarts don't invalidate
// every session — but it is NEVER hardcoded in source.
const path = require('node:path');
const fs = require('node:fs');
const SECRET_PATH = path.join(__dirname, '..', 'data', '.session_secret');
function loadOrCreateSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (fs.existsSync(SECRET_PATH)) return fs.readFileSync(SECRET_PATH, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true });
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}
const SESSION_SECRET = loadOrCreateSecret();

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

// A minimal real JWT-shaped token (HS256): header.payload.signature.
// Not pulled from a library, but the same structure and same guarantee —
// the signature is verified server-side on every request, and the token
// itself is also checked against the `sessions` table so it can be revoked
// before its natural expiry (plain JWTs can't do that; this can).
function signToken(payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${header}.${body}`).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}
function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---- Generic field-level encryption at rest (AES-256-GCM) ----
// Used for anything that must never be readable from a DB dump — right
// now that's M-Pesa consumer secret/key/passkey. Key comes from
// MPESA_ENCRYPTION_KEY if set (production), otherwise generated once and
// persisted outside source control, same pattern as SESSION_SECRET.
const ENC_KEY_PATH = path.join(__dirname, '..', 'data', '.mpesa_encryption_key');
function loadOrCreateEncKey() {
  if (process.env.MPESA_ENCRYPTION_KEY) return Buffer.from(process.env.MPESA_ENCRYPTION_KEY, 'hex');
  if (fs.existsSync(ENC_KEY_PATH)) return Buffer.from(fs.readFileSync(ENC_KEY_PATH, 'utf8').trim(), 'hex');
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(ENC_KEY_PATH), { recursive: true });
  fs.writeFileSync(ENC_KEY_PATH, key.toString('hex'), { mode: 0o600 });
  return key;
}
const ENC_KEY = loadOrCreateEncKey();

function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}
function decryptSecret(stored) {
  if (!stored) return null;
  const [ivB64, tagB64, dataB64] = stored.split(':');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}
// Never returned in full through any API — only the last 4 characters,
// so an admin can recognize "yes, that's the right key" without the
// value ever being reconstructable from a response body.
function maskSecret(plaintext) {
  if (!plaintext) return null;
  const s = String(plaintext);
  if (s.length <= 4) return '••••';
  return '••••••••' + s.slice(-4);
}

module.exports = { hashPassword, verifyPassword, generateTempPassword, signToken, verifyToken, tokenHash, encryptSecret, decryptSecret, maskSecret };
