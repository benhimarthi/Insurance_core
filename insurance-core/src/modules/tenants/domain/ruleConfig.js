'use strict';

const { checkCondition } = require('./conditions');

/**
 * Rules config of one insurance line (today: motor). This is everything that makes one insurer
 * different from another: questions, eligibility, risk, tariff, documents, policy, payment, branding.
 *
 * validateRuleConfig() is strict on purpose: a broken config must never reach customers. It checks
 * what the code actually reads (rules engine, questions, documents, policy, payment, PDF). Keys
 * starting with "_" are free-form notes and are ignored.
 */

const SUPPORTED_LINES = Object.freeze(['motor']);
const MAX_CONFIG_BYTES = 200 * 1024; // a Firestore document holds 1 MiB; versions store a copy
const NUMBER_PREFIX_RE = /^[A-Z0-9]{1,12}$/; // part of policy numbers and counter document ids
const ID_RE = /^[A-Z0-9_]{1,40}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const DOCUMENT_TYPES = Object.freeze(['national_id', 'vehicle_registration']); // keep in sync with src/documents/documents.js

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

function validateRuleConfig(config, { line = 'motor' } = {}) {
  const errors = [];
  const err = (path, message) => errors.push({ path, message });
  if (!isPlainObject(config)) return { ok: false, errors: [{ path: '', message: 'the config must be a JSON object' }] };

  let size;
  try { size = Buffer.byteLength(JSON.stringify(config)); } catch { return { ok: false, errors: [{ path: '', message: 'the config is not serializable' }] }; }
  if (size > MAX_CONFIG_BYTES) err('', `too large (${Math.round(size / 1024)} KB, max ${MAX_CONFIG_BYTES / 1024} KB)`);
  checkFirestoreShape(config, '', errors, 0);

  // identity
  if (!SUPPORTED_LINES.includes(line)) err('line', `unsupported line "${line}"`);
  if ('line' in config && config.line !== line) err('line', `must be "${line}"`);
  if (!isNonEmptyString(config.version)) err('version', 'is required (your label for this tariff, e.g. "2027.01")');
  if (typeof config.currency !== 'string' || !CURRENCY_RE.test(config.currency)) err('currency', 'must be a 3-letter currency code like "MAD"');

  // questions
  if (!Array.isArray(config.requiredFields) || config.requiredFields.length === 0) err('requiredFields', 'must be a non-empty list of field paths');
  else config.requiredFields.forEach((f, i) => { if (!isNonEmptyString(f)) err(`requiredFields[${i}]`, 'must be a field path'); });
  if ('zoneMap' in config) {
    if (!isPlainObject(config.zoneMap)) err('zoneMap', 'must map city names to zones');
    else for (const [k, v] of Object.entries(config.zoneMap)) if (!isNonEmptyString(v)) err(`zoneMap.${k}`, 'must be a zone name');
  }

  // eligibility
  if (!Array.isArray(config.eligibility)) err('eligibility', 'must be a list of rules (can be empty)');
  else checkRules(config.eligibility, 'eligibility', errors, (r, p) => {
    if (!['refuse', 'refer'].includes(r.outcome)) err(`${p}.outcome`, 'must be "refuse" or "refer"');
    if (!isNonEmptyString(r.message)) err(`${p}.message`, 'is required');
  });

  // risk
  const risk = config.risk;
  if (!isPlainObject(risk)) err('risk', 'is required');
  else {
    if (!Array.isArray(risk.factors)) err('risk.factors', 'must be a list (can be empty)');
    else checkRules(risk.factors, 'risk.factors', errors, (f, p) => {
      if (!isNonEmptyString(f.label)) err(`${p}.label`, 'is required');
      if (!isNum(f.points)) err(`${p}.points`, 'must be a number');
    });
    if (!Array.isArray(risk.bands) || risk.bands.length === 0) err('risk.bands', 'must be a non-empty list of { band, maxScore }');
    else {
      let prev = -Infinity;
      risk.bands.forEach((b, i) => {
        const p = `risk.bands[${i}]`;
        if (!isPlainObject(b)) { err(p, 'must be { band, maxScore }'); return; }
        if (!isNonEmptyString(b.band)) err(`${p}.band`, 'is required');
        if (!isNum(b.maxScore)) err(`${p}.maxScore`, 'must be a number');
        else if (b.maxScore <= prev) err(`${p}.maxScore`, 'bands must be in increasing maxScore order');
        else prev = b.maxScore;
      });
      // the engine picks the first band whose maxScore >= score: the last one must catch everything
      const last = risk.bands[risk.bands.length - 1];
      if (isPlainObject(last) && isNum(last.maxScore) && Array.isArray(risk.factors)) {
        const maxPossible = risk.factors.reduce((s, f) => s + (isNum(f && f.points) && f.points > 0 ? f.points : 0), 0);
        if (last.maxScore < maxPossible) err(`risk.bands[${risk.bands.length - 1}].maxScore`, `must be at least ${maxPossible} (the highest possible score), or high scores have no band`);
      }
    }
    if (!isNum(risk.referAt)) err('risk.referAt', 'must be a number');
    if (!isNum(risk.refuseAt)) err('risk.refuseAt', 'must be a number');
    if (isNum(risk.referAt) && isNum(risk.refuseAt) && risk.referAt > risk.refuseAt) err('risk.referAt', 'must not be above risk.refuseAt');
  }

  // pricing
  const pricing = config.pricing;
  const coverages = isPlainObject(pricing) && isPlainObject(pricing.base) ? Object.keys(pricing.base) : [];
  if (!isPlainObject(pricing)) err('pricing', 'is required');
  else {
    if (!isPlainObject(pricing.base) || coverages.length === 0) err('pricing.base', 'must give a base premium per coverage, e.g. { "tiers": 1200 }');
    else for (const [k, v] of Object.entries(pricing.base)) if (!isNum(v) || v < 0) err(`pricing.base.${k}`, 'must be a positive amount');
    if ('valueRate' in pricing) {
      if (!isPlainObject(pricing.valueRate)) err('pricing.valueRate', 'must map coverages to a rate');
      else for (const [k, v] of Object.entries(pricing.valueRate)) {
        if (!coverages.includes(k)) err(`pricing.valueRate.${k}`, 'is not a coverage of pricing.base');
        if (!isNum(v) || v < 0 || v > 1) err(`pricing.valueRate.${k}`, 'must be a rate between 0 and 1 (0.012 = 1.2%)');
      }
    }
    if ('multipliers' in pricing) {
      if (!Array.isArray(pricing.multipliers)) err('pricing.multipliers', 'must be a list');
      else checkRules(pricing.multipliers, 'pricing.multipliers', errors, (m, p) => {
        if (!isNonEmptyString(m.label)) err(`${p}.label`, 'is required');
        if (!isNum(m.factor) || m.factor <= 0 || m.factor > 10) err(`${p}.factor`, 'must be a number between 0 and 10 (1.1 = +10%)');
      });
    }
    if ('bandLoading' in pricing) {
      if (!isPlainObject(pricing.bandLoading)) err('pricing.bandLoading', 'must map risk bands to a factor');
      else {
        const bands = isPlainObject(risk) && Array.isArray(risk.bands) ? risk.bands.map((b) => b && b.band) : [];
        for (const [k, v] of Object.entries(pricing.bandLoading)) {
          if (!bands.includes(k)) err(`pricing.bandLoading.${k}`, 'is not a band of risk.bands');
          if (!isNum(v) || v <= 0 || v > 10) err(`pricing.bandLoading.${k}`, 'must be a factor between 0 and 10');
        }
      }
    }
    if ('policyFee' in pricing && (!isNum(pricing.policyFee) || pricing.policyFee < 0)) err('pricing.policyFee', 'must be a positive amount');
  }

  // documents
  const docs = config.documents;
  if (!isPlainObject(docs)) err('documents', 'is required');
  else {
    if (!Array.isArray(docs.required)) err('documents.required', 'must be a list of document types');
    else docs.required.forEach((d, i) => { if (!DOCUMENT_TYPES.includes(d)) err(`documents.required[${i}]`, `must be one of ${DOCUMENT_TYPES.join(', ')}`); });
    for (const k of ['resubmitBelow', 'nameSimilarityMin']) if (k in docs && (!isNum(docs[k]) || docs[k] < 0 || docs[k] > 1)) err(`documents.${k}`, 'must be between 0 and 1');
    for (const k of ['maxResubmits', 'ageTolerance', 'vehicleAgeTolerance']) if (k in docs && (!isInt(docs[k]) || docs[k] < 0 || docs[k] > 20)) err(`documents.${k}`, 'must be a whole number between 0 and 20');
  }

  // policy
  const policy = config.policy;
  if (!isPlainObject(policy)) err('policy', 'is required');
  else {
    if (typeof policy.numberPrefix !== 'string' || !NUMBER_PREFIX_RE.test(policy.numberPrefix)) err('policy.numberPrefix', 'must be 1 to 12 capital letters or digits');
    if ('durationMonths' in policy && (!isInt(policy.durationMonths) || policy.durationMonths < 1 || policy.durationMonths > 60)) err('policy.durationMonths', 'must be a whole number of months between 1 and 60');
    if ('startOffsetDays' in policy && (!isInt(policy.startOffsetDays) || policy.startOffsetDays < 0 || policy.startOffsetDays > 365)) err('policy.startOffsetDays', 'must be a whole number of days between 0 and 365');
  }

  // payment
  if ('payment' in config) {
    if (!isPlainObject(config.payment)) err('payment', 'must be an object');
    else if ('linkExpiryMinutes' in config.payment && (!isInt(config.payment.linkExpiryMinutes) || config.payment.linkExpiryMinutes < 5 || config.payment.linkExpiryMinutes > 43200)) err('payment.linkExpiryMinutes', 'must be between 5 and 43200 minutes (30 days)');
  }

  // branding and coverage wording (customer-facing)
  const branding = config.branding;
  if (!isPlainObject(branding)) err('branding', 'is required');
  else {
    if (!isNonEmptyString(branding.insurerName)) err('branding.insurerName', 'is required');
    if ('primaryColor' in branding && (typeof branding.primaryColor !== 'string' || !COLOR_RE.test(branding.primaryColor))) err('branding.primaryColor', 'must be a color like "#1F4E79"');
  }
  if ('coverageInfo' in config) {
    if (!isPlainObject(config.coverageInfo)) err('coverageInfo', 'must map coverages to their wording');
    else for (const k of Object.keys(config.coverageInfo)) if (!coverages.includes(k)) err(`coverageInfo.${k}`, 'is not a coverage of pricing.base');
  }

  // underwriting limits and escalation
  if ('authorization' in config) {
    const a = config.authorization;
    if (!isPlainObject(a)) err('authorization', 'must be an object');
    else if ('underwriterPremiumLimit' in a && (!isNum(a.underwriterPremiumLimit) || a.underwriterPremiumLimit <= 0)) err('authorization.underwriterPremiumLimit', 'must be a positive amount');
  }
  const esc = config.escalation;
  if (!isPlainObject(esc)) err('escalation', 'is required');
  else {
    if (!isNum(esc.maxAutoVehicleValue) || esc.maxAutoVehicleValue <= 0) err('escalation.maxAutoVehicleValue', 'must be a positive amount');
    if (!isNum(esc.minConfidence) || esc.minConfidence < 0 || esc.minConfidence > 1) err('escalation.minConfidence', 'must be between 0 and 1');
    if ('autoDecline' in esc && typeof esc.autoDecline !== 'boolean') err('escalation.autoDecline', 'must be true or false');
  }

  return { ok: errors.length === 0, errors };
}

