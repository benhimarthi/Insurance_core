'use strict';

const { AppError } = require('../../../../shared/errors');
const { normalizeName, isValidName, isValidStatus, prefixFromId, tenantSummary } = require('../../domain/tenant');
const { normalizeRuleConfig } = require('../../domain/ruleConfig');
const { adminEvent } = require('../../domain/adminEvent');
const { requireTenantId, requireNote, assertValidConfig, tenantNotFound } = require('./common');

/**
 * Insurer lifecycle: create, rename, demo flag, suspend/reactivate, web chat key.
 * Needs `tenants:manage` (platform team only). Reading an insurer needs `config:read`.
 */
function makeTenantUseCases({ authorizer, store, keys, clock, configTemplate }) {
  async function getTenant({ caller, tenantId, reason }) {
    requireTenantId(tenantId);
    await authorizer.authorize({ caller, tenantId, permission: 'config:read', reason });
    const t = await store.getTenant(tenantId);
    if (!t) throw tenantNotFound();
    const rules = await store.getRuleConfig(tenantId, 'motor');
    return {
      tenant: tenantSummary(tenantId, t),
      rules: rules ? { line: 'motor', ...rules } : { line: 'motor', config: null, revision: 0, updatedAt: null, updatedBy: null, updatedByEmail: null },
    };
  }

  /** Starting rules for a new insurer: the template, with its name and its own policy prefix. */
  function startingConfig(tenantId, name) {
    if (!configTemplate) throw new AppError('invalid-argument', 'CONFIG_REQUIRED');
    const c = JSON.parse(JSON.stringify(configTemplate));
    for (const k of Object.keys(c)) if (k.startsWith('_')) delete c[k]; // the template's notes are about the template
    c.branding = { ...(c.branding || {}), insurerName: name };
    c.policy = { ...(c.policy || {}), numberPrefix: prefixFromId(tenantId) };
    return c;
  }

  /** Returns the web chat key ONCE (real insurers only; demo tenants accept keyless web chat). */
  async function createTenant({ caller, tenantId, name, demo = false, config, reason }) {
    requireTenantId(tenantId);
    const note = requireNote(reason);
    const display = normalizeName(name);
    if (!isValidName(display)) throw new AppError('invalid-argument', 'Invalid name.');
    if (typeof demo !== 'boolean') throw new AppError('invalid-argument', 'demo must be true or false.');
    const ctx = await authorizer.authorize({ caller, tenantId, permission: 'tenants:manage', reason: note });

    const rules = normalizeRuleConfig(config === undefined ? startingConfig(tenantId, display) : config, { tenantId, line: 'motor' });
    assertValidConfig(rules, 'motor');
    const webchatKey = demo ? null : keys.newWebchatKey();

    await store.transaction(async (uow) => {
      if (await uow.getTenant(tenantId)) throw new AppError('already-exists', 'TENANT_EXISTS');
      const at = clock.now().toISOString();
      uow.saveTenant(tenantId, { name: display, status: 'active', demo, createdAt: at, createdBy: ctx.uid, updatedAt: at, updatedBy: ctx.uid });
      uow.saveRuleConfig(tenantId, 'motor', { config: rules, revision: 1, savedAt: at, savedBy: ctx.uid, savedByEmail: ctx.email, role: ctx.role, note });
      if (webchatKey) uow.saveWebchatKey(tenantId, webchatKey);
      uow.recordEvent(tenantId, adminEvent({ type: 'tenant_created', actor: { ...ctx, reason: note }, details: { name: display, demo }, at }));
    });
    return { tenantId, revision: 1, webchatKey };
  }

  /** Shared shape of the platform changes to an existing insurer. */
  async function change({ caller, tenantId, reason, type, apply }) {
    requireTenantId(tenantId);
    const note = requireNote(reason);
    const ctx = await authorizer.authorize({ caller, tenantId, permission: 'tenants:manage', reason: note });
    return store.transaction(async (uow) => {
      const current = await uow.getTenant(tenantId);
      if (!current) throw tenantNotFound();
      const at = clock.now().toISOString();
      const patch = apply(current);
      const next = { ...current, ...patch, updatedAt: at, updatedBy: ctx.uid };
      uow.saveTenant(tenantId, next);
      const before = Object.fromEntries(Object.keys(patch).map((k) => [k, current[k] === undefined ? null : current[k]]));
      uow.recordEvent(tenantId, adminEvent({ type, actor: { ...ctx, reason: note }, details: { before, after: patch }, at }));
      return { tenant: tenantSummary(tenantId, next) };
    });
  }

  async function updateTenant({ caller, tenantId, name, demo, reason }) {
    const patch = {};
    if (name !== undefined) {
      patch.name = normalizeName(name);
      if (!isValidName(patch.name)) throw new AppError('invalid-argument', 'Invalid name.');
    }
    if (demo !== undefined) {
      if (typeof demo !== 'boolean') throw new AppError('invalid-argument', 'demo must be true or false.');
      patch.demo = demo;
    }
    if (Object.keys(patch).length === 0) throw new AppError('invalid-argument', 'Nothing to change.');
    return change({ caller, tenantId, reason, type: 'tenant_updated', apply: () => patch });
  }

  async function setTenantStatus({ caller, tenantId, status, reason }) {
    if (!isValidStatus(status)) throw new AppError('invalid-argument', 'status must be active or suspended.');
    return change({ caller, tenantId, reason, type: status === 'suspended' ? 'tenant_suspended' : 'tenant_reactivated', apply: () => ({ status }) });
  }

  /** New web chat key, returned ONCE; the old one stops working (within the 60 s config cache). */
  async function rotateWebchatKey({ caller, tenantId, reason }) {
    requireTenantId(tenantId);
    const note = requireNote(reason);
    const ctx = await authorizer.authorize({ caller, tenantId, permission: 'tenants:manage', reason: note });
    const webchatKey = keys.newWebchatKey();
    await store.transaction(async (uow) => {
      if (!(await uow.getTenant(tenantId))) throw tenantNotFound();
      const at = clock.now().toISOString();
      uow.saveWebchatKey(tenantId, webchatKey);
      uow.recordEvent(tenantId, adminEvent({ type: 'webchat_key_rotated', actor: { ...ctx, reason: note }, details: {}, at }));
    });
    return { webchatKey };
  }

  return { getTenant, createTenant, updateTenant, setTenantStatus, rotateWebchatKey };
}

module.exports = { makeTenantUseCases };
