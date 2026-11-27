'use strict';

const crypto = require('crypto');

/**
 * RateLimiter over Firestore: fixed-window counters shared by every function instance.
 *   rateLimits/{hash(key|windowStart)} { count, expireAt }   (Firestore TTL on "expireAt" cleans them up)
 * All buckets of a request are checked and counted in one transaction: all or nothing.
 */
function createFirestoreRateLimiter(db, { now = () => new Date() } = {}) {
  return {
    async consume(buckets) {
      if (!buckets.length) return { allowed: true };
      const t = now().getTime();
      const slots = buckets.map((b) => {
        const windowMs = b.windowSec * 1000;
        const start = Math.floor(t / windowMs) * windowMs;
        const id = crypto.createHash('sha256').update(`${b.key}|${start}`).digest('hex').slice(0, 40);
        return { ...b, ref: db.doc(`rateLimits/${id}`), end: start + windowMs };
      });
      return db.runTransaction(async (tx) => {
        const snaps = await Promise.all(slots.map((s) => tx.get(s.ref)));
        const counts = snaps.map((s) => (s.exists ? s.data().count || 0 : 0));
        const full = slots.filter((s, i) => counts[i] >= s.limit);
        if (full.length) return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((Math.max(...full.map((s) => s.end)) - t) / 1000)) };
        slots.forEach((s, i) => tx.set(s.ref, { count: counts[i] + 1, expireAt: new Date(s.end + 24 * 3600 * 1000) }));
        return { allowed: true };
      });
    },
  };
}

module.exports = { createFirestoreRateLimiter };
