'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeEnv, referredCase, FRENCH_ANSWERS, img, TENANT, PAY_SECRET, WH_SECRET, PHONE } = require('./serverHelpers');
const { AppError } = require('../src/server/util');

const DOCS = { attachments: [img('demo_id_ok'), img('demo_registration_ok')] };

test('WhatsApp end to end: chat, quote, payment link, demo checkout, policy PDF on WhatsApp', async () => {
  const env = makeEnv();
  await env.sayAll([...FRENCH_ANSWERS, DOCS]);
  assert.match(env.lastText(), /3696 MAD/);
  assert.strictEqual(env.onlyCase().status, 'quoted');

  await env.say('oui');
  assert.match(env.lastText(), /https:\/\/demo\.example\/pay\/demo-insurer\/pay_[0-9a-f]{24}/);
  const paymentId = env.payIdFromChat();

  const form = await env.pay(paymentId, 'GET');
  assert.strictEqual(form.status, 200);
  assert.match(form.html, /3696,00 MAD/);
  assert.match(form.html, /AUCUN PAIEMENT RÉEL/);
  assert.ok(form.headers['content-security-policy']);

  const paid = await env.pay(paymentId, 'POST');
  assert.strictEqual(paid.status, 200);
  assert.match(paid.html, /Paiement confirmé/);

  const c = env.onlyCase();
  assert.strictEqual(c.status, 'issued');
  assert.strictEqual(c.policy.policyNumber, 'POL-DEMO-2026-000001');
  assert.match(env.lastText(), /POL-DEMO-2026-000001/);
  const doc = env.channel.sent.find((s) => s.kind === 'document');
  assert.strictEqual(doc.filename, 'POL-DEMO-2026-000001.pdf');
  assert.strictEqual(doc.to, PHONE);
  assert.match(doc.url, /^memory:\/\/tenants\/demo-insurer\/policies\/POL-DEMO-2026-000001\.pdf$/);

  assert.ok(env.db.docs.has('tenants/demo-insurer/policies/POL-DEMO-2026-000001'));
  const events = env.db.list(`tenants/${TENANT}/cases/${c.id}/events`).map((e) => e.type);
  for (const t of ['engine_evaluated', 'quote_accepted', 'payment_link_created', 'payment_received', 'policy_issued']) assert.ok(events.includes(t), `event ${t}`);
  assert.ok(env.db.list('outbox').every((o) => o.status === 'sent'));

  // a second click on "Pay" changes nothing
  const sentBefore = env.channel.sent.length;
  assert.match((await env.pay(paymentId, 'POST')).html, /Paiement confirmé/);
  assert.strictEqual(env.channel.sent.length, sentBefore);
});

test('uploads are stored only while the flow waits for documents', async () => {
  const env = makeEnv();
  await env.say('Bonjour', { attachments: [img('demo_id_ok')] });
  await env.say('38 ans', { attachments: [img('demo_id_ok')] });
  assert.strictEqual(env.storage.count(), 0);

  await env.sayAll(FRENCH_ANSWERS.slice(2));
  await env.say('', { attachments: [img('demo_id_ok'), { mimeType: 'application/zip', filename: 'x.zip' }] });
  assert.strictEqual(env.storage.count(), 1); // the zip is refused
  assert.ok([...env.db.docs.keys()].every((k) => !k.includes('fake-image-bytes')));
});

test('a redelivered WhatsApp message is processed once', async () => {
  const env = makeEnv();
  await env.say('Bonjour', { messageId: 'same-id' });
  const first = env.channel.sent.length;
  const again = await env.say('Bonjour', { messageId: 'same-id' });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(env.channel.sent.length, first);
  assert.strictEqual(env.cases().length, 1);
});

test('a concurrent change triggers a retry: replies are sent once, from the fresh state', async () => {
  const env = makeEnv();
  await env.say('Bonjour');
  const sentBefore = env.channel.sent.length;
  const c = env.onlyCase();

  env.hooks.extractCalls = 0;
  env.hooks.onExtract = async () => { // someone else commits while we are computing
    const path = `tenants/${TENANT}/cases/${c.id}`;
    env.db.docs.set(path, { ...env.db.docs.get(path), version: c.version + 1 });
  };
  await env.say('38 ans');

  assert.strictEqual(env.hooks.extractCalls, 2); // computed twice, committed once
  assert.strictEqual(env.onlyCase().input.driver.age, 38);
  assert.strictEqual(env.channel.sent.length - sentBefore, 1); // one reply: the next question
});

