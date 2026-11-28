'use strict';

/**
 * Firebase Cloud Functions (2nd gen) entry point. Thin on purpose: it only adapts HTTP to the
 * framework-agnostic handlers in src/server/app.js.
 *
 * Deploy:  firebase deploy --only functions,firestore
 * Params:  FIRESTORE_DATABASE_ID, GEMINI_MODEL, DEMO_PAYMENTS, DEMO_PAY_BASE_URL, USE_LOCAL_TENANTS, VERIFY_BASE_URL, REQUIRE_MFA
 * Modules: ENABLED_MODULES (auth, app or all) selects which functions are defined, see below
 * Secrets: WASENDER_API_KEY, WASENDER_WEBHOOK_SECRET, PAYMENT_WEBHOOK_SECRET, PHONE_PEPPER, GEMINI_API_KEY, VERIFY_SECRET
 *          (firebase functions:secrets:set NAME)
 *
 * URLs after deploy (each demo tenant gets its own path):
 *   WhatsApp webhook   {whatsappWebhook URL}/{tenantId}
 *   Web chat           {webchat URL}/{tenantId}          POST JSON, see handleWebChat
 *   Payment webhook    {paymentWebhook URL}/{tenantId}
 *   Demo checkout      {demoPay URL}/{tenantId}/{paymentId}   (demo tenants only)
 *   Verification (QR)  {verify URL}/{tenantId}/{policyNumber}/{code}   public, read-only
 */

