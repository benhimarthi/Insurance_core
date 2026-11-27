import { errorText, normalizeError } from 'insurance-dashboard-auth';
import { texts } from './texts.js';

/**
 * Client of the `tenants` callable. Platform staff acting on an insurer must give a reason for every
 * call, reads included: it is asked once per insurer per page load (writes carry their own note).
 */
export function createTenantsApi({ call, askReason, getContext }) {
  const sessionReasons = new Map();

  async function withReason(tenantId, payload) {
    if (payload.reason) return payload;
    const ctx = getContext();
    if (!(ctx && ctx.tenantId === tenantId && ctx.access === 'platform')) return payload;
    if (!sessionReasons.has(tenantId)) {
      const reason = await askReason('tenants');
      if (typeof reason !== 'string' || reason.trim().length < 5) throw Object.assign(new Error('REASON_CANCELLED'), { code: 'cancelled' });
      sessionReasons.set(tenantId, reason.trim());
    }
    return { ...payload, reason: sessionReasons.get(tenantId) };
  }

  const tenants = async (tenantId, payload) => call('tenants', await withReason(tenantId, { tenantId, ...payload }));

  return {
    get: (tenantId) => tenants(tenantId, { action: 'get' }),
    checkRules: (tenantId, config) => tenants(tenantId, { action: 'checkRules', config }),
    updateRules: (tenantId, { config, expectedRevision, reason }) => tenants(tenantId, { action: 'updateRules', config, expectedRevision, reason }),
    listVersions: (tenantId) => tenants(tenantId, { action: 'listVersions' }),
    getVersion: (tenantId, revision) => tenants(tenantId, { action: 'getVersion', revision }),
    restoreVersion: (tenantId, { revision, expectedRevision, reason }) => tenants(tenantId, { action: 'restoreVersion', revision, expectedRevision, reason }),
    // platform team
    create: ({ tenantId, name, demo, reason }) => call('tenants', { action: 'create', tenantId, name, demo, reason }),
    update: (tenantId, { name, demo, reason }) => call('tenants', { action: 'update', tenantId, name, demo, reason }),
    setStatus: (tenantId, { status, reason }) => call('tenants', { action: 'setStatus', tenantId, status, reason }),
    rotateWebchatKey: (tenantId, { reason }) => call('tenants', { action: 'rotateWebchatKey', tenantId, reason }),
  };
}

/** Stable reason of a callable error: CONFIG_INVALID, CONFIG_CHANGED, FORBIDDEN... */
export const reasonOf = (err) => (err && typeof err.message === 'string' ? err.message : '');

/** A message for any error of these pages: our own reasons first, then the dashboard's table. */
export function messageOf(err, lang) {
  const own = texts(lang).errors[reasonOf(err)];
  return own || errorText(normalizeError(err, lang), lang);
}
