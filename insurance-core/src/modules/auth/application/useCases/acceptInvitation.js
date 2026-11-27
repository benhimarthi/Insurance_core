'use strict';

const { AppError } = require('../../../../shared/errors');
const { TENANT_ID_RE, ID_RE } = require('../../../../shared/ids');
const { normalizeEmail, nextMember } = require('../../domain/member');
const { isWellFormedToken, isRedeemable } = require('../../domain/invitation');
const { auditEvent } = require('../../domain/auditEvent');
const { requireIdentity } = require('./authorize');

/** The invitee, signed in with the invited and VERIFIED email, redeems the token. */
function makeAcceptInvitation({ store, tokens, clock }) {
  return async function acceptInvitation({ identity, tenantId, invitationId, token }) {
    requireIdentity(identity);
    if (!TENANT_ID_RE.test(tenantId || '') || !ID_RE.test(invitationId || '') || !isWellFormedToken(token)) {
      throw new AppError('invalid-argument', 'Invalid invitation.');
    }
    if (!identity.emailVerified || !identity.email) throw new AppError('permission-denied', 'EMAIL_NOT_VERIFIED');

    return store.transaction(async (uow) => {
      const [inv, before] = await Promise.all([uow.getInvitation(tenantId, invitationId), uow.getMember(tenantId, identity.uid)]);
      const at = clock.now().toISOString();
      const ok = isRedeemable(inv, { email: normalizeEmail(identity.email), token, nowIso: at, tokenMatches: tokens.matches });
      if (!ok) throw new AppError('failed-precondition', 'INVITATION_INVALID'); // one message for every failure

      const actor = { uid: identity.uid, role: inv.role, source: 'invitation' };
      uow.saveMember(tenantId, nextMember({ before, uid: identity.uid, email: inv.email, role: inv.role, status: 'active', nowIso: at, actorUid: identity.uid, createdBy: inv.createdBy }));
      uow.updateInvitation(tenantId, invitationId, { status: 'accepted', acceptedAt: at, acceptedBy: identity.uid });
      uow.recordEvent(tenantId, auditEvent({
        type: before ? 'role_changed' : 'member_added', actor, target: { uid: identity.uid, email: inv.email },
        details: { invitationId, before: before ? { role: before.role, status: before.status } : null, after: { role: inv.role, status: 'active' } },
        at,
      }));
      return { tenantId, role: inv.role };
    });
  };
}

module.exports = { makeAcceptInvitation };
