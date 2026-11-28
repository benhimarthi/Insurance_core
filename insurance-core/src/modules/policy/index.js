'use strict';

/**
 * Policy module: issuing policies.
 *   - who may be issued (automatic accept or human approval), the policy draft from verified data,
 *     dates and premium parts (domain/policy.js)
 *   - issuing: numbering in the policy registry, the PDF, storage (application/useCases/issuePolicy.js)
 * It knows nothing about payment: the payment module calls issue() once a payment is confirmed.
 * This file is the composition root and the only public entry point.
 */

const { makeIssuePolicy } = require('./application/useCases/issuePolicy');
const { generatePolicyPdf } = require('./infrastructure/pdfRenderer');
const { createFirestorePolicyRegistry } = require('./infrastructure/firestorePolicyRegistry');
const { createMemoryPolicyRegistry } = require('./infrastructure/memoryPolicyRegistry');
const { isApprovedForIssuance, buildPolicyDraft, premiumParts, addDays, addMonths, isoDate } = require('./domain/policy');

/** Ports (application/ports.js): registry, files ({ save }), verifier (optional), renderer (defaults to pdf-lib). */
function createPolicyModule({ registry, files, verifier = null, renderer = { render: generatePolicyPdf } }) {
  return {
    issue: makeIssuePolicy({ registry, renderer, files, verifier }),
    getPolicy: (tenantId, policyNumber) => registry.getPolicy(tenantId, policyNumber),
  };
}

module.exports = {
  createPolicyModule,
  createFirestorePolicyRegistry, createMemoryPolicyRegistry, generatePolicyPdf,
  isApprovedForIssuance, buildPolicyDraft, premiumParts, addDays, addMonths, isoDate,
};
