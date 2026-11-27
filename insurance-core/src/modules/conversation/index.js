'use strict';

/**
 * Conversation module: talking with customers to collect an application.
 *   - the flow: language, questions, answers understood by an extractor (AI or rules), documents,
 *     quote or referral, acceptance (application/flow.js)
 *   - receiving a message from any channel, safely (dedupe, one atomic commit, outbox)
 *   - the web chat channel; WhatsApp still lives in src/server/app.js and uses handleInbound
 * This file is the composition root and the only public entry point.
 */

const { makeFlow, nextQuestion } = require('./application/flow');
const { makeHandleInbound } = require('./application/useCases/handleInbound');
const { makeWebChat } = require('./application/useCases/webChat');
const { createWebChatHttp } = require('./interface/webChatHttp');
const { createHmacCustomerIds } = require('./infrastructure/hmacCustomerIds');
const { createMockExtractor, createLlmExtractor } = require('./infrastructure/extractors');
const { QUESTIONS, assertQuestionsCoverConfig } = require('./domain/questions');
const { MESSAGES, DOC, PAY, t, quoteMessage } = require('./domain/messages');
const nlu = require('./domain/nlu');

/**
 * Ports (application/ports.js): extractor, underwriting, documents, payments (optional), store,
 * uploads, tenants ({ load }), delivery (optional, push channels), and either customerIds or a pepper.
 */
function createConversationModule({
  extractor, underwriting, documents, payments = null,
  store, uploads, tenants, delivery = null,
  pepper, customerIds = createHmacCustomerIds(pepper),
  now = () => new Date(), logger = console,
}) {
  const clock = { now };
  const flow = makeFlow({ extractor, underwriting, documents, payments });
  const handleInbound = makeHandleInbound({ flow, store, uploads, customerIds, delivery, clock, logger });
  const webChat = makeWebChat({ tenants, handleInbound, store, uploads, customerIds });
  return {
    handleInbound,                                   // any channel (WhatsApp uses it)
    handleWebChat: createWebChatHttp(webChat),       // the web chat endpoint
    customerIdFor: (contact) => customerIds.keyFor(contact),
  };
}

module.exports = {
  createConversationModule,
  makeFlow, nextQuestion,                            // the flow on its own (tests, examples)
  createMockExtractor, createLlmExtractor,
  QUESTIONS, assertQuestionsCoverConfig,
  MESSAGES, DOC, PAY, t, quoteMessage,               // customer-facing texts (payment and policy use PAY)
  nlu,                                               // text helpers (documents use tokenize)
};
