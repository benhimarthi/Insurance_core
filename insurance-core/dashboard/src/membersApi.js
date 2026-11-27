import { ApiError, normalizeError } from './errors.js';

/**
 * Typed wrappers around the `members` and `underwriterDecision` callables.
 *
 *   call(name, data)  -> Promise<data>        (see createCallable in firebasePort.js)
 *   getContext()      -> { tenantId, access, platformOnly } the active insurer and how the user reaches it:
 *                        'member' (a role at that insurer) or 'platform' (your team)
 *   askReason(action) -> Promise<string|null>  asks the person why they act on this insurer
 *
 * When the user acts on an insurer through a platform role, the server requires a `reason` that
 * is written to the audit trail. This layer asks for it before every such action, so no screen
 * has to remember.
 */
export function createMembersApi({ call, getContext = () => null, askReason = null, lang = 'fr' }) {
  async function invoke(name, payload) {
    try { return await call(name, payload); } catch (err) { throw normalizeError(err, lang); }
  }

  // the permission each members action needs (the server's rule: platform staff give a reason)
  const PERMISSION = { list: 'members:read' }; // every other action needs members:manage
  const viaPlatform = (ctx, action) => ctx.access === 'platform'
    || (Array.isArray(ctx.platformOnly) && ctx.platformOnly.includes(PERMISSION[action] || 'members:manage'));

  async function withReason(tenantId, payload) {
    const ctx = getContext();
    if (!(ctx && ctx.tenantId === tenantId && viaPlatform(ctx, payload.action)) || payload.reason) return payload;
    if (!askReason) throw new ApiError({ code: 'failed-precondition', reason: 'REASON_REQUIRED', message: 'REASON_REQUIRED' });
    const reason = await askReason(payload.action);
    if (typeof reason !== 'string' || reason.trim().length < 5) {
      throw normalizeError({ code: 'cancelled', message: 'REASON_CANCELLED' }, lang);
    }
    return { ...payload, reason: reason.trim() };
  }

  const members = async (tenantId, payload) => invoke('members', await withReason(tenantId, { tenantId, ...payload }));

  return {
    myTenants: () => invoke('members', { action: 'myTenants' }),
    allTenants: () => invoke('members', { action: 'allTenants' }),

    list: (tenantId) => members(tenantId, { action: 'list' }),
    invite: (tenantId, { email, role }) => members(tenantId, { action: 'invite', email, role }),
    revokeInvitation: (tenantId, invitationId) => members(tenantId, { action: 'revokeInvitation', invitationId }),
    changeRole: (tenantId, uid, role) => members(tenantId, { action: 'changeRole', uid, role }),
    setStatus: (tenantId, uid, status) => members(tenantId, { action: 'setStatus', uid, status }),
    remove: (tenantId, uid) => members(tenantId, { action: 'remove', uid }),

    /** Redeems an invitation: needs no reason (the invitee is not acting as platform staff). */
    accept: ({ tenantId, invitationId, token }) => invoke('members', { action: 'accept', tenantId, invitationId, token }),

    decide: (tenantId, { caseId, decision, adjustedPremium, note }) =>
      invoke('underwriterDecision', { tenantId, caseId, decision, adjustedPremium, note }),
  };
}
