'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const { config, NOW, FRENCH_ANSWERS, doc, converse } = require('./helpers');
const { createMockPaymentAdapter } = require('../src/adapters/payment');
const { createMockPolicyAdmin } = require('../src/adapters/policyAdmin');
const { createMemoryStorage } = require('../src/adapters/storage');
const { parseWebhook } = require('../src/payment/webhook');
const { notifyHumanDecision, requestPayment, handlePaymentEvent } = require('../src/policy/lifecycle');
const { buildPolicyDraft, addMonths, isoDate } = require('../src/policy/policy');
const { generatePolicyPdf } = require('../src/policy/pdf');
const { applyHumanDecision, CASE_STATUS } = require('../src/shared/cases');

const HAS_PDFTOTEXT = spawnSync('pdftotext', ['-v']).error === undefined;

function setup() {
  return {
    pay: createMockPaymentAdapter({ clock: () => NOW }),
    policyAdmin: createMockPolicyAdmin(),
    storage: createMemoryStorage(),
  };
}

/** Delivers a signed payment webhook the way the Cloud Function would: verify, then handle. */
async function deliver(env, caseDoc, simulateOpts) {
  const { rawBody, signature } = env.pay.simulate(caseDoc.payment.paymentId, simulateOpts);
  const event = parseWebhook({ secret: env.pay.secret, rawBody, signature });
  return handlePaymentEvent({ caseDoc, event, config, policyAdmin: env.policyAdmin, storage: env.storage, now: NOW });
}

function pdfText(bytes) {
  const file = path.join(os.tmpdir(), `policy-${process.pid}-${Date.now()}.pdf`);
  fs.writeFileSync(file, bytes);
  const out = spawnSync('pdftotext', [file, '-'], { encoding: 'utf8' }).stdout;
  fs.unlinkSync(file);
  return out;
}

const autoQuoted = (env, answers = FRENCH_ANSWERS, accept = 'oui') =>
  converse([...answers, doc('demo_id_ok', 'demo_registration_ok'), accept], { paymentAdapter: env.pay });

test('happy path: accept, pay, policy issued with a PDF', async () => {
  const env = setup();
  const { caseDoc, replies } = await autoQuoted(env);
  assert.strictEqual(caseDoc.status, CASE_STATUS.AWAITING_PAYMENT);
  assert.strictEqual(caseDoc.payment.amount, 3696);
  assert.match(replies[replies.length - 1], /https:\/\/pay\.demo-insurer\.example\/pay\/pay_000001/);

  const out = await deliver(env, caseDoc);
  assert.strictEqual(out.caseDoc.status, CASE_STATUS.ISSUED);
  assert.strictEqual(out.caseDoc.policy.policyNumber, 'POL-DEMO-2026-000001');
  assert.strictEqual(out.caseDoc.policy.startDate, '2026-11-21');
  assert.strictEqual(out.caseDoc.policy.endDate, '2027-11-20');
  assert.match(out.replies[0], /POL-DEMO-2026-000001/);
  assert.deepStrictEqual(out.attachments.map((a) => a.filename), ['POL-DEMO-2026-000001.pdf']);
  assert.ok(out.events.some((e) => e.type === 'payment_received'));
  assert.ok(out.events.some((e) => e.type === 'policy_issued'));

  const stored = env.storage.get(out.attachments[0].path);
  assert.strictEqual(stored.bytes.subarray(0, 4).toString(), '%PDF');
  const pdf = await PDFDocument.load(stored.bytes);
  assert.match(pdf.getTitle(), /POL-DEMO-2026-000001/);
  assert.ok(pdf.getPageCount() >= 1);
});

test('PDF content (French): holder, vehicle, premium, dates and the demo disclaimer', { skip: !HAS_PDFTOTEXT }, async () => {
  const env = setup();
  const { caseDoc } = await autoQuoted(env);
  const out = await deliver(env, caseDoc);
  const text = pdfText(env.storage.get(out.attachments[0].path).bytes);
  for (const expected of ['Amine Benali', '12345-A-6', 'Dacia Sandero', '3 696,00 MAD', '3 546,00 MAD', '150,00 MAD', '21/11/2026', '20/11/2027', 'SANS VALEUR CONTRACTUELLE', 'Tous risques']) {
    assert.ok(text.includes(expected), `PDF should contain "${expected}"`);
  }
});

test('PDF content (English): English labels', { skip: !HAS_PDFTOTEXT }, async () => {
  const env = setup();
  const answers = ['Hello, I need car insurance', '38', '15', '0', 'no', 'compact', '120000', '4', 'private', 'Rabat', 'comprehensive'];
  const { caseDoc } = await autoQuoted(env, answers, 'yes');
  const out = await deliver(env, caseDoc);
  const text = pdfText(env.storage.get(out.attachments[0].path).bytes);
  assert.ok(text.includes('POLICY SCHEDULE'));
  assert.ok(text.includes('MAD 3,696.00'));
  assert.ok(text.includes('NOT CONTRACTUAL'));
  assert.match(out.replies[0], /Payment received/);
});

