'use strict';

const { isApprovedForIssuance, buildPolicyDraft } = require('../../domain/policy');

const pdfLanguage = (lang) => (lang === 'en' ? 'en' : 'fr'); // darija customers get a French document

/**
 * Issues the policy of a paid case: the registry numbers it (idempotent on the case id, so a
 * redelivered payment never creates a second policy), the PDF is rendered and stored, and the
 * caller gets what to record on the case and the document to send the customer.
 * Only cases approved for issuance (automatic accept, or a human approval) can get here.
 */
function makeIssuePolicy({ registry, renderer, files, verifier }) {
  return async function issuePolicy({ caseDoc, config, payment, now }) {
    if (!isApprovedForIssuance(caseDoc)) throw new Error('Refusing to issue: the case is not approved for issuance.');
    const draft = buildPolicyDraft({ caseDoc, config, now });
    const policy = await registry.createPolicy(draft);
    const pdf = await renderer.render({
      policy,
      payment,
      branding: config.branding,
      coverageInfo: config.coverageInfo,
      verification: verifier ? { url: verifier.url(policy) } : null,
      language: pdfLanguage(caseDoc.language),
    });
    const pdfPath = `tenants/${caseDoc.tenantId}/policies/${policy.policyNumber}.pdf`;
    await files.save(pdfPath, pdf, 'application/pdf');
    return {
      policy,
      record: { policyNumber: policy.policyNumber, pdfPath, startDate: policy.startDate, endDate: policy.endDate, issuedAt: policy.issuedAt },
      document: { path: pdfPath, filename: `${policy.policyNumber}.pdf`, mimeType: 'application/pdf' },
    };
  };
}

module.exports = { makeIssuePolicy };
