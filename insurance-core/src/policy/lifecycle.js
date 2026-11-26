'use strict';

const { CASE_STATUS, ACTOR, EVENT, newEvent } = require('../models/schemas');
const { PAY } = require('../conversation/messages');
const { finalPremium, isApprovedForIssuance, buildPolicyDraft } = require('./policy');
const { generatePolicyPdf, formatMoney, formatDate } = require('./pdf');

/**
 * After the quote: human decision notice -> payment link -> payment webhook -> policy + PDF.
 *
 * Every function takes a case and returns { caseDoc, replies, events, attachments? }.
 * The caller persists the case, appends the events and sends the replies and attachments.
 * Run each call inside a Firestore transaction on the case document so two concurrent
 * webhook deliveries cannot both issue a policy (the handler is also idempotent by itself).
 */

const SYSTEM = { kind: ACTOR.SYSTEM, id: 'policy-lifecycle' };
const PAYABLE_STATUSES = [CASE_STATUS.QUOTED, CASE_STATUS.APPROVED, CASE_STATUS.ADJUSTED, CASE_STATUS.AWAITING_PAYMENT];

const amountsDiffer = (a, b) => Math.abs(Number(a) - Number(b)) > 0.005;
const pdfLanguage = (lang) => (lang === 'en' ? 'en' : 'fr'); // darija customers get a French document

/**
 * Tells the customer the underwriter's decision for a referred case (call it after
 * applyHumanDecision). Approved or adjusted: the customer is offered the final premium and
 * the normal accept -> pay path continues. Rejected: neutral message, case closed.
 */
function notifyHumanDecision({ caseDoc, config }) {
  const c = structuredClone(caseDoc);
  const lang = c.language || 'fr';
  const replies = [];

  if (c.status === CASE_STATUS.APPROVED || c.status === CASE_STATUS.ADJUSTED) {
    c.flow = { stage: 'quoted', pending: null, retries: 0 };
    replies.push(PAY.approved(lang, finalPremium(c), config.currency));
  } else if (c.status === CASE_STATUS.REJECTED) {
    c.flow = { stage: 'closed', pending: null, retries: 0 };
    replies.push(PAY.rejected(lang));
  } else {
    throw new Error(`No human decision to announce for a case in status "${c.status}".`);
  }
  c.updatedAt = new Date().toISOString();
  return { caseDoc: c, replies, events: [] };
}

/** Creates (or reuses) the payment link once the customer accepted the premium. */
async function requestPayment({ caseDoc, config, paymentAdapter, now = new Date() }) {
  const c = structuredClone(caseDoc);
  const lang = c.language || 'fr';
  if (!c.id) throw new Error('caseDoc.id is required to request a payment.');
  if (!PAYABLE_STATUSES.includes(c.status)) throw new Error(`Cannot request payment for a case in status "${c.status}".`);
  if (!isApprovedForIssuance(c)) throw new Error('Payment is only possible for automatically accepted or human-approved cases.');
  if (!c.flow || !['confirmed', 'payment'].includes(c.flow.stage)) throw new Error('The customer has not accepted the premium yet.');

  const amount = finalPremium(c);
  const priceText = (a) => formatMoney(a, config.currency, lang === 'en' ? 'en' : 'fr').replace(` ${config.currency}`, '');

  // Reuse a still-valid pending link for the same amount.
  if (c.payment && c.payment.status === 'pending' && c.payment.amount === amount && new Date(c.payment.expiresAt) > now) {
    return { caseDoc: c, replies: [PAY.link(lang, c.payment.url, priceText(amount), config.currency)], events: [] };
  }

  const attempt = ((c.payment && c.payment.attempt) || 0) + 1; // new link after expiry or a new amount
  const minutes = (config.payment && config.payment.linkExpiryMinutes) || 1440;
  const link = await paymentAdapter.createPaymentLink({
    tenantId: c.tenantId,
    caseId: c.id,
    amount,
    currency: config.currency,
    description: `Motor insurance, case ${c.id}`,
    expiresAt: new Date(now.getTime() + minutes * 60000).toISOString(),
    idempotencyKey: `${c.id}:${amount}:${attempt}`, // retried calls reuse the link; a new attempt gets a new one
  });

  c.payment = { paymentId: link.paymentId, url: link.url, amount, currency: config.currency, status: 'pending', expiresAt: link.expiresAt, attempt };
  c.status = CASE_STATUS.AWAITING_PAYMENT;
  c.flow = { stage: 'payment', pending: null, retries: 0 };
  c.updatedAt = new Date().toISOString();

  return {
    caseDoc: c,
    replies: [PAY.link(lang, link.url, priceText(amount), config.currency)],
    events: [newEvent({ type: EVENT.PAYMENT_LINK_CREATED, actor: SYSTEM, payload: { paymentId: link.paymentId, amount, currency: config.currency } })],
  };
}

