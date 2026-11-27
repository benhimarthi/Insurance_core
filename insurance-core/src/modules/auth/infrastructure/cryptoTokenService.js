'use strict';

const crypto = require('crypto');
const { sha256, newId, safeEqual } = require('../../../shared/crypto');

/** TokenService with Node's crypto: 192-bit random tokens, stored as SHA-256 hashes. */
function createCryptoTokenService() {
  return {
    newToken: () => crypto.randomBytes(24).toString('base64url'),
    hash: (token) => sha256(token),
    matches: (token, hash) => safeEqual(sha256(token), hash),
    newId,
  };
}

module.exports = { createCryptoTokenService };
