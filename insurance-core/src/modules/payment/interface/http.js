'use strict';

const { AppError } = require('../../../shared/errors');
const { renderPayPage, SECURITY_HEADERS } = require('./demoPayPage');

const WEBHOOK_HTTP = { UNKNOWN_TENANT: [404, 'unknown_tenant'], BAD_SIGNATURE: [401, 'bad_signature'], BAD_CASE_ID: [400, 'bad_case_id'] };

/** POST {paymentWebhook URL}/{tenantId}, raw body signed with x-signature (or x-webhook-signature). */
function createWebhookHttp(handleWebhook) {
  return async function handle({ tenantId, rawBody, headers }) {
    try {
      const signature = headers && (headers['x-signature'] || headers['x-webhook-signature']);
      return { status: 200, body: await handleWebhook({ tenantId, rawBody, signature }) };
    } catch (err) {
      if (err instanceof AppError && WEBHOOK_HTTP[err.message]) {
        const [status, error] = WEBHOOK_HTTP[err.message];
        return { status, body: { error } };
      }
      throw err; // 500: the provider retries
    }
  };
}

/** GET/POST {demoPay URL}/{tenantId}/{paymentId}: the demo checkout page. */
function createDemoPayHttp(demoCheckout) {
  return async function handle({ tenantId, paymentId, method }) {
    const r = await demoCheckout({ tenantId, paymentId, method });
    return { status: r.status, headers: SECURITY_HEADERS, html: renderPayPage({ state: r.state, payment: r.payment, brand: r.brand }) };
  };
}

module.exports = { createWebhookHttp, createDemoPayHttp };