const { setGlobalOptions } = require('firebase-functions/v2');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret, defineString } = require('firebase-functions/params');
const { initializeApp, getApps, getApp: getAdminApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { getAppCheck } = require('firebase-admin/app-check');

const { buildProductionApp } = require('./src/server/production');
const { resolveEnabledModules } = require('./src/server/enabledModules');
const { createAuthModule } = require('./src/modules/auth');
const { createTenantsModule, createTenantLoader } = require('./src/modules/tenants');
const { createConversationModule, createConversationCleanup, createFirestoreRateLimiter, createLlmExtractor, createLlmAssistant } = require('./src/modules/conversation');
const { legacyConversationPorts } = require('./src/server/conversationPorts');
const { createUnderwritingModule } = require('./src/modules/underwriting');
const { createPaymentModule, createDemoGateway, demoCheckoutForDemoInsurers } = require('./src/modules/payment');
const { createPolicyModule, createFirestorePolicyRegistry, isApprovedForIssuance } = require('./src/modules/policy');
const { announceDecision, policyResentMessage, PAY } = require('./src/modules/conversation');
const { createRepository } = require('./src/server/repository');
const { createGemini } = require('./src/adapters/gemini');
const { createLlmDocumentProcessor, createMockDocumentProcessor } = require('./src/adapters/documentProcessor');
const { createFirebaseStorage } = require('./src/adapters/storage');
const { AppError } = require('./src/server/util');

setGlobalOptions({ region: 'europe-west1', maxInstances: 10 }); // closest region to Morocco with Gen2 support

const FIRESTORE_DATABASE_ID = defineString('FIRESTORE_DATABASE_ID', { default: '(default)' });
const REQUIRE_MFA = defineString('REQUIRE_MFA', { default: 'true' }); // needs Identity Platform; keep true in production

/**
 * Which modules this deployment defines functions for, from ENABLED_MODULES (comma separated, in
 * .env.<project>): `auth`, `tenants`, `conversation` (web chat), `underwriting` (review queue, decisions),
 * `payment` (provider webhook, demo checkout; issues policies through the policy module),
 * `app` (everything not yet split into modules: WhatsApp, verification), or `all` (the default).
 * See src/server/enabledModules.js for why it also reads the .env file itself.
 * The Firebase CLI checks every secret index.js declares, even with `--only functions:<name>`, so a
 * module whose secrets do not exist yet must not be defined at all.
 */
const ENABLED_MODULES = resolveEnabledModules({ dir: __dirname });
const moduleEnabled = (name) => ENABLED_MODULES.includes('all') || ENABLED_MODULES.includes(name);

// Secrets are declared only when a module that uses them is enabled: the CLI resolves every
// declared secret before a deploy, and refuses it if one does not exist in Secret Manager.
const SECRETS_OF = {
  conversation: ['GEMINI_API_KEY', 'PHONE_PEPPER'],
  payment: ['PAYMENT_WEBHOOK_SECRET'],
  app: ['WASENDER_API_KEY', 'WASENDER_WEBHOOK_SECRET', 'PAYMENT_WEBHOOK_SECRET', 'PHONE_PEPPER', 'GEMINI_API_KEY', 'VERIFY_SECRET'],
};
const SECRET = {};
for (const [mod, names] of Object.entries(SECRETS_OF)) {
  if (!moduleEnabled(mod)) continue;
  for (const name of names) if (!SECRET[name]) SECRET[name] = defineSecret(name);
}
const secretsOf = (mod) => SECRETS_OF[mod].map((name) => SECRET[name]);
const SECRETS = moduleEnabled('app') ? secretsOf('app') : [];

// Params, declared only when a module that uses them is enabled, like secrets (in a non-interactive
// deploy the CLI wants a value in .env.<project> for every declared param).
const GEMINI_MODEL = moduleEnabled('conversation') || moduleEnabled('app') ? defineString('GEMINI_MODEL', { default: 'gemini-2.5-flash' }) : null;
// Cloud Storage bucket for customer documents and policies. Named explicitly: the "default bucket" the
// runtime guesses can be the legacy <project>.appspot.com while new projects use <project>.firebasestorage.app.
const STORAGE_BUCKET = ['conversation', 'underwriting', 'app'].some(moduleEnabled) ? defineString('STORAGE_BUCKET', { default: '' }) : null;
const bucket = () => getStorage(firebaseApp()).bucket(STORAGE_BUCKET.value() || undefined);
// App Check on the web chat: off | monitor | enforce (see src/modules/conversation/interface/webChatHttp.js)
const WEBCHAT_APP_CHECK = moduleEnabled('conversation') ? defineString('WEBCHAT_APP_CHECK', { default: 'off' }) : null;
// The demo checkout (demo insurers only): on, and where its pages are served (Hosting /pay, same site).
const PAYMENTS_PARAMS = ['conversation', 'payment', 'app'].some(moduleEnabled);
const DEMO_PAYMENTS = PAYMENTS_PARAMS ? defineString('DEMO_PAYMENTS', { default: 'false' }) : null;
const DEMO_PAY_BASE_URL = PAYMENTS_PARAMS ? defineString('DEMO_PAY_BASE_URL', { default: '' }) : null;
const PARAM = moduleEnabled('app') ? {
  GEMINI_MODEL,
  DEMO_PAYMENTS,
  DEMO_PAY_BASE_URL,
  USE_LOCAL_TENANTS: defineString('USE_LOCAL_TENANTS', { default: 'false' }),
  VERIFY_BASE_URL: defineString('VERIFY_BASE_URL', { default: '' }),
} : null;

// firebase-admin 14 has only the modular API (no admin.apps / admin.auth()). Look for the DEFAULT app
// by name: firebase-functions creates its own named app ("__FIREBASE_FUNCTIONS_SDK__") when it verifies
// a signed-in caller, so "some app exists" does not mean the default one does.
const DEFAULT_APP = '[DEFAULT]';
const firebaseApp = () => (getApps().some((a) => a.name === DEFAULT_APP) ? getAdminApp() : initializeApp());
// Named database pattern: always pass the database id explicitly.
const firestore = () => getFirestore(firebaseApp(), FIRESTORE_DATABASE_ID.value());

// Auth module: needs only Firestore and Firebase Auth (no secrets), so `members` deploys on its own.
let authModule;
function getAuthModule() {
  if (!authModule) {
    authModule = createAuthModule({ db: firestore(), authAdmin: getAuth(firebaseApp()), requireMfa: REQUIRE_MFA.value() !== 'false' });
  }
  return authModule;
}

// Tenants module: insurers and their rules. No secrets either; permissions come from the auth module.
let tenantsModule;
function getTenantsModule() {
  if (!tenantsModule) {
    const auth = getAuthModule();
    tenantsModule = createTenantsModule({
      db: firestore(),
      authorize: ({ caller, ...rest }) => auth.authorize({ auth: caller, ...rest }),
      configTemplate: require('./config/tenants/demo-insurer/motor.json'), // starting rules of a new insurer
    });
  }
  return tenantsModule;
}

// Payment and policy modules. The webhook secret is read only when a webhook or the demo checkout
// runs (those functions declare it); the web chat only creates links, which needs no secret.
let paymentModule;
function getPaymentModule() {
  if (!paymentModule) {
    const db = firestore();
    const tenants = { load: createTenantLoader({ db, localDir: null }) };
    const demoGateway = DEMO_PAYMENTS.value() === 'true' ? createDemoGateway({ db, baseUrl: DEMO_PAY_BASE_URL.value() }) : null;
    const policy = createPolicyModule({ registry: createFirestorePolicyRegistry(db), files: createFirebaseStorage(bucket()) });
    paymentModule = createPaymentModule({
      store: createRepository(db),
      tenants,
      gateways: demoCheckoutForDemoInsurers({ tenants, demoGateway }),
      demoGateway,
      webhookSecret: () => SECRET.PAYMENT_WEBHOOK_SECRET.value(),
      policies: { issue: policy.issue, isApprovedForIssuance },
      messages: PAY,
      // no delivery: web chat customers poll; WhatsApp replies wait for the app module's retry job
    });
  }
  return paymentModule;
}

// Conversation module (web chat): Gemini reads the answers and the documents. Only its two secrets.
let conversationModule;
function getConversationModule() {
  if (!conversationModule) {
    const db = firestore();
    const gemini = createGemini({ apiKey: SECRET.GEMINI_API_KEY.value(), model: GEMINI_MODEL.value() });
    const llmDocuments = createLlmDocumentProcessor({ callModel: gemini.callVision });
    const demoDocuments = createMockDocumentProcessor(); // demo insurers only: the chat page's sample documents
    conversationModule = createConversationModule({
      extractor: createLlmExtractor({ callModel: gemini.callText }),
      assistant: createLlmAssistant({ callModel: gemini.callText }), // answers questions, redirects off-topic messages
      ...legacyConversationPorts({
        documentProcessor: { process: (args) => (args.attachment.demoFixture ? demoDocuments : llmDocuments).process(args) },
        payments: moduleEnabled('payment') ? getPaymentModule() : null, // links; null for insurers without a provider
      }),
      store: createRepository(db),
      uploads: createFirebaseStorage(bucket()),
      tenants: { load: createTenantLoader({ db, localDir: null }) },
      rateLimiter: createFirestoreRateLimiter(db),
      appCheck: {
        mode: WEBCHAT_APP_CHECK.value(),
        verify: async (token) => !!(await getAppCheck(firebaseApp()).verifyToken(token)),
      },
      pepper: SECRET.PHONE_PEPPER.value(),
    });
  }
  return conversationModule;
}

// Underwriting module: the review queue, cases, document links, decisions. No secrets.
// Replies to WhatsApp customers wait in the outbox for the app module's retry job; web chat customers poll.
let underwritingModule;
function getUnderwritingModule() {
  if (!underwritingModule) {
    const auth = getAuthModule();
    const db = firestore();
    underwritingModule = createUnderwritingModule({
      authorize: ({ caller, ...rest }) => auth.authorize({ auth: caller, ...rest }),
      store: createRepository(db),
      tenants: { load: createTenantLoader({ db, localDir: null }) },
      notifier: { announce: announceDecision, policyResent: policyResentMessage },
      files: createFirebaseStorage(bucket()),
    });
  }
  return underwritingModule;
}

/**
 * The visitor's IP, for the per-IP limits (pseudonymized before use). Best effort: the first
 * x-forwarded-for entry can be forged by a script, which is why session and per-insurer limits and
 * App Check exist too.
 */
const clientIpOf = (req) => String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').trim() || null;

/** Browsers may call the web chat only from the project's own Hosting sites (the chat page). */
function hostingOrigins() {
  let project = process.env.GCLOUD_PROJECT;
  try { project = project || JSON.parse(process.env.FIREBASE_CONFIG || '{}').projectId; } catch { /* none */ }
  return project ? [`https://${project}.web.app`, `https://${project}.firebaseapp.com`] : false;
}

let app;
function getApp() {
  if (!app) {
    app = buildProductionApp({
      db: firestore(),
      authAdmin: getAuth(firebaseApp()),
      authModule: getAuthModule(),
      bucket: bucket(),
      env: {
        geminiApiKey: SECRET.GEMINI_API_KEY.value(),
        geminiModel: PARAM.GEMINI_MODEL.value(),
        wasenderApiKey: SECRET.WASENDER_API_KEY.value(),
        wasenderWebhookSecret: SECRET.WASENDER_WEBHOOK_SECRET.value(),
        paymentWebhookSecret: SECRET.PAYMENT_WEBHOOK_SECRET.value(),
        phonePepper: SECRET.PHONE_PEPPER.value(),
        demoPaymentsEnabled: PARAM.DEMO_PAYMENTS.value() === 'true',
        demoPayBaseUrl: PARAM.DEMO_PAY_BASE_URL.value(),
        useLocalTenants: PARAM.USE_LOCAL_TENANTS.value() === 'true',
        requireMfa: REQUIRE_MFA.value() !== 'false',
        verifyBaseUrl: PARAM.VERIFY_BASE_URL.value(),
        verifySecret: SECRET.VERIFY_SECRET.value(),
      },
    });
  }
  return app;
}

const segments = (req) => req.path.split('/').filter(Boolean);
const rawBodyOf = (req) => (req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {}));

