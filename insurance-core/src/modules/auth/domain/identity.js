'use strict';

/**
 * Identity: who is calling, as proven by the identity provider, in the module's own terms.
 * The domain and use cases only ever see this shape, never a provider token
 * (interface/firebaseIdentity.js translates Firebase's).
 *
 * @typedef {object} Identity
 * @property {string} uid
 * @property {string|undefined} email
 * @property {boolean} emailVerified
 * @property {boolean} secondFactor  signed in with a second factor in this session
 * @property {string|undefined} platformRole  global role claim, if any (validated by the caller)
 */

/** @returns {Identity} a frozen identity; uid is required. */
function createIdentity({ uid, email, emailVerified = false, secondFactor = false, platformRole }) {
  return Object.freeze({ uid, email, emailVerified: emailVerified === true, secondFactor: secondFactor === true, platformRole });
}

module.exports = { createIdentity };
