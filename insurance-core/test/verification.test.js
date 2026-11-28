'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { makeEnv, FRENCH_ANSWERS, img } = require('./serverHelpers');
const { createVerifier, policyState, publicView, initials } = require('../src/verification/verification');
const { generatePolicyPdf } = require('../src/modules/policy');
const config = require('../config/tenants/demo-insurer/motor.json');

let jsQR; let PNG;
try { jsQR = require('jsqr'); ({ PNG } = require('pngjs')); } catch { /* QR decoding tests are skipped */ }
const CAN_DECODE = !!jsQR && spawnSync('pdftoppm', ['-v']).error === undefined;
const HAS_PDFTOTEXT = spawnSync('pdftotext', ['-v']).error === undefined;

/** Renders page 1 of the PDF to an image and reads the QR code like a phone would. */
function decodeQr(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-'));
  fs.writeFileSync(path.join(dir, 'p.pdf'), bytes);
  spawnSync('pdftoppm', ['-png', '-r', '200', '-f', '1', '-l', '1', path.join(dir, 'p.pdf'), path.join(dir, 'page')]);
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.png'));
  const image = PNG.sync.read(fs.readFileSync(path.join(dir, file)));
  const result = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
  fs.rmSync(dir, { recursive: true, force: true });
  return result ? result.data : null;
}

const pdfText = (bytes) => {
  const f = path.join(os.tmpdir(), `v-${process.pid}-${Date.now()}.pdf`);
  fs.writeFileSync(f, bytes);
  const out = spawnSync('pdftotext', [f, '-'], { encoding: 'utf8' }).stdout;
  fs.unlinkSync(f);
  return out;
};

const pageCount = (bytes) => {
  const f = path.join(os.tmpdir(), `pc-${process.pid}-${Date.now()}.pdf`);
  fs.writeFileSync(f, bytes);
  const out = spawnSync('pdfinfo', [f], { encoding: 'utf8' }).stdout;
  fs.unlinkSync(f);
  return Number(/Pages:\s+(\d+)/.exec(out)[1]);
};

const policyRecord = (over = {}) => ({
  policyNumber: 'POL-DEMO-2026-000001', issuedAt: '2026-11-21T10:00:00.000Z', startDate: '2026-11-21', endDate: '2027-11-20',
  holder: { fullName: 'Amine Benali' }, vehicle: { plate: '12345-A-6', make: 'Dacia', model: 'Sandero' }, coverage: 'tous_risques',
  premium: { net: 3546, fee: 150, total: 3696, currency: 'MAD' }, ...over,
});

async function issuedPolicy(env) {
  await env.sayAll([...FRENCH_ANSWERS, { attachments: [img('demo_id_ok'), img('demo_registration_ok')] }, 'oui']);
  await env.pay(env.payIdFromChat(), 'POST');
  const c = env.onlyCase();
  return { c, pdf: env.storage.get(c.policy.pdfPath).bytes };
}

