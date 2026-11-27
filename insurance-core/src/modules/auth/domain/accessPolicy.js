'use strict';

const { AppError } = require('../../../shared/errors');
const { ROLES, can, isTenantRole, isPlatformRole } = require('./roles');

/**
 * Access rules, as pure functions. They decide; they never read or write anything.
 * Errors use stable messages the front end reacts to: EMAIL_NOT_VERIFIED, MFA_REQUIRED,
 * REASON_REQUIRED, FORBIDDEN, ROLE_NOT_GRANTABLE, ROLE_NOT_MANAGEABLE, CANNOT_CHANGE_SELF, LAST_ADMIN.
 */

const MIN_REASON_LENGTH = 5;

const requireVerifiedEmail = (identity) => {
  if (!identity.emailVerified) throw new AppError('permission-denied', 'EMAIL_NOT_VERIFIED');
};

/**
 * Which role lets `identity` use `permission` at an insurer where they are `member` (or null)?
 * A tenant membership is tried before a platform role.
 * @returns {{ role: string, source: 'member'|'platform', reason?: string }}
 */
function resolveAccess({ identity, member, permission, reason, requireMfa }) {
  requireVerifiedEmail(identity);
  const candidates = [];
  if (member && member.status === 'active' && isTenantRole(member.role)) candidates.push({ role: member.role, source: 'member' });
  if (isPlatformRole(identity.platformRole)) candidates.push({ role: identity.platformRole, source: 'platform' });

  const hit = candidates.find((c) => can(c.role, permission));
  if (!hit) throw new AppError('permission-denied', 'FORBIDDEN');
  if (requireMfa && ROLES[hit.role].mfa && !identity.secondFactor) throw new AppError('permission-denied', 'MFA_REQUIRED');
  // Platform staff acting on an insurer must say why; the reason lands in the audit trail.
  if (hit.source === 'platform' && !(typeof reason === 'string' && reason.trim().length >= MIN_REASON_LENGTH)) {
    throw new AppError('invalid-argument', 'REASON_REQUIRED');
  }
  return { ...hit, reason: typeof reason === 'string' ? reason.trim() : undefined };
}

/** Platform-wide actions (no insurer): a platform role, verified email and MFA. */
function requirePlatformRole({ identity, requireMfa }) {
  requireVerifiedEmail(identity);
  if (!isPlatformRole(identity.platformRole)) throw new AppError('permission-denied', 'FORBIDDEN');
  if (requireMfa && !identity.secondFactor) throw new AppError('permission-denied', 'MFA_REQUIRED');
}

/** No escalation: an actor may only grant the roles listed in their own role's `grantable`. */
function assertCanGrant(actorRole, role) {
  if (!ROLES[role] || !isTenantRole(role)) throw new AppError('invalid-argument', 'Unknown role.');
  if (!ROLES[actorRole].grantable.includes(role)) throw new AppError('permission-denied', 'ROLE_NOT_GRANTABLE');
}

/** An actor may only change members whose current role they could grant. */
function assertCanManage(actorRole, targetRole) {
  if (!ROLES[actorRole].grantable.includes(targetRole)) throw new AppError('permission-denied', 'ROLE_NOT_MANAGEABLE');
}

/** No self-promotion, no self-lockout. */
function assertNotSelf(actorUid, targetUid) {
  if (actorUid === targetUid) throw new AppError('permission-denied', 'CANNOT_CHANGE_SELF');
}

/** Never lock an insurer out: the last active tenant_admin stays one. */
function assertNotLastAdmin({ wasActiveAdmin, stillActiveAdmin, otherActiveAdmins }) {
  if (wasActiveAdmin && !stillActiveAdmin && otherActiveAdmins === 0) throw new AppError('failed-precondition', 'LAST_ADMIN');
}

module.exports = { resolveAccess, requirePlatformRole, requireVerifiedEmail, assertCanGrant, assertCanManage, assertNotSelf, assertNotLastAdmin, MIN_REASON_LENGTH };
