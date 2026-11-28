'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { config, NOW, FRENCH_ANSWERS, doc, converse } = require('./helpers');
const { createLlmDocumentProcessor } = require('../src/adapters/documentProcessor');
const { acceptDocument, nameSimilarity, yearsBetween, parseDate } = require('../src/documents/documents');
const { evaluateCase } = require('../src/modules/underwriting');
const { CASE_STATUS } = require('../src/shared/cases');

test('after the last question the agent asks for both documents', async () => {
  const { caseDoc, replies } = await converse(FRENCH_ANSWERS);
  assert.strictEqual(caseDoc.flow.stage, 'documents');
  assert.match(replies[replies.length - 1], /Carte nationale d’identité et Carte grise/);
});

test('documents can arrive one at a time; a text message gets a reminder', async () => {
  const { caseDoc, replies } = await converse([...FRENCH_ANSWERS, doc('demo_id_ok'), 'voilà', doc('demo_registration_ok')]);
  assert.ok(replies.some((r) => /Il me manque encore : Carte grise/.test(r)));
  assert.strictEqual(caseDoc.status, CASE_STATUS.QUOTED);
  assert.ok(caseDoc.documents.national_id && caseDoc.documents.vehicle_registration);
});

test('blurry photo: customer is asked to resend, then the flow continues', async () => {
  const { caseDoc, replies } = await converse([
    ...FRENCH_ANSWERS, doc('demo_id_blurry', 'demo_registration_ok'), doc('demo_id_ok'),
  ]);
  assert.ok(replies.some((r) => /pas assez lisible/.test(r)));
  assert.strictEqual(caseDoc.status, CASE_STATUS.QUOTED);
});

test('expired ID is rejected with a specific message', async () => {
  const { replies, caseDoc } = await converse([...FRENCH_ANSWERS, doc('demo_id_expired')]);
  assert.ok(replies.some((r) => /expiré/.test(r)));
  assert.strictEqual(caseDoc.flow.stage, 'documents');
  assert.strictEqual(caseDoc.documents.national_id, undefined);
});

test('unrecognised document: the agent says what it expects', async () => {
  const { replies } = await converse([...FRENCH_ANSWERS, { attachments: [{ filename: 'selfie.jpg' }] }]);
  assert.ok(replies.some((r) => /Je n’ai pas reconnu ce document/.test(r)));
});

test('three failed uploads trigger a human handoff', async () => {
  const bad = { attachments: [{ filename: 'random.jpg' }] };
  const { caseDoc } = await converse([...FRENCH_ANSWERS, bad, bad, bad]);
  assert.strictEqual(caseDoc.handoff.reason, 'documents_failed');
  assert.strictEqual(caseDoc.status, CASE_STATUS.PENDING_REVIEW);
});

test('registered owner differs from the ID holder: referred with OWNER_MISMATCH', async () => {
  const { caseDoc, replies } = await converse([...FRENCH_ANSWERS, doc('demo_id_ok', 'demo_registration_other_owner')]);
  assert.strictEqual(caseDoc.status, CASE_STATUS.PENDING_REVIEW);
  assert.ok(caseDoc.engineResult.reasons.some((r) => r.code === 'OWNER_MISMATCH'));
  assert.doesNotMatch(replies[replies.length - 1], /propriétaire|OWNER|MAD/);
});

test('declared vehicle age contradicts the registration: referred with VEHICLE_AGE_MISMATCH', async () => {
  const { caseDoc } = await converse([...FRENCH_ANSWERS, doc('demo_id_ok', 'demo_registration_old')]);
  assert.strictEqual(caseDoc.status, CASE_STATUS.PENDING_REVIEW);
  assert.ok(caseDoc.engineResult.reasons.some((r) => r.code === 'VEHICLE_AGE_MISMATCH'));
});

