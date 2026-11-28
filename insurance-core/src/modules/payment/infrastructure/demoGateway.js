'use strict';

const crypto = require('crypto');
const { sha256 } = require('../../../shared/crypto');
const { signPayload } = require('./webhookSignature');

/**
 * Firestore-backed DEMO payment gateway. It moves no money. The payment link opens a fake
 * checkout page (the demoPay function); pressing "Pay" produces a signed webhook that goes
 * through the same verification and issuance path as a real provider would.
 * Serverless-safe (state lives in Firestore) unlike the in-memory mock. Enable only for demo tenants.
 *   demoPayments/{paymentId}   demoPaymentKeys/{hash}
 */
function createDemoGateway({ db, baseUrl, now = () => new Date() }) {
  return {
    async createPaymentLink({ tenantId, caseId, amount, currency, description, expiresAt, idempotencyKey }) {
      const keyRef = db.doc(`demoPaymentKeys/${sha256(idempotencyKey)}`);
      return db.runTransaction(async (tx) => {
        const existing = await tx.get(keyRef);
        if (existing.exists) return existing.data().link;
        const paymentId = `pay_${crypto.randomBytes(12).toString('hex')}`; // unguessable
        const link = { paymentId, url: `${baseUrl}/${tenantId}/${paymentId}`, expiresAt, status: 'pending' };
        tx.set(db.doc(`demoPayments/${paymentId}`), { tenantId, caseId, amount, currency, description, status: 'pending', expiresAt, createdAt: now().toISOString() });
        tx.set(keyRef, { link });
        return link;
      });
    },

    async getPayment(paymentId) {
      const snap = await db.doc(`demoPayments/${paymentId}`).get();
      return snap.exists ? { id: paymentId, ...snap.data() } : null;
    },

    async markPaid(paymentId) {
      await db.doc(`demoPayments/${paymentId}`).set({ status: 'paid', paidAt: now().toISOString() }, { merge: true });
    },

    /** Builds the signed webhook body a real provider would send. */
    signEvent(payment, outcome, secret) {
      const rawBody = JSON.stringify({
        id: `evt_${payment.id}_${outcome}`, // same id on redelivery
        type: `payment.${outcome}`,
        paymentId: payment.id,
        caseId: payment.caseId,
        amount: payment.amount,
        currency: payment.currency,
        at: now().toISOString(),
      });
      return { rawBody, signature: signPayload(secret, rawBody) };
    },
  };
}

module.exports = { createDemoGateway };
