'use strict';

const { createIdentity } = require('../domain/identity');

/**
 * Translates what a Firebase callable receives (request.auth = { uid, token }) into an Identity.
 * The only place that knows Firebase's token claims: email_verified, firebase.sign_in_second_factor,
 * and our custom platformRole claim.
 */
function identityFromFirebase(auth) {
  if (!auth || !auth.uid) return null;
  const token = auth.token || {};
  return createIdentity({
    uid: auth.uid,
    email: token.email,
    emailVerified: token.email_verified === true,
    secondFactor: !!(token.firebase && token.firebase.sign_in_second_factor),
    platformRole: token.platformRole,
  });
}

module.exports = { identityFromFirebase };
