'use strict';

const baseConfig = require('../config/tenants/demo-insurer/motor.json');
const { FakeFirestore } = require('./fakeFirestore');
const { buildApp } = require('../src/server/app');
const { createRepository } = require('../src/server/repository');
const { createMemoryChannel } = require('../src/channels/whatsapp');
const { createMemoryStorage } = require('../src/adapters/storage');
const { createMockExtractor } = require('../src/adapters/extractor');
const { createMockDocumentProcessor } = require('../src/adapters/documentProcessor');
const { createDemoPaymentAdapter } = require('../src/adapters/demoPayment');
const { createFirestorePolicyAdmin } = require('../src/adapters/firestorePolicyAdmin');
const { createVerifier } = require('../src/verification/verification');
const { createAuthModule } = require('../src/modules/auth');

const TENANT = 'demo-insurer';
const PAY_SECRET = 'pay-secret';
const WH_SECRET = 'wh-secret';
const PHONE = '+212600000001';

const FRENCH_ANSWERS = ['Bonjour, je veux une assurance auto', '38 ans', '15', 'aucun', 'non', '1', '120 000 dh', '4', 'personnel', 'Rabat', 'tous risques'];
const img = (demoFixture) => ({ mimeType: 'image/jpeg', filename: `${demoFixture}.jpg` });

function makeEnv({ tenants, withVerifier = true } = {}) {
  const db = new FakeFirestore();
  const clock = { now: new Date('2026-11-21T10:00:00Z') };
  const now = () => new Date(clock.now);
  const errors = [];
  const logger = { error: (m) => errors.push(String(m)) };

  const hooks = { onExtract: null, extractCalls: 0 };
  const inner = createMockExtractor();
  const extractor = { async extract(args) { hooks.extractCalls += 1; if (hooks.onExtract) { const f = hooks.onExtract; hooks.onExtract = null; await f(); } return inner.extract(args); } };

  const channel = createMemoryChannel({ secret: WH_SECRET });
  const storage = createMemoryStorage();
  const payments = createDemoPaymentAdapter({ db, baseUrl: 'https://demo.example/pay', now });
  const realPolicyAdmin = createFirestorePolicyAdmin(db);
  const lookups = [];
  const policyAdmin = { createPolicy: (d) => realPolicyAdmin.createPolicy(d), getPolicy: (t, n) => { lookups.push([t, n]); return realPolicyAdmin.getPolicy(t, n); } };
  const verifier = withVerifier ? createVerifier({ secret: 'verify-secret', baseUrl: 'https://verify.example/v' }) : null;
  const repo = createRepository(db, { now });
  const revoked = [];
  const authAdmin = { revokeRefreshTokens: async (uid) => { revoked.push(uid); } };
  const authService = createAuthModule({ db, authAdmin, now, requireMfa: true, logger });

  const defaultTenants = {
    [TENANT]: { tenant: { id: TENANT, name: 'Assurance Démo', demo: true, status: 'active', webchatKey: null }, config: baseConfig },
    'other-insurer': { tenant: { id: 'other-insurer', name: 'Autre Assureur', demo: true, status: 'active', webchatKey: null }, config: baseConfig },
    'secure-insurer': { tenant: { id: 'secure-insurer', name: 'Secure', demo: false, status: 'active', webchatKey: 'key-123' }, config: baseConfig },
    'closed-insurer': { tenant: { id: 'closed-insurer', name: 'No web', demo: false, status: 'active', webchatKey: null }, config: baseConfig },
  };
  const table = tenants || defaultTenants;

  const app = buildApp({
    repo, channel, extractor, storage, policyAdmin, now, logger,
    loadTenant: async (id) => table[id] || null,
    documentProcessor: createMockDocumentProcessor(),
    paymentAdapter: payments,
    paymentSecret: () => PAY_SECRET,
    pepper: 'test-pepper',
    demoPay: payments,
    verifier,
    authService,
  });

  let n = 0;
  const env = { db, clock, now, errors, hooks, channel, storage, payments, policyAdmin, lookups, verifier, repo, app, authService, revoked, config: baseConfig };

  /** One WhatsApp message through the real webhook handler. */
  env.say = (text, { from = PHONE, attachments = [], messageId, tenantId = TENANT } = {}) => app.handleWhatsAppWebhook({
    tenantId,
    headers: { 'x-webhook-signature': WH_SECRET },
    body: { messages: [{ messageId: messageId || `m${++n}`, from, text, attachments }] },
  });
  env.sayAll = async (items, opts) => { for (const it of items) { const res = await (typeof it === 'string' ? env.say(it, opts) : env.say('', { ...opts, attachments: it.attachments })); if (res.status !== 200) throw new Error(`webhook ${res.status}`); } };
  env.cases = (tenantId = TENANT) => env.db.list(`tenants/${tenantId}/cases`);
  env.onlyCase = (tenantId = TENANT) => { const c = env.cases(tenantId); if (c.length !== 1) throw new Error(`expected 1 case, got ${c.length}`); return c[0]; };
  env.lastText = () => env.channel.texts().slice(-1)[0];
  env.payIdFromChat = () => /\/(pay_[0-9a-f]+)/.exec(env.lastText())[1];
  env.pay = (paymentId, method = 'POST', tenantId = TENANT) => app.handleDemoPay({ tenantId, paymentId, method });
  /** A signed-in staff user as Firebase would present them (verified email, second factor done). */
  env.user = (uid, extra = {}) => ({ uid, token: { email: `${uid}@insurer.example`, email_verified: true, firebase: { sign_in_second_factor: 'totp' }, ...extra } });
  env.underwriter = (uid = 'uw-1') => env.user(uid);
  /** Seeds a membership directly (what scripts/add-member.js does), synchronously. */
  env.seedMember = (tenantId, uid, role, status = 'active') => {
    db.docs.set(`tenants/${tenantId}/members/${uid}`, { uid, email: `${uid}@insurer.example`, role, status, createdAt: 'x', createdBy: 'seed', updatedAt: 'x', updatedBy: 'seed' });
    db.docs.set(`userTenants/${uid}/memberships/${tenantId}`, { tenantId, role, status, updatedAt: 'x' });
  };
  env.seedMember(TENANT, 'uw-1', 'underwriter');
  return env;
}

/** A referred case: documents show a different registered owner. */
async function referredCase(env) {
  await env.sayAll([...FRENCH_ANSWERS, { attachments: [img('demo_id_ok'), img('demo_registration_other_owner')] }]);
  return env.onlyCase();
}

module.exports = { makeEnv, referredCase, FRENCH_ANSWERS, img, TENANT, PAY_SECRET, WH_SECRET, PHONE };
