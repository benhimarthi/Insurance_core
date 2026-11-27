'use strict';

/**
 * Tenant: one insurer (or a demo) on the platform.
 *   tenants/{id} { name, status, demo, createdAt, createdBy, updatedAt, updatedBy }
 * `status: suspended` switches the insurer off everywhere (chat, payment, verification).
 * `demo: true` enables demo-only behaviour: fake checkout, document fixtures, keyless web chat.
 */

const TENANT_STATUSES = Object.freeze(['active', 'suspended']);
const NAME_MAX = 100;

const normalizeName = (n) => String(n == null ? '' : n).replace(/\s+/g, ' ').trim();
const isValidName = (n) => n.length >= 2 && n.length <= NAME_MAX;
const isValidStatus = (s) => TENANT_STATUSES.includes(s);

/** Policy-number prefix derived from the tenant id: letters and digits only (it is part of document ids). */
const prefixFromId = (tenantId) => (String(tenantId).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'POL');

/** The public view of a tenant: never secrets. */
const tenantSummary = (id, t) => ({
  tenantId: id, name: t.name || id, status: t.status || 'active', demo: !!t.demo,
  createdAt: t.createdAt || null, updatedAt: t.updatedAt || null,
});

module.exports = { TENANT_STATUSES, NAME_MAX, normalizeName, isValidName, isValidStatus, prefixFromId, tenantSummary };
