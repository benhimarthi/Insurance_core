'use strict';

/**
 * The whole customer journey as deployed, without app.js: web chat (conversation module) -> quote ->
 * "oui" -> payment link (payment module, demo checkout for demo insurers) -> the customer pays on the
 * demo page -> signed event -> the policy module issues -> confirmation and PDF in the chat.
 */
const test = require('node:test');
const assert = require('node:assert');
const { FakeFirestore } = require('./fakeFirestore');
const { createConversationModule, createMockExtractor, PAY, announceDecision } = require('../src/modules/conversation');
const { createPaymentModule, createDemoGateway, demoCheckoutForDemoInsurers, signPayload } = require('../src/modules/payment');
const { createPolicyModule, createFirestorePolicyRegistry, isApprovedForIssuance } = require('../src/modules/policy');
const { createTenantLoader } = require('../src/modules/tenants');
const { legacyConversationPorts } = require('../src/server/conversationPorts');
const { createRepository } = require('../src/server/repository');
const { createMemoryStorage } = require('../src/adapters/storage');
const { createMockDocumentProcessor } = require('../src/adapters/documentProcessor');
const config = require('../config/tenants/demo-insurer/motor.json');

const NOW = new Date('2026-11-21T10:00:00Z');
const SECRET = 'webhook-secret-for-tests';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const ANSWERS = ['Bonjour', '38 ans', '15', 'aucun', 'non', '1', '120 000 dh', '4', 'personnel', 'Rabat', 'tous risques'];
// filename: the offline reader of the tests recognises it on any insurer (demoFixture is honoured only on demo insurers)
const DOCS = [{ mimeType: 'image/png', filename: 'demo_id_ok.png', dataBase64: PNG, demoFixture: 'demo_id_ok' }, { mimeType: 'image/png', filename: 'demo_registration_ok.png', dataBase64: PNG, demoFixture: 'demo_registration_ok' }];

function deploy({ demo = true } = {}) {
  const db = new FakeFirestore();
  db.docs.set('tenants/acme-insure', { name: 'Acme', status: 'active', demo });
  db.docs.set('tenants/acme-insure/configs/motor', { ...config, tenantId: 'acme-insure' });
  if (!demo) db.docs.set('tenantSecrets/acme-insure', { webchatKey: 'k-123' });
  const now = () => NOW;
  const store = createRepository(db, { now });
  const storage = createMemoryStorage({ now });
  const tenants = { load: createTenantLoader({ db, localDir: null }) };
  const demoGateway = createDemoGateway({ db, baseUrl: 'https://my-super-manager-app.web.app/pay', now });
  const policy = createPolicyModule({ registry: createFirestorePolicyRegistry(db), files: storage });
  const payment = createPaymentModule({
    store, tenants, demoGateway, now,
    gateways: demoCheckoutForDemoInsurers({ tenants, demoGateway }),
    webhookSecret: () => SECRET,
    policies: { issue: policy.issue, isApprovedForIssuance },
    messages: PAY,
    logger: { error() {} },
  });
  const conversation = createConversationModule({
    extractor: createMockExtractor(),
    ...legacyConversationPorts({ documentProcessor: createMockDocumentProcessor(), payments: payment }),
    store, uploads: storage, tenants, pepper: 'p', now, logger: { error() {} },
  });
  const say = async (body) => (await conversation.handleWebChat({ tenantId: 'acme-insure', headers: demo ? {} : { 'x-webchat-key': 'k-123' }, body: { sessionId: 'sess-journey1', ...body } })).body.messages;
  return { db, storage, payment, say };
}

async function toQuote(env) {
  for (const text of ANSWERS) await env.say({ text });
  return env.say({ text: '', attachments: DOCS });
}

