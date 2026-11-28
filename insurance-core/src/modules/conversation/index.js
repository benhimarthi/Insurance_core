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
const { announceDecision, policyResentMessage } = require('./application/announceDecision');
const { makeHandleInbound } = require('./application/useCases/handleInbound');
const { makeWebChat } = require('./application/useCases/webChat');
const { makeCleanup } = require('./application/useCases/cleanup');
const { createWebChatHttp } = require('./interface/webChatHttp');
const { createHmacCustomerIds } = require('./infrastructure/hmacCustomerIds');
const { createFirestoreRateLimiter } = require('./infrastructure/firestoreRateLimiter');
const { createMockExtractor, createLlmExtractor } = require('./infrastructure/extractors');
const { createLlmAssistant } = require('./infrastructure/llmAssistant');
const { QUESTIONS, assertQuestionsCoverConfig } = require('./domain/questions');
const { MESSAGES, DOC, PAY, t, quoteMessage } = require('./domain/messages');
const nlu = require('./domain/nlu');

/**
 * Ports (application/ports.js): extractor, assistant (optional), underwriting, documents, payments (optional), store,
 * uploads, tenants ({ load }), delivery (optional, push channels), rateLimiter (web chat abuse limits),
 * appCheck ({ mode, verify }), and either customerIds or a pepper.
 */
function createConversationModule({
  extractor, assistant = null, underwriting, documents, payments = null,
  store, uploads, tenants, delivery = null, rateLimiter = null, appCheck = { mode: 'off' },
  pepper, customerIds = createHmacCustomerIds(pepper),
  now = () => new Date(), logger = console,
}) {
  const clock = { now };
  const flow = makeFlow({ extractor, underwriting, documents, payments, assistant });
  const handleInbound = makeHandleInbound({ flow, store, uploads, customerIds, delivery, clock, logger });
  const webChat = makeWebChat({ tenants, handleInbound, store, uploads, customerIds, rateLimiter, logger });
  return {
    handleInbound,                                                  // any channel (WhatsApp uses it)
    handleWebChat: createWebChatHttp(webChat, { appCheck, logger }), // the web chat endpoint
    customerIdFor: (contact) => customerIds.keyFor(contact),
  };
}

/** The daily data-retention job on its own: it needs no AI, no secret, only the store and the files. */
function createConversationCleanup({ store, uploads, now = () => new Date(), logger = console }) {
  return makeCleanup({ store, uploads, clock: { now }, logger });
}

module.exports = {
  createConversationModule, createConversationCleanup, createFirestoreRateLimiter,
  makeFlow, nextQuestion,                            // the flow on its own (tests, examples)
  announceDecision, policyResentMessage,              // the underwriting module's DecisionNotifier
  createMockExtractor, createLlmExtractor, createLlmAssistant,
  QUESTIONS, assertQuestionsCoverConfig,
  MESSAGES, DOC, PAY, t, quoteMessage,               // customer-facing texts (payment and policy use PAY)
  nlu,                                               // text helpers (documents use tokenize)
};
