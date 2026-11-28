'use strict';

const { CASE_STATUS, ACTOR, EVENT, newEvent } = require('../../../../shared/cases');
const { formatDate } = require('../../../../shared/format');
const { amountsDiffer } = require('../../domain/payment');

const SYSTEM = { kind: ACTOR.SYSTEM, id: 'payment' };

/**
 * A VERIFIED payment event (the signature was checked first) applied to its case:
 *   failed -> the customer gets the link again; wrong amount -> nothing issued, a person checks;
 *   succeeded -> the policy module issues the policy, the customer gets the confirmation and the PDF.
 * Idempotent: an event for an already issued case changes nothing.
 * Returns { caseDoc, replies, events, attachments, duplicate? }.
 */
function makeApplyPaymentEvent({ policies, messages }) {
  return async function applyPaymentEvent({ caseDoc, event, config, now = new Date() }) {
    const c = structuredClone(caseDoc);
    const lang = c.language || 'fr';
    const out = { caseDoc: c, replies: [], events: [], attachments: [] };

    if (c.status === CASE_STATUS.ISSUED || c.policy) return { ...out, duplicate: true };
    if (!c.payment || event.paymentId !== c.payment.paymentId || event.caseId !== c.id) {
      throw new Error('Payment event does not match this case.');
    }

    if (event.type === 'payment.failed') {
      out.events.push(newEvent({ type: EVENT.PAYMENT_FAILED, actor: SYSTEM, payload: { paymentId: event.paymentId } }));
      out.replies.push(messages.failed(lang, c.payment.url));
      return out;
    }
    if (event.type !== 'payment.succeeded') return out; // unknown event types are ignored

    if (amountsDiffer(event.amount, c.payment.amount) || event.currency !== c.payment.currency) {
      c.payment.status = 'mismatch';
      c.handoff = { reason: 'payment_mismatch' };
      c.updatedAt = new Date().toISOString();
      out.events.push(newEvent({
        type: EVENT.PAYMENT_MISMATCH, actor: SYSTEM,
        payload: { paymentId: event.paymentId, expected: c.payment.amount, received: event.amount, currency: event.currency },
      }));
      out.replies.push(messages.checking(lang));
      return out;
    }

    const paidAt = event.at || now.toISOString();
    const issued = await policies.issue({ caseDoc: c, config, payment: { paymentId: event.paymentId, paidAt }, now });

    c.payment.status = 'paid';
    c.payment.paidAt = paidAt;
    c.policy = issued.record;
    c.status = CASE_STATUS.ISSUED;
    c.flow = { stage: 'issued', pending: null, retries: 0 };
    c.updatedAt = new Date().toISOString();

    out.events.push(
      newEvent({ type: EVENT.PAYMENT_RECEIVED, actor: SYSTEM, payload: { paymentId: event.paymentId, amount: c.payment.amount, currency: c.payment.currency } }),
      newEvent({ type: EVENT.POLICY_ISSUED, actor: SYSTEM, payload: { policyNumber: issued.policy.policyNumber, approvedBy: issued.policy.approvedBy } }),
    );
    out.replies.push(messages.received(lang, issued.policy.policyNumber, formatDate(issued.policy.startDate), formatDate(issued.policy.endDate)));
    out.attachments.push(issued.document);
    return out;
  };
}

module.exports = { makeApplyPaymentEvent };
