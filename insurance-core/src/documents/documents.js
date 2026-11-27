'use strict';

const { nlu: { tokenize } } = require('../modules/conversation');

/**
 * Document verification, independent of the OCR/vision provider.
 *
 * Pipeline:  processor.process(attachment)  ->  acceptDocument()  ->  crossCheck()
 *   1. A processor (mock or LLM vision) returns { type, fields, confidence }.
 *   2. acceptDocument validates it: right type, readable, valid dates, not expired.
 *      Failures are customer-fixable ("resubmit").
 *   3. Once all required documents are accepted, crossCheck compares them with what the
 *      customer declared and with each other. Mismatches are NOT rejected: they become
 *      flags that force a human review (a driver can legitimately differ from the owner).
 *
 * Data minimisation: only the fields below are extracted, and audit events never contain values.
 */

const L = (fr, en, darija) => ({ fr, en, darija });

const DOCUMENT_TYPES = {
  national_id: {
    label: L('Carte nationale d’identité', 'National ID card', 'البطاقة الوطنية'),
    fields: { fullName: { type: 'string' }, birthDate: { type: 'date' }, expiryDate: { type: 'date' } },
  },
  vehicle_registration: {
    label: L('Carte grise', 'Vehicle registration', 'البطاقة الرمادية'),
    fields: {
      ownerName: { type: 'string' },
      plate: { type: 'string' },
      firstRegistrationDate: { type: 'date' },
      make: { type: 'string', optional: true },
      model: { type: 'string', optional: true },
    },
  },
};

const labelOf = (type, lang) => {
  const spec = DOCUMENT_TYPES[type];
  return spec ? spec.label[lang] || spec.label.fr : type;
};

const requiredTypes = (config) => (config.documents && config.documents.required) || [];
const missingTypes = (caseDoc, config) => requiredTypes(config).filter((t) => !(caseDoc.documents && caseDoc.documents[t]));

// ---------- dates ----------

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Full years elapsed between two dates. */
function yearsBetween(from, to) {
  let years = to.getUTCFullYear() - from.getUTCFullYear();
  const months = to.getUTCMonth() - from.getUTCMonth();
  if (months < 0 || (months === 0 && to.getUTCDate() < from.getUTCDate())) years -= 1;
  return years;
}

// ---------- normalization and acceptance ----------

function normalizeFields(type, raw) {
  const spec = DOCUMENT_TYPES[type].fields;
  const fields = {};
  const invalid = [];
  for (const [name, def] of Object.entries(spec)) {
    const value = raw ? raw[name] : undefined;
    if (value === undefined || value === null || value === '') {
      if (!def.optional) invalid.push(name);
      continue;
    }
    if (def.type === 'date') {
      if (parseDate(value)) fields[name] = value;
      else invalid.push(name);
    } else if (typeof value === 'string' && value.trim().length > 0 && value.length <= 80) {
      fields[name] = value.trim();
    } else {
      invalid.push(name);
    }
  }
  return { fields, invalid };
}

/**
 * Validates one processor result.
 * Returns { ok: true, type, fields, confidence } or { ok: false, type, issue, confidence }
 * with issue in WRONG_TYPE | ILLEGIBLE | EXPIRED (all customer-fixable).
 */
function acceptDocument(extracted, config, now) {
  const cfg = config.documents;
  const type = extracted && extracted.type;
  const confidence = Math.min(1, Math.max(0, Number(extracted && extracted.confidence) || 0));
  const fail = (issue) => ({ ok: false, type: type || 'unknown', issue, confidence });

  if (!DOCUMENT_TYPES[type] || !requiredTypes(config).includes(type)) return fail('WRONG_TYPE');
  if (confidence < (cfg.resubmitBelow ?? 0.5)) return fail('ILLEGIBLE');

  const { fields, invalid } = normalizeFields(type, extracted.fields);
  if (invalid.length) return fail('ILLEGIBLE');

  if (type === 'national_id') {
    if (parseDate(fields.birthDate) >= now) return fail('ILLEGIBLE');
    if (parseDate(fields.expiryDate) <= now) return fail('EXPIRED');
  }
  if (type === 'vehicle_registration' && parseDate(fields.firstRegistrationDate) > now) return fail('ILLEGIBLE');

  return { ok: true, type, fields, confidence };
}

// ---------- cross-checks (flags for the underwriter, never rejections) ----------

/** Order-insensitive name similarity in [0, 1] ("BENALI Amine" vs "Amine Benali" = 1). */
function nameSimilarity(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / new Set([...ta, ...tb]).size;
}

function crossCheck(input, docs, config, now) {
  const cfg = config.documents;
  const flags = [];
  const id = docs.national_id;
  const reg = docs.vehicle_registration;

  if (id) {
    const age = yearsBetween(parseDate(id.fields.birthDate), now);
    if (Math.abs(age - input.driver.age) > (cfg.ageTolerance ?? 1)) {
      flags.push({ code: 'AGE_MISMATCH', message: `Declared age (${input.driver.age}) differs from the age on the ID document (${age}).` });
    }
  }
  if (reg) {
    const vehicleAge = yearsBetween(parseDate(reg.fields.firstRegistrationDate), now);
    if (Math.abs(vehicleAge - input.vehicle.ageYears) > (cfg.vehicleAgeTolerance ?? 1)) {
      flags.push({ code: 'VEHICLE_AGE_MISMATCH', message: `Declared vehicle age (${input.vehicle.ageYears}) differs from the registration document (${vehicleAge}).` });
    }
  }
  if (id && reg && nameSimilarity(id.fields.fullName, reg.fields.ownerName) < (cfg.nameSimilarityMin ?? 0.5)) {
    flags.push({ code: 'OWNER_MISMATCH', message: 'The registered owner differs from the person on the ID document.' });
  }
  return flags;
}

module.exports = {
  DOCUMENT_TYPES, labelOf, requiredTypes, missingTypes,
  parseDate, yearsBetween, nameSimilarity, acceptDocument, crossCheck,
};
