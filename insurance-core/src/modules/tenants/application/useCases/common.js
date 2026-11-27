'use strict';

const { AppError } = require('../../../../shared/errors');
const { TENANT_ID_RE } = require('../../../../shared/ids');
const { SUPPORTED_LINES, validateRuleConfig } = require('../../domain/ruleConfig');

const MIN_NOTE = 5;

const requireTenantId = (tenantId) => {
  if (!TENANT_ID_RE.test(tenantId || '')) throw new AppError('invalid-argument', 'Invalid tenant.');
};
const requireLine = (line) => {
  if (!SUPPORTED_LINES.includes(line)) throw new AppError('invalid-argument', 'UNSUPPORTED_LINE');
};
/** Every change to an insurer or its rules says why: the note lands in the version history and the audit trail. */
const requireNote = (reason) => {
  if (!(typeof reason === 'string' && reason.trim().length >= MIN_NOTE)) throw new AppError('invalid-argument', 'REASON_REQUIRED');
  return reason.trim().slice(0, 500);
};
const assertValidConfig = (config, line) => {
  const result = validateRuleConfig(config, { line });
  if (!result.ok) throw new AppError('invalid-argument', 'CONFIG_INVALID', { errors: result.errors.slice(0, 100) });
};
const tenantNotFound = () => new AppError('not-found', 'TENANT_NOT_FOUND');

module.exports = { requireTenantId, requireLine, requireNote, assertValidConfig, tenantNotFound };
