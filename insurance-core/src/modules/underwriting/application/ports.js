'use strict';

/**
 * Ports of the underwriting module.
 *
 * @typedef {object} Authorizer      from the auth module: ({ caller, tenantId, permission, reason }) -> { uid, role, permissions, ... }
 * @typedef {object} TenantLoader    from the tenants module: { load(tenantId) -> { tenant, config } | null }
 *
 * @typedef {object} CaseStore       cases, their events and customers (src/server/repository.js)
 * @property {(tenantId, caseId) => Promise<object|null>} getCase
 * @property {(tenantId, customerId) => Promise<object|null>} getCustomer
 * @property {(tenantId, { status?, limit }) => Promise<object[]>} listCases        newest update first
 * @property {(tenantId, caseId, limit) => Promise<object[]>} listCaseEvents        oldest first
 * @property {(tenantId, caseId, event) => Promise<void>} appendEvent               audit only: the case is not touched
 * @property {(args: {tenantId, caseId, compute}) => Promise<{caseDoc, outbox}>} transact
 *
 * @typedef {object} DecisionNotifier  what the customer is told (customer texts belong to the conversation side)
 * @property {(args: {caseDoc, config}) => {caseDoc, replies: string[]}} announce
 * @property {(args: {caseDoc}) => string} policyResent   the text sent with a policy document sent again
 *
 * @typedef {object} Delivery        optional: sends push-channel replies now (WhatsApp); web chat replies wait for the page
 * @property {(outboxEntries) => Promise<void>} send
 *
 * @typedef {object} Files           customer uploads (Cloud Storage)
 * @property {(path) => Promise<boolean>} exists
 * @property {(path, ttlMs) => Promise<string>} getSignedUrl
 *
 * @typedef {object} Clock
 * @property {() => Date} now
 */

module.exports = {};
