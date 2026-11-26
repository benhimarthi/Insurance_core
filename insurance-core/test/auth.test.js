'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeEnv, referredCase, TENANT } = require('./serverHelpers');
const { PERMISSIONS, ROLES, TENANT_ROLES, can } = require('../src/auth/roles');
const { INVITE_TTL_MS } = require('../src/auth/service');
const config = require('../config/tenants/demo-insurer/motor.json');

const code = (fn) => fn.then(() => assert.fail('should have thrown'), (e) => e.code);
const msg = (fn) => fn.then(() => assert.fail('should have thrown'), (e) => `${e.code}:${e.message}`);
const OTHER = 'other-insurer';

/** An env where each insurer has one admin, ready to manage people. */
function setup() {
  const env = makeEnv();
  env.seedMember(TENANT, 'admin-1', 'tenant_admin');
  env.seedMember(OTHER, 'admin-2', 'tenant_admin');
  env.admin = (tenantId = TENANT) => env.user(tenantId === TENANT ? 'admin-1' : 'admin-2');
  env.platform = (uid = 'plat-1') => env.user(uid, { platformRole: 'platform_admin' });
  env.platform_noMfa = () => env.user('plat-2', { platformRole: 'platform_admin', firebase: {} });
  env.events = (tenantId = TENANT) => env.db.list(`tenants/${tenantId}/authEvents`);
  /** invite + accept in one go: how a new person gets a role */
  env.join = async (tenantId, uid, role) => {
    const inv = await env.authService.invite({ auth: env.admin(tenantId), tenantId, email: `${uid}@insurer.example`, role });
    await env.authService.acceptInvitation({ auth: env.user(uid), tenantId, invitationId: inv.invitationId, token: inv.token });
  };
  return env;
}

// ---------- the role matrix ----------

test('role matrix: sane, least-privilege invariants', () => {
  for (const [name, role] of Object.entries(ROLES)) {
    assert.ok(role.permissions.every((p) => PERMISSIONS.includes(p)), `${name} uses unknown permissions`);
    assert.strictEqual(role.mfa, true, `${name} must require MFA`);
    assert.ok(role.grantable.every((r) => TENANT_ROLES.includes(r)), `${name} can grant a non-tenant role`);
  }
  for (const p of ROLES.underwriter.permissions) assert.ok(can('underwriting_manager', p), `manager lacks ${p}`);
  assert.ok(can('underwriting_manager', 'case:decide_high') && !can('underwriter', 'case:decide_high'));
  assert.ok(can('underwriting_manager', 'config:write') && !can('underwriter', 'config:write'));
  // auditors only read
  for (const p of ROLES.auditor.permissions) assert.ok(p.endsWith(':read'), `auditor has ${p}`);
  // separation of duties: whoever manages people cannot decide cases, and vice versa
  assert.ok(!can('tenant_admin', 'case:decide') && !can('tenant_admin', 'config:write'));
  assert.ok(!can('underwriter', 'members:manage') && !can('underwriting_manager', 'members:manage'));
  // your team has no customer data access by default
  for (const p of ['case:read', 'case:decide', 'policy:read', 'audit:read']) assert.ok(!can('platform_admin', p), `platform_admin has ${p}`);
  assert.ok(!can('unknown_role', 'case:read'));
});

// ---------- authorize ----------

test('authorize: every way to be refused', async () => {
  const env = setup();
  const a = (auth, over = {}) => env.authService.authorize({ auth, tenantId: TENANT, permission: 'case:decide', ...over });

  assert.strictEqual(await code(a(null)), 'unauthenticated');
  assert.strictEqual(await code(a(env.underwriter(), { tenantId: '../x' })), 'invalid-argument');
  assert.strictEqual(await msg(a({ uid: 'uw-1', token: { email_verified: false } })), 'permission-denied:EMAIL_NOT_VERIFIED');
  assert.strictEqual(await msg(a({ uid: 'uw-1' })), 'permission-denied:EMAIL_NOT_VERIFIED');
  assert.strictEqual(await msg(a(env.underwriter('stranger'))), 'permission-denied:FORBIDDEN');
  assert.strictEqual(await msg(a(env.user('admin-1'))), 'permission-denied:FORBIDDEN'); // an admin cannot decide cases
  assert.strictEqual(await msg(a(env.user('uw-1', { firebase: {} }))), 'permission-denied:MFA_REQUIRED');
  assert.strictEqual(await msg(a(env.underwriter(), { tenantId: OTHER })), 'permission-denied:FORBIDDEN'); // member of A only
  assert.strictEqual(await msg(a(env.underwriter(), { tenantId: 'ghost-insurer' })), 'permission-denied:FORBIDDEN'); // same answer: no probing

  const ctx = await a(env.underwriter());
  assert.deepStrictEqual([ctx.uid, ctx.role, ctx.source, ctx.tenantId], ['uw-1', 'underwriter', 'member', TENANT]);
});

