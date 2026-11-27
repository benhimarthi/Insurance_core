'use strict';

/** Everything a staff member can be allowed to do. Roles (roles.js) are bundles of these. */
const PERMISSIONS = Object.freeze([
  'case:read',        // read cases (contains personal data), documents summary and their audit events
  'case:decide',      // approve / adjust / reject a referred case, up to the insurer's premium limit
  'case:decide_high', // the same, without the premium limit
  'audit:read',       // read the audit trail
  'policy:read',      // read issued policies
  'config:read',      // read rules, tariff and settings
  'config:write',     // change rules, tariff and settings
  'members:read',     // list members and pending invitations
  'members:manage',   // invite, change role, disable, remove members
  'tenants:manage',   // create insurers, rename, suspend, rotate their web chat key (platform team)
]);

module.exports = { PERMISSIONS };
