'use strict';

const crypto = require('crypto');
const { AppError, TENANT_ID_RE, ID_RE, newId, sha256, safeEqual, stripUndefined } = require('../server/util');
const { ROLES, can, isTenantRole, isPlatformRole } = require('./roles');

/**
 * Authentication and authorization for staff.
 *
 * Firebase Auth proves WHO someone is (password, MFA). This module decides WHAT they may do:
 *   - authorize(): checks, on every call, the verified email, MFA, the user's role at THAT insurer
 *     (read live from Firestore, so revocation is instant) or a global platform role
 *   - invitations: the only way to give someone a role. The invite goes to an email address and
 *     only the owner of that verified address, holding the secret token, can accept it
 *   - member management with escalation guards, a last-admin guard and an audit trail
 *
 * Firestore layout:
 *   tenants/{t}/members/{uid}              { uid, email, role, status, createdAt, createdBy, updatedAt, updatedBy }
 *   userTenants/{uid}/memberships/{t}      mirror, so a user can list their insurers { tenantId, role, status }
 *   tenants/{t}/invitations/{id}           { email, role, tokenHash, status, createdAt, expiresAt, createdBy }
 *   tenants/{t}/authEvents/{id}            append-only audit of every access change
 */

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const UID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
const MEMBER_STATUSES = ['active', 'disabled'];

const normEmail = (e) => String(e || '').trim().toLowerCase();

