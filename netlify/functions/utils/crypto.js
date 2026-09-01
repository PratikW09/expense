/**
 * netlify/functions/utils/crypto.js
 * Cryptographic helpers for session encryption (AES-256-GCM) and cookie handling.
 * Zero external dependencies — built entirely on Node.js standard library.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Derive a deterministic 32-byte key from environment secret
 */
function getEncryptionKey() {
  const secret = process.env.ENCRYPTION_SECRET || process.env.GOOGLE_CLIENT_SECRET || 'expense-tracker-fallback-secret-key-32-chars-min';
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a JavaScript object / string using AES-256-GCM
 * @param {object|string} data
 * @returns {string} base64url-encoded payload (iv:tag:ciphertext)
 */
function encrypt(data) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const text = typeof data === 'string' ? data : JSON.stringify(data);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Combine IV + AuthTag + EncryptedData
  const combined = Buffer.concat([iv, tag, encrypted]);
  return combined.toString('base64url');
}

/**
 * Decrypt a base64url payload encrypted with AES-256-GCM
 * @param {string} payload
 * @returns {object|null} parsed JSON object or null on error
 */
function decrypt(payload) {
  if (!payload || typeof payload !== 'string') return null;

  try {
    const key = getEncryptionKey();
    const combined = Buffer.from(payload, 'base64url');

    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      return null;
    }

    const iv = combined.subarray(0, IV_LENGTH);
    const tag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const text = decrypted.toString('utf8');

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (err) {
    console.error('Decryption error:', err.message);
    return null;
  }
}

/**
 * Parse Cookie header string into key-value map
 * @param {string} cookieHeader
 * @returns {Record<string, string>}
 */
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;

  cookieHeader.split(';').forEach((cookie) => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    list[name] = decodeURIComponent(value);
  });

  return list;
}

/**
 * Serialize a cookie string with secure defaults
 * @param {string} name
 * @param {string} value
 * @param {object} options
 * @returns {string} Set-Cookie header value
 */
function serializeCookie(name, value, options = {}) {
  const {
    maxAge = 60 * 60 * 24 * 90, // 90 days default
    httpOnly = true,
    secure = process.env.NODE_ENV !== 'development',
    sameSite = 'Lax',
    path = '/',
  } = options;

  let str = `${name}=${encodeURIComponent(value)}`;

  if (maxAge !== undefined) {
    str += `; Max-Age=${Math.floor(maxAge)}`;
    const expires = new Date(Date.now() + maxAge * 1000);
    str += `; Expires=${expires.toUTCString()}`;
  }

  if (path) str += `; Path=${path}`;
  if (httpOnly) str += '; HttpOnly';
  if (secure) str += '; Secure';
  if (sameSite) str += `; SameSite=${sameSite}`;

  return str;
}

module.exports = {
  encrypt,
  decrypt,
  parseCookies,
  serializeCookie,
};
