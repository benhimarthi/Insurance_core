'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { FakeFirestore } = require('./fakeFirestore');
const { createAuthModule } = require('../src/modules/auth');
const { createTenantsModule, createTenantLoader, validateRuleConfig } = require('../src/modules/tenants');
const template = require('../config/tenants/demo-insurer/motor.json');

const clone = (o) => JSON.parse(JSON.stringify(o));
const code = (p) => p.then(() => assert.fail('should have thrown'), (e) => `${e.code}:${e.message}`);
const caught = (p) => p.then(() => assert.fail('should have thrown'), (e) => e);
const pathsOf = (cfg) => validateRuleConfig(cfg).errors.map((e) => e.path);

/** Real auth module + tenants module over one fake Firestore, with a few staff members. */
function setup() {
  const db = new FakeFirestore();
  const clock = { now: new Date('2026-11-27T10:00:00Z') };
  const now = () => clock.now;
  const auth = createAuthModule({ db, now });
  const tenants = createTenantsModule({ db, now, configTemplate: template, authorize: ({ caller, ...rest }) => auth.authorize({ auth: caller, ...rest }) });
  const user = (uid, extra = {}) => ({ uid, token: { email: `${uid}@x.example`, email_verified: true, firebase: { sign_in_second_factor: 'totp' }, ...extra } });
  const seed = (t, uid, role) => {
    db.docs.set(`tenants/${t}/members/${uid}`, { uid, email: `${uid}@x.example`, role, status: 'active' });
    db.docs.set(`userTenants/${uid}/memberships/${t}`, { tenantId: t, role, status: 'active' });
  };
  const env = { db, clock, auth, tenants, user, seed, platform: user('plat', { platformRole: 'platform_admin' }) };
  env.create = (tenantId = 'acme-insure', over = {}) => tenants.createTenant({ auth: env.platform, tenantId, name: 'Acme Assurance', reason: 'onboarding ticket 1', ...over });
  return env;
}

// ---------- the validator ----------

test('rules validator: the demo config is valid; each kind of mistake is reported at its path', () => {
  assert.deepStrictEqual(validateRuleConfig(template), { ok: true, errors: [] });
  assert.deepStrictEqual(pathsOf(null), ['']);

  const c = clone(template);
  c.currency = 'dirham';
  c.policy.numberPrefix = 'A/B';                       // would break counter document ids
  c.risk.bands[1].maxScore = 5;                        // out of order
  c.eligibility[0].when.op = 'between';                // unknown operator
  c.eligibility[1].id = c.eligibility[0].id;           // duplicate id
  c.pricing.multipliers[0].when = { field: 'vehicle.category', op: 'in', value: 'suv' }; // "in" needs a list
  c.pricing.valueRate.unknown_cover = 0.01;            // not a coverage
  c.escalation.minConfidence = 7;
  c.documents.required.push('passport');
  c.zoneMap.nested = [['a']];                          // Firestore: no list in a list
  const got = pathsOf(c);
  for (const p of ['currency', 'policy.numberPrefix', 'risk.bands[1].maxScore', 'eligibility[0].when.op', 'eligibility[1].id',
    'pricing.multipliers[0].when.value', 'pricing.valueRate.unknown_cover', 'escalation.minConfidence', 'documents.required[2]', 'zoneMap.nested[0]']) {
    assert.ok(got.includes(p), `expected an error at ${p}, got ${got.join(', ')}`);
  }

  const missing = clone(template);
  delete missing.risk; delete missing.pricing; delete missing.branding;
  assert.ok(['risk', 'pricing', 'branding'].every((p) => pathsOf(missing).includes(p)));

  const lowTop = clone(template);
  lowTop.risk.bands[lowTop.risk.bands.length - 1].maxScore = 50; // high scores would have no band (engine crash)
  assert.ok(pathsOf(lowTop).some((p) => p.startsWith('risk.bands[')));

  const big = clone(template);
  big._padding = 'x'.repeat(210 * 1024);
  assert.ok(validateRuleConfig(big).errors.some((e) => /too large/.test(e.message)));
});

