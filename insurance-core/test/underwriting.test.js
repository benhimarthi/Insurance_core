'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeEnv, referredCase, FRENCH_ANSWERS, TENANT, PHONE } = require('./serverHelpers');

const code = (p) => p.then(() => assert.fail('should have thrown'), (e) => `${e.code}:${e.message}`);

function setup() {
  const env = makeEnv();
  env.seedMember(TENANT, 'aud-1', 'auditor');
  env.seedMember(TENANT, 'mgr-1', 'underwriting_manager');
  env.seedMember('other-insurer', 'uw-2', 'underwriter');
  env.call = (data, auth = env.underwriter()) => env.app.handleUnderwriting({ auth, data: { tenantId: TENANT, ...data } });
  return env;
}

test('review queue: referred cases with why they wait; the recent view lists every case', async () => {
  const env = setup();
  const referred = await referredCase(env);
  await env.say('Bonjour', { from: '+212600000099' });                          // another customer, still answering
  const { cases } = await env.call({ action: 'list' });
  assert.deepStrictEqual(cases.map((c) => c.caseId), [referred.id]);
  const [item] = cases;
  assert.strictEqual(item.waitingBecause, 'engine_refer');
  assert.ok(item.documentFlags.includes('OWNER_MISMATCH'), 'the registration belongs to someone else');
  assert.ok(item.reasonCodes.length > 0);
  assert.strictEqual(item.currency, 'MAD');
  assert.strictEqual((await env.call({ action: 'list', view: 'recent' })).cases.length, 2);

  assert.strictEqual((await env.call({ action: 'list' }, env.user('aud-1'))).cases.length, 1, 'auditors read too');
  assert.strictEqual(await code(env.call({ action: 'list' }, env.user('uw-2'))), 'permission-denied:FORBIDDEN', 'other insurers see nothing');
  assert.strictEqual(await code(env.call({ action: 'list' }, env.user('plat', { platformRole: 'platform_admin' }))), 'permission-denied:FORBIDDEN');
  assert.strictEqual(await code(env.call({ action: 'list', reason: 'support ticket 1' }, env.user('plat', { platformRole: 'platform_admin' }))), 'permission-denied:FORBIDDEN', 'the platform team has no case access');
  assert.strictEqual(await code(env.call({ action: 'list', view: 'everything' })), 'invalid-argument:view must be waiting or recent.');
});

test('a case in full: answers, engine reasons, document checks, contact, audit trail; never file paths', async () => {
  const env = setup();
  const referred = await referredCase(env);
  const c = await env.call({ action: 'get', caseId: referred.id });
  assert.strictEqual(c.input.driver.age, 38);
  assert.ok(c.engine.reasons.some((r) => r.type === 'document'));
  assert.deepStrictEqual(c.documents.map((d) => d.type).sort(), ['national_id', 'vehicle_registration']);
  assert.ok(c.documents.every((d) => d.hasFile === true && d.fields));
  assert.deepStrictEqual(c.contact, { channel: 'whatsapp', phone: PHONE, language: 'fr' });
  assert.ok(c.events.some((e) => e.type === 'engine_evaluated'));
  assert.ok(!JSON.stringify(c).includes('uploads/'), 'storage paths stay on the server');
  assert.strictEqual(await code(env.call({ action: 'get', caseId: 'nope' })), 'not-found:CASE_NOT_FOUND');
  assert.strictEqual(await code(env.call({ action: 'get', caseId: '../x' })), 'invalid-argument:Invalid caseId.');
});