test('authorize: a disabled member loses access immediately; MFA can be switched off for early demos', async () => {
  const env = setup();
  const ask = () => env.authService.authorize({ auth: env.underwriter(), tenantId: TENANT, permission: 'case:read' });
  await ask();
  env.seedMember(TENANT, 'uw-1', 'underwriter', 'disabled');
  assert.strictEqual(await msg(ask()), 'permission-denied:FORBIDDEN');

  const { createAuthService } = require('../src/auth/service');
  const relaxed = createAuthService({ db: env.db, requireMfa: false });
  env.seedMember(TENANT, 'uw-1', 'underwriter');
  await relaxed.authorize({ auth: env.user('uw-1', { firebase: {} }), tenantId: TENANT, permission: 'case:read' });
});

test('platform role: manages access but needs a reason and has no case access', async () => {
  const env = setup();
  const p = (permission, reason) => env.authService.authorize({ auth: env.platform(), tenantId: TENANT, permission, reason });
  assert.strictEqual(await msg(p('members:manage')), 'invalid-argument:REASON_REQUIRED');
  assert.strictEqual(await msg(p('members:manage', 'ok')), 'invalid-argument:REASON_REQUIRED');
  const ctx = await p('members:manage', 'Onboarding the first admin');
  assert.deepStrictEqual([ctx.role, ctx.source, ctx.reason], ['platform_admin', 'platform', 'Onboarding the first admin']);
  assert.strictEqual(await msg(p('case:read', 'Debugging a customer issue')), 'permission-denied:FORBIDDEN');
  assert.strictEqual(await msg(p('case:decide', 'Debugging a customer issue')), 'permission-denied:FORBIDDEN');
  // a forged or unknown platform claim grants nothing
  const fake = env.user('x', { platformRole: 'super_root' });
  assert.strictEqual(await msg(env.authService.authorize({ auth: fake, tenantId: TENANT, permission: 'members:read', reason: 'whatever' })), 'permission-denied:FORBIDDEN');
  const tenantRoleAsPlatform = env.user('y', { platformRole: 'tenant_admin' });
  assert.strictEqual(await msg(env.authService.authorize({ auth: tenantRoleAsPlatform, tenantId: TENANT, permission: 'members:read', reason: 'whatever' })), 'permission-denied:FORBIDDEN');
});

// ---------- invitations ----------

test('invitation: only the verified owner of the invited email, with the secret token, can join', async () => {
  const env = setup();
  const inv = await env.authService.invite({ auth: env.admin(), tenantId: TENANT, email: '  Sara@Insurer.example ', role: 'underwriter' });
  assert.match(inv.token, /^[A-Za-z0-9_-]{32}$/);
  assert.strictEqual(inv.expiresAt, new Date(env.now().getTime() + INVITE_TTL_MS).toISOString());

  const stored = env.db.docs.get(`tenants/${TENANT}/invitations/${inv.invitationId}`);
  assert.strictEqual(stored.email, 'sara@insurer.example');
  assert.ok(!JSON.stringify(stored).includes(inv.token)); // only the hash is stored
  assert.match(stored.tokenHash, /^[0-9a-f]{64}$/);

  const accept = (auth, token = inv.token, id = inv.invitationId) => env.authService.acceptInvitation({ auth, tenantId: TENANT, invitationId: id, token });
  const sara = env.user('sara', { email: 'sara@insurer.example' });

  assert.strictEqual(await code(accept(null)), 'unauthenticated');
  assert.strictEqual(await msg(accept({ uid: 'sara', token: { email: 'sara@insurer.example', email_verified: false } })), 'permission-denied:EMAIL_NOT_VERIFIED');
  assert.strictEqual(await msg(accept(env.user('mallory', { email: 'mallory@evil.example' }))), 'failed-precondition:INVITATION_INVALID'); // wrong email
  assert.strictEqual(await msg(accept(sara, 'x'.repeat(32))), 'failed-precondition:INVITATION_INVALID');                                 // wrong token
  assert.strictEqual(await msg(accept(sara, inv.token, 'does-not-exist')), 'failed-precondition:INVITATION_INVALID');
  assert.strictEqual(await code(accept(sara, 'short')), 'invalid-argument');
  assert.strictEqual(env.db.docs.has(`tenants/${TENANT}/members/sara`), false);

  assert.deepStrictEqual(await accept(sara), { tenantId: TENANT, role: 'underwriter' });
  assert.strictEqual(env.db.docs.get(`tenants/${TENANT}/members/sara`).role, 'underwriter');
  assert.strictEqual(env.db.docs.get('userTenants/sara/memberships/demo-insurer').role, 'underwriter');
  assert.strictEqual(await msg(accept(sara)), 'failed-precondition:INVITATION_INVALID'); // single use

  const added = env.events().find((e) => e.type === 'member_added');
  assert.deepStrictEqual([added.actor.uid, added.actor.source, added.target.uid], ['sara', 'invitation', 'sara']);
});

