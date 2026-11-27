'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { FakeFirestore } = require('./fakeFirestore');
const { createWaSenderChannel } = require('../src/channels/whatsapp');
const { createGemini } = require('../src/adapters/gemini');
const { createLlmExtractor } = require('../src/adapters/extractor');
const { createLlmDocumentProcessor } = require('../src/adapters/documentProcessor');
const { createTenantLoader } = require('../src/server/tenants');
const { createFirestorePolicyAdmin } = require('../src/adapters/firestorePolicyAdmin');
const { createFirebaseStorage } = require('../src/adapters/storage');
const { stripUndefined, customerKey, safeEqual } = require('../src/server/util');
const config = require('../config/tenants/demo-insurer/motor.json');

// ---------- WaSender channel ----------

const received = (over = {}) => ({
  event: 'messages.received',
  data: { messages: { key: { id: 'ABC123', cleanedSenderPn: '212600000001', fromMe: false }, messageBody: 'Bonjour', ...over } },
});

test('WaSender: webhook secret check is constant-time and strict', () => {
  const ch = createWaSenderChannel({ apiKey: 'k', webhookSecret: 's3cret' });
  assert.strictEqual(ch.verifyRequest({ 'x-webhook-signature': 's3cret' }), true);
  assert.strictEqual(ch.verifyRequest({ 'x-webhook-signature': 's3cre' }), false);
  assert.strictEqual(ch.verifyRequest({}), false);
  assert.strictEqual(createWaSenderChannel({ apiKey: 'k', webhookSecret: '' }).verifyRequest({ 'x-webhook-signature': '' }), false);
});

test('WaSender: parses text messages, ignores echoes and other events', () => {
  const ch = createWaSenderChannel({ apiKey: 'k', webhookSecret: 's' });
  assert.deepStrictEqual(ch.parseInbound(received()), [{ messageId: 'ABC123', from: '+212600000001', text: 'Bonjour', attachments: [] }]);
  assert.deepStrictEqual(ch.parseInbound({ event: 'message.sent', data: {} }), []);
  assert.deepStrictEqual(ch.parseInbound(received({ key: { id: 'X', cleanedSenderPn: '2126', fromMe: true } })), []);
  assert.deepStrictEqual(ch.parseInbound(null), []);
  const withImage = ch.parseInbound(received({ messageBody: undefined, message: { imageMessage: { mimetype: 'image/jpeg', caption: 'ma cin' } } }));
  assert.strictEqual(withImage[0].attachments[0].mimeType, 'image/jpeg');
  assert.strictEqual(withImage[0].text, 'ma cin');
});

test('WaSender: sendText posts to /send-message with the bearer key; HTTP errors throw', async () => {
  const calls = [];
  const ok = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ success: true }) }; };
  const ch = createWaSenderChannel({ apiKey: 'KEY', webhookSecret: 's', fetchImpl: ok });
  await ch.sendText('+212600000001', 'Salut');
  assert.strictEqual(calls[0].url, 'https://www.wasenderapi.com/api/send-message');
  assert.strictEqual(calls[0].init.headers.authorization, 'Bearer KEY');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { to: '+212600000001', text: 'Salut' });

  const bad = createWaSenderChannel({ apiKey: 'k', webhookSecret: 's', fetchImpl: async () => ({ ok: false, status: 429 }) });
  await assert.rejects(bad.sendText('+1', 'x'), /HTTP 429/);
});

// ---------- Gemini ----------

const geminiReply = (text) => async () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) });

test('Gemini: text and vision calls, key sent in a header, errors surfaced', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return geminiReply('{"driver.age":30}')(); };
  const g = createGemini({ apiKey: 'GKEY', model: 'm1', fetchImpl });

  assert.strictEqual(await g.callText('prompt'), '{"driver.age":30}');
  assert.match(calls[0].url, /\/models\/m1:generateContent$/);
  assert.ok(!calls[0].url.includes('GKEY'));
  assert.strictEqual(calls[0].init.headers['x-goog-api-key'], 'GKEY');

  await g.callVision({ prompt: 'p', attachment: { mimeType: 'image/png', data: Buffer.from('hello') } });
  const parts = JSON.parse(calls[1].init.body).contents[0].parts;
  assert.deepStrictEqual(parts[1].inline_data, { mime_type: 'image/png', data: Buffer.from('hello').toString('base64') });

  await assert.rejects(createGemini({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500 }) }).callText('x'), /HTTP 500/);
  await assert.rejects(createGemini({ apiKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }).callText('x'), /no text/);
});

