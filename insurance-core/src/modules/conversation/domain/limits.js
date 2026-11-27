'use strict';

/**
 * Abuse limits of the web chat. Every message costs an AI call, so they protect both the service and
 * the bill. Counted per session, per IP (pseudonymized) and per insurer; the insurer's daily cap is the
 * hard ceiling even if someone rotates sessions and IPs. Polls (checking for new replies) are cheap
 * and have their own, looser limits.
 */
const MINUTE = 60;
const DAY = 24 * 3600;

const LIMITS = Object.freeze({
  message: [
    { scope: 'session', limit: 20, windowSec: MINUTE },
    { scope: 'session', limit: 300, windowSec: DAY },
    { scope: 'ip', limit: 60, windowSec: MINUTE },
    { scope: 'ip', limit: 1500, windowSec: DAY },
    { scope: 'tenant', limit: 5000, windowSec: DAY },
  ],
  poll: [
    { scope: 'session', limit: 40, windowSec: MINUTE },
    { scope: 'ip', limit: 300, windowSec: MINUTE },
  ],
});

/** The counters one request uses: [{ key, limit, windowSec }]. Keys are already pseudonymous. */
function bucketsFor({ kind, tenantId, sessionKey, ipKey }) {
  const id = { session: sessionKey, ip: ipKey, tenant: tenantId };
  return LIMITS[kind]
    .filter((l) => id[l.scope])
    .map((l) => ({ key: `webchat|${kind}|${l.scope}|${tenantId}|${id[l.scope]}|${l.windowSec}`, limit: l.limit, windowSec: l.windowSec }));
}

module.exports = { LIMITS, bucketsFor };