test('invitation: expiry, revocation and re-invites', async () => {
  const env = setup();
  const invite = (email = 'lea@insurer.example', role = 'auditor') => env.authService.invite({ auth: env.admin(), tenantId: TENANT, email, role });
  const lea = env.user('lea', { email: 'lea@insurer.example' });
  const accept = (inv) => env.authService.acceptInvitation({ auth: lea, tenantId: TENANT, invitationId: inv.invitationId, token: inv.token });

  const old = await invite();
  const fresh = await invite(); // a new invite supersedes the old one
  assert.strictEqual(await msg(accept(old)), 'failed-precondition:INVITATION_INVALID');

  await env.authService.revokeInvitation({ auth: env.admin(), tenantId: TENANT, invitationId: fresh.invitationId });
  assert.strictEqual(await msg(accept(fresh)), 'failed-precondition:INVITATION_INVALID');

  const last = await invite();
  env.clock.now = new Date(env.clock.now.getTime() + INVITE_TTL_MS + 1000);
  assert.strictEqual(await msg(accept(last)), 'failed-precondition:INVITATION_INVALID'); // expired
  assert.strictEqual(await code(env.authService.revokeInvitation({ auth: env.admin(), tenantId: TENANT, invitationId: 'nope' })), 'failed-precondition');
});

// ---------- privilege rules ----------

test('who may invite whom: no escalation', async () => {
  const env = setup();
  const as = (auth, over) => env.authService.invite({ auth, tenantId: TENANT, email: 'new@insurer.example', role: 'underwriter', ...over });

  assert.strictEqual(await msg(as(env.underwriter())), 'permission-denied:FORBIDDEN');          // underwriters cannot invite
  assert.strictEqual(await msg(as(env.user('uw-1'), { role: 'tenant_admin' })), 'permission-denied:FORBIDDEN');
  await env.join(TENANT, 'mgr-1', 'underwriting_manager');
  assert.strictEqual(await msg(as(env.user('mgr-1'))), 'permission-denied:FORBIDDEN');          // managers cannot either
  await env.join(TENANT, 'aud-1', 'auditor');
  assert.strictEqual(await msg(as(env.user('aud-1'))), 'permission-denied:FORBIDDEN');

  for (const role of ['platform_admin', 'root', undefined, '']) {
    assert.strictEqual(await code(as(env.admin(), { role })), 'invalid-argument', `role ${role}`);
  }
  assert.strictEqual(await code(as(env.admin(), { email: 'not-an-email' })), 'invalid-argument');
  assert.strictEqual(await code(as(env.admin(OTHER), { tenantId: TENANT })), 'permission-denied'); // admin of another insurer
});

