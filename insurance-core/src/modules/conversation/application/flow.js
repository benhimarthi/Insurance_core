'use strict';

const { CASE_STATUS, ACTOR, EVENT, newEvent, caseStatusFromEngine, finalPremium } = require('../../../shared/cases');
const { QUESTIONS, getPath, setPath, validateValue, formatQuestion } = require('../domain/questions');
const { MESSAGES, DOC, PAY, t, quoteMessage } = require('../domain/messages');
const { detectLanguage, parseBoolean, wantsHuman } = require('../domain/nlu');
const { MAX_DETOURS, sanitizeAnswer, insurerKnowledge } = require('../domain/detour');

/**
 * Channel-agnostic conversation flow (WhatsApp, web chat, anything).
 *
 *   const handleMessage = makeFlow({ extractor, underwriting, documents, payments, assistant })
 *   handleMessage({ caseDoc, message, attachments, config, now }) -> { caseDoc, replies, events }
 *
 * What the flow needs from other modules comes through ports (application/ports.js): the rules
 * engine (underwriting), document checks (documents), payment links (payments, optional) and the
 * assistant (optional), which answers questions and redirects off-topic messages before the flow
 * asks its pending step again (see domain/detour.js).
 * It never touches Firestore or a messaging API: the caller persists caseDoc, appends events
 * to the audit trail and sends replies. That keeps the flow testable and channel-independent.
 *
 * Stages: new -> asking -> documents (if config.documents) -> quoted | review | closed ;
 *         handoff at any point ; quoted -> payment (if payments) | confirmed | closed ;
 *         payment -> issued (see src/policy/lifecycle.js)
 */

const MAX_RETRIES = 3;
const SYSTEM = { kind: ACTOR.SYSTEM, id: 'conversation-flow' };

const nextQuestion = (input) => QUESTIONS.find((q) => getPath(input, q.path) == null);

function finish(c, replies, events) {
  c.updatedAt = new Date().toISOString();
  return { caseDoc: c, replies, events };
}

function handoff(c, reason, lang, replies, events) {
  c.status = CASE_STATUS.PENDING_REVIEW;
  c.flow = { stage: 'handoff', pending: null, retries: 0 };
  c.handoff = { reason };
  events.push(newEvent({ type: EVENT.REFERRED, actor: SYSTEM, payload: { reason } }));
  replies.push(t(MESSAGES.handoff, lang));
  return finish(c, replies, events);
}

function runEngine({ underwriting }, c, config, lang, replies, events) {
  // documentConfidence comes from the document module; defaults to 1 until it exists
  const data = { ...c.input, documentConfidence: c.documentConfidence ?? 1, documentFlags: c.documentFlags || [] };
  const result = underwriting.evaluate(data, config);
  c.engineResult = result;
  c.status = caseStatusFromEngine(result.status, config);
  c.flow = { stage: 'review', pending: null, retries: 0 };

  events.push(newEvent({
    type: EVENT.ENGINE_EVALUATED,
    actor: { kind: ACTOR.SYSTEM, id: 'rules-engine' },
    payload: {
      status: result.status,
      riskScore: result.riskScore,
      riskBand: result.riskBand,
      confidence: result.confidence,
      premium: result.premium ? result.premium.total : null,
      reasonCodes: result.reasons.map((r) => r.code),
      configVersion: result.configVersion,
    },
  }));

  switch (c.status) {
    case CASE_STATUS.QUOTED:
      c.flow.stage = 'quoted';
      replies.push(quoteMessage(lang, result.premium.total, result.currency));
      break;
    case CASE_STATUS.PENDING_REVIEW:
      events.push(newEvent({ type: EVENT.REFERRED, actor: SYSTEM, payload: { reason: 'engine_' + result.status } }));
      replies.push(t(MESSAGES.review, lang)); // no price, no reasons: a human decides first
      break;
    case CASE_STATUS.DECLINED:
      c.flow.stage = 'closed';
      replies.push(t(MESSAGES.declined, lang));
      break;
    default:
      return handoff(c, 'engine_' + result.status, lang, replies, events);
  }
  return finish(c, replies, events);
}

function afterQuestions(ports, c, config, lang, replies, events) {
  const { documents } = ports;
  const required = documents.requiredTypes(config);
  if (!required.length) return runEngine(ports, c, config, lang, replies, events);
  c.flow = { stage: 'documents', pending: null, retries: 0, docRetries: 0 };
  replies.push(DOC.request(lang, required.map((type) => documents.labelOf(type, lang))));
  return finish(c, replies, events);
}

