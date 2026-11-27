'use strict';

const { ROLES, isPlatformRole } = require('../../domain/roles');
const { memberSummary } = require('../../domain/member');
const { invitationSummary } = require('../../domain/invitation');
const { requirePlatformRole } = require('../../domain/accessPolicy');
const { requireIdentity } = require('./authorize');

/** Read-only use cases. */
function makeQueries({ authorize, store, tenants, requireMfa }) {
  /** Members and pending invitations of one insurer. Never exposes invitation secrets. */
  async function listMembers({ identity, tenantId, reason }) {
    await authorize({ identity, tenantId, permission: 'members:read', reason });
    const [members, invitations] = await Promise.all([store.listMembers(tenantId), store.listPendingInvitations(tenantId)]);
    return { members: members.map(memberSummary), invitations: invitations.map(invitationSummary) };
  }

  /**
   * The insurers the signed-in user belongs to, with display names and the permissions of their
   * role (so the dashboard never duplicates the role matrix). No tenant permission needed.
   */
  async function myTenants({ identity }) {
    requireIdentity(identity);
    const active = (await store.listMemberships(identity.uid)).filter((m) => m.status === 'active' && ROLES[m.role]);
    const names = await tenants.namesOf(active.map((m) => m.tenantId));
    const platformRole = isPlatformRole(identity.platformRole) ? identity.platformRole : null;
    return {
      memberships: active.map((m) => ({ tenantId: m.tenantId, name: names.get(m.tenantId) || m.tenantId, role: m.role, permissions: ROLES[m.role].permissions })),
      platformRole,
      platformPermissions: platformRole ? ROLES[platformRole].permissions : [],
    };
  }

  /** Platform staff only: every insurer, for the dashboard's tenant switcher. */
  async function allTenants({ identity }) {
    requireIdentity(identity);
    requirePlatformRole({ identity, requireMfa });
    const list = await tenants.listAll();
    return { tenants: [...list].sort((a, b) => a.name.localeCompare(b.name)) };
  }

  return { listMembers, myTenants, allTenants };
}

module.exports = { makeQueries };
