'use strict';

const MAX_ATTEMPTS = 8;

/**
 * Sends outbox entries in order. At-least-once delivery: if a send fails the entry stays
 * pending with exponential backoff, and later entries of the same case wait so messages
 * never arrive out of order. After MAX_ATTEMPTS the entry is marked failed for a human to see.
 */
async function deliverOutbox({ repo, channel, storage, entries, now = () => new Date(), logger = console }) {
  const stats = { sent: 0, failed: 0 };
  const blockedCases = new Set();

  for (const e of entries) {
    if (e.status !== 'pending' || blockedCases.has(e.caseId)) continue;
    try {
      if (e.kind === 'document') {
        const url = await storage.getSignedUrl(e.document.path, 15 * 60 * 1000);
        await channel.sendDocument(e.to, { url, filename: e.document.filename, mimeType: e.document.mimeType, caption: e.text });
      } else {
        await channel.sendText(e.to, e.text);
      }
      await repo.markOutbox(e.id, { status: 'sent', attempts: e.attempts + 1, sentAt: now().toISOString() });
      stats.sent += 1;
    } catch (err) {
      const attempts = e.attempts + 1;
      const backoffMs = Math.min(30000 * 2 ** attempts, 3600000);
      await repo.markOutbox(e.id, attempts >= MAX_ATTEMPTS
        ? { status: 'failed', attempts, lastError: String(err.message).slice(0, 200) }
        : { attempts, nextAttemptAt: new Date(now().getTime() + backoffMs).toISOString(), lastError: String(err.message).slice(0, 200) });
      logger.error(`outbox ${e.id} failed (attempt ${attempts}): ${err.message}`);
      blockedCases.add(e.caseId);
      stats.failed += 1;
    }
  }
  return stats;
}

module.exports = { deliverOutbox, MAX_ATTEMPTS };