// ---------- creating insurers ----------

test('create insurer: platform team only, with a reason; starts from the template with its own name and prefix', async () => {
  const env = setup();
  env.seed('other-insurer', 'adm', 'tenant_admin');
  assert.strictEqual(await code(env.tenants.createTenant({ auth: env.user('adm'), tenantId: 'acme-insure', name: 'Acme', reason: 'trying it out' })), 'permission-denied:FORBIDDEN');
  assert.strictEqual(await code(env.create('acme-insure', { reason: '' })), 'invalid-argument:REASON_REQUIRED');
  assert.strictEqual(await code(env.create('Bad Id')), 'invalid-argument:Invalid tenant.');
  assert.strictEqual(await code(env.create('acme-insure', { name: ' ' })), 'invalid-argument:Invalid name.');

  const res = await env.create();
  assert.strictEqual(res.revision, 1);
  assert.match(res.webchatKey, /^[0-9a-f]{36}$/);
  assert.deepStrictEqual(env.db.docs.get('tenantSecrets/acme-insure'), { webchatKey: res.webchatKey });

  const t = env.db.docs.get('tenants/acme-insure');
  assert.strictEqual(t.name, 'Acme Assurance');
  assert.strictEqual(t.status, 'active');
  assert.strictEqual(t.createdBy, 'plat');
  const rules = env.db.docs.get('tenants/acme-insure/configs/motor');
  assert.strictEqual(rules.tenantId, 'acme-insure');
  assert.strictEqual(rules.branding.insurerName, 'Acme Assurance');
  assert.strictEqual(rules.policy.numberPrefix, 'ACMEINSU');
  assert.ok(!Object.keys(rules).some((k) => k.startsWith('_')), 'template notes are not copied');
  assert.deepStrictEqual(env.db.docs.get('tenants/acme-insure/configMeta/motor'), { revision: 1, updatedAt: '2026-11-27T10:00:00.000Z', updatedBy: 'plat', updatedByEmail: 'plat@x.example' });

  const [ev] = env.db.list('tenants/acme-insure/adminEvents');
  assert.strictEqual(ev.type, 'tenant_created');
  assert.strictEqual(ev.reason, 'onboarding ticket 1');
  assert.deepStrictEqual(ev.actor, { uid: 'plat', role: 'platform_admin', source: 'platform' });

  assert.strictEqual(await code(env.create()), 'already-exists:TENANT_EXISTS');
  const demo = await env.create('demo-two', { demo: true });
  assert.strictEqual(demo.webchatKey, null); // demo tenants accept keyless web chat
  assert.strictEqual(env.db.docs.get('tenantSecrets/demo-two'), undefined);

  const bad = clone(template); bad.currency = 'x';
  const e = await caught(env.create('bad-config', { config: bad }));
  assert.strictEqual(e.message, 'CONFIG_INVALID');
  assert.ok(e.details.errors.some((x) => x.path === 'currency'));
  assert.strictEqual(env.db.docs.get('tenants/bad-config'), undefined, 'nothing written');
});

test('an insurer created here is what the chat, payment and policy code loads', async () => {
  const env = setup();
  const { webchatKey } = await env.create();
  const load = createTenantLoader({ db: env.db, localDir: null });
  const loaded = await load('acme-insure');
  assert.strictEqual(loaded.tenant.name, 'Acme Assurance');
  assert.strictEqual(loaded.tenant.webchatKey, webchatKey);
  assert.strictEqual(loaded.tenant.demo, false);
  assert.strictEqual(loaded.config.branding.insurerName, 'Acme Assurance');

  await env.tenants.setTenantStatus({ auth: env.platform, tenantId: 'acme-insure', status: 'suspended', reason: 'contract ended' });
  assert.strictEqual(await createTenantLoader({ db: env.db, localDir: null })('acme-insure'), null, 'a suspended insurer stops answering');
});

// ---------- rules: read, change, history ----------