test('a failed send does not fail the request; the retry job delivers in order', async () => {
  const env = makeEnv();
  env.channel.failNext = 1;
  const res = await env.say('Bonjour');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(env.channel.sent.length, 0);
  const pending = env.db.list('outbox');
  assert.strictEqual(pending.length, 2);
  assert.ok(pending.every((o) => o.status === 'pending'));

  env.clock.now = new Date(env.clock.now.getTime() + 5 * 60 * 1000);
  const stats = await env.app.retryOutbox();
  assert.deepStrictEqual(stats, { sent: 2, failed: 0 });
  assert.match(env.channel.texts()[0], /Bonjour !/);   // intro first
  assert.match(env.channel.texts()[1], /Quel âge/);    // then the question
});

test('outbox gives up after repeated failures and marks the entry failed', async () => {
  const env = makeEnv();
  env.channel.failNext = 1000;
  await env.say('Bonjour');
  for (let i = 0; i < 10; i += 1) {
    env.clock.now = new Date(env.clock.now.getTime() + 2 * 3600 * 1000);
    await env.app.retryOutbox();
  }
  const entries = env.db.list('outbox');
  assert.ok(entries.some((o) => o.status === 'failed' && o.attempts === 8));
});

test('webhook security: bad secret, unknown or malformed tenant', async () => {
  const env = makeEnv();
  const body = { messages: [{ messageId: 'x', from: PHONE, text: 'Bonjour', attachments: [] }] };
  assert.strictEqual((await env.app.handleWhatsAppWebhook({ tenantId: TENANT, headers: { 'x-webhook-signature': 'nope' }, body })).status, 401);
  assert.strictEqual((await env.app.handleWhatsAppWebhook({ tenantId: TENANT, headers: {}, body })).status, 401);
  assert.strictEqual((await env.app.handleWhatsAppWebhook({ tenantId: 'ghost-tenant', headers: { 'x-webhook-signature': WH_SECRET }, body })).status, 404);
  assert.strictEqual((await env.app.handleWhatsAppWebhook({ tenantId: '../etc', headers: { 'x-webhook-signature': WH_SECRET }, body })).status, 404);
  assert.strictEqual(env.cases().length, 0);
});

test('tenants are isolated even for the same phone number', async () => {
  const env = makeEnv();
  await env.say('Bonjour');
  await env.say('Bonjour', { tenantId: 'other-insurer' });
  assert.strictEqual(env.cases(TENANT).length, 1);
  assert.strictEqual(env.cases('other-insurer').length, 1);
  assert.notStrictEqual(env.cases(TENANT)[0].id, env.cases('other-insurer')[0].id);
});

