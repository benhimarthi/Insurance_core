'use strict';

const { DOCUMENT_RETENTION_DAYS, ABANDONED_AFTER_DAYS, ABANDONABLE_STAGES, UPLOADS_PREFIX, daysBefore, caseUploadsPrefix } = require('../../domain/retention');

/**
 * Daily data retention (domain/retention.js): delete customer uploads past their retention, and
 * conversations abandoned before any quote or referral. Runs as a scheduled job; safe to rerun.
 */
function makeCleanup({ store, uploads, clock, logger }) {
  return async function cleanup({ maxCases = 500 } = {}) {
    const now = clock.now();
    const uploadsDeleted = await uploads.deleteOlderThan(UPLOADS_PREFIX, daysBefore(now, DOCUMENT_RETENTION_DAYS));

    const abandoned = await store.deleteAbandonedCases({
      updatedBefore: daysBefore(now, ABANDONED_AFTER_DAYS).toISOString(), stages: ABANDONABLE_STAGES, limit: maxCases,
    });
    let caseUploadsDeleted = 0;
    for (const { tenantId, caseId } of abandoned) caseUploadsDeleted += await uploads.deletePrefix(caseUploadsPrefix(tenantId, caseId));

    const report = { uploadsDeleted: uploadsDeleted + caseUploadsDeleted, casesDeleted: abandoned.length };
    logger.log(`conversation cleanup: ${JSON.stringify(report)}`);
    return report;
  };
}

module.exports = { makeCleanup };
