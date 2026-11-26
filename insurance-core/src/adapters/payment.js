'use strict';

const { signPayload } = require('../payment/webhook');

/**
 * PaymentAdapter interface (implement per provider: CMI, Stripe, a mobile-money gateway...):
 *   createPaymentLink({ tenantId, caseId, amount, currency, description, expiresAt, idempotencyKey })
 *     -> Promise<{ paymentId, url, expiresAt, status }>
 * The provider then calls your webhook endpoint; see src/payment/webhook.js.
 *
 * The mock below never moves money. simulate() produces a signed webhook payload, so you can
 * demo "the customer paid" live and test the whole path with real signature verification.
 */
function createMockPaymentAdapter({
  secret = 'demo-webhook-secret',
  baseUrl = 'https://pay.demo-insurer.example', // reserved .example domain: never resolves
  clock = () => new Date(),
} = {}) {
  const payments = new Map();
  const byKey = new Map();
  let seq = 0;

  return {
    secret,

    async createPaymentLink({ tenantId, caseId, amount, currency, description, expiresAt, idempotencyKey }) {
      if (idempotencyKey && byKey.has(idempotencyKey)) return byKey.get(idempotencyKey);
      const paymentId = `pay_${String(++seq).padStart(6, '0')}`;
      const link = { paymentId, url: `${baseUrl}/pay/${paymentId}`, expiresAt, status: 'pending' };
      payments.set(paymentId, { ...link, tenantId, caseId, amount, currency, description });
      if (idempotencyKey) byKey.set(idempotencyKey, link);
      return link;
    },

    /** Demo/test helper, not part of the real provider interface. */
    simulate(paymentId, { outcome = 'succeeded', amount } = {}) {
      const p = payments.get(paymentId);
      if (!p) throw new Error(`Unknown payment: ${paymentId}`);
      const event = {
        id: `evt_${paymentId}_${outcome}`, // same id on redelivery, like real providers
        type: `payment.${outcome}`,
        paymentId,
        caseId: p.caseId,
        amount: amount ?? p.amount,
        currency: p.currency,
        at: clock().toISOString(),
      };
      const rawBody = JSON.stringify(event);
      return { rawBody, signature: signPayload(secret, rawBody) };
    },
  };
}

module.exports = { createMockPaymentAdapter };
