'use strict';

const { AppError } = require('../../../../shared/errors');
const { normalizeEmail, isValidEmail } = require('../../domain/member');
const { expiryFrom } = require('../../domain/invitation');
const { assertCanGrant } = require('../../domain/accessPolicy');
const { auditEvent } = require('../../domain/auditEvent');

/**
 * Invite someone by email to a role. Supersedes their older pending invitations.
 * The token is returned ONCE and only its hash is stored: send it to the invitee and nowhere else.
 */
function makeInviteMember({ authorize, store, tokens, clock }) {
  return async function inviteMember({ identity, tenantId, email, role, reason }) {
    const ctx = await authorize({ identity, tenantId, permission: 'members:manage', reason });
    const address = normalizeEmail(email);
    if (!isValidEmail(address)) throw new AppError('invalid-argument', 'Invalid email address.');
    assertCanGrant(ctx.role, role);

    const token = tokens.newToken();
    const id = tokens.newId();
    const now = clock.now();
    const at = now.toISOString();
    const expiresAt = expiryFrom(now);
    const older = await store.findPendingInvitationIds(tenantId, address);

    await store.transaction(async (uow) => {
      for (const oldId of older) uow.updateInvitation(tenantId, oldId, { status: 'revoked', revokedAt: at, revokedBy: ctx.uid });
      uow.saveInvitation(tenantId, { id, email: address, role, tokenHash: tokens.hash(token), status: 'pending', createdAt: at, expiresAt, createdBy: ctx.uid });
      uow.recordEvent(tenantId, auditEvent({ type: 'invitation_created', actor: ctx, target: { email: address }, details: { role, invitationId: id, supersedes: older }, at }));
    });
    return { invitationId: id, token, expiresAt };
  };
}

module.exports = { makeInviteMember };
