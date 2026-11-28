'use strict';

const { AppError } = require('../../../shared/errors');

/**
 * Human decisions on referred cases. The engine only recommends; a person approves, adjusts the
 * premium or rejects. (The case record rule itself, applyHumanDecision, lives in shared/cases.js.)
 *   - underwriters decide up to the insurer's premium limit; above it, `case:decide_high` is needed
 *   - a conversation that stopped before the engine ran (advisor asked, stuck) cannot be priced
 *     here: the underwriter messages the customer or rejects
 */
const DECISIONS = Object.freeze(['approve', 'adjust', 'reject']);
const MAX_NOTE = 500;
const MAX_MESSAGE = 1000;

function validateDecisionInput({ decision, adjustedPremium, note }) {
  if (!DECISIONS.includes(decision)) throw new AppError('invalid-argument', 'decision must be approve, adjust or reject.');
  if (decision === 'adjust' && !(Number.isFinite(adjustedPremium) && adjustedPremium > 0)) throw new AppError('invalid-argument', 'adjust needs a positive adjustedPremium.');
  if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE)) throw new AppError('invalid-argument', `note must be at most ${MAX_NOTE} characters.`);
}

const proposedPremium = (c) => (c.engineResult && c.engineResult.premium ? c.engineResult.premium.total : null);

/** The amount the decision commits the insurer to (0 for a rejection). */
const amountOf = (c, decision, adjustedPremium) => (decision === 'adjust' ? adjustedPremium : decision === 'approve' ? (proposedPremium(c) || 0) : 0);

function assertWithinLimit({ amount, limit, permissions }) {
  if (limit && amount > limit && !permissions.includes('case:decide_high')) throw new AppError('permission-denied', 'LIMIT_EXCEEDED');
}

/** Pricing a case needs a finished conversation (the engine ran). Rejecting is always possible. */
function assertDecidable(c, decision) {
  if (decision !== 'reject' && !c.engineResult) throw new AppError('failed-precondition', 'CONVERSATION_NOT_FINISHED');
}

function validateMessage(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t || t.length > MAX_MESSAGE) throw new AppError('invalid-argument', `message must be 1 to ${MAX_MESSAGE} characters.`);
  return t;
}

module.exports = { DECISIONS, MAX_NOTE, MAX_MESSAGE, validateDecisionInput, proposedPremium, amountOf, assertWithinLimit, assertDecidable, validateMessage };
