'use strict';

/**
 * Generic underwriting rules engine.
 * Pure function: evaluateCase(caseInput, tenantConfig) -> result.
 * No I/O, no AI, no Firestore: easy to test, explain and audit.
 * All insurer-specific logic lives in the config (JSON), never in this file.
 */

const round = (n) => Math.round(n);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ---------- Condition evaluator (safe: no eval) ----------

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const OPS = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
  nin: (a, b) => Array.isArray(b) && !b.includes(a),
};

/**
 * Condition grammar:
 *   { field: "driver.age", op: "lt", value: 25 }
 *   { all: [cond, ...] } | { any: [cond, ...] } | { not: cond }
 * A missing field makes a comparison false (missing data is handled by checkInput).
 */
function evalCondition(cond, data) {
  if (cond.all) return cond.all.every((c) => evalCondition(c, data));
  if (cond.any) return cond.any.some((c) => evalCondition(c, data));
  if (cond.not) return !evalCondition(cond.not, data);
  const op = OPS[cond.op];
  if (!op) throw new Error(`Unknown operator: ${cond.op}`);
  const actual = getPath(data, cond.field);
  if (actual === undefined || actual === null) return false;
  return op(actual, cond.value);
}

// ---------- Steps ----------

function checkInput(data, config) {
  const issues = [];
  for (const field of config.requiredFields) {
    const v = getPath(data, field);
    if (v === undefined || v === null || v === '') issues.push({ field, problem: 'missing' });
  }
  if (data.coverage && !(data.coverage in config.pricing.base)) {
    issues.push({ field: 'coverage', problem: 'invalid' });
  }
  return issues;
}

function scoreRisk(data, config) {
  const hits = config.risk.factors.filter((f) => evalCondition(f.when, data));
  const score = hits.reduce((sum, f) => sum + f.points, 0);
  const band = config.risk.bands.find((b) => score <= b.maxScore).band;
  return { score, band, hits };
}

/**
 * Demo heuristic: confidence is capped by document extraction quality and by
 * how close the score is to the referral threshold. Replace per insurer.
 */
function estimateConfidence(data, score, config) {
  const docConf = typeof data.documentConfidence === 'number' ? data.documentConfidence : 1;
  const margin = clamp(Math.abs(config.risk.referAt - score) / 10, 0.5, 1);
  return Math.round(Math.min(docConf, margin) * 100) / 100;
}

function computePremium(data, config, band) {
  const p = config.pricing;
  const breakdown = [];
  let total = 0;
  const add = (entry) => {
    breakdown.push(entry);
    total += entry.amount;
  };

  add({ step: 'base', label: `Base premium (${data.coverage})`, amount: p.base[data.coverage] });

  const rate = p.valueRate && p.valueRate[data.coverage];
  if (rate) {
    add({ step: 'value', label: `Vehicle value x ${rate * 100}%`, amount: round(rate * data.vehicle.value) });
  }

  const subtotalAfter = (factor) => round(total * factor) - total;

  for (const m of p.multipliers || []) {
    if (!evalCondition(m.when, data)) continue;
    add({ step: 'multiplier', id: m.id, label: m.label, factor: m.factor, amount: subtotalAfter(m.factor) });
  }

  const loading = (p.bandLoading && p.bandLoading[band]) || 1;
  if (loading !== 1) {
    add({ step: 'risk_loading', label: `Risk band loading (${band})`, factor: loading, amount: subtotalAfter(loading) });
  }

  if (p.policyFee) add({ step: 'fee', label: 'Policy fee', amount: p.policyFee });

  return { total, currency: config.currency, breakdown };
}

// ---------- Main entry ----------

function evaluateCase(data, config) {
  const base = {
    tenantId: config.tenantId,
    line: config.line,
    configVersion: config.version,
    currency: config.currency,
  };

  const issues = checkInput(data, config);
  if (issues.length) {
    return { ...base, status: 'needs_info', issues, reasons: [], premium: null, riskScore: null, riskBand: null, confidence: null };
  }

  const reasons = [];
  const refuse = [];
  const refer = [];
  const flag = (list, reason) => {
    reasons.push(reason);
    list.push(reason);
  };

  // 1. Hard eligibility rules
  for (const rule of config.eligibility) {
    if (!evalCondition(rule.when, data)) continue;
    flag(rule.outcome === 'refuse' ? refuse : refer, {
      code: rule.id, type: 'eligibility', outcome: rule.outcome, message: rule.message,
    });
  }

  // 2. Risk scoring
  const { score, band, hits } = scoreRisk(data, config);
  for (const h of hits) reasons.push({ code: h.id, type: 'risk', points: h.points, message: h.label });

  if (score >= config.risk.refuseAt) {
    flag(refuse, { code: 'SCORE_REFUSE', type: 'risk', outcome: 'refuse', message: `Risk score ${score} is at or above the refusal threshold (${config.risk.refuseAt}).` });
  } else if (score >= config.risk.referAt) {
    flag(refer, { code: 'SCORE_REFER', type: 'risk', outcome: 'refer', message: `Risk score ${score} is at or above the referral threshold (${config.risk.referAt}).` });
  }

  // 3. Escalation rules
  const esc = config.escalation;
  if (data.vehicle.value > esc.maxAutoVehicleValue) {
    flag(refer, { code: 'VALUE_LIMIT', type: 'escalation', outcome: 'refer', message: `Vehicle value exceeds the automatic limit (${esc.maxAutoVehicleValue} ${config.currency}).` });
  }
  const confidence = estimateConfidence(data, score, config);
  if (confidence < esc.minConfidence) {
    flag(refer, { code: 'LOW_CONFIDENCE', type: 'escalation', outcome: 'refer', message: `Confidence ${confidence} is below the minimum (${esc.minConfidence}).` });
  }

  // 3b. Document cross-check flags (declared answers vs documents): a human must look
  for (const f of data.documentFlags || []) {
    flag(refer, { code: f.code, type: 'document', outcome: 'refer', message: f.message });
  }

  // 4. Decision (the engine only RECOMMENDS; humans approve what is referred)
  let status = 'accept';
  if (refuse.length) status = 'refuse';
  else if (refer.length) status = 'refer';

  const premium = status === 'refuse' ? null : computePremium(data, config, band);

  return { ...base, status, riskScore: score, riskBand: band, confidence, premium, reasons, issues: [] };
}

module.exports = { evaluateCase, evalCondition, checkInput, scoreRisk, computePremium, getPath };
