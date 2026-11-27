'use strict';

const { normalizeText } = require('./nlu');

/**
 * What the agent asks, in order. Each question maps to one field of the engine input.
 * Languages: fr, en, darija (Arabic script). Have a native speaker proofread the darija strings.
 */

const L = (fr, en, darija) => ({ fr, en, darija });

const QUESTIONS = [
  {
    path: 'driver.age', type: 'number', min: 14, max: 100, integer: true,
    ask: L('Quel âge avez-vous ?', 'How old are you?', 'شحال عندك فالعمر؟'),
  },
  {
    path: 'driver.licenseYears', type: 'number', min: 0, max: 80,
    ask: L(
      'Depuis combien d’années avez-vous votre permis ? (0 si moins d’un an)',
      'How many years have you held your driving license? (0 if less than a year)',
      'شحال من عام وانت عندك رخصة السياقة؟ (0 إلا كان أقل من عام)'
    ),
  },
  {
    path: 'driver.claimsLast3Years', type: 'number', min: 0, max: 20, integer: true,
    ask: L(
      'Combien de sinistres avez-vous eus ces 3 dernières années ? (0 si aucun)',
      'How many claims have you had in the last 3 years? (0 if none)',
      'شحال من حادثة وقعات ليك فـ 3 سنين لخرين؟ (0 إلا ما كانت حتى وحدة)'
    ),
  },
  {
    path: 'driver.hasSuspension', type: 'boolean',
    ask: L(
      'Votre permis est-il actuellement suspendu ? (oui/non)',
      'Is your license currently suspended? (yes/no)',
      'واش رخصة السياقة ديالك مسحوبة دابا؟ (إيه/لا)'
    ),
  },
  {
    path: 'vehicle.category', type: 'enum',
    ask: L('Quel type de véhicule ?', 'What type of vehicle?', 'شنو نوع الطوموبيل؟'),
    choices: [
      { value: 'compact', keywords: ['citadine', 'compacte', 'compact', 'صغيرة'], labels: L('Citadine / compacte', 'Compact car', 'طوموبيل صغيرة') },
      { value: 'sedan', keywords: ['berline', 'sedan', 'سيدان'], labels: L('Berline', 'Sedan', 'سيدان') },
      { value: 'suv', keywords: ['suv', '4x4', 'جيب'], labels: L('SUV / 4x4', 'SUV / 4x4', 'جيب / 4x4') },
      { value: 'pickup', keywords: ['pick-up', 'pickup', 'pick up', 'بيكوب'], labels: L('Pick-up', 'Pickup', 'بيكوب') },
      { value: 'luxury', keywords: ['luxe', 'luxury', 'premium', 'فاخرة'], labels: L('Luxe', 'Luxury', 'فاخرة') },
    ],
  },
  {
    path: 'vehicle.value', type: 'number', min: 1000, max: 50000000,
    ask: L(
      'Quelle est la valeur approximative du véhicule, en dirhams ?',
      'What is the approximate value of the vehicle, in dirhams?',
      'شحال تقريبا قيمة الطوموبيل بالدرهم؟'
    ),
  },
  {
    path: 'vehicle.ageYears', type: 'number', min: 0, max: 40, integer: true,
    ask: L(
      'Quel âge a le véhicule, en années ? (0 si neuf)',
      'How old is the vehicle, in years? (0 if new)',
      'شحال عندها فالعمر الطوموبيل بالسنين؟ (0 إلا كانت جديدة)'
    ),
  },
  {
    // private_work is listed before private so "personal and commuting" resolves to private_work
    path: 'vehicle.usage', type: 'enum',
    ask: L('Comment utilisez-vous le véhicule ?', 'How do you use the vehicle?', 'فاش كتستعمل الطوموبيل؟'),
    choices: [
      { value: 'private_work', keywords: ['trajet', 'travail', 'domicile', 'commute', 'work', 'الخدمة', 'خدمة'], labels: L('Privé + trajets domicile-travail', 'Private + commuting', 'خاص + الطريق للخدمة') },
      { value: 'private', keywords: ['personnel', 'prive', 'private', 'perso', 'خاص', 'شخصي'], labels: L('Usage privé uniquement', 'Private use only', 'استعمال خاص فقط') },
      { value: 'taxi', keywords: ['taxi', 'طاكسي'], labels: L('Taxi', 'Taxi', 'طاكسي') },
      { value: 'ride_hailing', keywords: ['vtc', 'uber', 'careem', 'indrive', 'ride'], labels: L('VTC / application', 'Ride-hailing app', 'تطبيق نقل (VTC)') },
      { value: 'rental', keywords: ['location', 'louer', 'rental', 'كراء'], labels: L('Location', 'Rental', 'كراء') },
      { value: 'goods_transport', keywords: ['marchandises', 'livraison', 'transport', 'goods', 'delivery', 'توصيل', 'نقل'], labels: L('Transport de marchandises', 'Goods transport', 'نقل البضائع') },
    ],
  },
  {
    path: 'location.city', type: 'text',
    derives: 'location.riskZone',
    derive: (city, config) => {
      const zones = config.zoneMap || {};
      return zones[normalizeText(city)] || zones.default || 'medium';
    },
    ask: L(
      'Dans quelle ville le véhicule est-il principalement utilisé ?',
      'In which city is the vehicle mainly used?',
      'فأي مدينة كتستعمل الطوموبيل أكثر؟'
    ),
  },
  {
    path: 'coverage', type: 'enum',
    ask: L('Quelle formule souhaitez-vous ?', 'Which cover would you like?', 'أش من تغطية بغيتي؟'),
    choices: [
      { value: 'tiers', keywords: ['tiers', 'responsabilite', 'third', 'الغير', 'ضد الغير'], labels: L('Tiers (responsabilité civile)', 'Third party only', 'ضد الغير') },
      { value: 'tous_risques', keywords: ['tous risques', 'tous-risques', 'tout risque', 'comprehensive', 'full', 'شامل'], labels: L('Tous risques', 'Comprehensive', 'شامل') },
    ],
  },
];

// ---------- helpers ----------

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

/** Never trust extractor output (rules or LLM): check type, range and allowed values. */
function validateValue(q, raw) {
  switch (q.type) {
    case 'number': {
      const n = typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw;
      if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false };
      if (n < q.min || n > q.max) return { ok: false };
      if (q.integer && !Number.isInteger(n)) return { ok: false };
      return { ok: true, value: n };
    }
    case 'boolean':
      return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false };
    case 'enum':
      return q.choices.some((c) => c.value === raw) ? { ok: true, value: raw } : { ok: false };
    case 'text': {
      const s = typeof raw === 'string' ? raw.trim() : '';
      return s.length >= 1 && s.length <= 60 ? { ok: true, value: s } : { ok: false };
    }
    default:
      return { ok: false };
  }
}

function formatQuestion(q, lang) {
  let text = q.ask[lang] || q.ask.fr;
  if (q.type === 'enum') {
    text += '\n' + q.choices.map((c, i) => `${i + 1}) ${c.labels[lang] || c.labels.fr}`).join('\n');
  }
  return text;
}

/** Fail fast if a tenant config requires a field that no question collects. */
function assertQuestionsCoverConfig(config) {
  const covered = new Set();
  for (const q of QUESTIONS) {
    covered.add(q.path);
    if (q.derives) covered.add(q.derives);
  }
  const missing = config.requiredFields.filter((f) => !covered.has(f));
  if (missing.length) throw new Error(`No question collects these required fields: ${missing.join(', ')}`);
}

module.exports = { QUESTIONS, getPath, setPath, validateValue, formatQuestion, assertQuestionsCoverConfig };
