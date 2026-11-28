'use strict';

/**
 * Gateways port for this platform today: demo insurers use the demo checkout; real insurers have no
 * provider yet (the conversation then says the insurer follows up). A real provider (CMI, Stripe...)
 * plugs in here per insurer.
 */
function demoCheckoutForDemoInsurers({ tenants, demoGateway, realGateway = null }) {
  return {
    async forTenant(tenantId) {
      const loaded = await tenants.load(tenantId);
      if (!loaded) return null;
      return loaded.tenant.demo ? demoGateway : realGateway;
    },
  };
}

module.exports = { demoCheckoutForDemoInsurers };