/**
 * Handles a VERIFIED payment webhook event (verify the signature first: see parseWebhook).
 * Idempotent: a redelivered event for an issued case changes nothing.
 */
async function handlePaymentEvent({ caseDoc, event, config, policyAdmin, storage, verifier = null, now = new Date() }) {
  const c = structuredClone(caseDoc);
  const lang = c.language || 'fr';
  const out = { caseDoc: c, replies: [], events: [], attachments: [] };

  if (c.status === CASE_STATUS.ISSUED || c.policy) return { ...out, duplicate: true };
  if (!c.payment || event.paymentId !== c.payment.paymentId || event.caseId !== c.id) {
    throw new Error('Payment event does not match this case.');
  }

  if (event.type === 'payment.failed') {
    out.events.push(newEvent({ type: EVENT.PAYMENT_FAILED, actor: SYSTEM, payload: { paymentId: event.paymentId } }));
    out.replies.push(PAY.failed(lang, c.payment.url));
    return out;
  }
  if (event.type !== 'payment.succeeded') return out; // unknown event types are ignored

  // The paid amount must be exactly what we asked for. Otherwise nothing is issued.
  if (amountsDiffer(event.amount, c.payment.amount) || event.currency !== c.payment.currency) {
    c.payment.status = 'mismatch';
    c.handoff = { reason: 'payment_mismatch' };
    c.updatedAt = new Date().toISOString();
    out.events.push(newEvent({
      type: EVENT.PAYMENT_MISMATCH, actor: SYSTEM,
      payload: { paymentId: event.paymentId, expected: c.payment.amount, received: event.amount, currency: event.currency },
    }));
    out.replies.push(PAY.checking(lang));
    return out;
  }

  if (!isApprovedForIssuance(c)) throw new Error('Refusing to issue: the case is not approved for issuance.');

  const draft = buildPolicyDraft({ caseDoc: c, config, now });
  const policy = await policyAdmin.createPolicy(draft); // idempotent by case id

  const paidAt = event.at || now.toISOString();
  const pdf = await generatePolicyPdf({
    policy,
    payment: { paymentId: event.paymentId, paidAt },
    branding: config.branding,
    coverageInfo: config.coverageInfo,
    verification: verifier ? { url: verifier.url(policy) } : null,
    language: pdfLanguage(lang),
  });
  const pdfPath = `tenants/${c.tenantId}/policies/${policy.policyNumber}.pdf`;
  await storage.save(pdfPath, pdf, 'application/pdf');

  c.payment.status = 'paid';
  c.payment.paidAt = paidAt;
  c.policy = { policyNumber: policy.policyNumber, pdfPath, startDate: policy.startDate, endDate: policy.endDate, issuedAt: policy.issuedAt };
  c.status = CASE_STATUS.ISSUED;
  c.flow = { stage: 'issued', pending: null, retries: 0 };
  c.updatedAt = new Date().toISOString();

  out.events.push(
    newEvent({ type: EVENT.PAYMENT_RECEIVED, actor: SYSTEM, payload: { paymentId: event.paymentId, amount: c.payment.amount, currency: c.payment.currency } }),
    newEvent({ type: EVENT.POLICY_ISSUED, actor: SYSTEM, payload: { policyNumber: policy.policyNumber, approvedBy: policy.approvedBy } }),
  );
  out.replies.push(PAY.received(lang, policy.policyNumber, formatDate(policy.startDate), formatDate(policy.endDate)));
  out.attachments.push({ path: pdfPath, filename: `${policy.policyNumber}.pdf`, mimeType: 'application/pdf' });
  return out;
}

module.exports = { notifyHumanDecision, requestPayment, handlePaymentEvent };
