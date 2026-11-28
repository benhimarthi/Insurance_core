'use strict';

/**
 * Payment module: from an accepted premium to a confirmed payment.
 *   - payment links with the insurer's provider (gateways.forTenant), reused while valid
 *   - provider notifications: signature first, exact amount, idempotent, then the policy module issues
 *   - the demo checkout for demo insurers (no money moves; same signed path as a real provider)
 * This file is the composition root and the only public entry point.
 */

const { makeRequestPayment } = require('./application/useCases/requestPayment');
const { makeApplyPaymentEvent } = require('./application/useCases/applyPaymentEvent');
const { makeHandleWebhook } = require('./application/useCases/webhook');
const { makeDemoCheckout } = require('./application/useCases/demoCheckout');
const { createWebhookHttp, createDemoPayHttp } = require('./interface/http');
const webhookSignature = require('./infrastructure/webhookSignature');
const { createDemoGateway } = require('./infrastructure/demoGateway');
const { createMockGateway } = require('./infrastructure/mockGateway');
const { demoCheckoutForDemoInsurers } = require('./infrastructure/gatewaySelection');

/**
 * Ports (application/ports.js): store, tenants ({ load }), gateways ({ forTenant }), demoGateway (optional),
 * webhookSecret (tenantId -> secret, read only when a webhook or the demo checkout runs), policies
 * ({ issue, isApprovedForIssuance }), messages (customer texts), delivery (optional).
 */
function createPaymentModule({
  store, tenants, gateways, demoGateway = null, webhookSecret, policies, messages, delivery = null,
  now = () => new Date(), logger = console,
}) {
  const clock = { now };
  const applyPaymentEvent = makeApplyPaymentEvent({ policies, messages });
  const signatures = { parse: webhookSignature.parseWebhook };
  const handleWebhook = makeHandleWebhook({ store, tenants, signatures, webhookSecret, applyPaymentEvent, delivery, clock, logger });
  return {
    requestPayment: makeRequestPayment({ gateways, messages, isApprovedForIssuance: policies.isApprovedForIssuance }), // the conversation's Payments port
    applyPaymentEvent,
    handleWebhook,
    handlePaymentWebhook: createWebhookHttp(handleWebhook),
    handleDemoPay: createDemoPayHttp(makeDemoCheckout({ tenants, demoGateway, handleWebhook, webhookSecret, clock })),
  };
}

module.exports = {
  createPaymentModule, createDemoGateway, createMockGateway, demoCheckoutForDemoInsurers,
  signPayload: webhookSignature.signPayload, verifySignature: webhookSignature.verifySignature, parseWebhook: webhookSignature.parseWebhook,
};
