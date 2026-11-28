'use strict';

const crypto = require('crypto');

/**
 * Webhook authenticity: HMAC-SHA256 over the RAW request body, compared in constant time.
 * Always verify BEFORE parsing or trusting anything in the body. Most providers use this
 * scheme (header name and encoding vary): adapt signPayload/verifySignature per provider.
 */

function signPayload(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function verifySignature(secret, rawBody, signature) {
  if (!secret || typeof signature !== 'string') return false;
  const expected = Buffer.from(signPayload(secret, rawBody), 'hex');
  let received;
  try { received = Buffer.from(signature, 'hex'); } catch { return false; }
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

/** Verifies the signature, then parses. Throws on a bad signature or invalid JSON. */
function parseWebhook({ secret, rawBody, signature }) {
  if (!verifySignature(secret, rawBody, signature)) throw new Error('Invalid webhook signature.');
  const event = JSON.parse(rawBody);
  for (const field of ['id', 'type', 'paymentId', 'caseId']) {
    if (typeof event[field] !== 'string') throw new Error(`Webhook event is missing "${field}".`);
  }
  return event;
}

module.exports = { signPayload, verifySignature, parseWebhook };
