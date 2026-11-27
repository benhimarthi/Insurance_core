'use strict';

const { newCase } = require('../../../../shared/cases');
const { sha256, newId } = require('../../../../shared/crypto');
const { MAX_ATTACHMENTS, ALLOWED_MIME, isTerminal, acceptsUploads, isAllowedUpload } = require('../../domain/inbound');
const { uploadPath } = require('../../domain/retention');

/**
 * One customer message, from any channel:
 *   find the customer's active case (or start one), keep uploads only when documents are expected,
 *   run the flow, then commit the case, its audit events, the replies (outbox) and the customer in
 *   ONE transaction, deduplicated on the customer and message id (providers redeliver). Replies are sent only
 *   after the commit; web chat replies wait in the outbox until the page polls.
 *
 * inbound: { messageId, from, text, attachments, channel: 'whatsapp' | 'web' }
 */
function makeHandleInbound({ flow, store, uploads, customerIds, delivery, clock, logger }) {
  async function collectAttachments({ tenant, tenantId, caseId, inbound }) {
    const out = [];
    const list = (inbound.attachments || []).slice(0, MAX_ATTACHMENTS);
    for (let i = 0; i < list.length; i += 1) {
      const att = list[i];
      if (!ALLOWED_MIME.includes(att.mimeType)) continue;
      const bytes = att.data ? Buffer.from(att.data) : (delivery && delivery.downloadMedia ? await delivery.downloadMedia(att) : null);
      if (!isAllowedUpload(att.mimeType, bytes)) continue; // the content must really be the declared type
      const storagePath = uploadPath(tenantId, caseId, `${sha256(inbound.messageId).slice(0, 12)}-${i}`);
      await uploads.save(storagePath, bytes, att.mimeType);
      out.push({
        storagePath, mimeType: att.mimeType, filename: att.filename || null, data: bytes,
        ...(tenant.demo && att.demoFixture ? { demoFixture: att.demoFixture } : {}), // demo scenarios only
      });
    }
    return out;
  }

  return async function handleInbound({ tenantId, tenant, config, inbound }) {
    const now = clock.now();
    const customerId = customerIds.keyFor(inbound.from);
    const customer = await store.getCustomer(tenantId, customerId);

    let caseId = customer && customer.activeCaseId;
    let existing = caseId ? await store.getCase(tenantId, caseId) : null;
    if (!existing || isTerminal(existing, now)) {
      caseId = newId();
      existing = null;
    }

    const attachments = acceptsUploads(existing) ? await collectAttachments({ tenant, tenantId, caseId, inbound }) : [];

    const result = await store.transact({
      tenantId, caseId, customerId,
      dedupe: { kind: 'msg', id: `${customerId}|${inbound.messageId}` }, // per customer: nobody can pre-empt another's message id
      compute: async ({ caseDoc }) => {
        const base = caseDoc || newCase({ id: caseId, tenantId, channel: inbound.channel, customerId });
        const out = await flow({ caseDoc: base, message: inbound.text || '', attachments, config, now: clock.now() });
        return {
          caseDoc: out.caseDoc,
          events: out.events,
          outbox: out.replies.map((text) => ({ kind: 'text', text })),
          customerPatch: { contact: inbound.from, channel: inbound.channel, activeCaseId: caseId, language: out.caseDoc.language || null, lastInboundAt: clock.now().toISOString() },
        };
      },
    });

    if (!result.duplicate && inbound.channel !== 'web' && delivery) {
      try { await delivery.send(result.outbox); } catch (err) { logger.error(`inline delivery failed: ${err.message}`); } // the retry job picks them up
    }
    return result;
  };
}

module.exports = { makeHandleInbound };
