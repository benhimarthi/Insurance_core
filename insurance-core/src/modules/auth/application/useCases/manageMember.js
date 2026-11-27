'use strict';

const { AppError } = require('../../../../shared/errors');
const { isValidUid, isValidStatus, isActiveAdmin } = require('../../domain/member');
const { assertCanGrant, assertCanManage, assertNotSelf, assertNotLastAdmin } = require('../../domain/accessPolicy');
const { auditEvent } = require('../../domain/auditEvent');

/**
 * Change role, disable/enable and remove, sharing one set of guards: permission, no self-change,
 * only members the actor could grant, never the last active admin, audited, sessions revoked
 * when someone loses access.
 */
function makeManageMember({ authorize, store, sessions, clock, logger }) {
  /** apply(current, ctx) returns the fields to change, or null to remove the member. */
  async function mutate({ identity, tenantId, uid, reason, type, apply }) {
    const ctx = await authorize({ identity, tenantId, permission: 'members:manage', reason });
    if (!isValidUid(uid)) throw new AppError('invalid-argument', 'Invalid user.');
    assertNotSelf(ctx.uid, uid);

    const result = await store.transaction(async (uow) => {
      const current = await uow.getMember(tenantId, uid);
      if (!current) throw new AppError('not-found', 'Member not found.');
      assertCanManage(ctx.role, current.role);

      const change = apply(current, ctx);
      const next = change ? { ...current, ...change } : null;
      const wasActiveAdmin = isActiveAdmin(current);
      const stillActiveAdmin = isActiveAdmin(next);
      if (wasActiveAdmin && !stillActiveAdmin) {
        assertNotLastAdmin({ wasActiveAdmin, stillActiveAdmin, otherActiveAdmins: await uow.countActiveAdmins(tenantId, { excludeUid: uid }) });
      }

      const at = clock.now().toISOString();
      if (next) uow.saveMember(tenantId, { ...next, updatedAt: at, updatedBy: ctx.uid });
      else uow.deleteMember(tenantId, uid);
      uow.recordEvent(tenantId, auditEvent({
        type, actor: ctx, target: { uid, email: current.email },
        details: { before: { role: current.role, status: current.status }, after: next ? { role: next.role, status: next.status } : null },
        at,
      }));
      return { removed: !next, disabled: !!next && next.status === 'disabled' };
    });

    if (result.removed || result.disabled) {
      try { await sessions.revokeAll(uid); } catch (err) { logger.error(`revokeSessions(${uid}) failed: ${err.message}`); }
    }
    return { ok: true };
  }

  const changeRole = ({ identity, tenantId, uid, role, reason }) => mutate({
    identity, tenantId, uid, reason, type: 'role_changed',
    apply: (current, ctx) => { assertCanGrant(ctx.role, role); return { role }; },
  });

  const setStatus = async ({ identity, tenantId, uid, status, reason }) => {
    if (!isValidStatus(status)) throw new AppError('invalid-argument', 'status must be active or disabled.');
    return mutate({ identity, tenantId, uid, reason, type: status === 'disabled' ? 'member_disabled' : 'member_enabled', apply: () => ({ status }) });
  };

  const removeMember = ({ identity, tenantId, uid, reason }) => mutate({ identity, tenantId, uid, reason, type: 'member_removed', apply: () => null });

  return { changeRole, setStatus, removeMember };
}

module.exports = { makeManageMember };