test('declared age contradicts the ID: referred with AGE_MISMATCH', async () => {
  const { caseDoc } = await converse([...FRENCH_ANSWERS, doc('demo_id_other_age', 'demo_registration_ok')]);
  assert.ok(caseDoc.engineResult.reasons.some((r) => r.code === 'AGE_MISMATCH'));
  assert.strictEqual(caseDoc.status, CASE_STATUS.PENDING_REVIEW);
});

test('fuzzy but acceptable document lowers confidence and forces a human review', async () => {
  const { caseDoc } = await converse([...FRENCH_ANSWERS, doc('demo_id_ok', 'demo_registration_fuzzy')]);
  assert.strictEqual(caseDoc.documentConfidence, 0.6);
  assert.ok(caseDoc.engineResult.reasons.some((r) => r.code === 'LOW_CONFIDENCE'));
  assert.strictEqual(caseDoc.status, CASE_STATUS.PENDING_REVIEW);
});

test('audit events never contain extracted personal values', async () => {
  const { events } = await converse([...FRENCH_ANSWERS, doc('demo_id_ok', 'demo_registration_ok')]);
  const log = JSON.stringify(events.filter((e) => e.type === 'document_extracted'));
  assert.ok(log.length > 0);
  assert.doesNotMatch(log, /Benali|BENALI|12345-A-6|1988/);
});

test('LLM document processor: valid JSON is used, failure means resend', async () => {
  const good = createLlmDocumentProcessor({
    callModel: async () => '```json\n{"type":"national_id","fields":{"fullName":"Amine Benali","birthDate":"1988-05-14","expiryDate":"2031-02-01"},"confidence":0.9}\n```',
  });
  const ok = await converse([...FRENCH_ANSWERS, { attachments: [{ filename: 'x.jpg' }] }], { documentProcessor: good });
  assert.ok(ok.caseDoc.documents.national_id);

  const down = createLlmDocumentProcessor({ callModel: async () => { throw new Error('API down'); } });
  const ko = await converse([...FRENCH_ANSWERS, { attachments: [{ filename: 'x.jpg' }] }], { documentProcessor: down });
  assert.strictEqual(ko.caseDoc.documents.national_id, undefined);
  assert.strictEqual(ko.caseDoc.flow.stage, 'documents');
});

test('acceptDocument rejects bad dates and out-of-spec data', () => {
  const bad = acceptDocument({ type: 'national_id', confidence: 0.9, fields: { fullName: 'A B', birthDate: '14/05/1988', expiryDate: '2031-02-01' } }, config, NOW);
  assert.deepStrictEqual([bad.ok, bad.issue], [false, 'ILLEGIBLE']);
  const future = acceptDocument({ type: 'vehicle_registration', confidence: 0.9, fields: { ownerName: 'A B', plate: '1-A-1', firstRegistrationDate: '2030-01-01' } }, config, NOW);
  assert.strictEqual(future.issue, 'ILLEGIBLE');
});

test('helpers: name similarity ignores order and case, years are full years', () => {
  assert.strictEqual(nameSimilarity('BENALI Amine', 'Amine Benali'), 1);
  assert.ok(nameSimilarity('Amine Benali', 'Zahra Idrissi') < 0.5);
  assert.strictEqual(yearsBetween(parseDate('1988-05-14'), NOW), 38);
  assert.strictEqual(yearsBetween(parseDate('2022-03-10'), NOW), 4);
});

test('engine: document flags force a referral even for a clean profile', () => {
  const clean = {
    driver: { age: 38, licenseYears: 15, claimsLast3Years: 0, hasSuspension: false },
    vehicle: { category: 'compact', value: 120000, ageYears: 4, usage: 'private' },
    location: { riskZone: 'medium' }, coverage: 'tous_risques', documentConfidence: 0.95,
    documentFlags: [{ code: 'OWNER_MISMATCH', message: 'test' }],
  };
  const r = evaluateCase(clean, config);
  assert.strictEqual(r.status, 'refer');
  assert.ok(r.reasons.some((x) => x.code === 'OWNER_MISMATCH' && x.type === 'document'));
});
