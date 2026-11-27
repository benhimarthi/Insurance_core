'use strict';

/**
 * Invitation: the only way to give someone a role at an insurer.
 *   { id, email, role, tokenHash, status: pending|accepted|revoked, createdAt, expiresAt, createdBy }
 * The secret token is shown once to the inviter; only its hash is ever stored.
 */

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const TOKEN_MIN = 20;
const TOKEN_MAX = 128;

const expiryFrom = (now) => new Date(now.getTime() + INVITE_TTL_MS).toISOString();
const isWellFormedToken = (t) => typeof t === 'string' && t.length >= TOKEN_MIN && t.length <= TOKEN_MAX;

/**
 * Can this invitation be redeemed by `email`, holding `token`, at `nowIso`?
 * `tokenMatches(token, hash)` is injected so the domain stays free of crypto details.
 */
function isRedeemable(inv, { email, token, nowIso, tokenMatches }) {
  return !!inv && inv.status === 'pending' && inv.expiresAt > nowIso && email === inv.email && tokenMatches(token, inv.tokenHash);
}

/** The public view of an invitation: never the token hash. */
const invitationSummary = (i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt });

module.exports = { INVITE_TTL_MS, expiryFrom, isWellFormedToken, isRedeemable, invitationSummary };