/** Runs a handler and writes its { status, body | html, headers } result. Never leaks internals. */
function respond(handler) {
  return async (req, res) => {
    try {
      const out = await handler(req);
      for (const [k, v] of Object.entries(out.headers || {})) res.set(k, v);
      if (out.html !== undefined) res.status(out.status).type('html').send(out.html);
      else res.status(out.status).json(out.body);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal_error' });
    }
  };
}

const postOnly = (fn) => (req) => (req.method === 'POST' ? fn(req) : { status: 405, body: { error: 'method_not_allowed' } });

// Callables for the dashboard (Firebase SDK: httpsCallable(functions, name)(data)).
const authOf = (request) => request.auth && { uid: request.auth.uid, token: request.auth.token };

function callable(handler, { secrets = SECRETS } = {}) {
  return onCall({ secrets, enforceAppCheck: false /* set true once App Check is configured */ }, async (request) => {
    try {
      return await handler(request);
    } catch (err) {
      if (err instanceof AppError) throw new HttpsError(err.code, err.message, err.details);
      console.error(err);
      throw new HttpsError('internal', 'Internal error.');
    }
  });
}

// ---------- auth module: needs no secrets ----------
// { action: 'myTenants' | 'allTenants' (platform only) | 'list' | 'invite' | 'accept' | 'revokeInvitation' | 'changeRole' | 'setStatus' | 'remove', tenantId, ... }
// Platform staff must add `reason` on every action that targets an insurer.
if (moduleEnabled('auth')) {
  exports.members = callable((request) => getAuthModule().handle({ auth: authOf(request), data: request.data }), { secrets: [] });
}

