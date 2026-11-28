'use strict';

const { TENANT_ID_RE, ID_RE } = require('../../../../shared/ids');

/**
 * The demo checkout (demo insurers only; it moves no money). GET shows the amount, POST "pays":
 * it signs the event a real provider would send and goes through the same webhook path.
 * Returns { status, state: form|paid|expired|error|missing, payment?, brand? } for the page.
 */
function makeDemoCheckout({ tenants, demoGateway, handleWebhook, webhookSecret, clock }) {
  return async function demoCheckout({ tenantId, paymentId, method }) {
    const page = (status, state, payment = null, loaded = null) => ({ status, state, payment, brand: loaded && loaded.tenant.name });
    if (!demoGateway || !TENANT_ID_RE.test(tenantId || '') || !ID_RE.test(paymentId || '')) return page(404, 'missing');
    const loaded = await tenants.load(tenantId);
    if (!loaded || !loaded.tenant.demo) return page(404, 'missing'); // never for real insurers

    const payment = await demoGateway.getPayment(paymentId);
    if (!payment || payment.tenantId !== tenantId) return page(404, 'missing', null, loaded);
    if (payment.status === 'paid') return page(200, 'paid', payment, loaded);
    if (new Date(payment.expiresAt) <= clock.now()) return page(410, 'expired', payment, loaded);
    if (method !== 'POST') return page(200, 'form', payment, loaded);

    const { rawBody, signature } = demoGateway.signEvent(payment, 'succeeded', webhookSecret(tenantId));
    const res = await handleWebhook({ tenantId, rawBody, signature });
    if (res.ok) {
      await demoGateway.markPaid(paymentId);
      return page(200, 'paid', payment, loaded);
    }
    return page(500, 'error', payment, loaded);
  };
}

module.exports = { makeDemoCheckout };