function makeFlow(ports) {
  const { extractor, documents, payments = null, assistant = null } = ports;
  if (!extractor || !ports.underwriting || !documents) throw new Error('makeFlow needs extractor, underwriting and documents ports.');

  /**
   * The message is not what the step expects: is it a question (answer it) or off topic (redirect)?
   * Returns { replies, event } to show before re-asking the step, or null (then: the usual re-ask).
   * Never counts as a failed answer, but at most MAX_DETOURS in a row.
   */
  async function detour({ c, message, lang, config, stage, pendingQuestion }) {
    if (!assistant || !String(message).trim() || (c.flow.detours || 0) >= MAX_DETOURS) return null;
    let res;
    try {
      res = await assistant.respond({
        message, language: lang, stage, pendingQuestion,
        knowledge: insurerKnowledge(config, { language: lang, documentLabels: documents.requiredTypes(config).map((type) => documents.labelOf(type, lang)), paymentEnabled: !!payments }),
      });
    } catch {
      return null;
    }
    let reply = null;
    if (res && res.kind === 'question') reply = sanitizeAnswer(res.answer);
    else if (res && res.kind === 'off_topic') reply = t(MESSAGES.offTopic, lang);
    if (!reply) return null;
    c.flow.detours = (c.flow.detours || 0) + 1;
    // the audit trail records that the customer went off the path, never what they wrote
    const event = newEvent({ type: EVENT.CUSTOMER_QUESTION, actor: { kind: ACTOR.CUSTOMER, id: c.customerId || 'customer' }, payload: { kind: res.kind, stage } });
    return { replies: [reply], event };
  }

  return async function handleMessage({ caseDoc, message = '', attachments = [], config, now = new Date() }) {
    const c = structuredClone(caseDoc);
    c.flow = c.flow || { stage: 'new', pending: null, retries: 0 };
    c.input = c.input || { driver: {}, vehicle: {}, location: {} };
    const replies = [];
    const events = [];

    // Stage: new. Detect the language and start asking.
    if (c.flow.stage === 'new') {
      c.language = c.language || detectLanguage(message);
      const q = nextQuestion(c.input);
      c.flow = { stage: 'asking', pending: q.path, retries: 0 };
      replies.push(t(MESSAGES.intro, c.language), formatQuestion(q, c.language));
      return finish(c, replies, events);
    }

    const lang = c.language || 'fr';

    // A customer can ask for a human at any point.
    if (!['handoff', 'closed'].includes(c.flow.stage) && wantsHuman(message)) {
      return handoff(c, 'customer_requested_human', lang, replies, events);
    }

    switch (c.flow.stage) {
      case 'asking': {
        const q = QUESTIONS.find((x) => x.path === c.flow.pending);
        const { fields } = await extractor.extract({ message, language: lang, question: q, questions: QUESTIONS });

        const applied = {};
        for (const [path, raw] of Object.entries(fields || {})) {
          const def = QUESTIONS.find((x) => x.path === path);
          if (!def) continue; // ignore unknown fields
          if (path !== q.path && getPath(c.input, path) != null) continue; // no silent overwrites
          const check = validateValue(def, raw);
          if (!check.ok) continue; // never trust extractor output
          setPath(c.input, path, check.value);
          applied[path] = check.value;
          if (def.derive) {
            const derived = def.derive(check.value, config);
            setPath(c.input, def.derives, derived);
            applied[def.derives] = derived;
          }
        }

        if (getPath(c.input, q.path) == null) {
          if (Object.keys(applied).length === 0) { // nothing usable: maybe a question, or off topic
            const d = await detour({ c, message, lang, config, stage: 'asking', pendingQuestion: formatQuestion(q, lang) });
            if (d) {
              events.push(d.event);
              replies.push(...d.replies, formatQuestion(q, lang));
              return finish(c, replies, events);
            }
          }
          c.flow.retries += 1;
          if (c.flow.retries >= MAX_RETRIES) return handoff(c, 'conversation_stuck', lang, replies, events);
          replies.push(t(MESSAGES.retry, lang), formatQuestion(q, lang));
          return finish(c, replies, events);
        }

        events.push(newEvent({ type: EVENT.INPUT_UPDATED, actor: { kind: ACTOR.CUSTOMER, id: c.customerId || 'customer' }, payload: { fields: applied } }));
        c.flow.retries = 0;
        c.flow.detours = 0;

        const nq = nextQuestion(c.input);
        if (nq) {
          c.flow.pending = nq.path;
          replies.push(formatQuestion(nq, lang));
          return finish(c, replies, events);
        }
        return afterQuestions(ports, c, config, lang, replies, events);
      }

      case 'documents': {
        const processor = { kind: ACTOR.AI, id: 'document-processor' };
        const labelOf = documents.labelOf;
        const missingTypes = documents.missingTypes;
        const labels = (types) => types.map((type) => labelOf(type, lang));
        c.documents = c.documents || {};

        if (!attachments.length) {
          const d = await detour({ c, message, lang, config, stage: 'documents', pendingQuestion: DOC.request(lang, labels(missingTypes(c, config))) });
          if (d) { events.push(d.event); replies.push(...d.replies); }
          replies.push(DOC.request(lang, labels(missingTypes(c, config))));
          return finish(c, replies, events);
        }

        let hadIssue = false;
        for (const attachment of attachments) {
          const missing = missingTypes(c, config);
          const extracted = await documents.process({ attachment, expectedTypes: missing, language: lang });
          const res = documents.accept(extracted, config, now);

          if (!res.ok) {
            hadIssue = true;
            c.flow.docRetries = (c.flow.docRetries || 0) + 1;
            // audit: codes and confidence only, never extracted values
            events.push(newEvent({ type: EVENT.DOCUMENT_EXTRACTED, actor: processor, payload: { docType: res.type, accepted: false, issue: res.issue, confidence: res.confidence } }));
            if (c.flow.docRetries >= (config.documents.maxResubmits || 3)) return handoff(c, 'documents_failed', lang, replies, events);
            replies.push(res.issue === 'WRONG_TYPE'
              ? DOC.WRONG_TYPE(lang, labels(missing))
              : DOC[res.issue](lang, labelOf(res.type, lang)));
            continue;
          }

          c.documents[res.type] = { fields: res.fields, confidence: res.confidence, receivedAt: now.toISOString(), source: attachment.storagePath || null };
          events.push(newEvent({ type: EVENT.DOCUMENT_EXTRACTED, actor: processor, payload: { docType: res.type, accepted: true, confidence: res.confidence } }));
          replies.push(DOC.received(lang, labelOf(res.type, lang)));
        }

        const stillMissing = missingTypes(c, config);
        if (stillMissing.length) {
          if (!hadIssue) replies.push(DOC.remaining(lang, labels(stillMissing)));
          return finish(c, replies, events);
        }

        // All documents accepted: cross-check against the declared answers, then run the engine.
        c.documentFlags = documents.crossCheck(c.input, c.documents, config, now);
        c.documentConfidence = Math.min(...documents.requiredTypes(config).map((type) => c.documents[type].confidence));
        events.push(newEvent({ type: EVENT.DOCUMENT_EXTRACTED, actor: SYSTEM, payload: { crossCheck: true, flagCodes: c.documentFlags.map((f) => f.code), documentConfidence: c.documentConfidence } }));
        return runEngine(ports, c, config, lang, replies, events);
      }

      case 'quoted': {
        const answer = parseBoolean(message);
        const customer = { kind: ACTOR.CUSTOMER, id: c.customerId || 'customer' };
        if (answer === true) {
          c.flow.stage = 'confirmed';
          events.push(newEvent({ type: EVENT.QUOTE_ACCEPTED, actor: customer, payload: { premium: finalPremium(c) } }));
          if (!payments) { // payment not enabled for this deployment: the insurer follows up
            replies.push(t(MESSAGES.confirmed, lang));
            return finish(c, replies, events);
          }
          const paid = await payments.requestPayment({ caseDoc: c, config, now });
          return finish(paid.caseDoc, [...replies, ...paid.replies], [...events, ...paid.events]);
        }
        if (answer === false) {
          c.flow.stage = 'closed';
          events.push(newEvent({ type: EVENT.QUOTE_DECLINED_BY_CUSTOMER, actor: customer, payload: {} }));
          replies.push(t(MESSAGES.closed, lang));
        } else {
          const d = await detour({ c, message, lang, config, stage: 'quoted', pendingQuestion: t(MESSAGES.quotedReprompt, lang) });
          if (d) { events.push(d.event); replies.push(...d.replies); }
          replies.push(t(MESSAGES.quotedReprompt, lang));
        }
        return finish(c, replies, events);
      }

      case 'payment':
        replies.push(PAY.link(lang, c.payment.url, c.payment.amount, c.payment.currency));
        return finish(c, replies, events);

      case 'issued':
        replies.push(PAY.issued(lang));
        return finish(c, replies, events);

      case 'closed':
        replies.push(t(MESSAGES.closed, lang));
        return finish(c, replies, events);

      default: // review, handoff, confirmed
        replies.push(t(MESSAGES.waiting, lang));
        return finish(c, replies, events);
    }
  };
}

module.exports = { makeFlow, nextQuestion };
