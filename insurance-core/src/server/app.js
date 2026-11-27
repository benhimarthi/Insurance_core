'use strict';

const { createConversationModule } = require('../modules/conversation');
const { applyHumanDecision } = require('../shared/cases');
const { legacyConversationPorts } = require('./conversationPorts');
const { notifyHumanDecision, handlePaymentEvent } = require('../policy/lifecycle');
const { parseWebhook } = require('../payment/webhook');
const { deliverOutbox } = require('./outbox');
const { renderPayPage, SECURITY_HEADERS } = require('./demoPayPage');
const { renderVerifyPage, VERIFY_HEADERS } = require('./verifyPage');
const { publicView, POLICY_NUMBER_RE, CODE_RE } = require('../verification/verification');
const { isoDate } = require('../policy/policy');
const { TENANT_ID_RE, ID_RE, AppError } = require('./util');

/**
 * Framework-agnostic handlers. index.js adapts Express requests to these plain inputs, and the
 * tests call them directly. Every handler returns { status, body | html, headers? } or throws AppError.
 *
 * Reliability rules:
 *   - every inbound message and payment event is deduplicated (providers redeliver)
 *   - state is committed before anything is sent; replies go through a retried outbox
 *   - external calls never run inside a Firestore transaction (see repository.js)
 *   - a policy is only issued by the payment path, and only for approved cases (see lifecycle.js)
 */

