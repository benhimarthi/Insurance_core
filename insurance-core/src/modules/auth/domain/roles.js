'use strict';

/**
 * Roles: bundles of permissions (permissions.js). Single source of truth: the server checks it on
 * every call, and firestore.rules mirrors the "who can read what" part (keep the two in sync).
 *
 * Staff roles are PER INSURER (tenant): one person can be underwriter at insurer A and auditor at
 * insurer B. They live in Firestore (tenants/{t}/members/{uid}), not in the sign-in token, so a
 * change or a revocation applies immediately and there is no token size limit.
 * Platform roles (your team) are global and live in a custom claim set only with the Admin SDK.
 *
 * To add a role: add one entry below, add it to the `grantable` lists that may assign it,
 * and (if it reads data) to the role lists in firestore.rules.
 */

const { PERMISSIONS } = require('./permissions');

const UNDERWRITER_PERMISSIONS = ['case:read', 'case:decide', 'policy:read', 'config:read'];

const TENANT_ROLES_LIST = ['tenant_admin', 'underwriter', 'underwriting_manager', 'auditor'];

const ROLES = Object.freeze({
  // Runs the insurer's workspace: people and settings. Can SEE cases but cannot decide them.
  tenant_admin: {
    scope: 'tenant', mfa: true,
    permissions: ['case:read', 'policy:read', 'config:read', 'members:read', 'members:manage'],
    grantable: TENANT_ROLES_LIST,
  },
  underwriter: {
    scope: 'tenant', mfa: true,
    permissions: UNDERWRITER_PERMISSIONS,
    grantable: [],
  },
  // Underwriter + decisions above the premium limit + rules and tariff changes.
  underwriting_manager: {
    scope: 'tenant', mfa: true,
    permissions: [...UNDERWRITER_PERMISSIONS, 'case:decide_high', 'config:write'],
    grantable: [],
  },
  // Read-only, including the audit trail, for compliance and regulator requests.
  auditor: {
    scope: 'tenant', mfa: true,
    permissions: ['case:read', 'audit:read', 'policy:read', 'config:read', 'members:read'],
    grantable: [],
  },
  // Your team. Manages access and configuration across insurers but has NO case access:
  // reading customer data means adding yourself as a member, which is logged with a reason.
  platform_admin: {
    scope: 'platform', mfa: true,
    permissions: ['members:read', 'members:manage', 'config:read', 'config:write'],
    grantable: TENANT_ROLES_LIST,
  },
});

const can = (role, permission) => !!ROLES[role] && ROLES[role].permissions.includes(permission);
const isTenantRole = (role) => !!ROLES[role] && ROLES[role].scope === 'tenant';
const isPlatformRole = (role) => !!ROLES[role] && ROLES[role].scope === 'platform';

module.exports = { PERMISSIONS, ROLES, TENANT_ROLES: TENANT_ROLES_LIST, can, isTenantRole, isPlatformRole };