/** A list of { id, when, ... } rules: unique ids, valid conditions, then the caller's own checks. */
function checkRules(list, base, errors, extra) {
  const seen = new Set();
  list.forEach((r, i) => {
    const p = `${base}[${i}]`;
    if (!isPlainObject(r)) { errors.push({ path: p, message: 'must be an object' }); return; }
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) errors.push({ path: `${p}.id`, message: 'must be an id like "YOUNG_DRIVER" (capitals, digits, _)' });
    else if (seen.has(r.id)) errors.push({ path: `${p}.id`, message: `duplicate id "${r.id}"` });
    else seen.add(r.id);
    checkCondition(r.when, `${p}.when`, errors);
    extra(r, p);
  });
}

/** Firestore limits: no arrays directly inside arrays, at most 20 levels deep. */
function checkFirestoreShape(v, path, errors, depth) {
  if (depth > 18) { errors.push({ path, message: 'nested too deeply' }); return; }
  if (Array.isArray(v)) v.forEach((x, i) => {
    if (Array.isArray(x)) errors.push({ path: `${path}[${i}]`, message: 'a list cannot directly contain another list' });
    else checkFirestoreShape(x, `${path}[${i}]`, errors, depth + 1);
  });
  else if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) checkFirestoreShape(x, path ? `${path}.${k}` : k, errors, depth + 1);
}

/** The config as stored: the platform owns tenantId and line, the rest is the insurer's. */
const normalizeRuleConfig = (config, { tenantId, line }) => ({ ...config, tenantId, line });

module.exports = { SUPPORTED_LINES, MAX_CONFIG_BYTES, validateRuleConfig, normalizeRuleConfig };