test('payment webhook: signature, redelivery, wrong amount, unknown case', async () => {
  const env = makeEnv();
  await env.sayAll([...FRENCH_ANSWERS, DOCS, 'oui']);
  const id = env.payIdFromChat();
  const payment = await env.payments.getPayment(id);
  const { rawBody, signature } = env.payments.signEvent(payment, 'succeeded', PAY_SECRET);

  const tampered = await env.app.handlePaymentWebhook({ tenantId: TENANT, rawBody: rawBody.replace('3696', '1'), headers: { 'x-signature': signature } });
  assert.strictEqual(tampered.status, 401);
  assert.strictEqual((await env.app.handlePaymentWebhook({ tenantId: TENANT, rawBody, headers: {} })).status, 401);
  assert.strictEqual(env.onlyCase().status, 'awaiting_payment');

  const first = await env.app.handlePaymentWebhook({ tenantId: TENANT, rawBody, headers: { 'x-signature': signature } });
  assert.deepStrictEqual(first.body, { ok: true, duplicate: false });
  const sent = env.channel.sent.length;
  const again = await env.app.handlePaymentWebhook({ tenantId: TENANT, rawBody, headers: { 'x-signature': signature } });
  assert.deepStrictEqual(again.body, { ok: true, duplicate: true });
  assert.strictEqual(env.channel.sent.length, sent);
  assert.strictEqual(env.db.list(`tenants/${TENANT}/policies`).length, 1);

  // unknown case: acknowledged (200) so the provider stops retrying, and logged
  const ghost = env.payments.signEvent({ id: 'pay_x', caseId: 'ghostcase', amount: 10, currency: 'MAD' }, 'succeeded', PAY_SECRET);
  const res = await env.app.handlePaymentWebhook({ tenantId: TENANT, rawBody: ghost.rawBody, headers: { 'x-signature': ghost.signature } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, false);
  assert.ok(env.errors.some((e) => /ignored/.test(e)));
});

test('a payment of the wrong amount issues nothing and tells the customer it is being checked', async () => {
  const env = makeEnv();
  await env.sayAll([...FRENCH_ANSWERS, DOCS, 'oui']);
  const payment = await env.payments.getPayment(env.payIdFromChat());
  const wrong = env.payments.signEvent({ ...payment, amount: 100 }, 'succeeded', PAY_SECRET);
  await env.app.handlePaymentWebhook({ tenantId: TENANT, rawBody: wrong.rawBody, headers: { 'x-signature': wrong.signature } });
  assert.strictEqual(env.onlyCase().payment.status, 'mismatch');
  assert.strictEqual(env.db.list(`tenants/${TENANT}/policies`).length, 0);
  assert.match(env.lastText(), /nous le vérifions/);
});

test('underwriter flow: referral, adjusted premium, customer pays the adjusted amount', async () => {
  const env = makeEnv();
  const referred = await referredCase(env);
  assert.strictEqual(referred.status, 'pending_review');
  assert.match(env.lastText(), /souscripteur/);

  const base = { tenantId: TENANT, data: { caseId: referred.id, decision: 'adjust', adjustedPremium: 4200, note: 'Owner differs' } };
  await assert.rejects(env.app.handleUnderwriterDecision({ ...base, auth: null }), (e) => e instanceof AppError && e.code === 'unauthenticated');
  await assert.rejects(env.app.handleUnderwriterDecision({ ...base, auth: { uid: 'u', token: {} } }), (e) => e.code === 'permission-denied');
  await assert.rejects(env.app.handleUnderwriterDecision({ ...base, auth: env.underwriter('outsider') }), (e) => e.code === 'permission-denied'); // not a member here
  await assert.rejects(env.app.handleUnderwriterDecision({ ...base, data: { ...base.data, decision: 'maybe' }, auth: env.underwriter() }), (e) => e.code === 'invalid-argument');
  await assert.rejects(env.app.handleUnderwriterDecision({ ...base, data: { ...base.data, adjustedPremium: -5 }, auth: env.underwriter() }), (e) => e.code === 'invalid-argument');
  await assert.rejects(env.app.handleUnderwriterDecision({ ...base, data: { caseId: 'nope', decision: 'approve' }, auth: env.underwriter() }), (e) => e.code === 'not-found');
  assert.strictEqual(env.onlyCase().status, 'pending_review'); // nothing changed so far

  const ok = await env.app.handleUnderwriterDecision({ ...base, auth: env.underwriter() });
  assert.deepStrictEqual(ok, { ok: true, status: 'adjusted' });
  assert.match(env.lastText(), /4200 MAD/);
  const events = env.db.list(`tenants/${TENANT}/cases/${referred.id}/events`);
  const decision = events.find((e) => e.type === 'human_decision');
  assert.deepStrictEqual(decision.actor, { kind: 'human', id: 'uw-1' });

  await assert.rejects(env.app.handleUnderwriterDecision({ ...base, auth: env.underwriter() }), (e) => e.code === 'failed-precondition');

  await env.say('oui');
  const id = env.payIdFromChat();
  assert.strictEqual((await env.payments.getPayment(id)).amount, 4200);
  await env.pay(id, 'POST');
  assert.strictEqual(env.onlyCase().status, 'issued');
});

test('underwriter rejection sends a neutral message and blocks payment', async () => {
  const env = makeEnv();
  const referred = await referredCase(env);
  await env.app.handleUnderwriterDecision({ tenantId: TENANT, auth: env.underwriter(), data: { caseId: referred.id, decision: 'reject', note: 'x' } });
  assert.match(env.lastText(), /ne pouvons malheureusement pas donner suite/);
  assert.doesNotMatch(env.lastText(), /propriétaire/);
  assert.strictEqual(env.onlyCase().flow.stage, 'closed');
});

test('a new case starts after a closed one, and after issuance once the day has passed', async () => {
  const env = makeEnv();
  await env.sayAll([...FRENCH_ANSWERS, DOCS, 'oui']);
  await env.pay(env.payIdFromChat(), 'POST');
  assert.strictEqual(env.cases().length, 1);

  await env.say('merci');
  assert.match(env.lastText(), /contrat est actif/);
  assert.strictEqual(env.cases().length, 1);

  env.clock.now = new Date(env.clock.now.getTime() + 25 * 3600 * 1000);
  await env.say('Bonjour, une autre voiture');
  assert.strictEqual(env.cases().length, 2);
  assert.match(env.channel.texts().slice(-2)[0], /Bonjour !/);
});

test('web chat: demo tenant works without a key and returns messages in order', async () => {
  const env = makeEnv();
  const call = (body, headers = {}, tenantId = TENANT) => env.app.handleWebChat({ tenantId, headers, body });
  const sessionId = 'sess-abcdef12';

  const first = await call({ sessionId, text: 'Hello, I need car insurance' });
  assert.strictEqual(first.status, 200);
  assert.deepStrictEqual(first.body.messages.map((m) => m.kind), ['text', 'text']);
  assert.match(first.body.messages[0].text, /Hello!/);
  assert.deepStrictEqual((await call({ sessionId, poll: true })).body.messages, []); // already taken
  assert.strictEqual(env.channel.sent.length, 0);                                    // nothing goes to WhatsApp

  assert.strictEqual((await call({ sessionId: 'bad id!', text: 'x' })).status, 400);
  assert.strictEqual((await call({ sessionId, text: 'x'.repeat(2000) })).status, 400);
});

test('web chat: tenant key and non-demo rules', async () => {
  const env = makeEnv();
  const call = (tenantId, headers) => env.app.handleWebChat({ tenantId, headers, body: { sessionId: 'sess-abcdef12', text: 'Bonjour' } });
  assert.strictEqual((await call('secure-insurer', {})).status, 401);
  assert.strictEqual((await call('secure-insurer', { 'x-webchat-key': 'wrong' })).status, 401);
  assert.strictEqual((await call('secure-insurer', { 'x-webchat-key': 'key-123' })).status, 200);
  assert.strictEqual((await call('closed-insurer', {})).status, 401); // open web chat only for demo tenants
});

test('web chat: customer gets the underwriter decision and the policy through polling', async () => {
  const env = makeEnv();
  const sessionId = 'sess-abcdef12';
  const call = (body) => env.app.handleWebChat({ tenantId: TENANT, headers: {}, body: { sessionId, ...body } });
  const file = (demoFixture) => ({ mimeType: 'image/png', dataBase64: 'aGVsbG8=', demoFixture });

  for (const text of FRENCH_ANSWERS) await call({ text });
  await call({ text: '', attachments: [file('demo_id_ok'), file('demo_registration_other_owner')] });
  const referred = env.onlyCase();
  assert.strictEqual(referred.status, 'pending_review');

  await env.app.handleUnderwriterDecision({ tenantId: TENANT, auth: env.underwriter(), data: { caseId: referred.id, decision: 'approve' } });
  const poll = await call({ poll: true });
  assert.match(poll.body.messages[0].text, /validé/);

  await call({ text: 'oui' });
  const paymentId = env.db.list('demoPayments')[0].id;
  await env.pay(paymentId, 'POST');
  const done = await call({ poll: true });
  assert.ok(done.body.messages.some((m) => m.kind === 'document' && m.filename === 'POL-DEMO-2026-000001.pdf'));
});

test('demo checkout does not exist for real tenants or unknown payments', async () => {
  const env = makeEnv();
  await env.sayAll([...FRENCH_ANSWERS, DOCS, 'oui']);
  const id = env.payIdFromChat();
  assert.strictEqual((await env.pay(id, 'GET', 'other-insurer')).status, 404); // belongs to another tenant
  assert.strictEqual((await env.pay(id, 'GET', 'secure-insurer')).status, 404); // not a demo tenant
  assert.strictEqual((await env.pay('pay_ffff', 'GET')).status, 404);
  assert.strictEqual((await env.pay('../x', 'GET')).status, 404);
  env.clock.now = new Date(env.clock.now.getTime() + 3 * 24 * 3600 * 1000);
  assert.strictEqual((await env.pay(id, 'POST')).status, 410); // expired link
});

test('no undefined values reach Firestore, and a failing handler does not corrupt state', async () => {
  const env = makeEnv();
  await env.say('Bonjour'); // newCase() has undefined fields: the strict fake would throw if they leaked
  const before = JSON.stringify(env.onlyCase());
  env.hooks.onExtract = async () => { throw new Error('model exploded'); };
  const res = await env.say('38 ans');
  assert.strictEqual(res.status, 500);
  assert.strictEqual(JSON.stringify(env.onlyCase()), before);

  const retry = await env.say('38 ans'); // the provider retries with a new delivery
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(env.onlyCase().input.driver.age, 38);
});
