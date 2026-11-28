'use strict';

const { finalPremium } = require('../../../shared/cases');

/**
 * Pure policy logic: no I/O. Decides what premium is charged, whether a case may be issued,
 * and builds the policy draft that a PolicyRegistry turns into a real policy (finalPremium, the
 * premium actually charged, comes from the shared case record).
 */

/**
 * The hard rule: a policy is only ever issued for
 *   - an automatic accept (engine said "accept", nobody had to review), or
 *   - a case a HUMAN approved or adjusted.
 * Referred or refused cases without a human approval can never be paid for or issued.
 */
function isApprovedForIssuance(caseDoc) {
  const engine = caseDoc.engineResult && caseDoc.engineResult.status;
  const decision = caseDoc.review && caseDoc.review.decision;
  if (decision === 'approve' || decision === 'adjust') return true;
  return engine === 'accept' && !decision;
}

// ---------- dates (UTC, ISO yyyy-mm-dd) ----------

const isoDate = (d) => d.toISOString().slice(0, 10);

function addDays(d, n) {
  const r = new Date(d.getTime());
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

/** Adds months keeping the day, clamped to the end of shorter months. */
function addMonths(d, months) {
  const r = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return r;
}

function premiumParts(caseDoc, total) {
  const breakdown = (caseDoc.engineResult && caseDoc.engineResult.premium && caseDoc.engineResult.premium.breakdown) || [];
  const fee = breakdown.filter((b) => b.step === 'fee').reduce((s, b) => s + b.amount, 0);
  return { net: total - fee, fee, total };
}

/**
 * Builds the policy draft from verified data only: holder from the ID, vehicle from the
 * registration, premium from the final decision. The policy number is assigned later by the
 * PolicyRegistry (the insurer's system owns numbering).
 */
function buildPolicyDraft({ caseDoc, config, now }) {
  const id = caseDoc.documents && caseDoc.documents.national_id;
  const reg = caseDoc.documents && caseDoc.documents.vehicle_registration;
  if (!id || !reg) throw new Error('Verified identity and registration documents are required to issue a policy.');

  const total = finalPremium(caseDoc);
  if (!(total > 0)) throw new Error('No premium to issue.');

  const cfg = config.policy || {};
  const start = addDays(now, cfg.startOffsetDays || 0);
  const end = addDays(addMonths(start, cfg.durationMonths || 12), -1);

  return {
    idempotencyKey: caseDoc.id,
    numberPrefix: cfg.numberPrefix || 'POL',
    tenantId: caseDoc.tenantId,
    caseId: caseDoc.id,
    line: caseDoc.line,
    issuedAt: now.toISOString(),
    startDate: isoDate(start),
    endDate: isoDate(end),
    holder: { fullName: id.fields.fullName },
    vehicle: {
      plate: reg.fields.plate,
      make: reg.fields.make || null,
      model: reg.fields.model || null,
    },
    coverage: caseDoc.input.coverage,
    premium: { ...premiumParts(caseDoc, total), currency: config.currency },
    approvedBy: caseDoc.review ? { kind: 'human', id: caseDoc.review.reviewerId } : { kind: 'rules-engine', id: caseDoc.engineResult.configVersion },
  };
}

module.exports = { finalPremium, isApprovedForIssuance, buildPolicyDraft, premiumParts, addDays, addMonths, isoDate };