// ---------- tenants module: needs no secrets ----------
// { action: 'get' | 'getRules' | 'checkRules' | 'listVersions' | 'getVersion' | 'updateRules' | 'restoreVersion'
//           | 'create' | 'update' | 'setStatus' | 'rotateWebchatKey', tenantId, reason, ... }
if (moduleEnabled('tenants')) {
  exports.tenants = callable((request) => getTenantsModule().handle({ auth: authOf(request), data: request.data }), { secrets: [] });
}

// ---------- conversation module (web chat): needs GEMINI_API_KEY and PHONE_PEPPER ----------
// POST {webchat URL}/{tenantId}, or /api/webchat/{tenantId} through Firebase Hosting (same origin as the chat page)
if (moduleEnabled('conversation')) {
  const tenantOf = (req) => { const s = segments(req); return s[0] === 'api' && s[1] === 'webchat' ? s[2] : s[0]; };
  exports.webchat = onRequest({ secrets: secretsOf('conversation'), timeoutSeconds: 120, memory: '512MiB', cors: hostingOrigins() },
    respond(postOnly((req) => getConversationModule().handleWebChat({ tenantId: tenantOf(req), headers: req.headers, body: req.body, clientIp: clientIpOf(req) }))));

  // Data retention, every night: old customer documents and abandoned conversations. No secret needed.
  exports.conversationCleanup = onSchedule({ schedule: 'every day 03:17', timeZone: 'Africa/Casablanca', timeoutSeconds: 540 }, async () => {
    const db = firestore();
    await createConversationCleanup({ store: createRepository(db), uploads: createFirebaseStorage(bucket()) })();
  });
}

