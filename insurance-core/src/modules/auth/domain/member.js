'use strict';

/**
 * Member: a person's role at one insurer.
 *   { uid, email, role, status, createdAt, createdBy, updatedAt, updatedBy }
 */

const MEMBER_STATUSES = Object.freeze(['active', 'disabled']);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const UID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;

const normalizeEmail = (e) => String(e || '').trim().toLowerCase();
const isValidEmail = (e) => EMAIL_RE.test(e);
const isValidUid = (uid) => UID_RE.test(uid || '');
const isValidStatus = (s) => MEMBER_STATUSES.includes(s);
const isActiveAdmin = (m) => !!m && m.role === 'tenant_admin' && m.status === 'active';

/** The member document after a change by `actorUid`; createdAt/createdBy are kept from `before`. */
function nextMember({ before, uid, email, role, status, nowIso, actorUid, createdBy }) {
  return {
    uid, email, role, status,
    createdAt: before ? before.createdAt : nowIso,
    createdBy: before ? before.createdBy : createdBy,
    updatedAt: nowIso, updatedBy: actorUid,
  };
}

/** The public view of a member (what listing returns). */
const memberSummary = (m) => ({ uid: m.uid, email: m.email, role: m.role, status: m.status, updatedAt: m.updatedAt });

module.exports = { MEMBER_STATUSES, normalizeEmail, isValidEmail, isValidUid, isValidStatus, isActiveAdmin, nextMember, memberSummary };
