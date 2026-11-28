'use strict';

const { AppError } = require('../../../../shared/errors');
const { TENANT_ID_RE, ID_RE } = require('../../../../shared/ids');
const { ACTOR, newEvent, applyHumanDecision } = require('../../../../shared/cases');
const { validateDecisionInput, amountOf, assertWithinLimit, assertDecidable, validateMessage } = require('../../domain/decision');

/**
 * Acting on a case (case:decide): the decision, and messages to the customer. Both are committed with
 * the case (audit event + outbox) in one transaction, then pushed to WhatsApp customers; web chat
 * customers receive them when their page checks for new messages.
 */
function makeCaseActions({ authorizer, store, tenants, notifier, delivery, logger }) {
  async function deliver(outbox) {
    if (!delivery || !outbox || !outbox.length) return;
    try { await delivery.send(outbox); } catch (err) { logger.error(`decision delivery failed: ${err.message}`); } // the retry job resends
  }

  async function context({ caller, tenantId, caseId, reason }) {
    const ctx = await authorizer.authorize({ caller, tenantId, permission: 'case:decide', reason });
    const loaded = await tenants.load(tenantId);
    if (!loaded) throw new AppError('not-found', 'Unknown tenant.');
    if (typeof caseId !== 'string' || !ID_RE.test(caseId)) throw new AppError('invalid-argument', 'Invalid caseId.');
    return { ctx, loaded };
  }

  async function decide({ caller, tenantId, caseId, decision, adjustedPremium, note, reason }) {
    if (!TENANT_ID_RE.test(tenantId || '')) throw new AppError('invalid-argument', 'Invalid tenant.');
    const { ctx, loaded } = await context({ caller, tenantId, caseId, reason });
    validateDecisionInput({ decision, adjustedPremium, note });

    const result = await store.transact({
      tenantId, caseId,
      compute: async ({ caseDoc }) => {
        if (!caseDoc) throw new AppError('not-found', 'Case not found.');
        assertDecidable(caseDoc, decision);
        const limit = loaded.config.authorization && loaded.config.authorization.underwriterPremiumLimit;
        assertWithinLimit({ amount: amountOf(caseDoc, decision, adjustedPremium), limit, permissions: ctx.permissions });

        let decided;
        try {
          decided = applyHumanDecision(caseDoc, { reviewerId: ctx.uid, decision, adjustedPremium, note });
        } catch (err) {
          throw new AppError('failed-precondition', err.message); // already decided, or not waiting for a decision
        }
        decided.event.payload.reviewerRole = ctx.role; // who decided, and in which capacity
        const notice = notifier.announce({ caseDoc: decided.case, config: loaded.config });
        return { caseDoc: notice.caseDoc, events: [decided.event], outbox: notice.replies.map((text) => ({ kind: 'text', text })) };
      },
    });
    await deliver(result.outbox);
    return { ok: true, status: result.caseDoc.status };
  }

  /** A message from the underwriter to the customer, in the customer's chat (e.g. after "I want an advisor"). */
  async function messageCustomer({ caller, tenantId, caseId, text, reason }) {
    if (!TENANT_ID_RE.test(tenantId || '')) throw new AppError('invalid-argument', 'Invalid tenant.');
    const { ctx } = await context({ caller, tenantId, caseId, reason });
    const message = validateMessage(text);
    const result = await store.transact({
      tenantId, caseId,
      compute: async ({ caseDoc }) => {
        if (!caseDoc) throw new AppError('not-found', 'Case not found.');
        const event = newEvent({ type: 'advisor_message', actor: { kind: ACTOR.HUMAN, id: ctx.uid }, payload: { role: ctx.role, length: message.length } });
        return { caseDoc, events: [event], outbox: [{ kind: 'text', text: message }] };
      },
    });
    await deliver(result.outbox);
    return { ok: true };
  }

  /** Sends the policy PDF of an issued case to the customer again (e.g. they lost it, or it did not arrive). */
  async function resendPolicy({ caller, tenantId, caseId, reason }) {
    if (!TENANT_ID_RE.test(tenantId || '')) throw new AppError('invalid-argument', 'Invalid tenant.');
    const { ctx } = await context({ caller, tenantId, caseId, reason });
    const result = await store.transact({
      tenantId, caseId,
      compute: async ({ caseDoc }) => {
        if (!caseDoc) throw new AppError('not-found', 'Case not found.');
        if (!caseDoc.policy || !caseDoc.policy.pdfPath) throw new AppError('failed-precondition', 'NO_POLICY');
        const { policyNumber, pdfPath } = caseDoc.policy;
        const event = newEvent({ type: 'policy_resent', actor: { kind: ACTOR.HUMAN, id: ctx.uid }, payload: { role: ctx.role, policyNumber } });
        return {
          caseDoc,
          events: [event],
          outbox: [
            { kind: 'text', text: notifier.policyResent({ caseDoc }) },
            { kind: 'document', document: { path: pdfPath, filename: `${policyNumber}.pdf`, mimeType: 'application/pdf' } },
          ],
        };
      },
    });
    await deliver(result.outbox);
    return { ok: true };
  }

  return { decide, messageCustomer, resendPolicy };
}

module.exports = { makeCaseActions };