test('rules: who may read and change them, reasons, optimistic locking, invalid configs rejected', async () => {
  const env = setup();
  await env.create();
  env.seed('acme-insure', 'mgr', 'underwriting_manager');
  env.seed('acme-insure', 'adm', 'tenant_admin');
  env.seed('acme-insure', 'aud', 'auditor');
  env.seed('other-insurer', 'mgr-b', 'underwriting_manager');
  const T = { tenantId: 'acme-insure' };

  for (const uid of ['mgr', 'adm', 'aud']) {
    const r = await env.tenants.getRuleConfig({ auth: env.user(uid), ...T });
    assert.strictEqual(r.revision, 1);
    assert.strictEqual(r.config.tenantId, 'acme-insure');
  }
  assert.strictEqual(await code(env.tenants.getRuleConfig({ auth: env.user('mgr-b'), ...T })), 'permission-denied:FORBIDDEN', 'other insurers see nothing');
  assert.strictEqual(await code(env.tenants.getRuleConfig({ auth: null, ...T })), 'unauthenticated:Sign in first.');

  const next = clone((await env.tenants.getRuleConfig({ auth: env.user('mgr'), ...T })).config);
  next.pricing.policyFee = 175;
  next.tenantId = 'other-insurer'; // ignored: the platform owns it
  const save = (uid, over = {}) => env.tenants.updateRuleConfig({ auth: env.user(uid), ...T, config: next, expectedRevision: 1, reason: 'new fee from January', ...over });

  assert.strictEqual(await code(save('adm')), 'permission-denied:FORBIDDEN', 'tenant_admin manages people, not tariffs');
  assert.strictEqual(await code(save('aud')), 'permission-denied:FORBIDDEN');
  assert.strictEqual(await code(save('mgr', { reason: 'x' })), 'invalid-argument:REASON_REQUIRED');

  const invalid = clone(next); invalid.risk.referAt = 99; invalid.risk.refuseAt = 10;
  const e = await caught(save('mgr', { config: invalid }));
  assert.strictEqual(e.message, 'CONFIG_INVALID');
  assert.deepStrictEqual(e.details.errors.map((x) => x.path), ['risk.referAt']);

  assert.deepStrictEqual(await env.tenants.checkRuleConfig({ auth: env.user('aud'), ...T, config: invalid }), { ok: false, errors: e.details.errors });
  assert.strictEqual((await env.tenants.getRuleConfig({ auth: env.user('mgr'), ...T })).revision, 1, 'nothing saved');

  const saved = await save('mgr');
  assert.strictEqual(saved.revision, 2);
  const live = env.db.docs.get('tenants/acme-insure/configs/motor');
  assert.strictEqual(live.pricing.policyFee, 175);
  assert.strictEqual(live.tenantId, 'acme-insure');

  const stale = await caught(save('mgr')); // still based on revision 1
  assert.strictEqual(stale.message, 'CONFIG_CHANGED');
  assert.deepStrictEqual(stale.details, { currentRevision: 2 });

  const ev = env.db.list('tenants/acme-insure/adminEvents').find((x) => x.type === 'config_updated');
  assert.deepStrictEqual(ev.details, { line: 'motor', revision: 2, previousRevision: 1 });
  assert.strictEqual(ev.reason, 'new fee from January');
  assert.strictEqual(ev.actor.role, 'underwriting_manager');

  // platform staff may change rules too, and their reason doubles as the audit reason
  next.pricing.policyFee = 180;
  const p = await env.tenants.updateRuleConfig({ auth: env.platform, ...T, config: next, expectedRevision: 2, reason: 'support ticket 77' });
  assert.strictEqual(p.revision, 3);
});

