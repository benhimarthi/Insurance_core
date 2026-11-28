'use strict';

const crypto = require('crypto');
const { safeEqual } = require('../../../shared/crypto');
const { CODE_LENGTH, CODE_RE } = require('../domain/view');

/**
 * Verification codes with an HMAC: unguessable per policy, checked in constant time.
 * Rotating the secret invalidates every printed QR code: treat it like a signing key.
 */
function createVerifier({ secret, baseUrl }) {
  if (!secret) throw new Error('A verification secret is required.');
  const base = String(baseUrl || '').replace(/\/+$/, '');

  const code = ({ tenantId, policyNumber }) =>
    crypto.createHmac('sha256', secret).update(`${tenantId}|${policyNumber}`).digest('hex').slice(0, CODE_LENGTH);

  return {
    code,
    url: ({ tenantId, policyNumber }) => `${base}/${tenantId}/${policyNumber}/${code({ tenantId, policyNumber })}`,
    check: ({ tenantId, policyNumber }, candidate) => CODE_RE.test(candidate || '') && safeEqual(code({ tenantId, policyNumber }), candidate),
  };
}

module.exports = { createVerifier };
