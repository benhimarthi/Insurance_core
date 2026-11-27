'use strict';

/** Audit record of a change to an insurer or its rules, kept in tenants/{t}/adminEvents (append-only). */
const adminEvent = ({ type, actor, details, at }) => ({
  type,
  actor: { uid: actor.uid, role: actor.role, source: actor.source },
  details,
  reason: actor.reason,
  at,
});

module.exports = { adminEvent };
