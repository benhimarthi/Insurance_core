'use strict';

const { handleMessage } = require('../conversation/flow');
const { newCase, applyHumanDecision } = require('../models/schemas');
const { notifyHumanDecision, handlePaymentEvent } = require('../policy/lifecycle');
const { parseWebhook } = require('../payment/webhook');
const { deliverOutbox } = require('./outbox');
const { renderPayPage, SECURITY_HEADERS } = require('./demoPayPage');
const { renderVerifyPage, VERIFY_HEADERS } = require('./verifyPage');
const { publicView, POLICY_NUMBER_RE, CODE_RE } = require('../verification/verification');
const { isoDate } = require('../policy/policy');
const { TENANT_ID_RE, ID_RE, AppError, sha256, newId, customerKey, safeEqual } = require('./util');

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

const ISSUED_WINDOW_MS = 24 * 3600 * 1000; // after issuance the chat stays on the same case for a day
const MAX_ATTACHMENTS = 3;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_TEXT_LENGTH = 1000;

function buildApp({
  repo, loadTenant, channel, extractor, documentProcessor, paymentAdapter, policyAdmin, storage,
  paymentSecret, pepper, authService, demoPay = null, verifier = null, now = () => new Date(), logger = console,
}) {
  const textEntry = (text) => ({ kind: 'text', text });

  const isTerminal = (c) => !!c.flow && (
    c.flow.stage === 'closed' ||
    (c.flow.stage === 'issued' && now().getTime() - new Date(c.updatedAt).getTime() > ISSUED_WINDOW_MS)
  );

  async function deliver(outbox) {
    try {
      await deliverOutbox({ repo, channel, storage, entries: outbox, now, logger });
    } catch (err) {
      logger.error(`inline outbox delivery failed: ${err.message}`); // the retry job will pick them up
    }
  }

  /** Stores accepted uploads and returns the attachments the flow can process (bytes stay in memory). */
  async function collectAttachments({ tenant, tenantId, caseId, inbound }) {
    const out = [];
    const list = (inbound.attachments || []).slice(0, MAX_ATTACHMENTS);
    for (let i = 0; i < list.length; i += 1) {
      const att = list[i];
      if (!ALLOWED_MIME.includes(att.mimeType)) continue;
      const bytes = att.data ? Buffer.from(att.data) : await channel.downloadMedia(att);
      if (!bytes || bytes.length === 0 || bytes.length > MAX_UPLOAD_BYTES) continue;
      const storagePath = `tenants/${tenantId}/cases/${caseId}/uploads/${sha256(inbound.messageId).slice(0, 12)}-${i}`;
      await storage.save(storagePath, bytes, att.mimeType);
      out.push({
        storagePath, mimeType: att.mimeType, filename: att.filename || null, data: bytes,
        ...(tenant.demo && att.demoFixture ? { demoFixture: att.demoFixture } : {}), // demo scenarios only
      });
    }
    return out;
  }

  /** inbound: { messageId, from, text, attachments, channel: 'whatsapp' | 'web' } */
  async function processInbound({ tenantId, tenant, config, inbound }) {
    const customerId = customerKey(pepper, inbound.from);
    const customer = await repo.getCustomer(tenantId, customerId);

    let caseId = customer && customer.activeCaseId;
    let existing = caseId ? await repo.getCase(tenantId, caseId) : null;
    if (!existing || isTerminal(existing)) {
      caseId = newId();
      existing = null;
    }

    // Only keep uploads while the flow is actually waiting for documents.
    const attachments = existing && existing.flow && existing.flow.stage === 'documents'
      ? await collectAttachments({ tenant, tenantId, caseId, inbound })
      : [];

    const result = await repo.transact({
      tenantId, caseId, customerId,
      dedupe: { kind: 'msg', id: inbound.messageId },
      compute: async ({ caseDoc }) => {
        const base = caseDoc || newCase({ id: caseId, tenantId, channel: inbound.channel, customerId });
        const out = await handleMessage({
          caseDoc: base, message: inbound.text || '', attachments, config,
          extractor, documentProcessor, paymentAdapter, now: now(),
        });
        return {
          caseDoc: out.caseDoc,
          events: out.events,
          outbox: out.replies.map(textEntry),
          customerPatch: { contact: inbound.from, channel: inbound.channel, activeCaseId: caseId, language: out.caseDoc.language || null, lastInboundAt: now().toISOString() },
        };
      },
    });

    if (!result.duplicate && inbound.channel !== 'web') await deliver(result.outbox);
    return result;
  }

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

  // ---------- Web chat (demo front end) ----------

  async function handleWebChat({ tenantId, headers, body }) {
    const loaded = await loadTenant(tenantId);
    if (!loaded) return { status: 404, body: { error: 'unknown_tenant' } };
    const { tenant } = loaded;

    if (tenant.webchatKey) {
      if (!safeEqual(headers && headers['x-webchat-key'], tenant.webchatKey)) return { status: 401, body: { error: 'bad_key' } };
    } else if (!tenant.demo) {
      return { status: 401, body: { error: 'webchat_not_enabled' } }; // open web chat only for demo tenants
    }

    const { sessionId, text, attachments, messageId, poll } = body || {};
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) return { status: 400, body: { error: 'bad_session' } };
    const from = `web:${sessionId}`;

    if (!poll) {
      if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) return { status: 400, body: { error: 'bad_text' } };
      if (messageId !== undefined && !ID_RE.test(messageId)) return { status: 400, body: { error: 'bad_message_id' } };
      const files = (Array.isArray(attachments) ? attachments : []).map((a) => ({
        mimeType: a.mimeType, filename: a.filename, demoFixture: a.demoFixture,
        data: typeof a.dataBase64 === 'string' ? Buffer.from(a.dataBase64, 'base64') : undefined,
      }));
      await processInbound({ tenantId, ...loaded, inbound: { messageId: messageId || newId(), from, text, attachments: files, channel: 'web' } });
    }

    const pending = await repo.takePendingWebMessages(tenantId, customerKey(pepper, from));
    const messages = [];
    for (const m of pending) {
      if (m.kind === 'document') {
        messages.push({ kind: 'document', filename: m.document.filename, url: await storage.getSignedUrl(m.document.path, 15 * 60 * 1000), text: m.text || null });
      } else {
        messages.push({ kind: 'text', text: m.text });
      }
    }
    return { status: 200, body: { messages } };
  }

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
