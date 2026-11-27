'use strict';

/**
 * Ports: what the auth use cases need from the outside world. Use cases depend on these
 * shapes only; infrastructure/ provides the Firestore and Firebase implementations, and tests
 * can provide in-memory ones. Nothing in this file runs: it documents the contracts.
 *
 * @typedef {object} AuthStore
 * @property {(tenantId: string, uid: string) => Promise<object|null>} getMember
 * @property {(tenantId: string) => Promise<object[]>} listMembers
 * @property {(tenantId: string) => Promise<object[]>} listPendingInvitations
 * @property {(tenantId: string, email: string) => Promise<string[]>} findPendingInvitationIds
 * @property {(uid: string) => Promise<Array<{tenantId: string, role: string, status: string}>>} listMemberships
 * @property {<T>(work: (uow: AuthUnitOfWork) => Promise<T>) => Promise<T>} transaction
 *   Atomic: every write in `work` happens, or none. Do all reads before the first write.
 *
 * @typedef {object} AuthUnitOfWork
 * @property {(tenantId: string, uid: string) => Promise<object|null>} getMember
 * @property {(tenantId: string, id: string) => Promise<object|null>} getInvitation
 * @property {(tenantId: string, opts: {excludeUid: string}) => Promise<number>} countActiveAdmins
 * @property {(tenantId: string, member: object) => void} saveMember      also keeps the user's membership list in sync
 * @property {(tenantId: string, uid: string) => void} deleteMember       also removes it from the user's membership list
 * @property {(tenantId: string, invitation: object) => void} saveInvitation
 * @property {(tenantId: string, id: string, patch: object) => void} updateInvitation
 * @property {(tenantId: string, event: object) => void} recordEvent       append-only audit trail
 *
 * @typedef {object} TenantDirectory  read-only view of the insurers (owned by the tenants module)
 * @property {(tenantIds: string[]) => Promise<Map<string, string>>} namesOf
 * @property {() => Promise<Array<{tenantId: string, name: string, demo: boolean, status: string}>>} listAll
 *
 * @typedef {object} SessionRevoker
 * @property {(uid: string) => Promise<void>} revokeAll  signs the person out everywhere
 *
 * @typedef {object} TokenService
 * @property {() => string} newToken
 * @property {(token: string) => string} hash
 * @property {(token: string, hash: string) => boolean} matches  constant time
 * @property {() => string} newId
 *
 * @typedef {object} Clock
 * @property {() => Date} now
 */

module.exports = {};