const parseLink = (url) => { const [tenantId, policyNumber, code] = new URL(url).pathname.replace(/^\/v\//, '').split('/'); return { tenantId, policyNumber, code }; };

test('verifier: deterministic unguessable codes bound to tenant and policy', () => {
  const v = createVerifier({ secret: 's1', baseUrl: 'https://verify.example/v/' });
  const a = { tenantId: 'demo-insurer', policyNumber: 'POL-DEMO-2026-000001' };
  const code = v.code(a);
  assert.match(code, /^[0-9a-f]{20}$/);
  assert.strictEqual(v.url(a), `https://verify.example/v/demo-insurer/POL-DEMO-2026-000001/${code}`);
  assert.notStrictEqual(code, v.code({ ...a, policyNumber: 'POL-DEMO-2026-000002' }));
  assert.notStrictEqual(code, v.code({ ...a, tenantId: 'other-insurer' }));
  assert.notStrictEqual(code, createVerifier({ secret: 's2', baseUrl: 'x' }).code(a));
  assert.strictEqual(v.check(a, code), true);
  assert.strictEqual(v.check(a, code.replace(/.$/, code.endsWith('0') ? '1' : '0')), false);
  for (const bad of [undefined, '', 'abc', code.toUpperCase(), `${code}0`, '0'.repeat(20)]) assert.strictEqual(v.check(a, bad), false);
  assert.throws(() => createVerifier({ secret: '', baseUrl: 'x' }), /secret/);
});

test('public view: state from dates, initials only, nothing sensitive', () => {
  const p = policyRecord();
  assert.strictEqual(policyState(p, '2026-11-20'), 'not_yet_active');
  assert.strictEqual(policyState(p, '2026-11-21'), 'active');
  assert.strictEqual(policyState(p, '2027-11-20'), 'active');
  assert.strictEqual(policyState(p, '2027-11-21'), 'expired');
  assert.strictEqual(policyState({ ...p, status: 'cancelled' }, '2026-12-01'), 'cancelled');
  assert.strictEqual(initials('Amine Benali'), 'A. B.');
  assert.strictEqual(initials('élodie de la Fontaine'), 'É. D. L. F.');
  const view = publicView(p, { tenant: { name: 'Assurance Démo', demo: true }, today: '2026-12-01' });
  assert.deepStrictEqual(Object.keys(view).sort(), ['coverage', 'demo', 'endDate', 'holderInitials', 'insurer', 'plate', 'policyNumber', 'startDate', 'state', 'valid']);
  assert.ok(!JSON.stringify(view).includes('Benali'));
  assert.ok(!JSON.stringify(view).includes('3696'));
});

test('PDF: the QR code decodes to the verification link', { skip: !CAN_DECODE }, async () => {
  const url = 'https://verify.example/v/demo-insurer/POL-DEMO-2026-000001/0123456789abcdef0123';
  const bytes = await generatePolicyPdf({ policy: policyRecord(), payment: { paymentId: 'pay_1', paidAt: '2026-11-21T10:00:00Z' }, branding: config.branding, coverageInfo: config.coverageInfo, verification: { url }, language: 'fr' });
  assert.strictEqual(decodeQr(bytes), url);
  if (HAS_PDFTOTEXT) {
    const text = pdfText(bytes);
    assert.ok(text.includes('Vérifier ce contrat'));
    assert.ok(text.replace(/\s+/g, '').includes(url)); // the link is also printed, for people who cannot scan
    assert.strictEqual(pageCount(bytes), 1);            // a full policy with QR still fits one page
  }
});

test('PDF: English labels and no QR section when verification is not configured', { skip: !HAS_PDFTOTEXT }, async () => {
  const base = { policy: policyRecord(), payment: null, branding: config.branding, coverageInfo: config.coverageInfo };
  const en = pdfText(await generatePolicyPdf({ ...base, verification: { url: 'https://verify.example/v/a/b/c' }, language: 'en' }));
  assert.ok(en.includes('Verify this policy'));
  const none = pdfText(await generatePolicyPdf({ ...base, language: 'fr' }));
  assert.ok(!none.includes('Vérifier ce contrat') && !none.includes('authenticité'));
});

test('end to end: issue a policy, scan its QR code, see the verification page', { skip: !CAN_DECODE }, async () => {
  const env = makeEnv();
  const { c, pdf } = await issuedPolicy(env);
  const link = decodeQr(pdf);
  assert.strictEqual(link, env.verifier.url({ tenantId: 'demo-insurer', policyNumber: c.policy.policyNumber }));

  const res = await env.app.handleVerify(parseLink(link));
  assert.strictEqual(res.status, 200);
  assert.match(res.html, /Contrat valide/);
  assert.match(res.html, /A\. B\./);
  assert.match(res.html, /12345-A-6/);
  assert.match(res.html, /DÉMONSTRATION/);
  assert.match(res.html, /Tous risques/);
  assert.doesNotMatch(res.html, /Amine|Benali|3696|3546/);
  assert.match(res.headers['x-robots-tag'], /noindex/);
  assert.ok(res.headers['content-security-policy']);

  const en = await env.app.handleVerify({ ...parseLink(link), lang: 'en' });
  assert.match(en.html, /Valid policy/);

  const json = await env.app.handleVerify({ ...parseLink(link), format: 'json' });
  assert.strictEqual(json.body.valid, true);
  assert.strictEqual(json.body.holderInitials, 'A. B.');
  assert.ok(!JSON.stringify(json.body).match(/Benali|Amine|3696|212600/));
});

test('verification states over time and after cancellation', async () => {
  const env = makeEnv();
  const { c } = await issuedPolicy(env);
  const link = parseLink(env.verifier.url({ tenantId: 'demo-insurer', policyNumber: c.policy.policyNumber }));
  const state = async () => (await env.app.handleVerify({ ...link, format: 'json' })).body.state;

  assert.strictEqual(await state(), 'active');
  const realNow = env.clock.now;
  env.clock.now = new Date('2026-11-20T10:00:00Z');
  assert.strictEqual(await state(), 'not_yet_active');
  env.clock.now = new Date('2027-11-21T10:00:00Z');
  assert.strictEqual(await state(), 'expired');
  assert.match((await env.app.handleVerify(link)).html, /Contrat expiré/);

  env.clock.now = realNow;
  const path = `tenants/demo-insurer/policies/${c.policy.policyNumber}`;
  env.db.docs.set(path, { ...env.db.docs.get(path), status: 'cancelled' });
  assert.strictEqual(await state(), 'cancelled');
});

test('no probing: wrong codes, unknown policies and bad links look identical and skip the database', async () => {
  const env = makeEnv();
  const { c } = await issuedPolicy(env);
  const good = parseLink(env.verifier.url({ tenantId: 'demo-insurer', policyNumber: c.policy.policyNumber }));
  env.lookups.length = 0;

  const wrongCode = await env.app.handleVerify({ ...good, code: '0'.repeat(20) });
  const unknown = await env.app.handleVerify({ tenantId: 'demo-insurer', policyNumber: 'POL-DEMO-2026-000999', code: env.verifier.code({ tenantId: 'demo-insurer', policyNumber: 'POL-DEMO-2026-000999' }) });
  const sequential = await env.app.handleVerify({ tenantId: 'demo-insurer', policyNumber: 'POL-DEMO-2026-000002', code: '1'.repeat(20) });
  assert.strictEqual(wrongCode.status, 404);
  assert.strictEqual(unknown.status, 404);
  assert.strictEqual(sequential.status, 404);
  assert.strictEqual(wrongCode.html, unknown.html);
  assert.strictEqual(wrongCode.html, sequential.html);
  assert.match(wrongCode.html, /Contrat introuvable/);
  assert.deepStrictEqual(env.lookups.filter(([, n]) => n !== 'POL-DEMO-2026-000999'), []); // a wrong code never reaches the database

  // the code of one tenant never opens a policy of another
  assert.strictEqual((await env.app.handleVerify({ ...good, tenantId: 'other-insurer' })).status, 404);
  for (const bad of [{ tenantId: '../x' }, { policyNumber: 'POL-1' }, { code: 'zzz' }, { policyNumber: undefined }]) {
    assert.strictEqual((await env.app.handleVerify({ ...good, ...bad })).status, 404);
  }
  const json = await env.app.handleVerify({ ...good, code: '0'.repeat(20), format: 'json' });
  assert.deepStrictEqual([json.status, json.body], [404, { valid: false, state: 'not_found' }]);
});

test('without a verifier: no QR on the PDF and the endpoint answers not found', async () => {
  const env = makeEnv({ withVerifier: false });
  const { c, pdf } = await issuedPolicy(env);
  if (HAS_PDFTOTEXT) assert.ok(!pdfText(pdf).includes('Vérifier ce contrat'));
  const res = await env.app.handleVerify({ tenantId: 'demo-insurer', policyNumber: c.policy.policyNumber, code: 'a'.repeat(20) });
  assert.strictEqual(res.status, 404);
});
