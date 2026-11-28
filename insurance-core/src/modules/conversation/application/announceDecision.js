'use strict';

const { CASE_STATUS, finalPremium } = require('../../../shared/cases');
const { PAY } = require('../domain/messages');

/**
 * Tells the customer the underwriter's decision on a referred case (the underwriting module's
 * DecisionNotifier). Approved or adjusted: the customer is offered the final premium and the
 * accept -> pay path continues. Rejected: a neutral message, and the conversation is closed.
 */
function announceDecision({ caseDoc, config }) {
  const c = structuredClone(caseDoc);
  const lang = c.language || 'fr';
  const replies = [];
  if (c.status === CASE_STATUS.APPROVED || c.status === CASE_STATUS.ADJUSTED) {
    c.flow = { stage: 'quoted', pending: null, retries: 0 };
    replies.push(PAY.approved(lang, finalPremium(c), config.currency));
  } else if (c.status === CASE_STATUS.REJECTED) {
    c.flow = { stage: 'closed', pending: null, retries: 0 };
    replies.push(PAY.rejected(lang));
  } else {
    throw new Error(`No human decision to announce for a case in status "${c.status}".`);
  }
  c.updatedAt = new Date().toISOString();
  return { caseDoc: c, replies, events: [] };
}

module.exports = { announceDecision };
