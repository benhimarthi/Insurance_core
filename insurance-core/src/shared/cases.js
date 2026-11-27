'use strict';

/**
 * The case record: the one contract every module shares (conversation, underwriting, documents,
 * payment, policy). Statuses, audit events and the human-decision rule live here so all modules
 * agree on them. Keep it about the record itself, never about how a module does its job.
 *
 * Firestore layout (every document lives under a tenant = one insurer / one demo):
 *
 *   tenants/{tenantId}                                  branding, languages, status
 *   tenants/{tenantId}/configs/{line}                   rules + tariff + thresholds (versioned JSON)
 *   tenants/{tenantId}/customers/{customerId}           contact, language, consent
 *   tenants/{tenantId}/cases/{caseId}                   one application: input, engine result, review
 *   tenants/{tenantId}/cases/{caseId}/documents/{docId} optional per-file metadata (raw files live in Cloud Storage; case.documents holds the verified summary)
 *   tenants/{tenantId}/cases/{caseId}/events/{eventId}  append-only audit trail
 *   tenants/{tenantId}/policies/{policyId}              issued policies (via PolicyAdminAdapter)
 */

const CASE_STATUS = Object.freeze({
  COLLECTING: 'collecting',       // conversation in progress
  NEEDS_INFO: 'needs_info',       // engine says fields are missing or invalid
  QUOTED: 'quoted',               // auto-accepted, quote sent to the client
  PENDING_REVIEW: 'pending_review', // referred: waiting for an underwriter
  AWAITING_PAYMENT: 'awaiting_payment', // customer accepted, payment link sent
  APPROVED: 'approved',           // human approved the AI proposal
  ADJUSTED: 'adjusted',           // human approved with a changed premium
  REJECTED: 'rejected',           // human rejected
  DECLINED: 'declined',           // automatic decline (only if config.escalation.autoDecline)
  AWAITING_PAYMENT: 'awaiting_payment', // payment link sent (quote confirmed or underwriter approved)
  ISSUED: 'issued',               // paid, policy active, certificate delivered
});

const ACTOR = Object.freeze({ SYSTEM: 'system', AI: 'ai', HUMAN: 'human', CUSTOMER: 'customer' });

const EVENT = Object.freeze({
  CASE_CREATED: 'case_created',
  INPUT_UPDATED: 'input_updated',
  DOCUMENT_EXTRACTED: 'document_extracted',
  ENGINE_EVALUATED: 'engine_evaluated',
  REFERRED: 'referred',
  HUMAN_DECISION: 'human_decision',
  QUOTE_ACCEPTED: 'quote_accepted',
  QUOTE_DECLINED_BY_CUSTOMER: 'quote_declined_by_customer',
  PAYMENT_LINK_CREATED: 'payment_link_created',
  PAYMENT_RECEIVED: 'payment_received',
  PAYMENT_FAILED: 'payment_failed',
  PAYMENT_MISMATCH: 'payment_mismatch',
  PAYMENT_LINK_CREATED: 'payment_link_created',
  PAYMENT_RECEIVED: 'payment_received',
  PAYMENT_FAILED: 'payment_failed',
  PAYMENT_MISMATCH: 'payment_mismatch',
  POLICY_ISSUED: 'policy_issued',
});

const paths = {
  tenant: (t) => `tenants/${t}`,
  config: (t, line) => `tenants/${t}/configs/${line}`,
  customers: (t) => `tenants/${t}/customers`,
  cases: (t) => `tenants/${t}/cases`,
  case: (t, id) => `tenants/${t}/cases/${id}`,
  documents: (t, id) => `tenants/${t}/cases/${id}/documents`,
  events: (t, id) => `tenants/${t}/cases/${id}/events`,
  policies: (t) => `tenants/${t}/policies`,
};

const now = () => new Date().toISOString(); // use serverTimestamp() when writing to Firestore

