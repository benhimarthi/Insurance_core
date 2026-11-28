'use strict';

const { AppError } = require('../../../../shared/errors');
const { ID_RE } = require('../../../../shared/ids');

/**
 * A payment provider's notification: verify its signature (before reading anything), then apply it
 * to the case in one transaction, deduplicated on the event id (providers redeliver), then deliver
 * the replies. Permanent problems are reported as ignored (the provider must not retry forever);
 * transient ones throw (the provider retries; the dedupe marker keeps it safe).
 */
function makeHandleWebhook({ store, tenants, signatures, webhookSecret, applyPaymentEvent, delivery, clock, logger }) {
  // a wiring mistake must fail loudly, not look like a forged webhook
  if (!signatures || typeof signatures.parse !== 'function') throw new Error('Payment module: signatures.parse is required.');
  if (typeof webhookSecret !== 'function') throw new Error('Payment module: webhookSecret(tenantId) is required.');
  return async function handleWebhook({ tenantId, rawBody, signature }) {
    const loaded = await tenants.load(tenantId);
    if (!loaded) throw new AppError('not-found', 'UNKNOWN_TENANT');

    let event;
    try {
      event = signatures.parse({ secret: webhookSecret(tenantId), rawBody: String(rawBody), signature: signature || '' });
    } catch {
      throw new AppError('unauthenticated', 'BAD_SIGNATURE');
    }
    if (!ID_RE.test(event.caseId)) throw new AppError('invalid-argument', 'BAD_CASE_ID');

    try {
      const result = await store.transact({
        tenantId, caseId: event.caseId,
        dedupe: { kind: 'pay', id: event.id },
        compute: async ({ caseDoc }) => {
          if (!caseDoc) throw new AppError('not-found', 'Unknown case for this payment event.');
          const out = await applyPaymentEvent({ caseDoc, event, config: loaded.config, now: clock.now() });
          return {
            caseDoc: out.caseDoc,
            events: out.events,
            outbox: [
              ...out.replies.map((text) => ({ kind: 'text', text })),
              ...out.attachments.map((document) => ({ kind: 'document', document })),
            ],
          };
        },
      });
      if (!result.duplicate && delivery) {
        try { await delivery.send(result.outbox); } catch (err) { logger.error(`payment delivery failed: ${err.message}`); }
      }
      return { ok: true, duplicate: !!result.duplicate };
    } catch (err) {
      if (err instanceof AppError || /does not match/.test(err.message)) {
        logger.error(`payment event ${event.id} ignored: ${err.message}`);
        return { ok: false, ignored: err.message };
      }
      throw err;
    }
  };
}

module.exports = { makeHandleWebhook };
