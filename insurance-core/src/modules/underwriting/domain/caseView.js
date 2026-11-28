'use strict';

const { proposedPremium } = require('./decision');

/**
 * What underwriters see. Built from the case record; nothing the customer typed freely is shown
 * (only validated answers), and stored file paths are never exposed (documents are opened through
 * short-lived links).
 */
const WAITING = Object.freeze(['pending_review']);

const reasonCodes = (c) => (c.engineResult && c.engineResult.reasons ? c.engineResult.reasons.map((r) => r.code) : []);

/** Why a case waits for a person: the engine referred it, the customer asked, or the chat got stuck. */
function waitingBecause(c) {
  if (c.status !== 'pending_review') return null;
  if (c.handoff && c.handoff.reason) return c.handoff.reason;
  return c.engineResult ? `engine_${c.engineResult.status}` : 'unknown';
}

const queueItem = (c) => ({
  caseId: c.id,
  status: c.status,
  stage: c.flow ? c.flow.stage : null,
  channel: c.channel || null,
  language: c.language || null,
  createdAt: c.createdAt || null,
  updatedAt: c.updatedAt || null,
  waitingBecause: waitingBecause(c),
  proposedPremium: proposedPremium(c),
  finalPremium: c.review && c.review.decision === 'adjust' ? c.review.adjustedPremium : proposedPremium(c),
  currency: c.engineResult ? c.engineResult.currency : null,
  riskBand: c.engineResult ? c.engineResult.riskBand : null,
  reasonCodes: reasonCodes(c),
  documentFlags: (c.documentFlags || []).map((f) => f.code),
});

function caseDetail(c, { events = [], contact = null } = {}) {
  const e = c.engineResult;
  return {
    ...queueItem(c),
    input: c.input || {},
    engine: e ? {
      status: e.status, riskScore: e.riskScore, riskBand: e.riskBand, confidence: e.confidence,
      configVersion: e.configVersion, premium: e.premium || null,
      reasons: (e.reasons || []).map((r) => ({ code: r.code, type: r.type, outcome: r.outcome || null, points: r.points || null, message: r.message })),
    } : null,
    documents: Object.entries(c.documents || {}).map(([type, d]) => ({
      type, fields: d.fields || {}, confidence: d.confidence ?? null, receivedAt: d.receivedAt || null, hasFile: !!d.source,
    })),
    documentFlags: (c.documentFlags || []).map((f) => ({ code: f.code, message: f.message })),
    documentConfidence: c.documentConfidence ?? null,
    review: c.review || null,
    payment: c.payment ? { status: c.payment.status, amount: c.payment.amount, currency: c.payment.currency } : null,
    policy: c.policy ? { policyNumber: c.policy.policyNumber, startDate: c.policy.startDate, endDate: c.policy.endDate } : null,
    contact,
    events: events.map((ev) => ({ type: ev.type, at: ev.at, actor: ev.actor ? { kind: ev.actor.kind, id: ev.actor.id } : null, payload: ev.payload || {} })),
  };
}

/** The customer's contact as staff may see it: a phone number, or "web chat" (no reachable address). */
function contactView(customer) {
  if (!customer) return null;
  const web = typeof customer.contact === 'string' && customer.contact.startsWith('web:');
  return { channel: customer.channel || (web ? 'web' : null), phone: web ? null : customer.contact || null, language: customer.language || null };
}

module.exports = { WAITING, queueItem, caseDetail, contactView, waitingBecause };
