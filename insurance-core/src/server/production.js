'use strict';

const path = require('path');
const { buildApp } = require('./app');
const { createRepository } = require('./repository');
const { createTenantLoader } = require('../modules/tenants');
const { createWaSenderChannel } = require('../channels/whatsapp');
const { createGemini } = require('../adapters/gemini');
const { createLlmExtractor, createLlmAssistant } = require('../modules/conversation');
const { createLlmDocumentProcessor } = require('../adapters/documentProcessor');
const { createDemoGateway } = require('../modules/payment');
const { createFirestorePolicyRegistry } = require('../modules/policy');
const { createFirebaseStorage } = require('../adapters/storage');
const { createVerifier } = require('../modules/verification');
const { createAuthModule } = require('../modules/auth');

/**
 * Wires the real adapters. `env` holds secrets and params (see index.js).
 * Payment: demo checkout when env.demoPaymentsEnabled, otherwise a real provider adapter must be
 * passed in as `paymentAdapter` (CMI, Stripe...), because no real provider is bundled.
 */
function buildProductionApp({ db, bucket, env, paymentAdapter, authAdmin, authModule }) {
  const gemini = createGemini({ apiKey: env.geminiApiKey, model: env.geminiModel });
  const demoPay = env.demoPaymentsEnabled ? createDemoGateway({ db, baseUrl: env.demoPayBaseUrl }) : null;

  const payment = paymentAdapter || demoPay || {
    async createPaymentLink() { throw new Error('No payment provider configured for this deployment.'); },
  };

  return buildApp({
    repo: createRepository(db),
    loadTenant: createTenantLoader({ db, localDir: env.useLocalTenants ? path.join(__dirname, '..', '..', 'config', 'tenants') : null }),
    channel: createWaSenderChannel({ apiKey: env.wasenderApiKey, webhookSecret: env.wasenderWebhookSecret }),
    extractor: createLlmExtractor({ callModel: gemini.callText }),
    assistant: createLlmAssistant({ callModel: gemini.callText }),
    documentProcessor: createLlmDocumentProcessor({ callModel: gemini.callVision }),
    paymentAdapter: payment,
    policyAdmin: createFirestorePolicyRegistry(db),
    storage: createFirebaseStorage(bucket),
    paymentSecret: () => env.paymentWebhookSecret, // single secret for the demo; per-tenant secrets for real providers
    pepper: env.phonePepper,
    demoPay,
    authService: authModule || createAuthModule({ db, authAdmin, requireMfa: env.requireMfa }),
    // QR verification is optional: without both values the PDF simply has no QR code
    verifier: env.verifyBaseUrl && env.verifySecret ? createVerifier({ secret: env.verifySecret, baseUrl: env.verifyBaseUrl }) : null,
  });
}

module.exports = { buildProductionApp };
