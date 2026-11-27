'use strict';

const { AppError } = require('../../../../shared/errors');
const { TENANT_ID_RE } = require('../../../../shared/ids');
const { isTenantRole } = require('../../domain/roles');
const { normalizeEmail, isValidUid, nextMember } = require('../../domain/member');
const { auditEvent } = require('../../domain/auditEvent');

/** Creates a member directly: for the first admin of an insurer (scripts) and tests. Never exposed over HTTP. */
function makeBootstrapMember({ store, clock }) {
  return async function bootstrapMember({ tenantId, uid, email, role }) {
    if (!TENANT_ID_RE.test(tenantId || '') || !isValidUid(uid) || !isTenantRole(role)) throw new AppError('invalid-argument', 'Invalid arguments.');
    const actor = { uid: 'bootstrap', role: null, source: 'bootstrap' };
    const address = normalizeEmail(email) || undefined;
    await store.transaction(async (uow) => {
      const before = await uow.getMember(tenantId, uid);
      const at = clock.now().toISOString();
      uow.saveMember(tenantId, { ...nextMember({ before, uid, email: address, role, status: 'active', nowIso: at, actorUid: 'bootstrap', createdBy: 'bootstrap' }), createdBy: 'bootstrap' });
      uow.recordEvent(tenantId, auditEvent({ type: before ? 'role_changed' : 'member_added', actor, target: { uid, email: address }, details: { after: { role, status: 'active' } }, at }));
    });
  };
}

module.exports = { makeBootstrapMember };
