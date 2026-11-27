'use strict';

/**
 * Creates a member directly (no invitation): for the FIRST admin of a new insurer.
 *   GOOGLE_APPLICATION_CREDENTIALS=key.json FIRESTORE_DATABASE_ID=(default) \
 *     node scripts/add-member.js <tenant-id> <uid> <role> [email]
 * Everyone else should be invited through the `members` callable. Writes an audit event.
 */
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { createAuthModule } = require('../src/modules/auth');

(async () => {
  const [tenantId, uid, role, email] = process.argv.slice(2);
  if (!tenantId || !uid || !role) throw new Error('Usage: node scripts/add-member.js <tenant-id> <uid> <role> [email]');
  const app = admin.initializeApp();
  const db = getFirestore(app, process.env.FIRESTORE_DATABASE_ID || '(default)');
  await createAuthModule({ db }).bootstrapMember({ tenantId, uid, email, role });
  console.log(`${uid} is now ${role} at "${tenantId}".`);
})().catch((e) => { console.error(e.message); process.exit(1); });
