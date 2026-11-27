'use strict';

/**
 * TenantDirectory over Firestore: the read-only view of insurers that auth needs
 * (names for the tenant switcher). The tenants module owns these documents.
 */
function createFirestoreTenantDirectory(db, { limit = 500 } = {}) {
  return {
    async namesOf(tenantIds) {
      const snaps = await Promise.all(tenantIds.map((id) => db.doc(`tenants/${id}`).get()));
      const names = new Map();
      snaps.forEach((s, i) => { if (s.exists && s.data().name) names.set(tenantIds[i], s.data().name); });
      return names;
    },
    async listAll() {
      const snap = await db.collection('tenants').limit(limit).get();
      return snap.docs.map((d) => {
        const t = d.data();
        return { tenantId: d.id, name: t.name || d.id, demo: !!t.demo, status: t.status || 'active' };
      });
    },
  };
}

module.exports = { createFirestoreTenantDirectory };
