'use strict';

/**
 * Lightweight rule-based NLU used by the mock extractor and by the flow
 * (language detection, yes/no, "talk to a human"). Works offline, so demos never break.
 * An LLM extractor can replace the field extraction; these helpers stay as a fallback.
 */

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function normalizeText(s) {
  return String(s)
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .normalize('NFD')
    .replace(/\p{M}/gu, '') // accents and Arabic diacritics (also folds أ to ا)
    .toLowerCase()
    .trim();
}

function tokenize(s) {
  return normalizeText(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const hasAny = (tokens, words) => words.some((w) => tokens.includes(normalizeText(w)));

function detectLanguage(message) {
  if (/[\u0600-\u06FF]/.test(message)) return 'darija';
  const tokens = tokenize(message);
  if (hasAny(tokens, ['bghit', 'bghiti', 'wach', 'tomobil', 'taamine', 'salam'])) return 'darija';
  const en = ['hello', 'hi', 'insurance', 'car', 'quote', 'want', 'need', 'my', 'i'];
  const fr = ['bonjour', 'salut', 'assurance', 'voiture', 'devis', 'je', 'veux', 'besoin', 'ma', 'une'];
  const enScore = tokens.filter((t) => en.includes(t)).length;
  const frScore = tokens.filter((t) => fr.includes(t)).length;
  return enScore > frScore ? 'en' : 'fr';
}

const YES = ['oui', 'yes', 'yep', 'y', 'ouais', 'ok', 'okay', 'wah', 'wakha', 'نعم', 'اه', 'ايه', 'واه', 'واخا'];
const NO = ['non', 'no', 'nope', 'lla', 'machi', 'ماشي', 'لا', 'لاه'];

/** true | false | undefined (unclear) */
function parseBoolean(message) {
  const tokens = tokenize(message);
  const yes = hasAny(tokens, YES);
  const no = hasAny(tokens, NO);
  if (yes === no) return undefined;
  return yes;
}

const ZERO_WORDS = ['aucun', 'aucune', 'zero', 'none', 'no', 'non', 'never', 'jamais', 'walo', 'والو', 'صفر'];

/** Returns a number, or undefined. Handles "120 000", "120,000", "1,5", "120k", Arabic digits, "none". */
function parseNumber(message) {
  let s = normalizeText(message);
  s = s.replace(/(?<=\d)[\s\u00a0,](?=\d{3}(?!\d))/g, ''); // thousands separators
  s = s.replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2');           // decimal comma
  const m = s.match(/(\d+(?:\.\d+)?)\s*(k|mille)?\b/);
  if (m) return Number(m[1]) * (m[2] ? 1000 : 1);
  if (hasAny(tokenize(message), ZERO_WORDS)) return 0;
  return undefined;
}

/** Match a choice by its number ("2") or by any keyword. Returns the choice value or undefined. */
function parseChoice(choices, message) {
  const text = normalizeText(message);
  if (/^\d+$/.test(text)) {
    const choice = choices[Number(text) - 1];
    return choice ? choice.value : undefined;
  }
  for (const c of choices) {
    if (c.keywords.some((k) => text.includes(normalizeText(k)))) return c.value;
  }
  return undefined;
}

const HUMAN_WORDS = ['conseiller', 'conseillere', 'humain', 'agent', 'human', 'advisor', 'person', 'مستشار', 'موظف'];
function wantsHuman(message) {
  return hasAny(tokenize(message), HUMAN_WORDS);
}

module.exports = { normalizeText, tokenize, detectLanguage, parseBoolean, parseNumber, parseChoice, wantsHuman };
