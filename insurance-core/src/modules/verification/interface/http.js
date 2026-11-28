'use strict';

const { renderVerifyPage, VERIFY_HEADERS } = require('./verifyPage');

/** GET {verify URL}/{tenantId}/{policyNumber}/{code}[?lang=en][&format=json]: the page, or JSON for other systems. */
function createVerifyHttp(verifyPolicy) {
  return async function handle({ tenantId, policyNumber, code, format = 'html', lang = 'fr' }) {
    const asJson = format === 'json';
    const r = await verifyPolicy({ tenantId, policyNumber, code, lang });
    if (!r.found) {
      return asJson
        ? { status: 404, headers: { 'cache-control': 'no-store' }, body: { valid: false, state: 'not_found' } }
        : { status: 404, headers: VERIFY_HEADERS, html: renderVerifyPage({ view: null, lang }) };
    }
    if (asJson) return { status: 200, headers: { 'cache-control': 'no-store' }, body: r.view };
    return { status: 200, headers: VERIFY_HEADERS, html: renderVerifyPage({ view: r.view, lang, coverageLabel: r.coverageLabel }) };
  };
}

module.exports = { createVerifyHttp };