test('rules history: newest first without the config copies, view one version, restore as a new revision', async () => {
  const env = setup();
  await env.create();
  env.seed('acme-insure', 'mgr', 'underwriting_manager');
  const T = { auth: env.user('mgr'), tenantId: 'acme-insure' };
  const base = (await env.tenants.getRuleConfig(T)).config;
  for (const [rev, fee] of [[1, 160], [2, 170]]) {
    const c = clone(base); c.pricing.policyFee = fee;
    await env.tenants.updateRuleConfig({ ...T, config: c, expectedRevision: rev, reason: `fee ${fee} please` });
  }

  const { versions } = await env.tenants.listRuleVersions(T);
  assert.deepStrictEqual(versions.map((v) => v.revision), [3, 2, 1]);
  assert.ok(versions.every((v) => !('config' in v)), 'the list does not carry the configs');
  assert.strictEqual(versions[0].note, 'fee 170 please');
  assert.strictEqual(versions[2].savedBy, 'plat');
  assert.strictEqual(versions[0].savedByEmail, 'mgr@x.example');

  assert.strictEqual((await env.tenants.getRuleVersion({ ...T, revision: 2 })).config.pricing.policyFee, 160);
  assert.strictEqual(await code(env.tenants.getRuleVersion({ ...T, revision: 9 })), 'not-found:VERSION_NOT_FOUND');
  assert.strictEqual(await code(env.tenants.getRuleVersion({ ...T, revision: 0 })), 'invalid-argument:Invalid revision.');

  const r = await env.tenants.restoreRuleVersion({ ...T, revision: 2, expectedRevision: 3, reason: 'roll back the fee' });
  assert.strictEqual(r.revision, 4);
  assert.strictEqual(env.db.docs.get('tenants/acme-insure/configs/motor').pricing.policyFee, 160);
  const v4 = await env.tenants.getRuleVersion({ ...T, revision: 4 });
  assert.strictEqual(v4.restoredFrom, 2);
  assert.ok(env.db.list('tenants/acme-insure/adminEvents').some((e) => e.type === 'config_restored' && e.details.restoredFrom === 2));
});

test('insurers seeded before versioning start at revision 0; the first save makes revision 1', async () => {
  const env = setup();
  env.db.docs.set('tenants/demo-insurer', { name: 'Assurance Démo', status: 'active', demo: true }); // what scripts/seed-demo-tenant.js writes
  env.db.docs.set('tenants/demo-insurer/configs/motor', clone(template));
  env.seed('demo-insurer', 'mgr', 'underwriting_manager');
  const T = { auth: env.user('mgr'), tenantId: 'demo-insurer' };
  const { tenant, rules } = await env.tenants.getTenant(T);
  assert.deepStrictEqual(tenant, { tenantId: 'demo-insurer', name: 'Assurance Démo', status: 'active', demo: true, createdAt: null, updatedAt: null });
  assert.strictEqual(rules.revision, 0);
  assert.deepStrictEqual((await env.tenants.listRuleVersions(T)).versions, []);
  const saved = await env.tenants.updateRuleConfig({ ...T, config: rules.config, expectedRevision: 0, reason: 'first versioned save' });
  assert.strictEqual(saved.revision, 1);
  assert.strictEqual(await code(env.tenants.getTenant({ ...T, tenantId: 'nobody-here' })), 'permission-denied:FORBIDDEN', 'no probing of other insurers');
});

