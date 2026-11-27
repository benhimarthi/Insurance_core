'use strict';

/**
 * Audit event: one append-only record per access change, kept in tenants/{t}/authEvents.
 * `actor` is the access context of whoever made the change ({ uid, role, source, reason }).
 */
const auditEvent = ({ type, actor, target, details, at }) => ({
  type,
  actor: { uid: actor.uid, role: actor.role, source: actor.source },
  target, details,
  reason: actor.reason,
  at,
});

module.exports = { auditEvent };
