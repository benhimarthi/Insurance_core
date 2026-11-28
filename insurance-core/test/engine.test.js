'use strict';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../config/tenants/demo-insurer/motor.json');
const { evaluateCase } = require('../src/modules/underwriting');
const { newCase, caseStatusFromEngine, applyHumanDecision, CASE_STATUS } = require('../src/shared/cases');

const cleanCase = () => ({
  driver: { age: 38, licenseYears: 15, claimsLast3Years: 0, hasSuspension: false },
  vehicle: { category: 'compact', value: 120000, ageYears: 4, usage: 'private' },
  location: { riskZone: 'medium' },
  coverage: 'tous_risques',
  documentConfidence: 0.95,
});

test('scenario 1: clean case is accepted with an explained premium', () => {
  const r = evaluateCase(cleanCase(), config);
  assert.strictEqual(r.status, 'accept');
  assert.strictEqual(r.riskBand, 'low');
  assert.strictEqual(r.premium.total, 3696); // (2500 + 1440) * 0.90 + 150
  assert.ok(r.premium.breakdown.length >= 3);
});

test('scenario 2: borderline case is referred with reasons and a suggested premium', () => {
  const c = cleanCase();
  c.driver = { age: 23, licenseYears: 4, claimsLast3Years: 1, hasSuspension: false };
  c.location = { riskZone: 'high' };
  const r = evaluateCase(c, config);
  assert.strictEqual(r.status, 'refer');
  assert.ok(r.premium.total > 0);
  assert.ok(r.reasons.some((x) => x.code === 'SCORE_REFER'));
  assert.ok(r.reasons.some((x) => x.code === 'YOUNG_DRIVER'));
});

test('scenario 3: suspended license is refused with no premium', () => {
  const c = cleanCase();
  c.driver.hasSuspension = true;
  const r = evaluateCase(c, config);
  assert.strictEqual(r.status, 'refuse');
  assert.strictEqual(r.premium, null);
  assert.ok(r.reasons.some((x) => x.code === 'LICENSE_SUSPENDED'));
});

test('poor document quality forces a human review', () => {
  const c = cleanCase();
  c.documentConfidence = 0.5;
  const r = evaluateCase(c, config);
  assert.strictEqual(r.status, 'refer');
  assert.ok(r.reasons.some((x) => x.code === 'LOW_CONFIDENCE'));
});

test('high-value vehicle is referred', () => {
  const c = cleanCase();
  c.vehicle.value = 650000;
  assert.strictEqual(evaluateCase(c, config).status, 'refer');
});

test('missing fields return needs_info listing what to ask', () => {
  const c = cleanCase();
  delete c.vehicle.value;
  const r = evaluateCase(c, config);
  assert.strictEqual(r.status, 'needs_info');
  assert.deepStrictEqual(r.issues, [{ field: 'vehicle.value', problem: 'missing' }]);
});

test('only a human can resolve a referred case, and it is audited', () => {
  const doc = newCase({ tenantId: 'demo-insurer', channel: 'whatsapp', language: 'fr', customerId: 'c1' });
  doc.engineResult = { premium: { total: 5000 } };
  doc.status = caseStatusFromEngine('refer', config);
  assert.strictEqual(doc.status, CASE_STATUS.PENDING_REVIEW);

  assert.throws(() => applyHumanDecision(doc, { decision: 'approve' }), /human reviewer/);
  const { case: updated, event } = applyHumanDecision(doc, { reviewerId: 'uw-1', decision: 'adjust', adjustedPremium: 5600, note: 'Added surcharge' });
  assert.strictEqual(updated.status, CASE_STATUS.ADJUSTED);
  assert.strictEqual(event.actor.kind, 'human');
  assert.strictEqual(event.payload.proposedPremium, 5000);
});
