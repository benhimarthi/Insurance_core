'use strict';

/**
 * Tenants module: the insurers on the platform and their rules.
 *   - insurer lifecycle: create, rename, demo flag, suspend/reactivate, web chat key (platform team)
 *   - rules (the JSON config of each line): read, check, change with a reason, version history, restore
 *   - the tenant loader the chat, payment and policy code use to get an insurer and its rules
 * This file is the composition root and the only public entry point.
 *
 * Layers: domain/ (tenant, rules validator, condition grammar), application/ (use cases + ports),
 * infrastructure/ (Firestore store, loader, keys), interface/ (the `tenants` callable).
 */

const { makeRuleConfigUseCases } = require('./application/useCases/ruleConfig');
const { makeTenantUseCases } = require('./application/useCases/tenants');
const { createFirestoreTenantStore } = require('./infrastructure/firestoreTenantStore');
const { createCryptoKeyService } = require('./infrastructure/cryptoKeyService');
const { createTenantLoader } = require('./infrastructure/tenantLoader');
const { createTenantsController } = require('./interface/tenantsController');
const { validateRuleConfig, SUPPORTED_LINES } = require('./domain/ruleConfig');
const { TENANT_STATUSES } = require('./domain/tenant');

/**
 * @param authorize  ({ caller, tenantId, permission, reason }) => access context; from the auth module,
 *                   wired by the app: ({ caller, ...rest }) => authModule.authorize({ auth: caller, ...rest })
 * @param configTemplate  starting rules for a new insurer (a valid config; its tenant-specific fields are replaced)
 *
 * Every method takes the raw Firebase `auth` ({ uid, token }) as callables receive it.
 */
function createTenantsModule({
  db, authorize, configTemplate = null, now = () => new Date(),
  store = createFirestoreTenantStore(db),
  keys = createCryptoKeyService(),
} = {}) {
  if (typeof authorize !== 'function') throw new Error('createTenantsModule needs an authorize function (from the auth module).');
  const deps = { authorizer: { authorize }, store, keys, clock: { now }, configTemplate };
  const useCases = { ...makeTenantUseCases(deps), ...makeRuleConfigUseCases(deps) };

  const api = {};
  for (const [name, useCase] of Object.entries(useCases)) {
    api[name] = ({ auth, ...rest } = {}) => useCase({ caller: auth, ...rest });
  }
  api.handle = createTenantsController(api);
  return api;
}

module.exports = { createTenantsModule, createTenantLoader, validateRuleConfig, SUPPORTED_LINES, TENANT_STATUSES };