test('changing roles: guards for self, last admin, unknown users, and a full audit trail', async () => {
  const env = setup();
  await env.join(TENANT, 'uw-2', 'underwriter');
  const change = (uid, role, auth = env.admin()) => env.authService.changeRole({ auth, tenantId: TENANT, uid, role });

  await change('uw-2', 'underwriting_manager');
  assert.strictEqual(env.db.docs.get(`tenants/${TENANT}/members/uw-2`).role, 'underwriting_manager');
  assert.strictEqual(env.db.docs.get('userTenants/uw-2/memberships/demo-insurer').role, 'underwriting_manager');
  const ev = env.events().find((e) => e.type === 'role_changed' && e.target.uid === 'uw-2');
  assert.deepStrictEqual([ev.actor.uid, ev.details.before.role, ev.details.after.role], ['admin-1', 'underwriter', 'underwriting_manager']);

  assert.strictEqual(await msg(change('admin-1', 'underwriter')), 'permission-denied:CANNOT_CHANGE_SELF');
  assert.strictEqual(await code(change('ghost', 'auditor')), 'not-found');
  assert.strictEqual(await code(change('uw-2', 'platform_admin')), 'invalid-argument');

  // a second admin makes it possible to demote the first
  await env.join(TENANT, 'admin-3', 'tenant_admin');
  await change('admin-1', 'auditor', env.user('admin-3'));
  assert.strictEqual(env.db.docs.get(`tenants/${TENANT}/members/admin-1`).role, 'auditor');
  assert.strictEqual(await msg(env.authService.invite({ auth: env.admin(), tenantId: TENANT, email: 'z@insurer.example', role: 'auditor' })), 'permission-denied:FORBIDDEN'); // demoted: no longer manages people
  assert.strictEqual(await msg(change('admin-3', 'auditor', env.user('admin-3'))), 'permission-denied:CANNOT_CHANGE_SELF');
});

test('last tenant_admin cannot be demoted, disabled or removed', async () => {
  const env = setup();
  env.seedMember(TENANT, 'platform-added', 'tenant_admin', 'disabled'); // a disabled admin does not count as a spare
  const platform = env.platform();
  const reason = 'Cleaning up access';
  for (const run of [
    () => env.authService.changeRole({ auth: platform, tenantId: TENANT, uid: 'admin-1', role: 'auditor', reason }),
    () => env.authService.setStatus({ auth: platform, tenantId: TENANT, uid: 'admin-1', status: 'disabled', reason }),
    () => env.authService.removeMember({ auth: platform, tenantId: TENANT, uid: 'admin-1', reason }),
  ]) assert.strictEqual(await msg(run()), 'failed-precondition:LAST_ADMIN');
  assert.strictEqual(env.db.docs.get(`tenants/${TENANT}/members/admin-1`).role, 'tenant_admin');

  await env.join(TENANT, 'admin-4', 'tenant_admin'); // now there is a spare
  await env.authService.removeMember({ auth: platform, tenantId: TENANT, uid: 'admin-1', reason });
  assert.strictEqual(env.db.docs.has(`tenants/${TENANT}/members/admin-1`), false);
  assert.strictEqual(env.db.docs.has('userTenants/admin-1/memberships/demo-insurer'), false);
});

test('disable, enable and remove: instant effect, sessions revoked, audited', async () => {
  const env = setup();
  const can = () => env.authService.authorize({ auth: env.underwriter(), tenantId: TENANT, permission: 'case:decide' });
  await can();

  await env.authService.setStatus({ auth: env.admin(), tenantId: TENANT, uid: 'uw-1', status: 'disabled' });
  assert.strictEqual(await msg(can()), 'permission-denied:FORBIDDEN');
  assert.deepStrictEqual(env.revoked, ['uw-1']);
  assert.strictEqual(env.db.docs.get('userTenants/uw-1/memberships/demo-insurer').status, 'disabled');
  assert.deepStrictEqual((await env.authService.myTenants({ auth: env.underwriter() })).memberships, []);

  await env.authService.setStatus({ auth: env.admin(), tenantId: TENANT, uid: 'uw-1', status: 'active' });
  await can();
  assert.deepStrictEqual(env.revoked, ['uw-1']); // enabling does not revoke

  await env.authService.removeMember({ auth: env.admin(), tenantId: TENANT, uid: 'uw-1' });
  assert.strictEqual(await msg(can()), 'permission-denied:FORBIDDEN');
  assert.deepStrictEqual(env.events().map((e) => e.type).filter((t) => t.startsWith('member_')), ['member_disabled', 'member_enabled', 'member_removed']);
  assert.strictEqual(await code(env.authService.setStatus({ auth: env.admin(), tenantId: TENANT, uid: 'ghost', status: 'maybe' })), 'invalid-argument');
});

