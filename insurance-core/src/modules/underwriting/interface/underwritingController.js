'use strict';

const { AppError } = require('../../../shared/errors');

/**
 * The `underwriting` callable: { action, tenantId, ... }.
 *   list { view: 'waiting' | 'recent' }, get { caseId }, documentLink { caseId, docType }   (case:read)
 *   decide { caseId, decision, adjustedPremium?, note? }, message { caseId, text },
 *   resendPolicy { caseId }                                                                  (case:decide)
 */
function createUnderwritingController(api) {
  const actions = {
    list: ({ c, d }) => api.listCases({ ...c, view: d.view }),
    get: ({ c, d }) => api.getCase({ ...c, caseId: d.caseId }),
    documentLink: ({ c, d }) => api.documentLink({ ...c, caseId: d.caseId, docType: d.docType }),
    decide: ({ c, d }) => api.decide({ ...c, caseId: d.caseId, decision: d.decision, adjustedPremium: d.adjustedPremium, note: d.note }),
    message: ({ c, d }) => api.messageCustomer({ ...c, caseId: d.caseId, text: d.text }),
    resendPolicy: ({ c, d }) => api.resendPolicy({ ...c, caseId: d.caseId }),
  };
  return async function handle({ auth, data }) {
    const d = data || {};
    const action = Object.prototype.hasOwnProperty.call(actions, d.action) ? actions[d.action] : null;
    if (!action) throw new AppError('invalid-argument', 'Unknown action.');
    return action({ d, c: { auth, tenantId: d.tenantId, reason: d.reason } });
  };
}

module.exports = { createUnderwritingController };
