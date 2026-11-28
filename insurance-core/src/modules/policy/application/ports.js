'use strict';

/**
 * Ports of the policy module.
 *
 * @typedef {object} PolicyRegistry   the insurer's policy system (numbering, records); Firestore for the demo
 * @property {(draft) => Promise<object>} createPolicy   idempotent on draft.idempotencyKey (the case id)
 * @property {(tenantId, policyNumber) => Promise<object|null>} getPolicy
 *
 * @typedef {object} PdfRenderer
 * @property {(args: {policy, payment, branding, coverageInfo, verification, language}) => Promise<Uint8Array>} render
 *
 * @typedef {object} Files            Cloud Storage
 * @property {(path, bytes, contentType) => Promise<void>} save
 *
 * @typedef {object} Verifier         optional (verification module): the public link printed as a QR code
 * @property {(policy) => string} url
 */

module.exports = {};