test('platform staff acting on an insurer leave a reason in the audit trail', async () => {
  const env = setup();
  const inv = await env.authService.invite({ auth: env.platform(), tenantId: TENANT, email: 'consultant@winnyx.example', role: 'auditor', reason: 'Support access for the pilot' });
  assert.ok(inv.token);
  const ev = env.events().find((e) => e.type === 'invitation_created');
  assert.deepStrictEqual([ev.actor.source, ev.actor.role, ev.reason], ['platform', 'platform_admin', 'Support access for the pilot']);
  assert.strictEqual(await msg(env.authService.invite({ auth: env.platform(), tenantId: TENANT, email: 'a@b.example', role: 'auditor' })), 'invalid-argument:REASON_REQUIRED');
});

// ---------- one person, several insurers ----------

test('multi-tenant: one person holds different roles at different insurers', async () => {
  const env = setup();
  await env.join(TENANT, 'consultant', 'underwriter');
  await env.join(OTHER, 'consultant', 'auditor');
  const me = env.user('consultant');

  await env.db.doc('tenants/demo-insurer').set({ name: 'Assurance Démo', status: 'active' });
  const tenants = await env.authService.myTenants({ auth: me });
  const mine = tenants.memberships.sort((a, b) => a.tenantId.localeCompare(b.tenantId));
  assert.deepStrictEqual(mine.map((m) => [m.tenantId, m.name, m.role]),
    [['demo-insurer', 'Assurance Démo', 'underwriter'], ['other-insurer', 'other-insurer', 'auditor']]); // name falls back to the id
  assert.deepStrictEqual(mine[0].permissions, ROLES.underwriter.permissions); // the dashboard never copies the role matrix
  assert.deepStrictEqual(mine[1].permissions, ROLES.auditor.permissions);
  assert.deepStrictEqual([tenants.platformRole, tenants.platformPermissions], [null, []]);

  const ask = (tenantId, permission) => env.authService.authorize({ auth: me, tenantId, permission });
  await ask(TENANT, 'case:decide');
  await ask(OTHER, 'audit:read');
  assert.strictEqual(await msg(ask(OTHER, 'case:decide')), 'permission-denied:FORBIDDEN'); // auditor there
  assert.strictEqual(await msg(ask(TENANT, 'audit:read')), 'permission-denied:FORBIDDEN'); // underwriter here

  // removing them from one insurer does not touch the other
  await env.authService.removeMember({ auth: env.admin(OTHER), tenantId: OTHER, uid: 'consultant' });
  await ask(TENANT, 'case:decide');
  assert.deepStrictEqual((await env.authService.myTenants({ auth: me })).memberships.map((m) => [m.tenantId, m.role]), [[TENANT, 'underwriter']]);
});

