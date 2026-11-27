'use strict';

/**
 * The conversation module on its own, wired as it is deployed for the web chat: no app.js, the
 * tenants module's loader, the rules engine and document checks through ports, no payment.
 */
const test = require('node:test');
const assert = require('node:assert');
const { FakeFirestore } = require('./fakeFirestore');
const { createConversationModule, createConversationCleanup, createFirestoreRateLimiter, createMockExtractor } = require('../src/modules/conversation');
const { createTenantLoader } = require('../src/modules/tenants');
const { legacyConversationPorts } = require('../src/server/conversationPorts');
const { createRepository } = require('../src/server/repository');
const { createMemoryStorage } = require('../src/adapters/storage');
const { createMockDocumentProcessor } = require('../src/adapters/documentProcessor');
const config = require('../config/tenants/demo-insurer/motor.json');

const NOW = new Date('2026-11-21T10:00:00Z');
const ANSWERS = ['Bonjour, je veux une assurance auto', '38 ans', '15', 'aucun', 'non', '1', '120 000 dh', '4', 'personnel', 'Rabat', 'tous risques'];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='; // a real 1x1 PNG: uploads are checked by content
const DOCS = [{ mimeType: 'image/png', filename: 'id.png', dataBase64: PNG, demoFixture: 'demo_id_ok' },
  { mimeType: 'image/png', filename: 'reg.png', dataBase64: PNG, demoFixture: 'demo_registration_ok' }];

function setup({ tenant = { name: 'Assurance Démo', status: 'active', demo: true }, limits = false, appCheck } = {}) {
  const db = new FakeFirestore();
  db.docs.set('tenants/demo-insurer', tenant);
  db.docs.set('tenants/demo-insurer/configs/motor', config);
  const clock = { now: NOW };
  const storage = createMemoryStorage({ now: () => clock.now });
  const conversation = createConversationModule({
    rateLimiter: limits ? createFirestoreRateLimiter(db, { now: () => clock.now }) : null,
    ...(appCheck ? { appCheck } : {}),
    extractor: createMockExtractor(),
    ...legacyConversationPorts({ documentProcessor: createMockDocumentProcessor() }), // no paymentAdapter: no payment
    store: createRepository(db, { now: () => clock.now }),
    uploads: storage,
    tenants: { load: createTenantLoader({ db, localDir: null }) },
    pepper: 'test-pepper',
    now: () => clock.now,
    logger: { error() {}, warn() {}, log() {} },
  });
  const sessionId = 'sess-abcdef12';
  const say = (body, headers = {}, clientIp = '198.51.100.7') => conversation.handleWebChat({ tenantId: 'demo-insurer', headers, clientIp, body: { sessionId, ...body } });
  return { db, storage, conversation, say, sessionId, clock };
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

// ---------- security ----------

test('uploads are checked by content: a file labelled as an image that is not one is refused', async () => {
  const env = setup();
  for (const text of ANSWERS) await env.say({ text });
  const fake = { mimeType: 'image/png', filename: 'id.png', dataBase64: Buffer.from('<html><script>x</script></html> padding').toString('base64'), demoFixture: 'demo_id_ok' };
  const res = await env.say({ text: '', attachments: [fake] });
  assert.strictEqual(env.storage.count(), 0);
  assert.match(res.body.messages.at(-1).text, /carte|document|photo/i, 'still waiting for real documents');
  assert.ok(env.storage.paths().every((p) => p.startsWith('uploads/')));
});

test('duplicates are detected per customer: two visitors may use the same message id', async () => {
  const env = setup();
  const a = await env.say({ text: 'Bonjour', messageId: 'm-1' });
  const b = await env.say({ sessionId: 'sess-other-123', text: 'Bonjour', messageId: 'm-1' });
  assert.strictEqual(a.body.messages.length, 2);
  assert.strictEqual(b.body.messages.length, 2, 'the second visitor is not silenced by the first one');
  assert.strictEqual(env.db.list('tenants/demo-insurer/cases').length, 2);
});

test('rate limits: per session, per IP, polls apart; refused requests get 429 with Retry-After and cost nothing', async () => {
  const env = setup({ limits: true });
  for (let i = 0; i < 20; i += 1) assert.strictEqual((await env.say({ text: `message ${i}` })).status, 200);
  const blocked = await env.say({ text: 'one too many' });
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.body.error, 'rate_limited');
  assert.ok(Number(blocked.headers['retry-after']) > 0 && Number(blocked.headers['retry-after']) <= 60);
  const cases = env.db.list('tenants/demo-insurer/cases');
  assert.strictEqual(cases.length, 1);
  assert.strictEqual((await env.say({ poll: true })).status, 200, 'polling has its own budget');

  env.clock.now = new Date(NOW.getTime() + 61 * 1000); // next minute
  assert.strictEqual((await env.say({ text: 'back again' })).status, 200);

  // one IP spreading over many sessions is still limited (60 per minute)
  env.clock.now = new Date(NOW.getTime() + 10 * 60 * 1000);
  let ipBlocked = null;
  for (let s = 0; s < 4 && !ipBlocked; s += 1) {
    for (let i = 0; i < 20; i += 1) {
      const r = await env.say({ sessionId: `sess-ip-test-${s}`, text: 'x' });
      if (r.status === 429) { ipBlocked = { s, i }; break; }
    }
  }
  assert.deepStrictEqual(ipBlocked, { s: 3, i: 0 }, 'the 61st message of the minute from one IP is refused');
  assert.strictEqual((await env.say({ sessionId: 'sess-other-ip-1', text: 'x' }, {}, '203.0.113.9')).status, 200, 'other IPs are not affected');
  assert.ok(env.db.list('rateLimits').every((d) => d.expireAt instanceof Date), 'counters expire (Firestore TTL)');
  assert.ok(!JSON.stringify(env.db.list('rateLimits')).includes('198.51.100.7'), 'IPs are not stored');
});

