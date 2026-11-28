'use strict';

const { createConversationModule, announceDecision, policyResentMessage, PAY } = require('../modules/conversation');
const { createUnderwritingModule } = require('../modules/underwriting');
const { createPolicyModule, isApprovedForIssuance } = require('../modules/policy');
const { createPaymentModule } = require('../modules/payment');
const { legacyConversationPorts } = require('./conversationPorts');
const { deliverOutbox } = require('./outbox');
const { createVerificationModule } = require('../modules/verification');

/**
 * Framework-agnostic handlers. index.js adapts Express requests to these plain inputs, and the
 * tests call them directly. Every handler returns { status, body | html, headers? } or throws AppError.
 *
 * Reliability rules:
 *   - every inbound message and payment event is deduplicated (providers redeliver)
 *   - state is committed before anything is sent; replies go through a retried outbox
 *   - external calls never run inside a Firestore transaction (see repository.js)
 *   - a policy is only issued by the payment path, and only for approved cases (payment and policy modules)
 *
 * The modules do the work; this file wires them for the deployment that runs everything (WhatsApp
 * included) and for the tests. paymentAdapter: the provider used for every insurer here.
 */

function buildApp({
  repo, loadTenant, channel, extractor, assistant = null, documentProcessor, paymentAdapter, policyAdmin, storage,
  paymentSecret, pepper, authService, demoPay = null, verifier = null, now = () => new Date(), logger = console,
}) {
  async function deliver(outbox) {
    try {
      await deliverOutbox({ repo, channel, storage, entries: outbox, now, logger });
    } catch (err) {
      logger.error(`inline outbox delivery failed: ${err.message}`); // the retry job will pick them up
    }
  }

  // Policy and payment modules: links, provider notifications, issuance.
  const policy = createPolicyModule({ registry: policyAdmin, files: storage, verifier });
  const payment = createPaymentModule({
    store: repo,
    tenants: { load: loadTenant },
    gateways: { forTenant: async () => paymentAdapter || null },
    demoGateway: demoPay,
    webhookSecret: paymentSecret,
    policies: { issue: policy.issue, isApprovedForIssuance },
    messages: PAY,
    delivery: { send: deliver },
    now,
    logger,
  });

  // Conversation module: receiving messages from any channel, and the web chat.
  const conversation = createConversationModule({
    extractor,
    assistant,
    ...legacyConversationPorts({ documentProcessor, payments: payment }),
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

  // ---------- Payment: the payment module (provider notifications, demo checkout) ----------

  const handlePaymentWebhook = payment.handlePaymentWebhook;
  const handleDemoPay = payment.handleDemoPay;

  // ---------- Underwriter decision (called by the dashboard) ----------

  // ---------- Underwriting: the underwriting module (decisions, the review queue) ----------

  const underwriting = createUnderwritingModule({
    authorize: ({ caller, ...rest }) => authService.authorize({ auth: caller, ...rest }),
    store: repo,
    tenants: { load: loadTenant },
    notifier: { announce: announceDecision, policyResent: policyResentMessage },
    delivery: { send: deliver },
    files: storage,
    now,
    logger,
  });

  /** data: { caseId, decision: 'approve' | 'adjust' | 'reject', adjustedPremium?, note? } */
  const handleUnderwriterDecision = ({ tenantId, auth, data }) => {
    const d = data || {};
    return underwriting.decide({ auth, tenantId, caseId: d.caseId, decision: d.decision, adjustedPremium: d.adjustedPremium, note: d.note });
  };

  // ---------- Public policy verification (the QR code on the PDF) ----------

  /**
   * Public, unauthenticated, read-only. Shows only what publicView() allows. A wrong code,
   * an unknown policy and a malformed link all give the same "not found" answer, and the code
   * is checked before any database read, so the endpoint cannot be used to probe policies.
   */
  const verification = createVerificationModule({ verifier, tenants: { load: loadTenant }, policies: policy, now });
  const handleVerify = verification.handleVerify;

  // ---------- Scheduled retry ----------

  async function retryOutbox() {
    const due = await repo.listDueOutbox(50);
    return deliverOutbox({ repo, channel, storage, entries: due, now, logger });
  }

  return { handleWhatsAppWebhook, handleWebChat, handlePaymentWebhook, handleUnderwriterDecision, handleUnderwriting: underwriting.handle, handleMembers: (args) => authService.handle(args), handleDemoPay, handleVerify, retryOutbox };
}

module.exports = { buildApp };
