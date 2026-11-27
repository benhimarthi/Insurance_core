'use strict';

/** SessionRevoker over Firebase Auth: revoking refresh tokens signs the person out everywhere. */
function createFirebaseSessionRevoker(authAdmin) {
  return {
    async revokeAll(uid) {
      if (authAdmin) await authAdmin.revokeRefreshTokens(uid);
    },
  };
}

module.exports = { createFirebaseSessionRevoker };