test('full journey on a demo insurer: quote, link, demo checkout, policy PDF in the chat', async () => {
  const env = deploy();
  await toQuote(env);
  const [link] = await env.say({ text: 'oui' });
  const url = /(https:\/\/my-super-manager-app\.web\.app\/pay\/acme-insure\/pay_[0-9a-f]+)/.exec(link.text)[1];
  const paymentId = url.split('/').pop();

  const form = await env.payment.handleDemoPay({ tenantId: 'acme-insure', paymentId, method: 'GET' });
  assert.strictEqual(form.status, 200);
  assert.match(form.html, /3696,00 MAD/);
  assert.match(form.headers['content-security-policy'], /default-src 'none'/);

  const paid = await env.payment.handleDemoPay({ tenantId: 'acme-insure', paymentId, method: 'POST' });
  assert.strictEqual(paid.status, 200);
  assert.match(paid.html, /Paiement confirmé/);
  assert.match(paid.html, /dans la conversation/, 'no promise of WhatsApp to a web chat customer');

  const messages = await env.say({ poll: true });
  assert.match(messages[0].text, /POL-DEMO-2026-000001/);
  assert.deepStrictEqual({ kind: messages[1].kind, filename: messages[1].filename }, { kind: 'document', filename: 'POL-DEMO-2026-000001.pdf' });
  assert.match(messages[1].url, /^memory:\/\/tenants\/acme-insure\/policies\//);
  const [c] = env.db.list('tenants/acme-insure/cases');
  assert.strictEqual(c.status, 'issued');
  assert.ok(env.storage.get('tenants/acme-insure/policies/POL-DEMO-2026-000001.pdf').bytes.length > 1000, 'a real PDF');
  assert.ok(!env.storage.paths().some((p) => p.startsWith('uploads/') && p.includes('policies')), 'policies are not under uploads/ (not deleted by retention)');

  const again = await env.payment.handleDemoPay({ tenantId: 'acme-insure', paymentId, method: 'POST' });
  assert.match(again.html, /Paiement confirmé/);
  assert.strictEqual(env.db.list('tenants/acme-insure/policies').length, 1, 'paying twice issues one policy');
});

test('a real insurer without a provider yet: the customer is told the insurer follows up; no demo checkout', async () => {
  const env = deploy({ demo: false });
  await toQuote(env);
  const [reply] = await env.say({ text: 'oui' });
  assert.strictEqual(reply.text, 'Parfait ! Nous préparons votre contrat.');
  const [c] = env.db.list('tenants/acme-insure/cases');
  assert.strictEqual(c.flow.stage, 'confirmed');
  assert.strictEqual(c.payment, null);
  assert.strictEqual((await env.payment.handleDemoPay({ tenantId: 'acme-insure', paymentId: 'pay_x', method: 'GET' })).status, 404);
});

test('provider webhook: forged, unknown insurer, bad case id, wrong amount', async () => {
  const env = deploy();
  await toQuote(env);
  await env.say({ text: 'oui' });
  const [c] = env.db.list('tenants/acme-insure/cases');
  const event = (over = {}) => JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', paymentId: c.payment.paymentId, caseId: c.id, amount: c.payment.amount, currency: 'MAD', at: NOW.toISOString(), ...over });
  const hook = (rawBody, signature = signPayload(SECRET, rawBody), tenantId = 'acme-insure') => env.payment.handlePaymentWebhook({ tenantId, rawBody, headers: { 'x-signature': signature } });

  assert.deepStrictEqual(await hook(event(), signPayload('wrong-secret', event())), { status: 401, body: { error: 'bad_signature' } });
  assert.deepStrictEqual(await hook(event(), undefined, 'nobody-here'), { status: 404, body: { error: 'unknown_tenant' } });
  assert.deepStrictEqual(await hook(event({ caseId: '../x' })), { status: 400, body: { error: 'bad_case_id' } });
  const cheaper = await hook(event({ id: 'evt_2', amount: 1 }));
  assert.strictEqual(cheaper.status, 200);
  const after = env.db.list('tenants/acme-insure/cases')[0];
  assert.strictEqual(after.payment.status, 'mismatch');
  assert.strictEqual(env.db.list('tenants/acme-insure/policies').length, 0, 'nothing issued for a wrong amount');
});

test('the decision notice is the conversation\'s: approved -> quoted with the final premium, rejected -> closed', () => {
  const base = { status: 'approved', language: 'fr', engineResult: { premium: { total: 3000 } }, review: { decision: 'approve' } };
  assert.match(announceDecision({ caseDoc: base, config }).replies[0], /3000/);
  assert.strictEqual(announceDecision({ caseDoc: base, config }).caseDoc.flow.stage, 'quoted');
  assert.strictEqual(announceDecision({ caseDoc: { ...base, status: 'rejected' }, config }).caseDoc.flow.stage, 'closed');
  assert.throws(() => announceDecision({ caseDoc: { ...base, status: 'quoted' }, config }), /No human decision/);
});

test('the payment module refuses to start without a signature parser or a secret', () => {
  assert.throws(() => createPaymentModule({ webhookSecret: null, policies: { issue() {}, isApprovedForIssuance() {} }, gateways: {}, messages: PAY }), /webhookSecret/);
});
