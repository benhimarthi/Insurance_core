'use strict';

const { AppError } = require('../../../shared/errors');

/**
 * The `tenants` callable: one endpoint, { action, tenantId, ... }.
 *   get, getRules, checkRules, listVersions, getVersion        (config:read)
 *   updateRules, restoreVersion                                 (config:write, with a reason)
 *   create, update, setStatus, rotateWebchatKey                 (tenants:manage, platform team, with a reason)
 */
function createTenantsController(api) {
  const actions = {
    get: ({ c }) => api.getTenant(c),
    getRules: ({ c, d }) => api.getRuleConfig({ ...c, line: d.line }),
    checkRules: ({ c, d }) => api.checkRuleConfig({ ...c, line: d.line, config: d.config }),
    listVersions: ({ c, d }) => api.listRuleVersions({ ...c, line: d.line }),
    getVersion: ({ c, d }) => api.getRuleVersion({ ...c, line: d.line, revision: d.revision }),
    updateRules: ({ c, d }) => api.updateRuleConfig({ ...c, line: d.line, config: d.config, expectedRevision: d.expectedRevision }),
    restoreVersion: ({ c, d }) => api.restoreRuleVersion({ ...c, line: d.line, revision: d.revision, expectedRevision: d.expectedRevision }),
    create: ({ c, d }) => api.createTenant({ ...c, name: d.name, demo: d.demo, config: d.config }),
    update: ({ c, d }) => api.updateTenant({ ...c, name: d.name, demo: d.demo }),
    setStatus: ({ c, d }) => api.setTenantStatus({ ...c, status: d.status }),
    rotateWebchatKey: ({ c }) => api.rotateWebchatKey(c),
  };

  return async function handle({ auth, data }) {
    const d = data || {};
    const action = Object.prototype.hasOwnProperty.call(actions, d.action) ? actions[d.action] : null;
    if (!action) throw new AppError('invalid-argument', 'Unknown action.');
    return action({ d, c: { auth, tenantId: d.tenantId, reason: d.reason } });
  };
}

module.exports = { createTenantsController };
