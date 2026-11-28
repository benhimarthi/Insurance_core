'use strict';

const { TENANT_ID_RE } = require('../../../../shared/ids');
const { publicView, POLICY_NUMBER_RE, CODE_RE } = require('../../domain/view');

/**
 * Checks a verification link. The code is verified BEFORE any database read, and every failure
 * (malformed link, wrong code, unknown insurer, unknown policy) gives the same answer: the endpoint
 * cannot be used to find out which policies exist.
 * Returns { found: false } or { found: true, view, coverageLabel }.
 */
function makeVerifyPolicy({ verifier, tenants, policies, clock }) {
  return async function verifyPolicy({ tenantId, policyNumber, code, lang = 'fr' }) {
    const notFound = { found: false };
    if (!verifier || !TENANT_ID_RE.test(tenantId || '') || !POLICY_NUMBER_RE.test(policyNumber || '') || !CODE_RE.test(code || '')) return notFound;
    if (!verifier.check({ tenantId, policyNumber }, code)) return notFound;

    const loaded = await tenants.load(tenantId);
    if (!loaded) return notFound;
    const policy = await policies.getPolicy(tenantId, policyNumber);
    if (!policy) return notFound;

    const view = publicView(policy, { tenant: loaded.tenant, today: clock.now().toISOString().slice(0, 10) });
    const info = loaded.config.coverageInfo && loaded.config.coverageInfo[policy.coverage];
    return { found: true, view, coverageLabel: info ? (info.label[lang] || info.label.fr) : null };
  };
}

module.exports = { makeVerifyPolicy };
