'use strict';

/**
 * Ports of the payment module.
 *
 * @typedef {object} Gateways         which payment provider an insurer uses (null: none yet)
 * @property {(tenantId) => Promise<PaymentGateway|null>} forTenant
 *
 * @typedef {object} PaymentGateway   a provider (CMI, Stripe...) or the demo checkout
 * @property {(args: {tenantId, caseId, amount, currency, description, expiresAt, idempotencyKey}) => Promise<{paymentId, url, expiresAt, status}>} createPaymentLink
 *
 * @typedef {object} DemoGateway      the demo checkout (demo insurers only): PaymentGateway + getPayment, markPaid, signEvent
 *
 * @typedef {object} Signatures       webhook authenticity (HMAC over the raw body)
 * @property {(args: {secret, rawBody, signature}) => object} parse   throws on a bad signature
 *
 * @typedef {object} Policies         the policy module
 * @property {(args: {caseDoc, config, payment: {paymentId, paidAt}, now}) => Promise<{policy, record, document}>} issue
 *
 * @typedef {object} Messages         customer texts (the conversation module's PAY): link, failed, checking, received
 *
 * @typedef {object} CaseStore        transact with dedupe (src/server/repository.js)
 * @typedef {object} TenantLoader     { load(tenantId) -> { tenant, config } | null }
 * @typedef {object} Delivery         optional: push channels now; web chat customers poll
 */

module.exports = {};