test('a redelivered webhook never issues a second policy', async () => {
  const env = setup();
  const { caseDoc } = await autoQuoted(env);
  const first = await deliver(env, caseDoc);
  const second = await deliver(env, first.caseDoc);
  assert.strictEqual(second.duplicate, true);
  assert.deepStrictEqual(second.replies, []);
  assert.deepStrictEqual(second.attachments, []);
  assert.strictEqual(env.policyAdmin.count(), 1);
  assert.strictEqual(env.storage.count(), 1);
});

test('wrong amount: nothing is issued and the case is flagged', async () => {
  const env = setup();
  const { caseDoc } = await autoQuoted(env);
  const out = await deliver(env, caseDoc, { amount: 100 });
  assert.strictEqual(out.caseDoc.status, CASE_STATUS.AWAITING_PAYMENT);
  assert.strictEqual(out.caseDoc.payment.status, 'mismatch');
  assert.strictEqual(out.caseDoc.handoff.reason, 'payment_mismatch');
  assert.ok(out.events.some((e) => e.type === 'payment_mismatch'));
  assert.strictEqual(env.policyAdmin.count(), 0);
  assert.strictEqual(out.attachments.length, 0);
});

test('an event for another case is rejected', async () => {
  const env = setup();
  const { caseDoc } = await autoQuoted(env);
  const event = { id: 'evt_x', type: 'payment.succeeded', paymentId: caseDoc.payment.paymentId, caseId: 'case-9', amount: 3696, currency: 'MAD' };
  await assert.rejects(handlePaymentEvent({ caseDoc, event, config, policyAdmin: env.policyAdmin, storage: env.storage, now: NOW }), /does not match/);
});

