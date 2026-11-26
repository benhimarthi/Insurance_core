'use strict';

const crypto = require('crypto');

const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Error with a code that maps 1:1 to Firebase HttpsError codes. */
class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'invalid-argument' | 'permission-denied' | 'not-found' | 'failed-precondition' | ...
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newId = () => crypto.randomBytes(10).toString('hex');

/** Stable pseudonymous customer id: raw phone numbers are never used as document ids. */
const customerKey = (pepper, contact) => crypto.createHmac('sha256', pepper).update(String(contact)).digest('hex').slice(0, 32);

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B);
}

/** Firestore rejects undefined values: remove them (plain objects and arrays only). */
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = stripUndefined(v);
    return out;
  }
  return value;
}

module.exports = { TENANT_ID_RE, ID_RE, AppError, sha256, newId, customerKey, safeEqual, stripUndefined };
