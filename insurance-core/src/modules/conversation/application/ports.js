'use strict';

/**
 * Ports of the conversation module. Today the composition root plugs the existing code into the
 * ports owned by future modules (underwriting, documents, payments); when those modules exist,
 * only the wiring changes.
 *
 * @typedef {object} Extractor          what the customer said -> field values (LLM or rule-based)
 * @property {(args: {message, language, question, questions}) => Promise<{fields: object}>} extract
 *
 * @typedef {object} Underwriting       the rules engine
 * @property {(data: object, config: object) => object} evaluate   engine result (status, premium, reasons...)
 *
 * @typedef {object} Documents          document checks
 * @property {(config) => string[]} requiredTypes
 * @property {(caseDoc, config) => string[]} missingTypes
 * @property {(type, lang) => string} labelOf
 * @property {(args: {attachment, expectedTypes, language}) => Promise<object>} process   reads a document (AI)
 * @property {(extracted, config, now) => {ok, type, fields?, confidence, issue?}} accept
 * @property {(input, documents, config, now) => object[]} crossCheck                    flags for a human
 *
 * @typedef {object} Payments           optional: without it, an accepted quote is "confirmed" and the insurer follows up
 * @property {(args: {caseDoc, config, now}) => Promise<{caseDoc, replies, events}>} requestPayment
 *
 * @typedef {object} CaseStore          cases, customers and the outbox (see src/server/repository.js)
 * @property {(tenantId, customerId) => Promise<object|null>} getCustomer
 * @property {(tenantId, caseId) => Promise<object|null>} getCase
 * @property {(args: {tenantId, caseId, customerId, dedupe, compute}) => Promise<{duplicate, caseDoc?, outbox?}>} transact
 *   optimistic: compute() runs outside the transaction, the commit re-checks the case version
 * @property {(tenantId, customerId) => Promise<object[]>} takePendingWebMessages
 * @property {(args: {updatedBefore: string, stages: string[], limit: number}) => Promise<Array<{tenantId, caseId}>>} deleteAbandonedCases
 *   deletes those cases, their audit events and the customer record pointing to them
 *
 * @typedef {object} Uploads            customer files (Cloud Storage)
 * @property {(path, bytes, mimeType) => Promise<void>} save
 * @property {(path, ttlMs) => Promise<string>} getSignedUrl
 * @property {(prefix, before: Date) => Promise<number>} deleteOlderThan   files under prefix created before `before`
 * @property {(prefix) => Promise<number>} deletePrefix
 *
 * @typedef {object} RateLimiter        counters shared by all instances (Firestore)
 * @property {(buckets: Array<{key, limit, windowSec}>) => Promise<{allowed: boolean, retryAfterSec?: number}>} consume
 *   all-or-nothing: counts the request in every bucket, or in none if one is full
 *
 * @typedef {object} TenantLoader       from the tenants module
 * @property {(tenantId) => Promise<{tenant, config}|null>} load
 *
 * @typedef {object} CustomerIds        pseudonymous customer ids: raw contacts are never document ids
 * @property {(contact: string) => string} keyFor
 *
 * @typedef {object} Delivery           push channels (WhatsApp); web chat is polled instead
 * @property {(outboxEntries: object[]) => Promise<void>} send
 * @property {(attachment) => Promise<Buffer|null>} [downloadMedia]
 */

module.exports = {};
