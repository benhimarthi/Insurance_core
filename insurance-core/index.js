'use strict';

/**
 * Firebase Cloud Functions (2nd gen) entry point. Thin on purpose: it only adapts HTTP to the
 * framework-agnostic handlers in src/server/app.js.
 *
 * Deploy:  firebase deploy --only functions,firestore
 * Params:  FIRESTORE_DATABASE_ID, GEMINI_MODEL, DEMO_PAYMENTS, DEMO_PAY_BASE_URL, USE_LOCAL_TENANTS, VERIFY_BASE_URL
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
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const { buildProductionApp } = require('./src/server/production');
const { AppError } = require('./src/server/util');

setGlobalOptions({ region: 'europe-west1', maxInstances: 10 }); // closest region to Morocco with Gen2 support

const FIRESTORE_DATABASE_ID = defineString('FIRESTORE_DATABASE_ID', { default: '(default)' });
const GEMINI_MODEL = defineString('GEMINI_MODEL', { default: 'gemini-2.5-flash' });
const DEMO_PAYMENTS = defineString('DEMO_PAYMENTS', { default: 'false' });
const DEMO_PAY_BASE_URL = defineString('DEMO_PAY_BASE_URL', { default: '' });
const USE_LOCAL_TENANTS = defineString('USE_LOCAL_TENANTS', { default: 'false' });
const REQUIRE_MFA = defineString('REQUIRE_MFA', { default: 'true' }); // needs Identity Platform; keep true in production
const VERIFY_BASE_URL = defineString('VERIFY_BASE_URL', { default: '' });

const WASENDER_API_KEY = defineSecret('WASENDER_API_KEY');
const WASENDER_WEBHOOK_SECRET = defineSecret('WASENDER_WEBHOOK_SECRET');
const PAYMENT_WEBHOOK_SECRET = defineSecret('PAYMENT_WEBHOOK_SECRET');
const PHONE_PEPPER = defineSecret('PHONE_PEPPER');
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const VERIFY_SECRET = defineSecret('VERIFY_SECRET');
const SECRETS = [WASENDER_API_KEY, WASENDER_WEBHOOK_SECRET, PAYMENT_WEBHOOK_SECRET, PHONE_PEPPER, GEMINI_API_KEY, VERIFY_SECRET];

let app;
function getApp() {
  if (!app) {
    const firebaseApp = admin.apps.length ? admin.app() : admin.initializeApp();
    // Named database pattern: always pass the database id explicitly.
    const db = getFirestore(firebaseApp, FIRESTORE_DATABASE_ID.value());
    app = buildProductionApp({
      db,
      authAdmin: admin.auth(firebaseApp),
      bucket: getStorage(firebaseApp).bucket(),
      env: {
        geminiApiKey: GEMINI_API_KEY.value(),
        geminiModel: GEMINI_MODEL.value(),
        wasenderApiKey: WASENDER_API_KEY.value(),
        wasenderWebhookSecret: WASENDER_WEBHOOK_SECRET.value(),
        paymentWebhookSecret: PAYMENT_WEBHOOK_SECRET.value(),
        phonePepper: PHONE_PEPPER.value(),
        demoPaymentsEnabled: DEMO_PAYMENTS.value() === 'true',
        demoPayBaseUrl: DEMO_PAY_BASE_URL.value(),
        useLocalTenants: USE_LOCAL_TENANTS.value() === 'true',
        requireMfa: REQUIRE_MFA.value() !== 'false',
        verifyBaseUrl: VERIFY_BASE_URL.value(),
        verifySecret: VERIFY_SECRET.value(),
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

exports.whatsappWebhook = onRequest({ secrets: SECRETS, timeoutSeconds: 120, memory: '512MiB' },
  respond(postOnly((req) => getApp().handleWhatsAppWebhook({ tenantId: segments(req)[0], headers: req.headers, body: req.body }))));

exports.webchat = onRequest({ secrets: SECRETS, timeoutSeconds: 120, memory: '512MiB', cors: true },
  respond(postOnly((req) => getApp().handleWebChat({ tenantId: segments(req)[0], headers: req.headers, body: req.body }))));

exports.paymentWebhook = onRequest({ secrets: SECRETS, timeoutSeconds: 120, memory: '512MiB' },
  respond(postOnly((req) => getApp().handlePaymentWebhook({ tenantId: segments(req)[0], rawBody: rawBodyOf(req), headers: req.headers }))));

exports.demoPay = onRequest({ secrets: SECRETS, timeoutSeconds: 120, memory: '512MiB' },
  respond((req) => {
    if (!['GET', 'POST'].includes(req.method)) return { status: 405, body: { error: 'method_not_allowed' } };
    const [tenantId, paymentId] = segments(req);
    return getApp().handleDemoPay({ tenantId, paymentId, method: req.method });
  }));

// Public QR verification. GET /{tenantId}/{policyNumber}/{code}[?lang=en][&format=json]
exports.verify = onRequest({ secrets: SECRETS, timeoutSeconds: 30, memory: '256MiB', maxInstances: 5 }, respond((req) => {
  if (req.method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } };
  const [tenantId, policyNumber, code] = segments(req);
  return getApp().handleVerify({ tenantId, policyNumber, code, format: req.query.format === 'json' ? 'json' : 'html', lang: req.query.lang === 'en' ? 'en' : 'fr' });
}));

// Callables for the dashboard (Firebase SDK: httpsCallable(functions, name)(data)).
const authOf = (request) => request.auth && { uid: request.auth.uid, token: request.auth.token };

function callable(handler) {
  return onCall({ secrets: SECRETS, enforceAppCheck: false /* set true once App Check is configured */ }, async (request) => {
    try {
      return await handler(request);
    } catch (err) {
      if (err instanceof AppError) throw new HttpsError(err.code, err.message);
      console.error(err);
      throw new HttpsError('internal', 'Internal error.');
    }
  });
}

// { tenantId, caseId, decision: 'approve' | 'adjust' | 'reject', adjustedPremium?, note? }
exports.underwriterDecision = callable((request) => getApp().handleUnderwriterDecision({
  tenantId: request.data && request.data.tenantId, auth: authOf(request), data: request.data,
}));

// { action: 'myTenants' | 'allTenants' (platform only) | 'list' | 'invite' | 'accept' | 'revokeInvitation' | 'changeRole' | 'setStatus' | 'remove', tenantId, ... }
// Platform staff must add `reason` on every action that targets an insurer.
exports.members = callable((request) => getApp().handleMembers({ auth: authOf(request), data: request.data }));

exports.retryOutbox = onSchedule({ schedule: 'every 2 minutes', secrets: SECRETS, timeoutSeconds: 120 }, async () => {
  await getApp().retryOutbox();
});
