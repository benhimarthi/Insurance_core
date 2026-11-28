'use strict';

const { sha256, newId, stripUndefined } = require('./util');

/**
 * Firestore persistence for the server layer. Takes any Firestore-like `db`
 * (firebase-admin in production, an in-memory fake in tests).
 *
 * Concurrency model: external calls (LLM, payment provider) must NOT run inside a Firestore
 * transaction, because transactions are retried. So transact() works optimistically:
 *   1. read the case (with its version) and the dedupe marker, outside any transaction
 *   2. run compute(): the pure flow plus idempotent adapters; nothing is sent to the customer
 *   3. commit in ONE transaction: re-check the version and the dedupe marker, then write the
 *      case, its audit events, the outbox messages, the customer record and the marker
 *   4. on a version conflict (someone else changed the case), go back to step 1
 * Replies are only sent AFTER the commit, from the outbox, so a retry never double-sends.
 */

class ConflictError extends Error {}

const byCreation = (a, b) => a.createdAt.localeCompare(b.createdAt) || (a.seq || 0) - (b.seq || 0);

const DAY_MS = 24 * 3600 * 1000;
const OUTBOX_GRACE_MS = 90 * 1000; // inline delivery gets a head start before the retry job looks

function createRepository(db, { now = () => new Date() } = {}) {
  const caseRef = (t, id) => db.doc(`tenants/${t}/cases/${id}`);
  const eventsCol = (t, id) => db.collection(`tenants/${t}/cases/${id}/events`);
  const customerRef = (t, id) => db.doc(`tenants/${t}/customers/${id}`);
  const dedupeRef = (kind, t, id) => db.doc(`dedupe/${sha256(`${kind}|${t}|${id}`)}`);

  return {
    newId,

    async getCase(tenantId, caseId) {
      const snap = await caseRef(tenantId, caseId).get();
      return snap.exists ? snap.data() : null;
    },

    async getCustomer(tenantId, customerId) {
      const snap = await customerRef(tenantId, customerId).get();
      return snap.exists ? snap.data() : null;
    },

    /**
     * compute({ caseDoc, customer }) -> { caseDoc, events?, outbox?, customerPatch? }
     * outbox entries: { kind: 'text', text } | { kind: 'document', document: { path, filename, mimeType }, text? }
     * Returns { duplicate: true } or { duplicate: false, caseDoc, outbox: [{ id, ...entry }] }.
     */
    async transact({ tenantId, caseId, customerId, dedupe, compute, maxAttempts = 3 }) {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const [caseSnap, dedupeSnap] = await Promise.all([
          caseRef(tenantId, caseId).get(),
          dedupe ? dedupeRef(dedupe.kind, tenantId, dedupe.id).get() : null,
        ]);
        if (dedupeSnap && dedupeSnap.exists) return { duplicate: true };

        const current = caseSnap.exists ? caseSnap.data() : null;
        const cid = customerId || (current && current.customerId);
        const customer = cid ? await this.getCustomer(tenantId, cid) : null;
        const out = await compute({ caseDoc: current, customer });

        const patch = out.customerPatch || null;
        const channel = (patch && patch.channel) || (customer && customer.channel) || 'whatsapp';
        const contact = (patch && patch.contact) || (customer && customer.contact) || null;
        const nowDate = now();
        const nowIso = nowDate.toISOString();

        try {
          return await db.runTransaction(async (tx) => {
            const [c2, d2] = await Promise.all([
              tx.get(caseRef(tenantId, caseId)),
              dedupe ? tx.get(dedupeRef(dedupe.kind, tenantId, dedupe.id)) : null,
            ]);
            if (d2 && d2.exists) return { duplicate: true };
            const storedVersion = c2.exists ? c2.data().version || 0 : 0;
            if (storedVersion !== (current ? current.version || 0 : 0)) throw new ConflictError('case changed');

            const next = stripUndefined({ ...out.caseDoc, id: caseId, version: storedVersion + 1, updatedAt: nowIso }); // commit time is the single source of updatedAt
            tx.set(caseRef(tenantId, caseId), next);

            for (const event of out.events || []) tx.set(eventsCol(tenantId, caseId).doc(), stripUndefined(event));

            const outbox = [];
            for (const [seq, entry] of (out.outbox || []).entries()) {
              const ref = db.collection('outbox').doc();
              const doc = stripUndefined({
                ...entry,
                tenantId, caseId, customerId: cid || null, channel,
                to: channel === 'web' ? null : contact,
                status: channel === 'web' ? 'queued_web' : contact ? 'pending' : 'failed',
                seq, // keeps order inside one commit (same createdAt)
                attempts: 0,
                createdAt: nowIso,
                nextAttemptAt: new Date(nowDate.getTime() + OUTBOX_GRACE_MS).toISOString(),
                expireAt: new Date(nowDate.getTime() + 7 * DAY_MS), // Firestore TTL policy on "expireAt"
              });
              tx.set(ref, doc);
              outbox.push({ id: ref.id, ...doc });
            }

            if (patch && cid) tx.set(customerRef(tenantId, cid), stripUndefined({ ...patch, updatedAt: nowIso }), { merge: true });
            if (dedupe) tx.set(dedupeRef(dedupe.kind, tenantId, dedupe.id), { at: nowIso, expireAt: new Date(nowDate.getTime() + 30 * DAY_MS) });

            return { duplicate: false, caseDoc: next, outbox };
          });
        } catch (err) {
          if (err instanceof ConflictError && attempt < maxAttempts) continue;
          throw err;
        }
      }
      throw new Error('transact: too many conflicts');
    },

    /** Outbox entries the retry job should (re)send. Needs the composite index in firestore.indexes.json. */
    async listDueOutbox(limit = 50) {
      const snap = await db.collection('outbox')
        .where('status', '==', 'pending')
        .where('nextAttemptAt', '<=', now().toISOString())
        .limit(limit).get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byCreation);
    },

    async markOutbox(id, patch) {
      await db.doc(`outbox/${id}`).set(stripUndefined(patch), { merge: true });
    },

    /** Cases of one insurer, last updated first (optionally one status: index status + updatedAt). */
    async listCases(tenantId, { status, limit = 100 } = {}) {
      let q = db.collection(`tenants/${tenantId}/cases`);
      if (status) q = q.where('status', '==', status);
      const snap = await q.orderBy('updatedAt', 'desc').limit(limit).get();
      return snap.docs.map((d) => d.data());
    },

    /** A case's audit trail, oldest first. */
    async listCaseEvents(tenantId, caseId, limit = 200) {
      const snap = await eventsCol(tenantId, caseId).orderBy('at', 'asc').limit(limit).get();
      return snap.docs.map((d) => d.data());
    },

    /** Audit only (e.g. a document was opened): the case itself is not touched. */
    async appendEvent(tenantId, caseId, event) {
      await eventsCol(tenantId, caseId).doc().set(stripUndefined(event));
    },

    /**
     * Data retention: deletes cases last updated before `updatedBy` that never got past `stages`
     * (abandoned conversations), with their audit events and the customer record pointing to them.
     * Returns [{ tenantId, caseId }]. Walks insurer by insurer (single-field index, no collection group).
     */
    async deleteAbandonedCases({ updatedBefore, stages, limit = 500 }) {
      const deleted = [];
      const tenants = await db.collection('tenants').get();
      for (const t of tenants.docs) {
        if (deleted.length >= limit) break;
        const snap = await db.collection(`tenants/${t.id}/cases`).where('updatedAt', '<=', updatedBefore).limit(limit - deleted.length).get();
        for (const d of snap.docs) {
          const c = d.data();
          if (!c.flow || !stages.includes(c.flow.stage)) continue;
          const events = await eventsCol(t.id, d.id).get();
          for (const e of events.docs) await db.doc(`tenants/${t.id}/cases/${d.id}/events/${e.id}`).delete();
          if (c.customerId) {
            const cust = await customerRef(t.id, c.customerId).get();
            if (cust.exists && cust.data().activeCaseId === d.id) await customerRef(t.id, c.customerId).delete();
          }
          await caseRef(t.id, d.id).delete();
          deleted.push({ tenantId: t.id, caseId: d.id });
        }
      }
      return deleted;
    },

    /** Web chat has no push channel: the client polls and receives queued messages in order. */
    async takePendingWebMessages(tenantId, customerId) {
      const snap = await db.collection('outbox')
        .where('tenantId', '==', tenantId)
        .where('customerId', '==', customerId)
        .where('status', '==', 'queued_web').get();
      const entries = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byCreation);
      for (const e of entries) await this.markOutbox(e.id, { status: 'sent', sentAt: now().toISOString() });
      return entries;
    },
  };
}

module.exports = { createRepository, ConflictError };
