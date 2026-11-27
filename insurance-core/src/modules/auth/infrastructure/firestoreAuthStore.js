'use strict';

const { stripUndefined } = require('../../../shared/firestore');

/**
 * AuthStore over Firestore (see application/ports.js). Document layout (read by firestore.rules
 * and the dashboard, so do not change it lightly):
 *   tenants/{t}/members/{uid}              { uid, email, role, status, createdAt, createdBy, updatedAt, updatedBy }
 *   userTenants/{uid}/memberships/{t}      mirror, so a user can list their insurers { tenantId, role, status, updatedAt }
 *   tenants/{t}/invitations/{id}           { id, email, role, tokenHash, status, createdAt, expiresAt, createdBy, ... }
 *   tenants/{t}/authEvents/{id}            append-only audit of every access change
 */
function createFirestoreAuthStore(db) {
  const memberRef = (t, uid) => db.doc(`tenants/${t}/members/${uid}`);
  const mirrorRef = (uid, t) => db.doc(`userTenants/${uid}/memberships/${t}`);
  const inviteRef = (t, id) => db.doc(`tenants/${t}/invitations/${id}`);
  const members = (t) => db.collection(`tenants/${t}/members`);
  const invitations = (t) => db.collection(`tenants/${t}/invitations`);
  const activeAdmins = (t) => members(t).where('role', '==', 'tenant_admin').where('status', '==', 'active');
  const pending = (t) => invitations(t).where('status', '==', 'pending');
  const dataOrNull = (snap) => (snap.exists ? snap.data() : null);

  function unitOfWork(tx) {
    return {
      getMember: async (t, uid) => dataOrNull(await tx.get(memberRef(t, uid))),
      getInvitation: async (t, id) => dataOrNull(await tx.get(inviteRef(t, id))),
      async countActiveAdmins(t, { excludeUid }) {
        const snap = await tx.get(activeAdmins(t));
        return snap.docs.filter((d) => d.id !== excludeUid).length;
      },
      saveMember(t, member) {
        tx.set(memberRef(t, member.uid), stripUndefined(member));
        tx.set(mirrorRef(member.uid, t), { tenantId: t, role: member.role, status: member.status, updatedAt: member.updatedAt });
      },
      deleteMember(t, uid) {
        tx.delete(memberRef(t, uid));
        tx.delete(mirrorRef(uid, t));
      },
      saveInvitation: (t, inv) => { tx.set(inviteRef(t, inv.id), stripUndefined(inv)); },
      updateInvitation: (t, id, patch) => { tx.set(inviteRef(t, id), stripUndefined(patch), { merge: true }); },
      recordEvent: (t, event) => { tx.set(db.collection(`tenants/${t}/authEvents`).doc(), stripUndefined(event)); },
    };
  }

  return {
    getMember: async (t, uid) => dataOrNull(await memberRef(t, uid).get()),
    listMembers: async (t) => (await members(t).get()).docs.map((d) => d.data()),
    listPendingInvitations: async (t) => (await pending(t).get()).docs.map((d) => d.data()),
    findPendingInvitationIds: async (t, email) => (await pending(t).where('email', '==', email).get()).docs.map((d) => d.id),
    listMemberships: async (uid) => (await db.collection(`userTenants/${uid}/memberships`).get()).docs.map((d) => d.data()),
    transaction: (work) => db.runTransaction((tx) => work(unitOfWork(tx))),
  };
}

module.exports = { createFirestoreAuthStore };