test('failed payment: customer can retry with the same link, then pay', async () => {
  const env = setup();
  const { caseDoc } = await autoQuoted(env);
  const failed = await deliver(env, caseDoc, { outcome: 'failed' });
  assert.strictEqual(failed.caseDoc.status, CASE_STATUS.AWAITING_PAYMENT);
  assert.match(failed.replies[0], new RegExp(caseDoc.payment.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const paid = await deliver(env, failed.caseDoc);
  assert.strictEqual(paid.caseDoc.status, CASE_STATUS.ISSUED);
});

test('referred case: underwriter adjusts the premium, customer accepts and pays the adjusted amount', async () => {
  const env = setup();
  const referred = await converse([...FRENCH_ANSWERS, doc('demo_id_ok', 'demo_registration_other_owner')], { paymentAdapter: env.pay });
  assert.strictEqual(referred.caseDoc.status, CASE_STATUS.PENDING_REVIEW);

  const decided = applyHumanDecision(referred.caseDoc, { reviewerId: 'uw-1', decision: 'adjust', adjustedPremium: 4200, note: 'Owner differs' });
  const notice = notifyHumanDecision({ caseDoc: decided.case, config });
  assert.match(notice.replies[0], /4200 MAD/);

  const accepted = await converse(['oui'], { start: notice.caseDoc, paymentAdapter: env.pay });
  assert.strictEqual(accepted.caseDoc.payment.amount, 4200);

  const out = await deliver(env, accepted.caseDoc);
  assert.strictEqual(out.caseDoc.status, CASE_STATUS.ISSUED);
  const issued = out.events.find((e) => e.type === 'policy_issued');
  assert.deepStrictEqual(issued.payload.approvedBy, { kind: 'human', id: 'uw-1' });
  if (HAS_PDFTOTEXT) assert.ok(pdfText(env.storage.get(out.attachments[0].path).bytes).includes('4 200,00 MAD'));
});

test('a referred case without human approval can never be paid or issued', async () => {
  const env = setup();
  const referred = await converse([...FRENCH_ANSWERS, doc('demo_id_ok', 'demo_registration_other_owner')], { paymentAdapter: env.pay });
  await assert.rejects(requestPayment({ caseDoc: referred.caseDoc, config, paymentAdapter: env.pay, now: NOW }), /Cannot request payment/);

  // even if someone forces the status and stage, the approval rule still blocks it
  const forced = { ...referred.caseDoc, status: CASE_STATUS.QUOTED, flow: { stage: 'confirmed' } };
  await assert.rejects(requestPayment({ caseDoc: forced, config, paymentAdapter: env.pay, now: NOW }), /only possible for automatically accepted or human-approved/);
});

test('payment is refused until the customer has accepted the premium', async () => {
  const env = setup();
  const quoted = await converse([...FRENCH_ANSWERS, doc('demo_id_ok', 'demo_registration_ok')], { paymentAdapter: env.pay });
  assert.strictEqual(quoted.caseDoc.status, CASE_STATUS.QUOTED);
  await assert.rejects(requestPayment({ caseDoc: quoted.caseDoc, config, paymentAdapter: env.pay, now: NOW }), /not accepted/);
});

test('rejected by the underwriter: neutral message, case closed, no payment', async () => {
  const env = setup();
  const referred = await converse([...FRENCH_ANSWERS, doc('demo_id_ok', 'demo_registration_other_owner')], { paymentAdapter: env.pay });
  const decided = applyHumanDecision(referred.caseDoc, { reviewerId: 'uw-1', decision: 'reject', note: 'Owner unknown' });
  const notice = notifyHumanDecision({ caseDoc: decided.case, config });
  assert.match(notice.replies[0], /ne pouvons malheureusement pas donner suite/);
  assert.doesNotMatch(notice.replies[0], /propriétaire|Owner/);
  assert.strictEqual(notice.caseDoc.flow.stage, 'closed');
  await assert.rejects(requestPayment({ caseDoc: notice.caseDoc, config, paymentAdapter: env.pay, now: NOW }), /Cannot request payment/);
});

test('payment link is reused while valid and renewed after expiry', async () => {
  const env = setup();
  const { caseDoc } = await autoQuoted(env);
  const again = await requestPayment({ caseDoc, config, paymentAdapter: env.pay, now: NOW });
  assert.strictEqual(again.caseDoc.payment.paymentId, caseDoc.payment.paymentId);
  assert.deepStrictEqual(again.events, []);

  const later = new Date(NOW.getTime() + 3 * 24 * 3600 * 1000);
  const renewed = await requestPayment({ caseDoc, config, paymentAdapter: env.pay, now: later });
  assert.notStrictEqual(renewed.caseDoc.payment.paymentId, caseDoc.payment.paymentId);
  assert.strictEqual(renewed.caseDoc.payment.attempt, 2);
});

test('chatting during payment resends the link; after issuance the customer is told the policy is active', async () => {
  const env = setup();
  const { caseDoc } = await autoQuoted(env);
  const nudge = await converse(['alors ?'], { start: caseDoc, paymentAdapter: env.pay });
  assert.match(nudge.replies[0], /pay_000001/);

  const issued = await deliver(env, caseDoc);
  const after = await converse(['merci'], { start: issued.caseDoc, paymentAdapter: env.pay });
  assert.match(after.replies[0], /contrat est actif/);
});

test('webhook signature: tampering, wrong secret and garbage are rejected', async () => {
  const env = setup();
  const { caseDoc } = await autoQuoted(env);
  const { rawBody, signature } = env.pay.simulate(caseDoc.payment.paymentId);
  assert.doesNotThrow(() => parseWebhook({ secret: env.pay.secret, rawBody, signature }));
  assert.throws(() => parseWebhook({ secret: env.pay.secret, rawBody: rawBody.replace('3696', '1'), signature }), /signature/);
  assert.throws(() => parseWebhook({ secret: 'other-secret', rawBody, signature }), /signature/);
  assert.throws(() => parseWebhook({ secret: env.pay.secret, rawBody, signature: 'not-hex' }), /signature/);
  assert.throws(() => parseWebhook({ secret: env.pay.secret, rawBody, signature: undefined }), /signature/);
});

test('policy dates: 12 months minus one day, month-end clamping', () => {
  assert.strictEqual(isoDate(addMonths(new Date('2028-02-29T00:00:00Z'), 12)), '2029-02-28');
  assert.strictEqual(isoDate(addMonths(new Date('2026-01-31T00:00:00Z'), 1)), '2026-02-28');
  const draft = buildPolicyDraft({
    caseDoc: {
      id: 'c1', tenantId: 't', line: 'motor', input: { coverage: 'tiers' },
      engineResult: { status: 'accept', configVersion: 'v1', premium: { total: 1350, breakdown: [{ step: 'fee', amount: 150 }] } },
      documents: { national_id: { fields: { fullName: 'A B' } }, vehicle_registration: { fields: { plate: '1-A-1' } } },
    },
    config, now: new Date('2028-02-29T10:00:00Z'),
  });
  assert.strictEqual(draft.startDate, '2028-02-29');
  assert.strictEqual(draft.endDate, '2029-02-27');
  assert.deepStrictEqual([draft.premium.net, draft.premium.fee, draft.premium.total], [1200, 150, 1350]);
});

test('PDF generation survives characters the built-in font cannot print', async () => {
  const bytes = await generatePolicyPdf({
    policy: {
      policyNumber: 'POL-DEMO-2026-000009', issuedAt: NOW.toISOString(), startDate: '2026-11-21', endDate: '2027-11-20',
      holder: { fullName: 'محمد Benali 😀' }, vehicle: { plate: '1-A-1', make: 'Dacia', model: null }, coverage: 'tiers',
      premium: { net: 1200, fee: 150, total: 1350, currency: 'MAD' },
    },
    payment: { paymentId: 'pay_000009', paidAt: NOW.toISOString() },
    branding: config.branding, coverageInfo: config.coverageInfo, language: 'fr',
  });
  assert.strictEqual(Buffer.from(bytes).subarray(0, 4).toString(), '%PDF');
});