function buildApp({
  repo, loadTenant, channel, extractor, documentProcessor, paymentAdapter, policyAdmin, storage,
  paymentSecret, pepper, authService, demoPay = null, verifier = null, now = () => new Date(), logger = console,
}) {
  const textEntry = (text) => ({ kind: 'text', text });

  async function deliver(outbox) {
    try {
      await deliverOutbox({ repo, channel, storage, entries: outbox, now, logger });
    } catch (err) {
      logger.error(`inline outbox delivery failed: ${err.message}`); // the retry job will pick them up
    }
  }

  // Conversation module: receiving messages from any channel, and the web chat.
  const conversation = createConversationModule({
    extractor,
    ...legacyConversationPorts({ documentProcessor, paymentAdapter }),
    store: repo,
    uploads: storage,
    tenants: { load: loadTenant },
    delivery: { send: deliver, downloadMedia: (att) => channel.downloadMedia(att) },
    pepper,
    now,
    logger,
  });
  const processInbound = conversation.handleInbound;

  // ---------- WhatsApp ----------

  async function handleWhatsAppWebhook({ tenantId, headers, body }) {
    const loaded = await loadTenant(tenantId);
    if (!loaded) return { status: 404, body: { error: 'unknown_tenant' } };
    if (!channel.verifyRequest(headers || {})) return { status: 401, body: { error: 'bad_signature' } };

    let failed = false;
    for (const inbound of channel.parseInbound(body)) {
      try {
        await processInbound({ tenantId, ...loaded, inbound: { ...inbound, channel: 'whatsapp' } });
      } catch (err) {
        failed = true;
        logger.error(`inbound ${inbound.messageId} failed: ${err.message}`);
      }
    }
    // A 500 makes the provider retry; messages already committed are deduplicated on retry.
    return { status: failed ? 500 : 200, body: { ok: !failed } };
  }

  // ---------- Web chat: the conversation module ----------

  const handleWebChat = conversation.handleWebChat;

  // ---------- Payment webhook ----------

  async function handlePaymentWebhook({ tenantId, rawBody, headers }) {
    const loaded = await loadTenant(tenantId);
    if (!loaded) return { status: 404, body: { error: 'unknown_tenant' } };

    let event;
    try {
      event = parseWebhook({
        secret: paymentSecret(tenantId),
        rawBody: String(rawBody),
        signature: (headers && (headers['x-signature'] || headers['x-webhook-signature'])) || '',
      });
    } catch (err) {
      return { status: 401, body: { error: 'bad_signature' } };
    }
    if (!ID_RE.test(event.caseId)) return { status: 400, body: { error: 'bad_case_id' } };

    try {
      const result = await repo.transact({
        tenantId, caseId: event.caseId,
        dedupe: { kind: 'pay', id: event.id },
        compute: async ({ caseDoc }) => {
          if (!caseDoc) throw new AppError('not-found', 'Unknown case for this payment event.');
          const out = await handlePaymentEvent({ caseDoc, event, config: loaded.config, policyAdmin, storage, verifier, now: now() });
          return {
            caseDoc: out.caseDoc,
            events: out.events,
            outbox: [
              ...out.replies.map(textEntry),
              ...out.attachments.map((a) => ({ kind: 'document', document: a })),
            ],
          };
        },
      });
      if (!result.duplicate) await deliver(result.outbox);
      return { status: 200, body: { ok: true, duplicate: !!result.duplicate } };
    } catch (err) {
      // Permanent problems get a 200 so the provider does not retry forever; they are logged for follow-up.
      if (err instanceof AppError || /does not match/.test(err.message)) {
        logger.error(`payment event ${event.id} ignored: ${err.message}`);
        return { status: 200, body: { ok: false, ignored: err.message } };
      }
      throw err; // transient: 500, the provider retries and the dedupe marker keeps it safe
    }
  }

  // ---------- Underwriter decision (called by the dashboard) ----------

  /**
   * auth: { uid, token } from Firebase Auth (token carries email_verified, email, MFA and the
   * platformRole claim). What the person may do comes from authService.authorize(): their role at
   * THIS insurer, read live from Firestore.
   */
  async function handleUnderwriterDecision({ tenantId, auth, data }) {
    const ctx = await authService.authorize({ auth, tenantId, permission: 'case:decide' });
    const loaded = await loadTenant(tenantId);
    if (!loaded) throw new AppError('not-found', 'Unknown tenant.');

    const { caseId, decision, adjustedPremium, note } = data || {};
    if (typeof caseId !== 'string' || !ID_RE.test(caseId)) throw new AppError('invalid-argument', 'Invalid caseId.');
    if (!['approve', 'adjust', 'reject'].includes(decision)) throw new AppError('invalid-argument', 'decision must be approve, adjust or reject.');
    if (decision === 'adjust' && !(Number.isFinite(adjustedPremium) && adjustedPremium > 0)) throw new AppError('invalid-argument', 'adjust needs a positive adjustedPremium.');
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) throw new AppError('invalid-argument', 'note must be at most 500 characters.');

    const result = await repo.transact({
      tenantId, caseId,
      compute: async ({ caseDoc }) => {
        if (!caseDoc) throw new AppError('not-found', 'Case not found.');

        // Underwriters decide up to the insurer's premium limit; larger amounts need a manager.
        const amount = decision === 'adjust' ? adjustedPremium
          : decision === 'approve' ? (caseDoc.engineResult && caseDoc.engineResult.premium ? caseDoc.engineResult.premium.total : 0) : 0;
        const limit = loaded.config.authorization && loaded.config.authorization.underwriterPremiumLimit;
        if (limit && amount > limit && !ctx.permissions.includes('case:decide_high')) throw new AppError('permission-denied', 'LIMIT_EXCEEDED');

        let decided;
        try {
          decided = applyHumanDecision(caseDoc, { reviewerId: ctx.uid, decision, adjustedPremium, note });
        } catch (err) {
          throw new AppError('failed-precondition', err.message); // already decided, or not pending review
        }
        decided.event.payload.reviewerRole = ctx.role; // who decided, and in which capacity
        const notice = notifyHumanDecision({ caseDoc: decided.case, config: loaded.config });
        return { caseDoc: notice.caseDoc, events: [decided.event], outbox: notice.replies.map(textEntry) };
      },
    });
    await deliver(result.outbox);
    return { ok: true, status: result.caseDoc.status };
  }

  // ---------- Demo checkout page ----------

  async function handleDemoPay({ tenantId, paymentId, method }) {
    const page = (status, state, payment, loaded) => ({
      status, headers: SECURITY_HEADERS, html: renderPayPage({ state, payment, brand: loaded && loaded.tenant.name }),
    });
    if (!demoPay || !TENANT_ID_RE.test(tenantId || '') || !ID_RE.test(paymentId || '')) return page(404, 'missing');
    const loaded = await loadTenant(tenantId);
    if (!loaded || !loaded.tenant.demo) return page(404, 'missing'); // demo checkout never exists for real tenants

    const payment = await demoPay.getPayment(paymentId);
    if (!payment || payment.tenantId !== tenantId) return page(404, 'missing', null, loaded);
    if (payment.status === 'paid') return page(200, 'paid', payment, loaded);
    if (new Date(payment.expiresAt) <= now()) return page(410, 'expired', payment, loaded);
    if (method !== 'POST') return page(200, 'form', payment, loaded);

    const { rawBody, signature } = demoPay.signEvent(payment, 'succeeded', paymentSecret(tenantId));
    const res = await handlePaymentWebhook({ tenantId, rawBody, headers: { 'x-signature': signature } });
    if (res.status === 200 && res.body.ok) {
      await demoPay.markPaid(paymentId);
      return page(200, 'paid', payment, loaded);
    }
    return page(500, 'error', payment, loaded);
  }

  // ---------- Public policy verification (the QR code on the PDF) ----------

  /**
   * Public, unauthenticated, read-only. Shows only what publicView() allows. A wrong code,
   * an unknown policy and a malformed link all give the same "not found" answer, and the code
   * is checked before any database read, so the endpoint cannot be used to probe policies.
   */
  async function handleVerify({ tenantId, policyNumber, code, format = 'html', lang = 'fr' }) {
    const asJson = format === 'json';
    const notFound = () => (asJson
      ? { status: 404, headers: { 'cache-control': 'no-store' }, body: { valid: false, state: 'not_found' } }
      : { status: 404, headers: VERIFY_HEADERS, html: renderVerifyPage({ view: null, lang }) });

    if (!verifier || !TENANT_ID_RE.test(tenantId || '') || !POLICY_NUMBER_RE.test(policyNumber || '') || !CODE_RE.test(code || '')) return notFound();
    if (!verifier.check({ tenantId, policyNumber }, code)) return notFound();

    const loaded = await loadTenant(tenantId);
    if (!loaded) return notFound();
    const policy = await policyAdmin.getPolicy(tenantId, policyNumber);
    if (!policy) return notFound();

    const view = publicView(policy, { tenant: loaded.tenant, today: isoDate(now()) });
    if (asJson) return { status: 200, headers: { 'cache-control': 'no-store' }, body: view };

    const info = loaded.config.coverageInfo && loaded.config.coverageInfo[policy.coverage];
    const coverageLabel = info && (info.label[lang] || info.label.fr);
    return { status: 200, headers: VERIFY_HEADERS, html: renderVerifyPage({ view, lang, coverageLabel }) };
  }

  // ---------- Scheduled retry ----------

  async function retryOutbox() {
    const due = await repo.listDueOutbox(50);
    return deliverOutbox({ repo, channel, storage, entries: due, now, logger });
  }

  return { handleWhatsAppWebhook, handleWebChat, handlePaymentWebhook, handleUnderwriterDecision, handleMembers: (args) => authService.handle(args), handleDemoPay, handleVerify, retryOutbox };
}

module.exports = { buildApp };
