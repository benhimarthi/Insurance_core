'use strict';

const { sha256, stripUndefined } = require('../server/util');

/**
 * Policy records and numbering in Firestore, for the demo deployment. A real insurer's core
 * system replaces this adapter (it owns numbering). Idempotent on draft.idempotencyKey, and the
 * counter and the record are written in one transaction, so numbers never repeat or skip.
 *   tenants/{t}/policies/{policyNumber}   the policy
 *   counters/{t}-{prefix}-{year}          { value }
 *   policyIdempotency/{hash}              { policy }
 */
function createFirestorePolicyAdmin(db) {
  return {
    async createPolicy(draft) {
      const year = draft.issuedAt.slice(0, 4);
      const idemRef = db.doc(`policyIdempotency/${sha256(`${draft.tenantId}:${draft.idempotencyKey}`)}`);
      const counterRef = db.doc(`counters/${draft.tenantId}-${draft.numberPrefix}-${year}`);

      return db.runTransaction(async (tx) => {
        const [idem, counter] = await Promise.all([tx.get(idemRef), tx.get(counterRef)]);
        if (idem.exists) return idem.data().policy;

        const seq = (counter.exists ? counter.data().value : 0) + 1;
        const policyNumber = `POL-${draft.numberPrefix}-${year}-${String(seq).padStart(6, '0')}`;
        const policy = stripUndefined({ ...draft, policyNumber, status: 'active' });
        tx.set(counterRef, { value: seq });
        tx.set(db.doc(`tenants/${draft.tenantId}/policies/${policyNumber}`), policy);
        tx.set(idemRef, { policy });
        return policy;
      });
    },

    async getPolicy(tenantId, policyNumber) {
      const snap = await db.doc(`tenants/${tenantId}/policies/${policyNumber}`).get();
      return snap.exists ? snap.data() : null;
    },
  };
}

module.exports = { createFirestorePolicyAdmin };
