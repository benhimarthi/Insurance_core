'use strict';

const { AppError } = require('../../../../shared/errors');
const { validateRuleConfig, normalizeRuleConfig } = require('../../domain/ruleConfig');
const { adminEvent } = require('../../domain/adminEvent');
const { requireTenantId, requireLine, requireNote, assertValidConfig, tenantNotFound } = require('./common');

const VERSIONS_LIMIT = 50;

/**
 * Reading, checking, changing and restoring an insurer's rules. Every change is a new numbered
 * revision (the live config, its counter, a copy in the history and an audit event are written
 * together), and is refused if someone else saved since the editor loaded it (CONFIG_CHANGED).
 */
function makeRuleConfigUseCases({ authorizer, store, clock }) {
  // platform staff give a reason for every action at an insurer, reads included (auth module rule)
  async function read({ caller, tenantId, line = 'motor', reason }) {
    requireTenantId(tenantId);
    requireLine(line);
    return authorizer.authorize({ caller, tenantId, permission: 'config:read', reason });
  }

  async function getRuleConfig({ caller, tenantId, line = 'motor', reason }) {
    await read({ caller, tenantId, line, reason });
    const current = await store.getRuleConfig(tenantId, line);
    return current ? { line, ...current } : { line, config: null, revision: 0, updatedAt: null, updatedBy: null, updatedByEmail: null };
  }

  /** Dry run for the editor: same checks as a save, nothing written. */
  async function checkRuleConfig({ caller, tenantId, line = 'motor', config, reason }) {
    await read({ caller, tenantId, line, reason });
    return validateRuleConfig(config, { line });
  }

  async function listRuleVersions({ caller, tenantId, line = 'motor', reason }) {
    await read({ caller, tenantId, line, reason });
    return { line, versions: await store.listRuleVersions(tenantId, line, VERSIONS_LIMIT) };
  }

  async function getRuleVersion({ caller, tenantId, line = 'motor', revision, reason }) {
    await read({ caller, tenantId, line, reason });
    if (!Number.isInteger(revision) || revision < 1) throw new AppError('invalid-argument', 'Invalid revision.');
    const v = await store.getRuleVersion(tenantId, line, revision);
    if (!v) throw new AppError('not-found', 'VERSION_NOT_FOUND');
    return v;
  }

  /** Saves `config` as the next revision. `expectedRevision` is the revision the editor started from. */
  async function save({ caller, tenantId, line, config, expectedRevision, reason, restoredFrom, type }) {
    requireTenantId(tenantId);
    requireLine(line);
    const note = requireNote(reason);
    const ctx = await authorizer.authorize({ caller, tenantId, permission: 'config:write', reason: note });
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new AppError('invalid-argument', 'Invalid expectedRevision.');
    const stored = normalizeRuleConfig(config, { tenantId, line });
    assertValidConfig(stored, line);

    return store.transaction(async (uow) => {
      const [tenant, meta] = await Promise.all([uow.getTenant(tenantId), uow.getRuleMeta(tenantId, line)]);
      if (!tenant) throw tenantNotFound();
      const current = meta ? meta.revision : 0;
      if (current !== expectedRevision) throw new AppError('failed-precondition', 'CONFIG_CHANGED', { currentRevision: current });
      const revision = current + 1;
      const at = clock.now().toISOString();
      uow.saveRuleConfig(tenantId, line, { config: stored, revision, savedAt: at, savedBy: ctx.uid, savedByEmail: ctx.email, role: ctx.role, note, restoredFrom });
      uow.recordEvent(tenantId, adminEvent({ type, actor: { ...ctx, reason: note }, details: { line, revision, previousRevision: current, restoredFrom }, at }));
      return { line, revision, savedAt: at };
    });
  }

  const updateRuleConfig = ({ caller, tenantId, line = 'motor', config, expectedRevision, reason }) => save({
    caller, tenantId, line, config, expectedRevision, reason, type: 'config_updated',
  });

  /** Puts an older revision back, as a new revision (history is never rewritten). Re-validated first. */
  async function restoreRuleVersion({ caller, tenantId, line = 'motor', revision, expectedRevision, reason }) {
    const old = await getRuleVersion({ caller, tenantId, line, revision, reason });
    return save({ caller, tenantId, line, config: old.config, expectedRevision, reason, restoredFrom: revision, type: 'config_restored' });
  }

  return { getRuleConfig, checkRuleConfig, listRuleVersions, getRuleVersion, updateRuleConfig, restoreRuleVersion };
}

module.exports = { makeRuleConfigUseCases };