test('App Check: off, monitor (logs only) and enforce (refuses requests without a valid token)', async () => {
  const verify = async (token) => token === 'good-token';
  const enforce = setup({ appCheck: { mode: 'enforce', verify } });
  assert.deepStrictEqual(await enforce.say({ text: 'Bonjour' }), { status: 401, body: { error: 'app_check_failed' } });
  assert.deepStrictEqual(await enforce.say({ text: 'Bonjour' }, { 'x-firebase-appcheck': 'forged' }), { status: 401, body: { error: 'app_check_failed' } });
  assert.strictEqual((await enforce.say({ text: 'Bonjour' }, { 'x-firebase-appcheck': 'good-token' })).status, 200);
  assert.strictEqual(enforce.db.list('tenants/demo-insurer/cases').length, 1, 'refused requests never reach the flow');

  const monitor = setup({ appCheck: { mode: 'monitor', verify } });
  assert.strictEqual((await monitor.say({ text: 'Bonjour' })).status, 200);
});

test('data retention: old uploads and abandoned conversations are deleted; quotes and referrals are kept', async () => {
  const env = setup();
  // an abandoned conversation (stuck in the questions), a finished quote, and a fresh conversation
  await env.say({ sessionId: 'sess-abandoned1', text: 'Bonjour' });
  await env.say({ sessionId: 'sess-abandoned1', text: '38' });
  for (const text of ANSWERS) await env.say({ sessionId: 'sess-quoted-001', text });
  await env.say({ sessionId: 'sess-quoted-001', text: '', attachments: DOCS });
  assert.strictEqual(env.storage.count(), 2);

  env.clock.now = new Date(NOW.getTime() + 40 * 24 * 3600 * 1000); // 40 days later
  await env.say({ sessionId: 'sess-fresh-0001', text: 'Bonjour' });
  const cleanup = createConversationCleanup({ store: createRepository(env.db, { now: () => env.clock.now }), uploads: env.storage, now: () => env.clock.now, logger: { log() {} } });

  const first = await cleanup();
  assert.deepStrictEqual(first, { uploadsDeleted: 0, casesDeleted: 1 });
  const left = env.db.list('tenants/demo-insurer/cases').map((c) => c.flow.stage).sort();
  assert.deepStrictEqual(left, ['asking', 'quoted'], 'the quote and the fresh conversation stay');
  assert.strictEqual(env.db.list('tenants/demo-insurer/customers').length, 2, 'the abandoned visitor record is gone');
  const gone = env.conversation.customerIdFor('web:sess-abandoned1');
  assert.ok(![...env.db.docs.keys()].some((k) => k.includes(gone)), 'nothing of the abandoned conversation remains');

  env.clock.now = new Date(NOW.getTime() + 91 * 24 * 3600 * 1000); // past document retention
  const second = await cleanup();
  assert.strictEqual(second.uploadsDeleted, 2, 'ID and registration photos deleted after 90 days');
  assert.strictEqual(env.db.list('tenants/demo-insurer/cases').find((c) => c.flow.stage === 'quoted').documents.national_id.fields !== undefined, true, 'the verified fields stay on the case');
});

