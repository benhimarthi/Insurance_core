import { errorText, normalizeError } from 'insurance-dashboard-auth';
import { casesText } from './casesText.js';

/** Client of the `underwriting` callable. */
export function createCasesApi({ call }) {
  const u = (tenantId, payload) => call('underwriting', { tenantId, ...payload });
  return {
    list: (tenantId, view) => u(tenantId, { action: 'list', view }),
    get: (tenantId, caseId) => u(tenantId, { action: 'get', caseId }),
    documentLink: (tenantId, caseId, docType) => u(tenantId, { action: 'documentLink', caseId, docType }),
    decide: (tenantId, { caseId, decision, adjustedPremium, note }) => u(tenantId, { action: 'decide', caseId, decision, adjustedPremium, note }),
    message: (tenantId, caseId, text) => u(tenantId, { action: 'message', caseId, text }),
  };
}

export function caseErrorText(err, lang) {
  const own = casesText(lang).errors[err && err.message];
  return own || errorText(normalizeError(err, lang), lang);
}
