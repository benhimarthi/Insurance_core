'use strict';

/**
 * How long conversation data is kept.
 *   - customer uploads (ID cards, registrations) are deleted after DOCUMENT_RETENTION_DAYS; what the
 *     case needs (the verified fields) stays on the case
 *   - a conversation abandoned before any quote or referral is deleted after ABANDONED_AFTER_DAYS,
 *     with its audit events, uploads and the customer record that pointed to it
 * Cases that reached a quote, a human or a policy are business records and are never deleted here.
 */
const DOCUMENT_RETENTION_DAYS = 90;
const ABANDONED_AFTER_DAYS = 30;
const ABANDONABLE_STAGES = Object.freeze(['new', 'asking', 'documents']);
const UPLOADS_PREFIX = 'uploads/';

const daysBefore = (now, days) => new Date(now.getTime() - days * 24 * 3600 * 1000);
const uploadPath = (tenantId, caseId, name) => `${UPLOADS_PREFIX}tenants/${tenantId}/cases/${caseId}/${name}`;
const caseUploadsPrefix = (tenantId, caseId) => `${UPLOADS_PREFIX}tenants/${tenantId}/cases/${caseId}/`;

module.exports = { DOCUMENT_RETENTION_DAYS, ABANDONED_AFTER_DAYS, ABANDONABLE_STAGES, UPLOADS_PREFIX, daysBefore, uploadPath, caseUploadsPrefix };
