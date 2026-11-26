'use strict';
// Generates a sample policy PDF through the full flow: node examples/make-sample-policy.js
const path = require('path');
const config = require('../config/tenants/demo-insurer/motor.json');
const { handleMessage } = require('../src/conversation/flow');
const { handlePaymentEvent } = require('../src/policy/lifecycle');
const { parseWebhook } = require('../src/payment/webhook');
const { createMockExtractor } = require('../src/adapters/extractor');
const { createMockDocumentProcessor } = require('../src/adapters/documentProcessor');
const { createMockPaymentAdapter } = require('../src/adapters/payment');
const { createMockPolicyAdmin } = require('../src/adapters/policyAdmin');
const { createFileStorage } = require('../src/adapters/storage');
const { newCase } = require('../src/models/schemas');
const { createVerifier } = require('../src/verification/verification');

(async () => {
  const now = new Date();
  const pay = createMockPaymentAdapter();
  const storage = createFileStorage(path.join(__dirname, 'output'));
  const policyAdmin = createMockPolicyAdmin();
  const extractor = createMockExtractor();
  const documentProcessor = createMockDocumentProcessor();

  let caseDoc = newCase({ id: 'demo-case-1', tenantId: 'demo-insurer', channel: 'web', customerId: 'demo-customer' });
  const turns = [
    'Bonjour, je veux une assurance auto', '38 ans', '15', 'aucun', 'non', '1', '120 000 dh', '4', 'personnel', 'Rabat', 'tous risques',
    { attachments: [{ demoFixture: 'demo_id_ok' }, { demoFixture: 'demo_registration_ok' }] },
    'oui',
  ];
  for (const turn of turns) {
    const input = typeof turn === 'string' ? { message: turn } : turn;
    const out = await handleMessage({ caseDoc, ...input, config, extractor, documentProcessor, paymentAdapter: pay, now });
    caseDoc = out.caseDoc;
    out.replies.forEach((r) => console.log('BOT:', r.split('\n')[0]));
  }

  const { rawBody, signature } = pay.simulate(caseDoc.payment.paymentId); // "the customer paid"
  const event = parseWebhook({ secret: pay.secret, rawBody, signature });
  const verifier = createVerifier({ secret: 'sample-only-secret', baseUrl: 'https://verify.demo-insurer.example/v' });
  const issued = await handlePaymentEvent({ caseDoc, event, config, policyAdmin, storage, verifier, now });
  console.log('BOT:', issued.replies[0]);
  console.log('PDF:', path.join('examples/output', issued.attachments[0].path));
})();
