'use strict';

const { stripUndefined } = require('../../../shared/firestore');

/**
 * TenantStore over Firestore. Layout:
 *   tenants/{t}                              { name, status, demo, createdAt, createdBy, updatedAt, updatedBy }
 *   tenants/{t}/configs/{line}               the live rules (read by the chat, payment and policy code)
 *   tenants/{t}/configMeta/{line}            { revision, updatedAt, updatedBy, updatedByEmail }
 *   tenants/{t}/configVersions/{line}-{rev}  { line, revision, config, savedAt, savedBy, savedByEmail, role, note, restoredFrom? }
 *   tenants/{t}/adminEvents/{id}             append-only audit of changes to the insurer and its rules
 *   tenantSecrets/{t}                        { webchatKey }  (no client access)
 * None of these except configs is readable by clients (firestore.rules): the dashboard goes through
 * the `tenants` callable.
 */
function createFirestoreTenantStore(db) {
  const tenantRef = (t) => db.doc(`tenants/${t}`);
  const configRef = (t, line) => db.doc(`tenants/${t}/configs/${line}`);
  const metaRef = (t, line) => db.doc(`tenants/${t}/configMeta/${line}`);
  const versionId = (line, rev) => `${line}-${String(rev).padStart(6, '0')}`;
  const versionRef = (t, line, rev) => db.doc(`tenants/${t}/configVersions/${versionId(line, rev)}`);
  const dataOrNull = (snap) => (snap.exists ? snap.data() : null);
  const VERSION_FIELDS = ['line', 'revision', 'savedAt', 'savedBy', 'savedByEmail', 'role', 'note', 'restoredFrom'];

  function unitOfWork(tx) {
    return {
      getTenant: async (t) => dataOrNull(await tx.get(tenantRef(t))),
      getRuleMeta: async (t, line) => dataOrNull(await tx.get(metaRef(t, line))),
      getRuleVersion: async (t, line, rev) => dataOrNull(await tx.get(versionRef(t, line, rev))),
      saveTenant: (t, tenant) => { tx.set(tenantRef(t), stripUndefined(tenant)); },
      saveRuleConfig(t, line, { config, revision, savedAt, savedBy, savedByEmail, role, note, restoredFrom }) {
        tx.set(configRef(t, line), config);
        tx.set(metaRef(t, line), stripUndefined({ revision, updatedAt: savedAt, updatedBy: savedBy, updatedByEmail: savedByEmail }));
        tx.set(versionRef(t, line, revision), stripUndefined({ line, revision, config, savedAt, savedBy, savedByEmail, role, note, restoredFrom }));
      },
      saveWebchatKey: (t, webchatKey) => { tx.set(db.doc(`tenantSecrets/${t}`), { webchatKey }); },
      recordEvent: (t, event) => { tx.set(db.collection(`tenants/${t}/adminEvents`).doc(), stripUndefined(event)); },
    };
  }

  return {
    getTenant: async (t) => dataOrNull(await tenantRef(t).get()),
    async getRuleConfig(t, line) {
      const [cfg, meta] = await Promise.all([configRef(t, line).get(), metaRef(t, line).get()]);
      if (!cfg.exists) return null;
      const m = meta.exists ? meta.data() : {};
      // rules seeded before versioning existed have no meta: revision 0, the first save makes revision 1
      return { config: cfg.data(), revision: m.revision || 0, updatedAt: m.updatedAt || null, updatedBy: m.updatedBy || null, updatedByEmail: m.updatedByEmail || null };
    },
    async listRuleVersions(t, line, limit) {
      const snap = await db.collection(`tenants/${t}/configVersions`)
        .where('line', '==', line).orderBy('revision', 'desc').limit(limit)
        .select(...VERSION_FIELDS).get(); // the list never downloads the config copies
      return snap.docs.map((d) => d.data());
    },
    getRuleVersion: async (t, line, rev) => dataOrNull(await versionRef(t, line, rev).get()),
    transaction: (work) => db.runTransaction((tx) => work(unitOfWork(tx))),
  };
}

module.exports = { createFirestoreTenantStore };