function newCase({ id, tenantId, line = 'motor', channel, language, customerId }) {
  return {
    id,           // Firestore document id; required before issuance
    tenantId, line, channel, language, customerId,
    status: CASE_STATUS.COLLECTING,
    input: { driver: {}, vehicle: {}, location: {}, coverage: null },
    documents: {},              // verified documents: { [type]: { fields, confidence, receivedAt, source } }
    documentFlags: [],          // cross-check flags that force a human review
    documentConfidence: null,   // min extraction confidence across documents
    engineResult: null,         // output of evaluateCase (immutable snapshot per evaluation)
    review: null,               // { reviewerId, decision, adjustedPremium, note, decidedAt }
    payment: null,              // { paymentId, url, amount, currency, status, expiresAt, paidAt }
    policy: null,               // { policyNumber, pdfPath, startDate, endDate, issuedAt }
    createdAt: now(),
    updatedAt: now(),
  };
}

function newEvent({ type, actor, payload = {} }) {
  if (!Object.values(ACTOR).includes(actor.kind)) throw new Error(`Unknown actor kind: ${actor.kind}`);
  return { type, actor, payload, at: now() }; // append-only: never update or delete
}

/** Map the engine recommendation to a case status. Refusals can also go to a human. */
function caseStatusFromEngine(engineStatus, config) {
  switch (engineStatus) {
    case 'needs_info': return CASE_STATUS.NEEDS_INFO;
    case 'accept': return CASE_STATUS.QUOTED;
    case 'refer': return CASE_STATUS.PENDING_REVIEW;
    case 'refuse': return config.escalation.autoDecline ? CASE_STATUS.DECLINED : CASE_STATUS.PENDING_REVIEW;
    default: throw new Error(`Unknown engine status: ${engineStatus}`);
  }
}

/**
 * The only way a referred case moves forward. Enforces: humans decide, the AI never does.
 * Returns the updated case and the audit event to append.
 */
function applyHumanDecision(caseDoc, { reviewerId, decision, adjustedPremium, note }) {
  if (caseDoc.status !== CASE_STATUS.PENDING_REVIEW) {
    throw new Error(`Case is "${caseDoc.status}", not pending review.`);
  }
  if (!reviewerId) throw new Error('A human reviewer id is required.');
  if (!['approve', 'adjust', 'reject'].includes(decision)) throw new Error(`Invalid decision: ${decision}`);
  if (decision === 'adjust' && !(adjustedPremium > 0)) throw new Error('Adjust requires a positive premium.');

  const status = { approve: CASE_STATUS.APPROVED, adjust: CASE_STATUS.ADJUSTED, reject: CASE_STATUS.REJECTED }[decision];
  const proposed = caseDoc.engineResult && caseDoc.engineResult.premium ? caseDoc.engineResult.premium.total : null;
  if (decision === 'approve' && !(proposed > 0)) throw new Error('No proposed premium to approve: use "adjust" with a premium.');
  const review = { reviewerId, decision, adjustedPremium: adjustedPremium || null, note: note || '', decidedAt: now() };

  return {
    case: { ...caseDoc, status, review, updatedAt: now() },
    event: newEvent({
      type: EVENT.HUMAN_DECISION,
      actor: { kind: ACTOR.HUMAN, id: reviewerId },
      payload: { decision, proposedPremium: proposed, adjustedPremium: adjustedPremium || null, note: note || '' },
    }),
  };
}

/** The premium the customer pays: the underwriter's adjusted amount, else the engine's. */
function finalPremium(caseDoc) {
  if (caseDoc.review && caseDoc.review.decision === 'adjust') return caseDoc.review.adjustedPremium;
  return caseDoc.engineResult && caseDoc.engineResult.premium ? caseDoc.engineResult.premium.total : null;
}

module.exports = { CASE_STATUS, ACTOR, EVENT, paths, newCase, newEvent, caseStatusFromEngine, applyHumanDecision, finalPremium };
