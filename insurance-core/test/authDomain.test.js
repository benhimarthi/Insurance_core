'use strict';

/** Unit tests of the auth domain: pure functions, no database, no Firebase. */
const test = require('node:test');
const assert = require('node:assert');
const { resolveAccess, assertCanGrant, assertCanManage, assertNotSelf, assertNotLastAdmin, requirePlatformRole } = require('../src/modules/auth/domain/accessPolicy');
const { createIdentity } = require('../src/modules/auth/domain/identity');
const { isRedeemable, expiryFrom, INVITE_TTL_MS } = require('../src/modules/auth/domain/invitation');
const { isActiveAdmin, normalizeEmail, isValidEmail } = require('../src/modules/auth/domain/member');

const staff = (over = {}) => createIdentity({ uid: 'u1', email: 'u1@x.example', emailVerified: true, secondFactor: true, ...over });
const err = (fn) => { try { fn(); } catch (e) { return `${e.code}:${e.message}`; } return 'no error'; };

test('domain: resolveAccess picks the membership, then the platform role, and enforces MFA and reasons', () => {
  const uw = { role: 'underwriter', status: 'active' };
  assert.deepStrictEqual(resolveAccess({ identity: staff(), member: uw, permission: 'case:decide', requireMfa: true }), { role: 'underwriter', source: 'member', reason: undefined });
  assert.strictEqual(err(() => resolveAccess({ identity: staff({ emailVerified: false }), member: uw, permission: 'case:decide', requireMfa: true })), 'permission-denied:EMAIL_NOT_VERIFIED');
  assert.strictEqual(err(() => resolveAccess({ identity: staff(), member: { ...uw, status: 'disabled' }, permission: 'case:decide', requireMfa: true })), 'permission-denied:FORBIDDEN');
  assert.strictEqual(err(() => resolveAccess({ identity: staff({ secondFactor: false }), member: uw, permission: 'case:decide', requireMfa: true })), 'permission-denied:MFA_REQUIRED');
  assert.strictEqual(resolveAccess({ identity: staff({ secondFactor: false }), member: uw, permission: 'case:decide', requireMfa: false }).role, 'underwriter');

  const plat = staff({ platformRole: 'platform_admin' });
  assert.strictEqual(err(() => resolveAccess({ identity: plat, member: null, permission: 'members:manage', requireMfa: true })), 'invalid-argument:REASON_REQUIRED');
  assert.deepStrictEqual(resolveAccess({ identity: plat, member: null, permission: 'members:manage', reason: '  ticket 42 ', requireMfa: true }), { role: 'platform_admin', source: 'platform', reason: 'ticket 42' });
  assert.strictEqual(err(() => resolveAccess({ identity: plat, member: null, permission: 'case:read', reason: 'ticket 42', requireMfa: true })), 'permission-denied:FORBIDDEN');
  assert.strictEqual(err(() => resolveAccess({ identity: staff({ platformRole: 'god' }), member: null, permission: 'members:read', requireMfa: true })), 'permission-denied:FORBIDDEN');
});

test('domain: grant, manage, self and last-admin guards', () => {
  assert.strictEqual(err(() => assertCanGrant('tenant_admin', 'underwriter')), 'no error');
  assert.strictEqual(err(() => assertCanGrant('tenant_admin', 'platform_admin')), 'invalid-argument:Unknown role.');
  assert.strictEqual(err(() => assertCanGrant('underwriting_manager', 'underwriter')), 'permission-denied:ROLE_NOT_GRANTABLE');
  assert.strictEqual(err(() => assertCanManage('auditor', 'underwriter')), 'permission-denied:ROLE_NOT_MANAGEABLE');
  assert.strictEqual(err(() => assertNotSelf('a', 'a')), 'permission-denied:CANNOT_CHANGE_SELF');
  assert.strictEqual(err(() => assertNotLastAdmin({ wasActiveAdmin: true, stillActiveAdmin: false, otherActiveAdmins: 0 })), 'failed-precondition:LAST_ADMIN');
  assert.strictEqual(err(() => assertNotLastAdmin({ wasActiveAdmin: true, stillActiveAdmin: false, otherActiveAdmins: 1 })), 'no error');
  assert.ok(isActiveAdmin({ role: 'tenant_admin', status: 'active' }) && !isActiveAdmin({ role: 'tenant_admin', status: 'disabled' }) && !isActiveAdmin(null));
  assert.strictEqual(err(() => requirePlatformRole({ identity: staff(), requireMfa: true })), 'permission-denied:FORBIDDEN');
});

test('domain: invitations redeem only when pending, unexpired, for the right email and token', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const inv = { status: 'pending', email: 'a@x.example', tokenHash: 'H', expiresAt: expiryFrom(now) };
  assert.strictEqual(new Date(inv.expiresAt) - now, INVITE_TTL_MS);
  const ok = { email: 'a@x.example', token: 't', nowIso: now.toISOString(), tokenMatches: (t, h) => t === 't' && h === 'H' };
  assert.ok(isRedeemable(inv, ok));
  assert.ok(!isRedeemable(null, ok));
  assert.ok(!isRedeemable({ ...inv, status: 'accepted' }, ok));
  assert.ok(!isRedeemable(inv, { ...ok, email: 'b@x.example' }));
  assert.ok(!isRedeemable(inv, { ...ok, token: 'u' }));
  assert.ok(!isRedeemable(inv, { ...ok, nowIso: inv.expiresAt }));
  assert.strictEqual(normalizeEmail('  A@X.Example '), 'a@x.example');
  assert.ok(isValidEmail('a@x.example') && !isValidEmail('a@x'));
});
