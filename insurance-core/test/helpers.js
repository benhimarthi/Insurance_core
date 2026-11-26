'use strict';

const config = require('../config/tenants/demo-insurer/motor.json');
const { handleMessage } = require('../src/conversation/flow');
const { createMockExtractor } = require('../src/adapters/extractor');
const { createMockDocumentProcessor } = require('../src/adapters/documentProcessor');
const { newCase } = require('../src/models/schemas');

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
  const replies = [];
  const events = [];
  for (const item of items) {
    const input = typeof item === 'string' ? { text: item } : item;
    const out = await handleMessage({
      caseDoc, message: input.text || '', attachments: input.attachments || [],
      config: cfg, extractor, documentProcessor, paymentAdapter, now: NOW,
    });
    caseDoc = out.caseDoc;
    replies.push(...out.replies);
    events.push(...out.events);
  }
  return { caseDoc, replies, events };
}

module.exports = { config, NOW, FRENCH_ANSWERS, doc, converse };
