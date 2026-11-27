'use strict';

/**
 * The condition grammar of the rules engine (src/rules/engine.js), checked before a config is saved:
 *   { field: "driver.age", op: "lt", value: 25 }
 *   { all: [cond, ...] } | { any: [cond, ...] } | { not: cond }
 * Keep OPERATORS in sync with OPS in the engine.
 */

const OPERATORS = Object.freeze(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin']);
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const MAX_DEPTH = 8;
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Pushes { path, message } for every problem in `cond` into `errors`. */
function checkCondition(cond, path, errors, depth = 0) {
  if (depth > MAX_DEPTH) { errors.push({ path, message: `nested more than ${MAX_DEPTH} levels` }); return; }
  if (!isPlainObject(cond)) { errors.push({ path, message: 'must be a condition object' }); return; }
  for (const group of ['all', 'any']) {
    if (group in cond) {
      if (!Array.isArray(cond[group]) || cond[group].length === 0) errors.push({ path: `${path}.${group}`, message: 'must be a non-empty list of conditions' });
      else cond[group].forEach((c, i) => checkCondition(c, `${path}.${group}[${i}]`, errors, depth + 1));
      return;
    }
  }
  if ('not' in cond) { checkCondition(cond.not, `${path}.not`, errors, depth + 1); return; }
  if (typeof cond.field !== 'string' || !FIELD_RE.test(cond.field)) errors.push({ path: `${path}.field`, message: 'must be a field path like "driver.age"' });
  if (!OPERATORS.includes(cond.op)) errors.push({ path: `${path}.op`, message: `must be one of ${OPERATORS.join(', ')}` });
  if (!('value' in cond)) errors.push({ path: `${path}.value`, message: 'is required' });
  else if ((cond.op === 'in' || cond.op === 'nin') && !Array.isArray(cond.value)) errors.push({ path: `${path}.value`, message: `must be a list for "${cond.op}"` });
}

module.exports = { OPERATORS, checkCondition };
