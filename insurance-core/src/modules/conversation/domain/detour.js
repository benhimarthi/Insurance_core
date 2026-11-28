'use strict';

/**
 * Detours: the customer writes something that is not an answer (a question about the insurance, or
 * something unrelated). The assistant answers from the insurer's own information, then the flow asks
 * its pending question again. These rules keep that safe:
 *   - the assistant only sees a summary of the insurer's settings, never prices (insurerKnowledge)
 *   - its answer is refused if it contains an amount with a currency, links are removed, length capped
 *   - after MAX_DETOURS detours in a row the flow stops answering and treats messages as unclear
 */

const MAX_DETOURS = 5;
const MAX_ANSWER_CHARS = 600;
const DETOUR_KINDS = Object.freeze(['human', 'question', 'off_topic', 'unclear']);
const MONEY_RE = /\d[\d\s.,]*\s?(mad|dhs?|dirhams?|درهم|€|eur|euros?|\$|usd)(?![a-z])|(?<![a-z])(mad|dhs?|€|\$|usd)\s?\d/i;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

/** A safe answer to show the customer, or null (then the flow re-asks as if the message was unclear). */
function sanitizeAnswer(text) {
  if (typeof text !== 'string') return null;
  let a = text.replace(URL_RE, '').replace(/[ \t]+/g, ' ').trim();
  if (!a || MONEY_RE.test(a)) return null; // prices only come from the rules engine
  if (a.length > MAX_ANSWER_CHARS) {
    const cut = a.slice(0, MAX_ANSWER_CHARS);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('؟'), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    a = end > 100 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  return a;
}

/**
 * What the assistant may know about this insurer, as plain text: its name, coverages and their
 * guarantees, the documents asked, policy duration, how the process works. No tariff, no rule.
 */
function insurerKnowledge(config, { language = 'fr', documentLabels = [], paymentEnabled = false } = {}) {
  const lang = language === 'darija' ? 'fr' : language;
  const pick = (l) => (l && (l[lang] || l.fr || l.en)) || '';
  const lines = [];
  const name = config.branding && config.branding.insurerName;
  if (name) lines.push(`Insurer: ${name}. Product: car (motor) insurance, quote online.`);
  for (const [key, info] of Object.entries(config.coverageInfo || {})) {
    const g = (info.guarantees || []).map(pick).filter(Boolean);
    lines.push(`Coverage "${pick(info.label) || key}"${g.length ? `: ${g.join('; ')}` : ''}.`);
  }
  if (documentLabels.length) lines.push(`Documents asked (photos): ${documentLabels.join(', ')}. They are used only to check the answers.`);
  const p = config.policy || {};
  lines.push(`Policy duration: ${p.durationMonths || 12} months, starting ${p.startOffsetDays ? `${p.startOffsetDays} days after` : 'on the day of'} payment.`);
  lines.push('Process: a few questions, then photos of the documents, then either an estimated premium shown in the chat, or a review by an underwriter who answers in the chat.');
  lines.push(paymentEnabled
    ? `After the customer accepts, a secure payment link is sent${config.payment && config.payment.linkExpiryMinutes ? ` (valid ${Math.round(config.payment.linkExpiryMinutes / 60)} hours)` : ''}; the contract arrives after payment.`
    : 'After the customer accepts, the insurer prepares the contract and follows up.');
  lines.push('The premium depends on the driver, the vehicle and the city; it is only computed from the answers, never estimated in advance.');
  lines.push('The customer can ask for an advisor at any time by writing "conseiller".');
  return lines.join('\n');
}

module.exports = { MAX_DETOURS, DETOUR_KINDS, sanitizeAnswer, insurerKnowledge };
