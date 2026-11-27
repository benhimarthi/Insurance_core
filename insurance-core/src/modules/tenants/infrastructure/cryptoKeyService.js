'use strict';

const crypto = require('crypto');

/** KeyService with Node's crypto: 144-bit random web chat keys. */
const createCryptoKeyService = () => ({ newWebchatKey: () => crypto.randomBytes(18).toString('hex') });

module.exports = { createCryptoKeyService };