test('platform changes: rename, demo flag, suspend and reactivate, rotate the web chat key, all audited', async () => {
  const env = setup();
  const { webchatKey } = await env.create();
  const P = { auth: env.platform, tenantId: 'acme-insure' };
  env.seed('acme-insure', 'adm', 'tenant_admin');

  assert.strictEqual(await code(env.tenants.updateTenant({ auth: env.user('adm'), tenantId: 'acme-insure', name: 'Mine now', reason: 'rename please' })), 'permission-denied:FORBIDDEN');
  assert.strictEqual(await code(env.tenants.updateTenant({ ...P, reason: 'nothing at all' })), 'invalid-argument:Nothing to change.');
  assert.strictEqual(await code(env.tenants.setTenantStatus({ ...P, status: 'deleted', reason: 'cleanup time' })), 'invalid-argument:status must be active or suspended.');
  assert.strictEqual(await code(env.tenants.setTenantStatus({ ...P, tenantId: 'nobody-here', status: 'suspended', reason: 'cleanup time' })), 'not-found:TENANT_NOT_FOUND');

  const renamed = await env.tenants.updateTenant({ ...P, name: '  Acme   Group ', reason: 'brand change' });
  assert.strictEqual(renamed.tenant.name, 'Acme Group');
  await env.tenants.setTenantStatus({ ...P, status: 'suspended', reason: 'unpaid invoice' });
  await env.tenants.setTenantStatus({ ...P, status: 'active', reason: 'invoice paid' });
  const rotated = await env.tenants.rotateWebchatKey({ ...P, reason: 'key leaked in a screenshot' });
  assert.notStrictEqual(rotated.webchatKey, webchatKey);
  assert.strictEqual(env.db.docs.get('tenantSecrets/acme-insure').webchatKey, rotated.webchatKey);

  const types = env.db.list('tenants/acme-insure/adminEvents').map((e) => e.type).sort();
  assert.deepStrictEqual(types, ['tenant_created', 'tenant_reactivated', 'tenant_suspended', 'tenant_updated', 'webchat_key_rotated']);
  const upd = env.db.list('tenants/acme-insure/adminEvents').find((e) => e.type === 'tenant_updated');
  assert.deepStrictEqual(upd.details, { before: { name: 'Acme Assurance' }, after: { name: 'Acme Group' } });
  assert.ok(!JSON.stringify(env.db.list('tenants/acme-insure/adminEvents')).includes(rotated.webchatKey), 'keys never reach the audit trail');
});

test('tenants callable: dispatches every action and rejects unknown ones', async () => {
  const env = setup();
  // platform staff give a reason on every action at an insurer, reads included
  const call = (data, auth = env.platform) => env.tenants.handle({ auth, data: data && { reason: 'support ticket 9', ...data } });
  await call({ action: 'create', tenantId: 'acme-insure', name: 'Acme', demo: true, reason: 'demo for a prospect' });
  const got = await call({ action: 'get', tenantId: 'acme-insure' });
  assert.strictEqual(got.rules.revision, 1);
  const cfg = (await call({ action: 'getRules', tenantId: 'acme-insure' })).config;
  assert.strictEqual((await call({ action: 'checkRules', tenantId: 'acme-insure', config: cfg })).ok, true);
  await call({ action: 'updateRules', tenantId: 'acme-insure', config: cfg, expectedRevision: 1, reason: 'same rules again' });
  assert.strictEqual((await call({ action: 'listVersions', tenantId: 'acme-insure' })).versions.length, 2);
  assert.strictEqual((await call({ action: 'getVersion', tenantId: 'acme-insure', revision: 1 })).revision, 1);
  assert.strictEqual((await call({ action: 'restoreVersion', tenantId: 'acme-insure', revision: 1, expectedRevision: 2, reason: 'back to the first' })).revision, 3);
  assert.strictEqual((await call({ action: 'update', tenantId: 'acme-insure', name: 'Acme 2', reason: 'new name here' })).tenant.name, 'Acme 2');
  assert.strictEqual((await call({ action: 'setStatus', tenantId: 'acme-insure', status: 'suspended', reason: 'pause the demo' })).tenant.status, 'suspended');
  assert.match((await call({ action: 'rotateWebchatKey', tenantId: 'acme-insure', reason: 'new key for prospect' })).webchatKey, /^[0-9a-f]+$/);
  assert.strictEqual(await code(call({ action: 'dropAll', tenantId: 'acme-insure' })), 'invalid-argument:Unknown action.');
  assert.strictEqual(await code(env.tenants.handle({ auth: env.platform, data: undefined })), 'invalid-argument:Unknown action.');
  assert.strictEqual(await code(env.tenants.handle({ auth: env.platform, data: { action: 'get', tenantId: 'acme-insure' } })), 'invalid-argument:REASON_REQUIRED');
  assert.strictEqual(await code(call({ action: 'getRules', tenantId: 'acme-insure', line: 'home' })), 'invalid-argument:UNSUPPORTED_LINE');
});
