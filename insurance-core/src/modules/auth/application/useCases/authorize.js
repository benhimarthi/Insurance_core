'use strict';

const { AppError } = require('../../../../shared/errors');
const { TENANT_ID_RE } = require('../../../../shared/ids');
const { ROLES } = require('../../domain/roles');
const { resolveAccess, requireVerifiedEmail } = require('../../domain/accessPolicy');

const requireIdentity = (identity) => {
  if (!identity || !identity.uid) throw new AppError('unauthenticated', 'Sign in first.');
};

const requireTenantId = (tenantId) => {
  if (!TENANT_ID_RE.test(tenantId || '')) throw new AppError('invalid-argument', 'Invalid tenant.');
};

/**
 * Authorize: may this identity use `permission` at this insurer? Reads the membership live,
 * so a revoked or disabled member loses access on their very next call.
 * @returns {Promise<{uid, email, role, source, tenantId, permissions, reason}>} the access context
 */
function makeAuthorize({ store, requireMfa }) {
  return async function authorize({ identity, tenantId, permission, reason }) {
    requireIdentity(identity);
    requireTenantId(tenantId);
    requireVerifiedEmail(identity); // before any read: no probing with unverified accounts
    const member = await store.getMember(tenantId, identity.uid);
    const access = resolveAccess({ identity, member, permission, reason, requireMfa });
    return {
      uid: identity.uid, email: identity.email, role: access.role, source: access.source, tenantId,
      permissions: ROLES[access.role].permissions, reason: access.reason,
    };
  };
}

module.exports = { makeAuthorize, requireIdentity, requireTenantId };
