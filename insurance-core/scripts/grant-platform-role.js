'use strict';

/**
 * Gives a Firebase Auth user a global platform role (custom claim "platformRole").
 *   GOOGLE_APPLICATION_CREDENTIALS=key.json node scripts/grant-platform-role.js <uid> platform_admin
 *   ... node scripts/grant-platform-role.js <uid> none      (removes it)
 * Only the Admin SDK can set claims, so this cannot be done from the app. The person must sign
 * out and in again for the claim to appear in their token.
 */
const admin = require('firebase-admin');
const { isPlatformRole } = require('../src/auth/roles');

(async () => {
  const [uid, role] = process.argv.slice(2);
  if (!uid || !(isPlatformRole(role) || role === 'none')) throw new Error('Usage: node scripts/grant-platform-role.js <uid> <platform_admin|none>');
  admin.initializeApp();
  const user = await admin.auth().getUser(uid);
  const claims = { ...(user.customClaims || {}) };
  if (role === 'none') delete claims.platformRole; else claims.platformRole = role;
  await admin.auth().setCustomUserClaims(uid, claims);
  await admin.auth().revokeRefreshTokens(uid);
  console.log(role === 'none' ? `Platform role removed from ${uid}.` : `${uid} is now ${role}.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
