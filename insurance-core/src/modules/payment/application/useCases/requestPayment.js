'use strict';

const { CASE_STATUS, ACTOR, EVENT, newEvent, finalPremium } = require('../../../../shared/cases');
const { formatMoney } = require('../../../../shared/format');
const { PAYABLE_STATUSES, canReuseLink, linkExpiry } = require('../../domain/payment');

const SYSTEM = { kind: ACTOR.SYSTEM, id: 'payment' };

/**
 * The customer accepted the premium: create (or reuse) the payment link with the insurer's provider.
 * Returns null when the insurer has no provider yet (the conversation then says the insurer follows up).
 * Issuance rules are checked by `isApprovedForIssuance` (policies port) before any link exists.
 */
function makeRequestPayment({ gateways, messages, isApprovedForIssuance }) {
  return async function requestPayment({ caseDoc, config, now = new Date() }) {
    const gateway = await gateways.forTenant(caseDoc.tenantId);
    if (!gateway) return null;

    const c = structuredClone(caseDoc);
    const lang = c.language || 'fr';
    if (!c.id) throw new Error('caseDoc.id is required to request a payment.');
    if (!PAYABLE_STATUSES.includes(c.status)) throw new Error(`Cannot request payment for a case in status "${c.status}".`);
    if (!isApprovedForIssuance(c)) throw new Error('Payment is only possible for automatically accepted or human-approved cases.');
    if (!c.flow || !['confirmed', 'payment'].includes(c.flow.stage)) throw new Error('The customer has not accepted the premium yet.');

    const amount = finalPremium(c);
    const priceText = (a) => formatMoney(a, config.currency, lang === 'en' ? 'en' : 'fr').replace(` ${config.currency}`, '');

    if (canReuseLink(c.payment, amount, now)) {
      return { caseDoc: c, replies: [messages.link(lang, c.payment.url, priceText(amount), config.currency)], events: [] };
    }

    const attempt = ((c.payment && c.payment.attempt) || 0) + 1; // new link after expiry or a new amount
    const link = await gateway.createPaymentLink({
      tenantId: c.tenantId,
      caseId: c.id,
      amount,
      currency: config.currency,
      description: `Motor insurance, case ${c.id}`,
      expiresAt: linkExpiry(config, now),
      idempotencyKey: `${c.id}:${amount}:${attempt}`, // retried calls reuse the link; a new attempt gets a new one
    });

    c.payment = { paymentId: link.paymentId, url: link.url, amount, currency: config.currency, status: 'pending', expiresAt: link.expiresAt, attempt };
    c.status = CASE_STATUS.AWAITING_PAYMENT;
    c.flow = { stage: 'payment', pending: null, retries: 0 };
    c.updatedAt = new Date().toISOString();

    return {
      caseDoc: c,
      replies: [messages.link(lang, link.url, priceText(amount), config.currency)],
      events: [newEvent({ type: EVENT.PAYMENT_LINK_CREATED, actor: SYSTEM, payload: { paymentId: link.paymentId, amount, currency: config.currency } })],
    };
  };
}

module.exports = { makeRequestPayment };