test('listing members never exposes invitation secrets; auditors may read, underwriters may not', async () => {
  const env = setup();
  await env.authService.invite({ auth: env.admin(), tenantId: TENANT, email: 'pending@insurer.example', role: 'underwriter' });
  await env.join(TENANT, 'aud-1', 'auditor');
  const list = await env.authService.listMembers({ auth: env.user('aud-1'), tenantId: TENANT });
  assert.deepStrictEqual(list.members.map((m) => m.uid).sort(), ['admin-1', 'aud-1', 'uw-1']);
  assert.strictEqual(list.invitations.length, 1);
  assert.ok(!JSON.stringify(list).match(/tokenHash|token"/));
  assert.strictEqual(await msg(env.authService.listMembers({ auth: env.underwriter(), tenantId: TENANT })), 'permission-denied:FORBIDDEN');
});

test('members callable: dispatches actions and rejects unknown ones', async () => {
  const env = setup();
  const call = (data, auth = env.admin()) => env.app.handleMembers({ auth, data });
  const inv = await call({ action: 'invite', tenantId: TENANT, email: 'x@insurer.example', role: 'underwriter' });
  await call({ action: 'accept', tenantId: TENANT, invitationId: inv.invitationId, token: inv.token }, env.user('x', { email: 'x@insurer.example' }));
  assert.strictEqual((await call({ action: 'list', tenantId: TENANT })).members.length, 3);
  await call({ action: 'changeRole', tenantId: TENANT, uid: 'x', role: 'auditor' });
  await call({ action: 'setStatus', tenantId: TENANT, uid: 'x', status: 'disabled' });
  await call({ action: 'remove', tenantId: TENANT, uid: 'x' });
  assert.strictEqual((await call({ action: 'myTenants' }, env.user('admin-1'))).memberships[0].role, 'tenant_admin');
  assert.strictEqual(await code(call({ action: 'dropDatabase', tenantId: TENANT })), 'invalid-argument');
  assert.strictEqual(await code(call(undefined)), 'invalid-argument');
});

// ---------- decisions: roles and premium limits ----------

test('underwriter decisions respect roles and the premium limit; the role is recorded', async () => {
  const limited = { ...config, authorization: { underwriterPremiumLimit: 4000 } };
  const env = makeEnv({ tenants: { [TENANT]: { tenant: { id: TENANT, name: 'Assurance Démo', demo: true, status: 'active', webchatKey: null }, config: limited } } });
  env.seedMember(TENANT, 'mgr-1', 'underwriting_manager');
  env.seedMember(TENANT, 'aud-1', 'auditor');
  const referred = await referredCase(env); // proposed premium 3696
  const decide = (auth, data) => env.app.handleUnderwriterDecision({ tenantId: TENANT, auth, data: { caseId: referred.id, ...data } });

  assert.strictEqual(await msg(decide(env.user('aud-1'), { decision: 'approve' })), 'permission-denied:FORBIDDEN');   // read-only
  assert.strictEqual(await msg(decide(env.underwriter(), { decision: 'adjust', adjustedPremium: 4500 })), 'permission-denied:LIMIT_EXCEEDED');
  assert.strictEqual(env.onlyCase().status, 'pending_review');                                                          // nothing changed

  await decide(env.user('mgr-1'), { decision: 'adjust', adjustedPremium: 4500 });                                       // a manager may
  assert.strictEqual(env.onlyCase().review.adjustedPremium, 4500);
  const event = env.db.list(`tenants/${TENANT}/cases/${referred.id}/events`).find((e) => e.type === 'human_decision');
  assert.deepStrictEqual([event.actor.id, event.payload.reviewerRole], ['mgr-1', 'underwriting_manager']);
});

test('underwriters can approve within the limit and always reject; a platform admin cannot decide', async () => {
  const env = makeEnv();
  const referred = await referredCase(env);
  const decide = (auth, data) => env.app.handleUnderwriterDecision({ tenantId: TENANT, auth, data: { caseId: referred.id, ...data } });
  assert.strictEqual(await msg(decide(env.user('plat-1', { platformRole: 'platform_admin' }), { decision: 'approve', reason: 'peeking' })), 'permission-denied:FORBIDDEN');
  assert.deepStrictEqual(await decide(env.underwriter(), { decision: 'approve' }), { ok: true, status: 'approved' });
});

test('allTenants: platform staff only, verified, MFA, sorted by name', async () => {
  const env = setup();
  await env.db.doc('tenants/zeta-insurer').set({ name: 'Zeta Assurance', status: 'active', demo: false });
  await env.db.doc('tenants/alpha-insurer').set({ name: 'Alpha Assurance', demo: true });
  const ask = (auth) => env.authService.allTenants({ auth });

  assert.strictEqual(await code(ask(null)), 'unauthenticated');
  assert.strictEqual(await msg(ask(env.admin())), 'permission-denied:FORBIDDEN');                       // tenant admins see only their insurer
  assert.strictEqual(await msg(ask(env.user('p', { platformRole: 'tenant_admin' }))), 'permission-denied:FORBIDDEN');
  assert.strictEqual(await msg(ask({ uid: 'p', token: { email_verified: false, platformRole: 'platform_admin' } })), 'permission-denied:EMAIL_NOT_VERIFIED');
  assert.strictEqual(await msg(ask(env.platform_noMfa())), 'permission-denied:MFA_REQUIRED');

  const { tenants } = await ask(env.platform());
  assert.deepStrictEqual(tenants.map((t) => t.name), ['Alpha Assurance', 'Zeta Assurance']);
  assert.deepStrictEqual(tenants[0], { tenantId: 'alpha-insurer', name: 'Alpha Assurance', demo: true, status: 'active' });
  assert.deepStrictEqual((await env.app.handleMembers({ auth: env.platform(), data: { action: 'allTenants' } })).tenants.length, 2);
  const mine = await env.authService.myTenants({ auth: env.platform() });
  assert.deepStrictEqual([mine.platformRole, mine.memberships, mine.platformPermissions], ['platform_admin', [], ROLES.platform_admin.permissions]);
});