test('Gemini plugged into the extractors: works, and degrades to "ask again" when the API is down', async () => {
  const good = createGemini({ apiKey: 'k', fetchImpl: geminiReply('{"driver.age": 31}') });
  const ex = createLlmExtractor({ callModel: good.callText });
  assert.deepStrictEqual((await ex.extract({ message: 'I am 31', language: 'en', question: { path: 'driver.age' }, questions: [] })).fields, { 'driver.age': 31 });

  const down = createGemini({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 503 }) });
  const exDown = createLlmExtractor({ callModel: down.callText });
  assert.deepStrictEqual((await exDown.extract({ message: 'x', language: 'en', question: { path: 'driver.age' }, questions: [] })).fields, {});
  const dp = createLlmDocumentProcessor({ callModel: down.callVision });
  const res = await dp.process({ attachment: { mimeType: 'image/png', data: Buffer.from('x') }, expectedTypes: ['national_id'] });
  assert.strictEqual(res.type, 'unknown');
});

// ---------- tenants ----------

test('tenant loader: Firestore, inactive tenants, bad ids, cache expiry, local fallback', async () => {
  const db = new FakeFirestore();
  await db.doc('tenants/acme-insure').set({ name: 'Acme', status: 'active', demo: false });
  await db.doc('tenants/acme-insure/configs/motor').set(config);
  await db.doc('tenantSecrets/acme-insure').set({ webchatKey: 'abc' });
  await db.doc('tenants/old-insurer').set({ name: 'Old', status: 'suspended' });
  await db.doc('tenants/old-insurer/configs/motor').set(config);

  let t = 0;
  const load = createTenantLoader({ db, localDir: path.join(__dirname, '..', 'config', 'tenants'), ttlMs: 1000, now: () => t });

  const acme = await load('acme-insure');
  assert.strictEqual(acme.tenant.name, 'Acme');
  assert.strictEqual(acme.tenant.webchatKey, 'abc');
  assert.strictEqual(acme.config.line, 'motor');
  assert.strictEqual(await load('old-insurer'), null);
  assert.strictEqual(await load('../config'), null);
  assert.strictEqual(await load('missing-one'), null);

  await db.doc('tenants/acme-insure').set({ name: 'Renamed', status: 'active', demo: false });
  assert.strictEqual((await load('acme-insure')).tenant.name, 'Acme'); // cached
  t = 2000;
  assert.strictEqual((await load('acme-insure')).tenant.name, 'Renamed'); // expired

  const local = await load('demo-insurer'); // not in Firestore: local demo config
  assert.strictEqual(local.tenant.demo, true);
});

// ---------- policy numbering in Firestore ----------

const draft = (caseId, year = '2026') => ({
  idempotencyKey: caseId, numberPrefix: 'DEMO', tenantId: 'demo-insurer', caseId, issuedAt: `${year}-11-21T10:00:00.000Z`,
  startDate: `${year}-11-21`, endDate: `${Number(year) + 1}-11-20`, holder: { fullName: 'A B' },
  vehicle: { plate: '1-A-1', make: undefined, model: null }, coverage: 'tiers', premium: { net: 1, fee: 0, total: 1, currency: 'MAD' },
});

test('Firestore policy admin: sequential numbers, idempotent per case, yearly counters, undefined-safe', async () => {
  const db = new FakeFirestore();
  const admin = createFirestorePolicyAdmin(db);
  const a = await admin.createPolicy(draft('case-a'));
  const b = await admin.createPolicy(draft('case-b'));
  const aAgain = await admin.createPolicy(draft('case-a'));
  const next = await admin.createPolicy(draft('case-c', '2027'));
  assert.deepStrictEqual([a.policyNumber, b.policyNumber, aAgain.policyNumber, next.policyNumber],
    ['POL-DEMO-2026-000001', 'POL-DEMO-2026-000002', 'POL-DEMO-2026-000001', 'POL-DEMO-2027-000001']);
  assert.strictEqual((await admin.getPolicy('demo-insurer', 'POL-DEMO-2026-000002')).caseId, 'case-b');
  assert.strictEqual(await admin.getPolicy('demo-insurer', 'POL-DEMO-2026-000099'), null);
});

// ---------- utilities and storage ----------

test('utilities: stripUndefined, pseudonymous customer key, safeEqual', () => {
  assert.deepStrictEqual(stripUndefined({ a: 1, b: undefined, c: { d: undefined, e: [1, undefined] }, f: new Date(0) }), { a: 1, c: { e: [1, undefined] }, f: new Date(0) });
  const k = customerKey('pepper', '+212600000001');
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.ok(!k.includes('212600000001'));
  assert.strictEqual(k, customerKey('pepper', '+212600000001'));
  assert.notStrictEqual(k, customerKey('other', '+212600000001'));
  assert.strictEqual(safeEqual('abc', 'abc'), true);
  assert.strictEqual(safeEqual('abc', 'abd'), false);
  assert.strictEqual(safeEqual('', ''), false);
});

