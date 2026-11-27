'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { config, FRENCH_ANSWERS, doc, converse } = require('./helpers');
const { assertQuestionsCoverConfig, createLlmExtractor } = require('../src/modules/conversation');
const { CASE_STATUS } = require('../src/shared/cases');

test('config and question catalogue are consistent', () => {
  assertQuestionsCoverConfig(config);
});

test('French conversation: clean profile and good documents get an automatic quote', async () => {
  const { caseDoc, replies } = await converse([...FRENCH_ANSWERS, doc('demo_id_ok', 'demo_registration_ok')]);
  assert.strictEqual(caseDoc.language, 'fr');
  assert.strictEqual(caseDoc.status, CASE_STATUS.QUOTED);
  assert.strictEqual(caseDoc.engineResult.premium.total, 3696);
  assert.strictEqual(caseDoc.input.location.riskZone, 'medium');
  assert.deepStrictEqual(caseDoc.documentFlags, []);
  assert.match(replies[replies.length - 1], /3696 MAD/);
});

test('English conversation: borderline profile is referred, customer sees no price', async () => {
  const { caseDoc, replies, events } = await converse([
    'Hello, I need car insurance',
    '38', '15', '1', 'no', 'compact', '90000', '4', 'private', 'Casablanca', 'comprehensive',
    doc('demo_id_ok', 'demo_registration_ok'),
  ]);
  assert.strictEqual(caseDoc.language, 'en');
  assert.strictEqual(caseDoc.status, CASE_STATUS.QUOTED); // 1 claim + high zone = 20 points: still accepted
  assert.ok(events.some((e) => e.type === 'engine_evaluated'));

  // a genuinely borderline profile: young driver, 1 claim, high-risk zone, documents match the declaration
  const young = await converse([
    'Hello, I need car insurance',
    '23', '4', '1', 'no', 'compact', '90000', '4', 'private', 'Casablanca', 'comprehensive',
    doc('demo_id_ok', 'demo_registration_ok'),
  ]);
  // declared age 23 vs ID age 38 also raises AGE_MISMATCH: both reasons reach the underwriter
  assert.strictEqual(young.caseDoc.status, CASE_STATUS.PENDING_REVIEW);
  const last = young.replies[young.replies.length - 1];
  assert.match(last, /underwriter/);
  assert.doesNotMatch(last, /MAD|\d{3}/);
  assert.ok(young.events.some((e) => e.type === 'referred'));
  assert.ok(young.caseDoc.engineResult.reasons.some((r) => r.code === 'SCORE_REFER'));
  assert.ok(young.caseDoc.engineResult.reasons.some((r) => r.code === 'AGE_MISMATCH'));
});

test('Darija: Arabic script starts the conversation in darija', async () => {
  const { caseDoc, replies } = await converse(['سلام بغيت نأمن الطوموبيل']);
  assert.strictEqual(caseDoc.language, 'darija');
  assert.match(replies[0], /[\u0600-\u06FF]/);
  assert.match(replies[1], /شحال عندك فالعمر/);
});

test('suspended license is never auto-declined by default: it goes to a human', async () => {
  const { caseDoc } = await converse([
    'Bonjour', '38', '15', '0', 'oui', '1', '120000', '4', '1', 'Rabat', '2',
    doc('demo_id_ok', 'demo_registration_ok'),
  ]);
  assert.strictEqual(caseDoc.engineResult.status, 'refuse');
  assert.strictEqual(caseDoc.status, CASE_STATUS.PENDING_REVIEW);
});

test('customer confirms the quote and the event is logged', async () => {
  const { caseDoc, events } = await converse([...FRENCH_ANSWERS, doc('demo_id_ok', 'demo_registration_ok'), 'oui']);
  assert.strictEqual(caseDoc.flow.stage, 'confirmed');
  assert.ok(events.some((e) => e.type === 'quote_accepted'));
});

test('three misunderstood answers trigger a human handoff', async () => {
  const { caseDoc } = await converse(['Bonjour', 'euh', 'je ne sais pas', 'peut-être']);
  assert.strictEqual(caseDoc.status, CASE_STATUS.PENDING_REVIEW);
  assert.strictEqual(caseDoc.handoff.reason, 'conversation_stuck');
});

test('customer can ask for a human at any time', async () => {
  const { caseDoc, replies } = await converse(['Hello', '30', 'I want to speak to an advisor']);
  assert.strictEqual(caseDoc.handoff.reason, 'customer_requested_human');
  assert.match(replies[replies.length - 1], /advisor/);
});

test('invalid extractor output is rejected and the question is repeated', async () => {
  const badExtractor = { extract: async () => ({ fields: { 'driver.age': -5, 'not.a.field': 1 } }) };
  const { caseDoc, replies } = await converse(['Bonjour', 'whatever'], { extractor: badExtractor });
  assert.strictEqual(caseDoc.input.driver.age, undefined);
  assert.strictEqual(caseDoc.flow.retries, 1);
  assert.match(replies[replies.length - 1], /âge/);
});

test('LLM extractor can fill several fields at once and the flow skips answered questions', async () => {
  const fakeModel = async () => '```json\n{"driver.age": 30, "vehicle.category": "suv", "bogus": 1}\n```';
  const extractor = createLlmExtractor({ callModel: fakeModel });
  const { caseDoc, replies } = await converse(['Bonjour', 'I am 30 and I drive an SUV'], { extractor });
  assert.strictEqual(caseDoc.input.driver.age, 30);
  assert.strictEqual(caseDoc.input.vehicle.category, 'suv');
  assert.match(replies[replies.length - 1], /permis/);
});

test('LLM failure degrades gracefully to a retry', async () => {
  const extractor = createLlmExtractor({ callModel: async () => { throw new Error('API down'); } });
  const { caseDoc } = await converse(['Bonjour', '30'], { extractor });
  assert.strictEqual(caseDoc.flow.retries, 1);
  assert.strictEqual(caseDoc.flow.stage, 'asking');
});