function createAuthService({ db, authAdmin = null, now = () => new Date(), requireMfa = true, logger = console }) {
  const memberRef = (t, uid) => db.doc(`tenants/${t}/members/${uid}`);
  const mirrorRef = (uid, t) => db.doc(`userTenants/${uid}/memberships/${t}`);
  const inviteRef = (t, id) => db.doc(`tenants/${t}/invitations/${id}`);
  const newEventRef = (t) => db.collection(`tenants/${t}/authEvents`).doc();
  const iso = () => now().toISOString();

  const audit = (tx, tenantId, ctx, type, target, details) => tx.set(newEventRef(tenantId), stripUndefined({
    type,
    actor: { uid: ctx.uid, role: ctx.role, source: ctx.source },
    target, details,
    reason: ctx.reason,
    at: iso(),
  }));

  // ---------- authorization ----------

  /**
   * Returns { uid, email, role, source, tenantId, permissions, reason } or throws AppError.
   * Errors use stable messages the front end can react to: EMAIL_NOT_VERIFIED, MFA_REQUIRED,
   * REASON_REQUIRED, FORBIDDEN (also used when the insurer does not exist: no probing).
   */
  async function authorize({ auth, tenantId, permission, reason }) {
    if (!auth || !auth.uid) throw new AppError('unauthenticated', 'Sign in first.');
    if (!TENANT_ID_RE.test(tenantId || '')) throw new AppError('invalid-argument', 'Invalid tenant.');
    const token = auth.token || {};
    if (token.email_verified !== true) throw new AppError('permission-denied', 'EMAIL_NOT_VERIFIED');

    const snap = await memberRef(tenantId, auth.uid).get();
    const member = snap.exists ? snap.data() : null;

    const candidates = [];
    if (member && member.status === 'active' && isTenantRole(member.role)) candidates.push({ role: member.role, source: 'member' });
    if (isPlatformRole(token.platformRole)) candidates.push({ role: token.platformRole, source: 'platform' });

    const hit = candidates.find((c) => can(c.role, permission));
    if (!hit) throw new AppError('permission-denied', 'FORBIDDEN');
    if (requireMfa && ROLES[hit.role].mfa && !(token.firebase && token.firebase.sign_in_second_factor)) {
      throw new AppError('permission-denied', 'MFA_REQUIRED');
    }
    // Platform staff acting on an insurer must say why; the reason lands in the audit trail.
    if (hit.source === 'platform' && !(typeof reason === 'string' && reason.trim().length >= 5)) {
      throw new AppError('invalid-argument', 'REASON_REQUIRED');
    }
    return {
      uid: auth.uid, email: token.email, role: hit.role, source: hit.source, tenantId,
      permissions: ROLES[hit.role].permissions, reason: typeof reason === 'string' ? reason.trim() : undefined,
    };
  }

  function assertGrantable(ctx, role) {
    if (!ROLES[role] || !isTenantRole(role)) throw new AppError('invalid-argument', 'Unknown role.');
    if (!ROLES[ctx.role].grantable.includes(role)) throw new AppError('permission-denied', 'ROLE_NOT_GRANTABLE');
  }

  async function revokeSessions(uid) {
    if (!authAdmin) return;
    try { await authAdmin.revokeRefreshTokens(uid); } catch (err) { logger.error(`revokeRefreshTokens(${uid}) failed: ${err.message}`); }
  }

  // ---------- invitations ----------

  async function invite({ auth, tenantId, email, role, reason }) {
    const ctx = await authorize({ auth, tenantId, permission: 'members:manage', reason });
    const address = normEmail(email);
    if (!EMAIL_RE.test(address)) throw new AppError('invalid-argument', 'Invalid email address.');
    assertGrantable(ctx, role);

    const token = crypto.randomBytes(24).toString('base64url');
    const id = newId();
    const expiresAt = new Date(now().getTime() + INVITE_TTL_MS).toISOString();
    const older = await db.collection(`tenants/${tenantId}/invitations`).where('email', '==', address).where('status', '==', 'pending').get();

    await db.runTransaction(async (tx) => {
      for (const d of older.docs) tx.set(inviteRef(tenantId, d.id), { status: 'revoked', revokedAt: iso(), revokedBy: ctx.uid }, { merge: true });
      tx.set(inviteRef(tenantId, id), { id, email: address, role, tokenHash: sha256(token), status: 'pending', createdAt: iso(), expiresAt, createdBy: ctx.uid });
      audit(tx, tenantId, ctx, 'invitation_created', { email: address }, { role, invitationId: id, supersedes: older.docs.map((d) => d.id) });
    });
    // The token is returned ONCE and only its hash is stored. Send it to the invitee (email) and nowhere else.
    return { invitationId: id, token, expiresAt };
  }

  async function revokeInvitation({ auth, tenantId, invitationId, reason }) {
    const ctx = await authorize({ auth, tenantId, permission: 'members:manage', reason });
    if (!ID_RE.test(invitationId || '')) throw new AppError('invalid-argument', 'Invalid invitation.');
    await db.runTransaction(async (tx) => {
      const inv = await tx.get(inviteRef(tenantId, invitationId));
      if (!inv.exists || inv.data().status !== 'pending') throw new AppError('failed-precondition', 'INVITATION_INVALID');
      tx.set(inviteRef(tenantId, invitationId), { status: 'revoked', revokedAt: iso(), revokedBy: ctx.uid }, { merge: true });
      audit(tx, tenantId, ctx, 'invitation_revoked', { email: inv.data().email }, { invitationId });
    });
    return { ok: true };
  }

  /** The invitee, signed in with the invited and VERIFIED email, redeems the token. */
  async function acceptInvitation({ auth, tenantId, invitationId, token }) {
    if (!auth || !auth.uid) throw new AppError('unauthenticated', 'Sign in first.');
    if (!TENANT_ID_RE.test(tenantId || '') || !ID_RE.test(invitationId || '') || typeof token !== 'string' || token.length < 20 || token.length > 128) {
      throw new AppError('invalid-argument', 'Invalid invitation.');
    }
    const t = auth.token || {};
    if (t.email_verified !== true || !t.email) throw new AppError('permission-denied', 'EMAIL_NOT_VERIFIED');

    return db.runTransaction(async (tx) => {
      const [inv, member] = await Promise.all([tx.get(inviteRef(tenantId, invitationId)), tx.get(memberRef(tenantId, auth.uid))]);
      const invalid = () => new AppError('failed-precondition', 'INVITATION_INVALID'); // one message for every failure
      if (!inv.exists) throw invalid();
      const d = inv.data();
      if (d.status !== 'pending' || d.expiresAt <= iso() || normEmail(t.email) !== d.email || !safeEqual(sha256(token), d.tokenHash)) throw invalid();

      const before = member.exists ? member.data() : null;
      const ctx = { uid: auth.uid, role: d.role, source: 'invitation' };
      tx.set(memberRef(tenantId, auth.uid), stripUndefined({
        uid: auth.uid, email: d.email, role: d.role, status: 'active',
        createdAt: before ? before.createdAt : iso(), createdBy: before ? before.createdBy : d.createdBy,
        updatedAt: iso(), updatedBy: auth.uid,
      }));
      tx.set(mirrorRef(auth.uid, tenantId), { tenantId, role: d.role, status: 'active', updatedAt: iso() });
      tx.set(inviteRef(tenantId, invitationId), { status: 'accepted', acceptedAt: iso(), acceptedBy: auth.uid }, { merge: true });
      audit(tx, tenantId, ctx, before ? 'role_changed' : 'member_added', { uid: auth.uid, email: d.email },
        { invitationId, before: before ? { role: before.role, status: before.status } : null, after: { role: d.role, status: 'active' } });
      return { tenantId, role: d.role };
    });
  }

  // ---------- member management ----------

  /**
   * Shared guard for role change, disable/enable and removal.
   * apply(current) returns the next member document, or null to delete the member.
   */
  async function mutateMember({ auth, tenantId, uid, reason, type, apply }) {
    const ctx = await authorize({ auth, tenantId, permission: 'members:manage', reason });
    if (!UID_RE.test(uid || '')) throw new AppError('invalid-argument', 'Invalid user.');
    if (uid === ctx.uid) throw new AppError('permission-denied', 'CANNOT_CHANGE_SELF'); // no self-promotion, no self-lockout

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(memberRef(tenantId, uid));
      if (!snap.exists) throw new AppError('not-found', 'Member not found.');
      const current = snap.data();
      if (!ROLES[ctx.role].grantable.includes(current.role)) throw new AppError('permission-denied', 'ROLE_NOT_MANAGEABLE');

      const next = apply(current, ctx);
      const wasActiveAdmin = current.role === 'tenant_admin' && current.status === 'active';
      const stillActiveAdmin = !!next && next.role === 'tenant_admin' && next.status === 'active';
      if (wasActiveAdmin && !stillActiveAdmin) {
        const admins = await tx.get(db.collection(`tenants/${tenantId}/members`).where('role', '==', 'tenant_admin').where('status', '==', 'active'));
        if (admins.docs.filter((d) => d.id !== uid).length === 0) throw new AppError('failed-precondition', 'LAST_ADMIN'); // never lock an insurer out
      }

      if (next) {
        const doc = stripUndefined({ ...current, ...next, updatedAt: iso(), updatedBy: ctx.uid });
        tx.set(memberRef(tenantId, uid), doc);
        tx.set(mirrorRef(uid, tenantId), { tenantId, role: doc.role, status: doc.status, updatedAt: iso() });
      } else {
        tx.delete(memberRef(tenantId, uid));
        tx.delete(mirrorRef(uid, tenantId));
      }
      audit(tx, tenantId, ctx, type, { uid, email: current.email },
        { before: { role: current.role, status: current.status }, after: next ? { role: next.role, status: next.status } : null });
      return { removed: !next, disabled: !!next && next.status === 'disabled' };
    });

    if (result.removed || result.disabled) await revokeSessions(uid);
    return { ok: true };
  }

  const changeRole = ({ auth, tenantId, uid, role, reason }) => mutateMember({
    auth, tenantId, uid, reason, type: 'role_changed',
    apply: (current, ctx) => { assertGrantable(ctx, role); return { role }; },
  });

  const setStatus = async ({ auth, tenantId, uid, status, reason }) => {
    if (!MEMBER_STATUSES.includes(status)) throw new AppError('invalid-argument', 'status must be active or disabled.');
    return mutateMember({ auth, tenantId, uid, reason, type: status === 'disabled' ? 'member_disabled' : 'member_enabled', apply: () => ({ status }) });
  };

  const removeMember = ({ auth, tenantId, uid, reason }) => mutateMember({ auth, tenantId, uid, reason, type: 'member_removed', apply: () => null });

  // ---------- reads ----------

  async function listMembers({ auth, tenantId, reason }) {
    await authorize({ auth, tenantId, permission: 'members:read', reason });
    const [members, invites] = await Promise.all([
      db.collection(`tenants/${tenantId}/members`).get(),
      db.collection(`tenants/${tenantId}/invitations`).where('status', '==', 'pending').get(),
    ]);
    return {
      members: members.docs.map((d) => { const m = d.data(); return { uid: m.uid, email: m.email, role: m.role, status: m.status, updatedAt: m.updatedAt }; }),
      invitations: invites.docs.map((d) => { const i = d.data(); return { id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt }; }), // never the token hash
    };
  }

  /**
   * The insurers the signed-in user belongs to, with display names and the permissions of their
   * role (so the dashboard never duplicates the role matrix). No tenant permission needed.
   */
  async function myTenants({ auth }) {
    if (!auth || !auth.uid) throw new AppError('unauthenticated', 'Sign in first.');
    const snap = await db.collection(`userTenants/${auth.uid}/memberships`).get();
    const active = snap.docs.map((d) => d.data()).filter((m) => m.status === 'active' && ROLES[m.role]);
    const tenantDocs = await Promise.all(active.map((m) => db.doc(`tenants/${m.tenantId}`).get()));
    const platformRole = isPlatformRole(auth.token && auth.token.platformRole) ? auth.token.platformRole : null;
    return {
      memberships: active.map((m, i) => ({
        tenantId: m.tenantId,
        name: tenantDocs[i].exists && tenantDocs[i].data().name ? tenantDocs[i].data().name : m.tenantId,
        role: m.role,
        permissions: ROLES[m.role].permissions,
      })),
      platformRole,
      platformPermissions: platformRole ? ROLES[platformRole].permissions : [],
    };
  }

  /** Platform staff only: every insurer, for the dashboard's tenant switcher. */
  async function allTenants({ auth }) {
    if (!auth || !auth.uid) throw new AppError('unauthenticated', 'Sign in first.');
    const token = auth.token || {};
    if (token.email_verified !== true) throw new AppError('permission-denied', 'EMAIL_NOT_VERIFIED');
    if (!isPlatformRole(token.platformRole)) throw new AppError('permission-denied', 'FORBIDDEN');
    if (requireMfa && !(token.firebase && token.firebase.sign_in_second_factor)) throw new AppError('permission-denied', 'MFA_REQUIRED');
    const snap = await db.collection('tenants').limit(500).get();
    return {
      tenants: snap.docs.map((d) => {
        const t = d.data();
        return { tenantId: d.id, name: t.name || d.id, demo: !!t.demo, status: t.status || 'active' };
      }).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** Creates a member directly: for the first admin of an insurer (scripts) and for tests. Not exposed over HTTP. */
  async function bootstrapMember({ tenantId, uid, email, role }) {
    if (!TENANT_ID_RE.test(tenantId || '') || !UID_RE.test(uid || '') || !isTenantRole(role)) throw new AppError('invalid-argument', 'Invalid arguments.');
    const ctx = { uid: 'bootstrap', role: null, source: 'bootstrap' };
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(memberRef(tenantId, uid));
      tx.set(memberRef(tenantId, uid), stripUndefined({
        uid, email: normEmail(email) || undefined, role, status: 'active',
        createdAt: existing.exists ? existing.data().createdAt : iso(), createdBy: 'bootstrap', updatedAt: iso(), updatedBy: 'bootstrap',
      }));
      tx.set(mirrorRef(uid, tenantId), { tenantId, role, status: 'active', updatedAt: iso() });
      audit(tx, tenantId, ctx, existing.exists ? 'role_changed' : 'member_added', { uid, email: normEmail(email) || undefined }, { after: { role, status: 'active' } });
    });
  }

  /** Single entry point for the `members` callable: { action, ...fields }. */
  async function handle({ auth, data }) {
    const d = data || {};
    const common = { auth, tenantId: d.tenantId, reason: d.reason };
    switch (d.action) {
      case 'myTenants': return myTenants({ auth });
      case 'allTenants': return allTenants({ auth });
      case 'list': return listMembers(common);
      case 'invite': return invite({ ...common, email: d.email, role: d.role });
      case 'accept': return acceptInvitation({ auth, tenantId: d.tenantId, invitationId: d.invitationId, token: d.token });
      case 'revokeInvitation': return revokeInvitation({ ...common, invitationId: d.invitationId });
      case 'changeRole': return changeRole({ ...common, uid: d.uid, role: d.role });
      case 'setStatus': return setStatus({ ...common, uid: d.uid, status: d.status });
      case 'remove': return removeMember({ ...common, uid: d.uid });
      default: throw new AppError('invalid-argument', 'Unknown action.');
    }
  }

  return { authorize, invite, revokeInvitation, acceptInvitation, changeRole, setStatus, removeMember, listMembers, myTenants, allTenants, bootstrapMember, handle };
}

module.exports = { createAuthService, INVITE_TTL_MS };
