'use strict';

const config = require('../config/tenants/demo-insurer/motor.json');
const { makeFlow, createMockExtractor, PAY } = require('../src/modules/conversation');
const { createPaymentModule } = require('../src/modules/payment');
const { createPolicyModule, createMemoryPolicyRegistry, isApprovedForIssuance } = require('../src/modules/policy');
const { createMemoryStorage } = require('../src/adapters/storage');
const { legacyConversationPorts } = require('../src/server/conversationPorts');
const { createMockDocumentProcessor } = require('../src/adapters/documentProcessor');
const { newCase } = require('../src/shared/cases');

const NOW = new Date('2026-11-21T10:00:00Z'); // fixed clock: dates in fixtures stay valid

// Clean French profile: matches demo_id_ok and demo_registration_ok
const FRENCH_ANSWERS = [
  'Bonjour, je veux une assurance auto',
  '38 ans', '15', 'aucun', 'non', '1', '120 000 dh', '4', 'personnel', 'Rabat', 'tous risques',
];

/** Attachment message: doc('demo_id_ok', 'demo_registration_ok') */
const doc = (...names) => ({ attachments: names.map((demoFixture) => ({ demoFixture })) });

/** Plays a conversation. Items are strings or { text?, attachments? }. */
async function converse(items, {
  extractor = createMockExtractor(),
  documentProcessor = createMockDocumentProcessor(),
  cfg = config,
  paymentAdapter,
  start,
} = {}) {
  let caseDoc = start || newCase({ id: 'case-1', tenantId: 'demo-insurer', channel: 'whatsapp', customerId: 'cust-1' });
  const payments = paymentAdapter ? paymentKit({ gateway: paymentAdapter }) : null;
  const flow = makeFlow({ extractor, ...legacyConversationPorts({ documentProcessor, payments }) });
  const replies = [];
  const events = [];
  for (const item of items) {
    const input = typeof item === 'string' ? { text: item } : item;
    const out = await flow({ caseDoc, message: input.text || '', attachments: input.attachments || [], config: cfg, now: NOW });
    caseDoc = out.caseDoc;
    replies.push(...out.replies);
    events.push(...out.events);
  }
  return { caseDoc, replies, events };
}

/**
 * The payment and policy modules wired as in production, with one gateway for every insurer:
 * requestPayment (the conversation's Payments port) and applyPaymentEvent (a verified provider event).
 */
function paymentKit({ gateway, registry = createMemoryPolicyRegistry(), storage = createMemoryStorage(), verifier = null }) {
  const policy = createPolicyModule({ registry, files: storage, verifier });
  return createPaymentModule({
    gateways: { forTenant: async () => gateway },
    webhookSecret: () => gateway.secret,
    policies: { issue: policy.issue, isApprovedForIssuance },
    messages: PAY,
  });
}

module.exports = { config, NOW, FRENCH_ANSWERS, doc, converse, paymentKit };
