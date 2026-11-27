'use strict';

const fs = require('fs');
const path = require('path');
const { TENANT_ID_RE } = require('../../../shared/ids');

/**
 * Loads a tenant (insurer or demo) and its rules config, for the chat, payment and policy code.
 *   Firestore:  tenants/{id}                   { name, status, demo }
 *               tenants/{id}/configs/motor     the rules, tariff, documents, policy config
 *               tenantSecrets/{id}             { webchatKey }  (no client access)
 * Fallback for local demos: config/tenants/{id}/motor.json (tenant treated as demo).
 * Cached for 60 s so config edits apply quickly without a read on every message.
 */
function createTenantLoader({ db, localDir, ttlMs = 60000, now = () => Date.now() }) {
  const cache = new Map();

  async function fromFirestore(tenantId) {
    if (!db) return null;
    const [t, cfg, secrets] = await Promise.all([
      db.doc(`tenants/${tenantId}`).get(),
      db.doc(`tenants/${tenantId}/configs/motor`).get(),
      db.doc(`tenantSecrets/${tenantId}`).get(),
    ]);
    if (!t.exists || !cfg.exists) return null;
    const tenant = { id: tenantId, status: 'active', demo: false, ...t.data(), webchatKey: secrets.exists ? secrets.data().webchatKey : null };
    return { tenant, config: cfg.data() };
  }

  function fromLocal(tenantId) {
    if (!localDir) return null;
    const file = path.join(localDir, tenantId, 'motor.json');
    if (!fs.existsSync(file)) return null;
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { tenant: { id: tenantId, name: (config.branding && config.branding.insurerName) || tenantId, status: 'active', demo: true, webchatKey: null }, config };
  }

  return async function loadTenant(tenantId) {
    if (!TENANT_ID_RE.test(tenantId || '')) return null; // also blocks path traversal in the local loader
    const hit = cache.get(tenantId);
    if (hit && hit.expires > now()) return hit.value;
    const value = (await fromFirestore(tenantId)) || fromLocal(tenantId);
    if (value && value.tenant.status !== 'active') return null;
    cache.set(tenantId, { value, expires: now() + ttlMs });
    return value;
  };
}

module.exports = { createTenantLoader };
