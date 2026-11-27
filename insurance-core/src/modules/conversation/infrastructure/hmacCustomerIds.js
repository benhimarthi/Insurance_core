'use strict';

const crypto = require('crypto');

/**
 * CustomerIds with an HMAC and a secret pepper: the same phone number (or web session) always maps to
 * the same id, which reveals nothing about it. Never change the pepper: customers would lose their case.
 */
function createHmacCustomerIds(pepper) {
  if (!pepper) throw new Error('A pepper (secret) is required for customer ids.');
  return { keyFor: (contact) => crypto.createHmac('sha256', pepper).update(String(contact)).digest('hex').slice(0, 32) };
}

module.exports = { createHmacCustomerIds };
