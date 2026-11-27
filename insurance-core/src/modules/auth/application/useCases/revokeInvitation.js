'use strict';

const { AppError } = require('../../../../shared/errors');
const { ID_RE } = require('../../../../shared/ids');
const { auditEvent } = require('../../domain/auditEvent');

function makeRevokeInvitation({ authorize, store, clock }) {
  return async function revokeInvitation({ identity, tenantId, invitationId, reason }) {
    const ctx = await authorize({ identity, tenantId, permission: 'members:manage', reason });
    if (!ID_RE.test(invitationId || '')) throw new AppError('invalid-argument', 'Invalid invitation.');
    await store.transaction(async (uow) => {
      const inv = await uow.getInvitation(tenantId, invitationId);
      if (!inv || inv.status !== 'pending') throw new AppError('failed-precondition', 'INVITATION_INVALID');
      const at = clock.now().toISOString();
      uow.updateInvitation(tenantId, invitationId, { status: 'revoked', revokedAt: at, revokedBy: ctx.uid });
      uow.recordEvent(tenantId, auditEvent({ type: 'invitation_revoked', actor: ctx, target: { email: inv.email }, details: { invitationId }, at }));
    });
    return { ok: true };
  };
}

module.exports = { makeRevokeInvitation };