test('Firebase storage adapter calls the bucket API correctly', async () => {
  const log = [];
  const bucket = { file: (p) => ({
    save: async (buf, opts) => log.push(['save', p, buf.length, opts.contentType, opts.resumable]),
    download: async () => [Buffer.from('pdf')],
    getSignedUrl: async (o) => [`https://signed.example/${p}?v=${o.version}&a=${o.action}`],
  }) };
  const s = createFirebaseStorage(bucket);
  await s.save('a/b.pdf', new Uint8Array([1, 2, 3]), 'application/pdf');
  assert.deepStrictEqual(log[0], ['save', 'a/b.pdf', 3, 'application/pdf', false]);
  assert.strictEqual((await s.read('a/b.pdf')).toString(), 'pdf');
  assert.strictEqual(await s.getSignedUrl('a/b.pdf'), 'https://signed.example/a/b.pdf?v=v4&a=read');
});

// ---------- the Cloud Functions entry point ----------

let hasFirebase = true;
try { require.resolve('firebase-functions/v2/https'); require.resolve('firebase-admin'); } catch { hasFirebase = false; }

test('index.js loads and exports the expected functions', { skip: !hasFirebase }, () => {
  const exported = Object.keys(require('../index.js')).sort();
  assert.deepStrictEqual(exported, ['demoPay', 'members', 'paymentWebhook', 'retryOutbox', 'underwriterDecision', 'verify', 'webchat', 'whatsappWebhook']);
});

test('index.js defines only the enabled modules (ENABLED_MODULES), so missing secrets of others do not block a deploy', { skip: !hasFirebase }, () => {
  const load = (value) => {
    const before = process.env.ENABLED_MODULES;
    process.env.ENABLED_MODULES = value;
    delete require.cache[require.resolve('../index.js')];
    try { return Object.keys(require('../index.js')).sort(); } finally {
      if (before === undefined) delete process.env.ENABLED_MODULES; else process.env.ENABLED_MODULES = before;
      delete require.cache[require.resolve('../index.js')];
    }
  };
  assert.deepStrictEqual(load('auth'), ['members']);
  assert.deepStrictEqual(load('app'), ['demoPay', 'paymentWebhook', 'retryOutbox', 'underwriterDecision', 'verify', 'webchat', 'whatsappWebhook']);
  assert.strictEqual(load('auth, app').length, 8);
});

test('enabled modules: from the environment, else from .env.<project> (as during the CLI analysis), else all', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { resolveEnabledModules } = require('../src/server/enabledModules');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-'));
  fs.writeFileSync(path.join(dir, '.env.proj-a'), '# comment\nREQUIRE_MFA=false\nENABLED_MODULES= auth \n');
  assert.deepStrictEqual(resolveEnabledModules({ env: { ENABLED_MODULES: 'auth,app' }, dir }), ['auth', 'app']);
  assert.deepStrictEqual(resolveEnabledModules({ env: { GCLOUD_PROJECT: 'proj-a' }, dir }), ['auth']);
  assert.deepStrictEqual(resolveEnabledModules({ env: { FIREBASE_CONFIG: JSON.stringify({ projectId: 'proj-a' }) }, dir }), ['auth']);
  assert.deepStrictEqual(resolveEnabledModules({ env: { GCLOUD_PROJECT: 'other' }, dir }), ['all']);
  assert.deepStrictEqual(resolveEnabledModules({ env: { GCLOUD_PROJECT: '../etc' }, dir }), ['all']);
  assert.deepStrictEqual(resolveEnabledModules({ env: {}, dir }), ['all']);
});

test('deployed members handler runs end to end: builds the default Firebase app and Auth, even when firebase-functions created its own app', { skip: !hasFirebase }, () => {
  // Runs in a child process so the Firebase app and env stay isolated. Calls the real callable
  // handler (as Cloud Functions does): a signed-out call must be refused cleanly, not crash.
  const { execFileSync } = require('child_process');
  // The named app mimics firebase-functions, which creates one when it verifies a signed-in caller.
  const script = `
    require('firebase-admin/app').initializeApp({ projectId: 'demo-test' }, '__FIREBASE_FUNCTIONS_SDK__');
    const m = require(${JSON.stringify(require.resolve('../index.js'))}).members;
    m.run({ auth: null, data: { action: 'myTenants' }, rawRequest: {} })
      .then(() => console.log('NO_ERROR'), (e) => console.log(e.code + '|' + e.message));`;
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { PATH: process.env.PATH, ENABLED_MODULES: 'auth', GCLOUD_PROJECT: 'demo-test', FIREBASE_CONFIG: JSON.stringify({ projectId: 'demo-test' }) },
    encoding: 'utf8',
  });
  assert.strictEqual(out.trim().split('\n').pop(), 'unauthenticated|Sign in first.');
});