// ---------- underwriting module: needs no secrets ----------
// { action: 'list' | 'get' | 'documentLink' | 'decide' | 'message', tenantId, ... }
if (moduleEnabled('underwriting')) {
  exports.underwriting = callable((request) => getUnderwritingModule().handle({ auth: authOf(request), data: request.data }), { secrets: [] });
}

// ---------- payment module: needs PAYMENT_WEBHOOK_SECRET ----------
// POST {paymentWebhook URL}/{tenantId}: provider notifications (signed). GET/POST /pay/{tenantId}/{paymentId}
// through Hosting: the demo checkout (demo insurers only).
if (moduleEnabled('payment')) {
  const afterPrefix = (req, prefix) => { const s = segments(req); return s[0] === prefix ? s.slice(1) : s; };
  exports.paymentWebhook = onRequest({ secrets: secretsOf('payment'), timeoutSeconds: 120, memory: '512MiB' },
    respond(postOnly((req) => getPaymentModule().handlePaymentWebhook({ tenantId: segments(req)[0], rawBody: rawBodyOf(req), headers: req.headers }))));
  exports.demoPay = onRequest({ secrets: secretsOf('payment'), timeoutSeconds: 120, memory: '512MiB' },
    respond((req) => {
      if (!['GET', 'POST'].includes(req.method)) return { status: 405, body: { error: 'method_not_allowed' } };
      const [tenantId, paymentId] = afterPrefix(req, 'pay');
      return getPaymentModule().handleDemoPay({ tenantId, paymentId, method: req.method });
    }));
}

// ---------- the rest of the app (not yet split into modules): needs every secret ----------
if (moduleEnabled('app')) {
  exports.whatsappWebhook = onRequest({ secrets: SECRETS, timeoutSeconds: 120, memory: '512MiB' },
    respond(postOnly((req) => getApp().handleWhatsAppWebhook({ tenantId: segments(req)[0], headers: req.headers, body: req.body }))));

  // Public QR verification. GET /{tenantId}/{policyNumber}/{code}[?lang=en][&format=json]
  exports.verify = onRequest({ secrets: SECRETS, timeoutSeconds: 30, memory: '256MiB', maxInstances: 5 }, respond((req) => {
    if (req.method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } };
    const [tenantId, policyNumber, code] = segments(req);
    return getApp().handleVerify({ tenantId, policyNumber, code, format: req.query.format === 'json' ? 'json' : 'html', lang: req.query.lang === 'en' ? 'en' : 'fr' });
  }));

  exports.retryOutbox = onSchedule({ schedule: 'every 2 minutes', secrets: SECRETS, timeoutSeconds: 120 }, async () => {
    await getApp().retryOutbox();
  });
}