test('document photos: short-lived link, every opening audited, nothing after retention', async () => {
  const env = setup();
  const referred = await referredCase(env);
  const before = env.onlyCase().updatedAt;
  const link = await env.call({ action: 'documentLink', caseId: referred.id, docType: 'national_id' }, env.user('aud-1'));
  assert.match(link.url, /^memory:\/\/uploads\//);
  assert.strictEqual(link.expiresInSec, 300);
  const viewed = env.db.list(`tenants/${TENANT}/cases/${referred.id}/events`).filter((e) => e.type === 'document_viewed');
  assert.deepStrictEqual(viewed.map((e) => [e.actor.id, e.payload]), [['aud-1', { docType: 'national_id', role: 'auditor' }]]);
  assert.strictEqual(env.onlyCase().updatedAt, before, 'looking does not touch the case');

  assert.strictEqual(await code(env.call({ action: 'documentLink', caseId: referred.id, docType: 'passport' })), 'not-found:DOCUMENT_NOT_FOUND');
  assert.strictEqual(await code(env.call({ action: 'documentLink', caseId: referred.id, docType: '__proto__' })), 'not-found:DOCUMENT_NOT_FOUND');
  await env.storage.deletePrefix('uploads/');                                     // the retention job ran
  assert.strictEqual(await code(env.call({ action: 'documentLink', caseId: referred.id, docType: 'national_id' })), 'not-found:DOCUMENT_GONE');
});

test('decisions through the module: approve, and the customer is told; conversations that never finished can only be rejected', async () => {
  const env = setup();
  const referred = await referredCase(env);
  const sentBefore = env.channel.texts().length;
  assert.deepStrictEqual(await env.call({ action: 'decide', caseId: referred.id, decision: 'approve' }), { ok: true, status: 'approved' });
  assert.ok(env.channel.texts().length > sentBefore, 'the WhatsApp customer was told');
  assert.strictEqual(await code(env.call({ action: 'decide', caseId: referred.id, decision: 'reject' })), 'failed-precondition:Case is "approved", not pending review.');

  // a customer who asked for an advisor in the middle of the questions
  await env.say('Bonjour', { from: '+212600000077' });
  await env.say('Je veux parler à un conseiller', { from: '+212600000077' });
  const handoff = env.cases().find((c) => c.handoff);
  const waiting = (await env.call({ action: 'list' })).cases.find((c) => c.caseId === handoff.id);
  assert.strictEqual(waiting.waitingBecause, 'customer_requested_human');
  assert.strictEqual(await code(env.call({ action: 'decide', caseId: handoff.id, decision: 'adjust', adjustedPremium: 3000 }, env.user('mgr-1'))), 'failed-precondition:CONVERSATION_NOT_FINISHED');
  assert.deepStrictEqual(await env.call({ action: 'decide', caseId: handoff.id, decision: 'reject', note: 'Rappelé par téléphone' }), { ok: true, status: 'rejected' });
});

test('messages to the customer: underwriters only, in the customer\'s channel, audited without the text', async () => {
  const env = setup();
  const referred = await referredCase(env);
  await env.call({ action: 'message', caseId: referred.id, text: 'Bonjour, pouvez-vous confirmer le nom sur la carte grise ?' });
  assert.strictEqual(env.channel.texts().at(-1), 'Bonjour, pouvez-vous confirmer le nom sur la carte grise ?');
  const ev = env.db.list(`tenants/${TENANT}/cases/${referred.id}/events`).find((e) => e.type === 'advisor_message');
  assert.deepStrictEqual(ev.payload, { role: 'underwriter', length: 58 });
  assert.strictEqual(await code(env.call({ action: 'message', caseId: referred.id, text: 'x' }, env.user('aud-1'))), 'permission-denied:FORBIDDEN');
  assert.strictEqual(await code(env.call({ action: 'message', caseId: referred.id, text: '  ' })), 'invalid-argument:message must be 1 to 1000 characters.');

  // a web chat customer gets it when the page checks for new messages
  const sessionId = 'sess-abcdef12';
  const web = (body) => env.app.handleWebChat({ tenantId: TENANT, headers: {}, body: { sessionId, ...body } });
  await web({ text: 'Bonjour' });
  const webCase = env.cases().find((c) => c.channel === 'web');
  await env.call({ action: 'message', caseId: webCase.id, text: 'Un conseiller vous répond ici.' });
  assert.deepStrictEqual((await web({ poll: true })).body.messages, [{ kind: 'text', text: 'Un conseiller vous répond ici.' }]);
});

test('underwriting callable rejects unknown actions', async () => {
  const env = setup();
  assert.strictEqual(await code(env.call({ action: 'deleteAll' })), 'invalid-argument:Unknown action.');
  assert.strictEqual(await code(env.app.handleUnderwriting({ auth: env.underwriter(), data: undefined })), 'invalid-argument:Unknown action.');
});
