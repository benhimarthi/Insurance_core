'use strict';

/**
 * The conversation module on its own, wired as it is deployed for the web chat: no app.js, the
 * tenants module's loader, the rules engine and document checks through ports, no payment.
 */
const test = require('node:test');
const assert = require('node:assert');
const { FakeFirestore } = require('./fakeFirestore');
const { createConversationModule, createMockExtractor } = require('../src/modules/conversation');
const { createTenantLoader } = require('../src/modules/tenants');
const { legacyConversationPorts } = require('../src/server/conversationPorts');
const { createRepository } = require('../src/server/repository');
const { createMemoryStorage } = require('../src/adapters/storage');
const { createMockDocumentProcessor } = require('../src/adapters/documentProcessor');
const config = require('../config/tenants/demo-insurer/motor.json');

const NOW = new Date('2026-11-21T10:00:00Z');
const ANSWERS = ['Bonjour, je veux une assurance auto', '38 ans', '15', 'aucun', 'non', '1', '120 000 dh', '4', 'personnel', 'Rabat', 'tous risques'];
const DOCS = [{ mimeType: 'image/jpeg', filename: 'id.jpg', dataBase64: Buffer.from('id').toString('base64'), demoFixture: 'demo_id_ok' },
  { mimeType: 'image/jpeg', filename: 'reg.jpg', dataBase64: Buffer.from('reg').toString('base64'), demoFixture: 'demo_registration_ok' }];

function setup({ tenant = { name: 'Assurance Démo', status: 'active', demo: true } } = {}) {
  const db = new FakeFirestore();
  db.docs.set('tenants/demo-insurer', tenant);
  db.docs.set('tenants/demo-insurer/configs/motor', config);
  const storage = createMemoryStorage();
  const conversation = createConversationModule({
    extractor: createMockExtractor(),
    ...legacyConversationPorts({ documentProcessor: createMockDocumentProcessor() }), // no paymentAdapter: no payment
    store: createRepository(db, { now: () => NOW }),
    uploads: storage,
    tenants: { load: createTenantLoader({ db, localDir: null }) },
    pepper: 'test-pepper',
    now: () => NOW,
    logger: { error() {} },
  });
  const sessionId = 'sess-abcdef12';
  const say = (body, headers = {}) => conversation.handleWebChat({ tenantId: 'demo-insurer', headers, body: { sessionId, ...body } });
  return { db, storage, conversation, say, sessionId };
}

test('web chat on its own: questions, documents, quote, acceptance without payment', async () => {
  const env = setup();
  let last;
  for (const text of ANSWERS) last = await env.say({ text });
  assert.strictEqual(env.storage.count(), 0);
  assert.match(last.body.messages.at(-1).text, /carte|document|pièce/i, 'documents are requested after the questions');

  last = await env.say({ text: '', attachments: DOCS });
  assert.match(last.body.messages.at(-1).text, /3696 MAD/);
  assert.strictEqual(env.storage.count(), 2, 'documents are stored once they are expected');
  last = await env.say({ text: 'oui' });
  assert.strictEqual(last.status, 200);
  const [c] = env.db.list('tenants/demo-insurer/cases');
  assert.strictEqual(c.status, 'quoted');
  assert.strictEqual(c.flow.stage, 'confirmed', 'no payment module: the insurer follows up');
  assert.strictEqual(c.channel, 'web');
  assert.strictEqual(env.db.list('outbox').filter((o) => o.status === 'queued_web').length, 0, 'every reply was collected by the page');
});

test('customers are pseudonymous: neither the session id nor "web:..." is stored as an id', async () => {
  const env = setup();
  await env.say({ text: 'Bonjour' });
  const [cust] = env.db.list('tenants/demo-insurer/customers');
  assert.match(cust.id, /^[0-9a-f]{32}$/);
  assert.ok(!cust.id.includes(env.sessionId));
  assert.strictEqual(cust.id, env.conversation.customerIdFor(`web:${env.sessionId}`));
});

test('a redelivered message is processed once; uploads are kept only when documents are expected', async () => {
  const env = setup();
  const first = await env.say({ text: 'Bonjour', messageId: 'm-1', attachments: DOCS });
  assert.strictEqual(first.body.messages.length, 2);
  assert.strictEqual(env.storage.count(), 0, 'a file sent before the documents step is not stored');
  const again = await env.say({ text: 'Bonjour', messageId: 'm-1' });
  assert.deepStrictEqual(again.body.messages, [], 'nothing new: deduplicated');
  assert.strictEqual(env.db.list('tenants/demo-insurer/cases').length, 1);
});

test('web chat errors keep their HTTP answers; keys protect real insurers', async () => {
  const demo = setup();
  assert.deepStrictEqual(await demo.conversation.handleWebChat({ tenantId: 'nobody-here', headers: {}, body: { sessionId: 'sess-abcdef12', text: 'x' } }), { status: 404, body: { error: 'unknown_tenant' } });
  assert.deepStrictEqual(await demo.say({ text: 'x', messageId: 'bad id!' }), { status: 400, body: { error: 'bad_message_id' } });
  assert.deepStrictEqual(await demo.say({ sessionId: 'short', text: 'x' }), { status: 400, body: { error: 'bad_session' } });
  assert.deepStrictEqual(await demo.say({ text: 42 }), { status: 400, body: { error: 'bad_text' } });

  const real = setup({ tenant: { name: 'Acme', status: 'active', demo: false } });
  assert.deepStrictEqual(await real.say({ text: 'x' }), { status: 401, body: { error: 'webchat_not_enabled' } });
  const fresh = setup({ tenant: { name: 'Acme', status: 'active', demo: false } });
  fresh.db.docs.set('tenantSecrets/demo-insurer', { webchatKey: 'k-123' });
  assert.deepStrictEqual(await fresh.say({ text: 'x' }, { 'x-webchat-key': 'nope' }), { status: 401, body: { error: 'bad_key' } });
  assert.strictEqual((await fresh.say({ text: 'Bonjour' }, { 'x-webchat-key': 'k-123' })).status, 200);

  const suspended = setup({ tenant: { name: 'Off', status: 'suspended', demo: true } });
  assert.deepStrictEqual(await suspended.say({ text: 'x' }), { status: 404, body: { error: 'unknown_tenant' } });
});
