'use strict';

/**
 * Creates a demo tenant in Firestore from config/tenants/<tenantId>/motor.json.
 *   GOOGLE_APPLICATION_CREDENTIALS=key.json FIRESTORE_DATABASE_ID=(default) node scripts/seed-demo-tenant.js demo-insurer
 * Prints the web chat key once: keep it, it is stored only in tenantSecrets (no client access).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

(async () => {
  const tenantId = process.argv[2];
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(tenantId || '')) throw new Error('Usage: node scripts/seed-demo-tenant.js <tenant-id>');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tenants', tenantId, 'motor.json'), 'utf8'));

  const app = admin.initializeApp();
  const db = getFirestore(app, process.env.FIRESTORE_DATABASE_ID || '(default)');
  const webchatKey = crypto.randomBytes(18).toString('hex');

  await db.doc(`tenants/${tenantId}`).set({ name: config.branding.insurerName, status: 'active', demo: true });
  await db.doc(`tenants/${tenantId}/configs/motor`).set(config);
  await db.doc(`tenantSecrets/${tenantId}`).set({ webchatKey });
  console.log(`Tenant "${tenantId}" seeded. Web chat key (send as x-webchat-key): ${webchatKey}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
