'use strict';

/**
 * Ports of the tenants module. Use cases depend on these shapes only.
 *
 * @typedef {object} Authorizer  provided by the auth module (wired in the app's composition root)
 * @property {(args: {caller: any, tenantId: string, permission: string, reason?: string}) => Promise<{uid, role, source, reason, permissions}>} authorize
 *   `caller` is opaque here: whatever the delivery layer received (Firebase `request.auth`).
 *
 * @typedef {object} TenantStore
 * @property {(tenantId) => Promise<object|null>} getTenant
 * @property {(tenantId, line) => Promise<{config, revision, updatedAt, updatedBy, updatedByEmail}|null>} getRuleConfig
 * @property {(tenantId, line, limit) => Promise<object[]>} listRuleVersions   newest first, without the config body
 * @property {(tenantId, line, revision) => Promise<object|null>} getRuleVersion  with the config body
 * @property {<T>(work: (uow: TenantUnitOfWork) => Promise<T>) => Promise<T>} transaction  all reads before writes
 *
 * @typedef {object} TenantUnitOfWork
 * @property {(tenantId) => Promise<object|null>} getTenant
 * @property {(tenantId, line) => Promise<{revision: number}|null>} getRuleMeta
 * @property {(tenantId, line, revision) => Promise<object|null>} getRuleVersion
 * @property {(tenantId, tenant) => void} saveTenant
 * @property {(tenantId, line, {config, revision, savedAt, savedBy, savedByEmail, role, note, restoredFrom}) => void} saveRuleConfig
 *   writes the live config, its revision counter and the numbered version, together
 * @property {(tenantId, webchatKey) => void} saveWebchatKey
 * @property {(tenantId, event) => void} recordEvent
 *
 * @typedef {object} KeyService
 * @property {() => string} newWebchatKey
 *
 * @typedef {object} Clock
 * @property {() => Date} now
 */

module.exports = {};
