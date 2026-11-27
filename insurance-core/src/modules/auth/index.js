'use strict';

/**
 * Auth module: staff authentication checks, roles, invitations and member management.
 * This file is its composition root and its ONLY public entry point: other modules and
 * index.js import from here, never from the layers inside.
 *
 * Layers (dependencies point inwards only):
 *   domain/          roles, permissions, access rules. Pure: no I/O, no Firebase
 *   application/     use cases + the ports they need (application/ports.js)
 *   infrastructure/  Firestore / Firebase Auth / crypto implementations of the ports
 *   interface/       Firebase identity translation and the `members` callable controller
 */

const { makeAuthorize } = require('./application/useCases/authorize');
const { makeInviteMember } = require('./application/useCases/inviteMember');
const { makeRevokeInvitation } = require('./application/useCases/revokeInvitation');
const { makeAcceptInvitation } = require('./application/useCases/acceptInvitation');
const { makeManageMember } = require('./application/useCases/manageMember');
const { makeQueries } = require('./application/useCases/queries');
const { makeBootstrapMember } = require('./application/useCases/bootstrapMember');
const { createFirestoreAuthStore } = require('./infrastructure/firestoreAuthStore');
const { createFirestoreTenantDirectory } = require('./infrastructure/firestoreTenantDirectory');
const { createFirebaseSessionRevoker } = require('./infrastructure/firebaseSessionRevoker');
const { createCryptoTokenService } = require('./infrastructure/cryptoTokenService');
const { identityFromFirebase } = require('./interface/firebaseIdentity');
const { createMembersController } = require('./interface/membersController');
const { PERMISSIONS } = require('./domain/permissions');
const { ROLES, TENANT_ROLES, can, isTenantRole, isPlatformRole } = require('./domain/roles');
const { INVITE_TTL_MS } = require('./domain/invitation');

/**
 * Wires the module. Pass `db` (and `authAdmin` to revoke sessions) for the Firebase setup, or
 * replace any port (store, tenants, sessions, tokens) with your own implementation.
 *
 * Every method takes the raw Firebase `auth` ({ uid, token }) as callables receive it.
 */
function createAuthModule({
  db, authAdmin = null, now = () => new Date(), requireMfa = true, logger = console,
  store = createFirestoreAuthStore(db),
  tenants = createFirestoreTenantDirectory(db),
  sessions = createFirebaseSessionRevoker(authAdmin),
  tokens = createCryptoTokenService(),
} = {}) {
  const clock = { now };
  const authorize = makeAuthorize({ store, requireMfa });
  const manage = makeManageMember({ authorize, store, sessions, clock, logger });
  const queries = makeQueries({ authorize, store, tenants, requireMfa });
  const useCases = {
    authorize,
    invite: makeInviteMember({ authorize, store, tokens, clock }),
    revokeInvitation: makeRevokeInvitation({ authorize, store, clock }),
    acceptInvitation: makeAcceptInvitation({ store, tokens, clock }),
    changeRole: manage.changeRole,
    setStatus: manage.setStatus,
    removeMember: manage.removeMember,
    listMembers: queries.listMembers,
    myTenants: queries.myTenants,
    allTenants: queries.allTenants,
  };

  // Public API: same use cases, taking Firebase's `auth` instead of an Identity.
  const api = {};
  for (const [name, useCase] of Object.entries(useCases)) {
    api[name] = ({ auth, ...rest } = {}) => useCase({ identity: identityFromFirebase(auth), ...rest });
  }
  api.bootstrapMember = makeBootstrapMember({ store, clock }); // scripts only, never over HTTP
  api.handle = createMembersController(api);
  return api;
}

module.exports = { createAuthModule, PERMISSIONS, ROLES, TENANT_ROLES, can, isTenantRole, isPlatformRole, INVITE_TTL_MS };
