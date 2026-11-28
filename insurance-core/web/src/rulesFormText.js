// Texts of the rules form, and the words used to show conditions in plain language.
const FR = {
  views: { form: 'Formulaire', json: 'JSON' },
  jsonFirst: 'Le JSON contient une erreur : corrigez-la dans la vue JSON pour revenir au formulaire.',
  showJson: 'Ouvrir la vue JSON',
  conditionsHint: 'Pour ajouter une règle ou modifier une condition, utilisez la vue JSON.',
  sections: {
    general: 'Général', pricing: 'Tarif', multipliers: 'Majorations et réductions', risk: 'Score de risque', eligibility: 'Éligibilité',
    zones: 'Zones géographiques', documents: 'Documents', policy: 'Contrat et paiement', limits: 'Limites et escalade',
  },
  f: {
    version: 'Version du tarif (votre libellé)', currency: 'Devise (code à 3 lettres)', insurerName: 'Nom affiché aux clients', primaryColor: 'Couleur principale',
    base: 'Prime de base', valueRate: 'Taux sur la valeur du véhicule (0,012 = 1,2 %)', policyFee: 'Frais de police', bandLoading: 'Coefficient par niveau de risque',
    label: 'Libellé', factor: 'Coefficient (1,10 = +10 %)', points: 'Points', referAt: 'Seuil de transmission à un souscripteur', refuseAt: 'Seuil de refus',
    bands: 'Niveaux de risque (score maximum de chaque niveau)', outcome: 'Résultat', message: 'Message', condition: 'Condition',
    city: 'Ville', zone: 'Zone', defaultZone: 'Zone par défaut (autres villes)', addCity: 'Ajouter une ville', remove: 'Retirer',
    required: 'Documents demandés', resubmitBelow: 'Redemander si lisibilité sous (0 à 1)', maxResubmits: 'Nombre maximum de nouvelles demandes',
    ageTolerance: 'Écart d’âge toléré (ans)', vehicleAgeTolerance: 'Écart d’âge du véhicule toléré (ans)', nameSimilarityMin: 'Ressemblance minimale des noms (0 à 1)',
    numberPrefix: 'Préfixe des numéros de contrat', durationMonths: 'Durée du contrat (mois)', startOffsetDays: 'Début du contrat (jours après le paiement)',
    linkExpiryMinutes: 'Validité du lien de paiement (minutes)', underwriterPremiumLimit: 'Prime maximale décidée par un souscripteur', maxAutoVehicleValue: 'Valeur du véhicule au-delà de laquelle un souscripteur décide',
    minConfidence: 'Confiance minimale de l’analyse automatique (0 à 1)', autoDecline: 'Refuser automatiquement (sinon transmettre à un souscripteur)',
  },
  outcomes: { refuse: 'Refus', refer: 'Transmis à un souscripteur' },
  docTypes: { national_id: 'Carte d’identité', vehicle_registration: 'Carte grise' },
  fields: {
    'driver.age': 'Âge du conducteur', 'driver.licenseYears': 'Années de permis', 'driver.claimsLast3Years': 'Sinistres (3 dernières années)',
    'driver.hasSuspension': 'Permis suspendu', 'vehicle.category': 'Catégorie du véhicule', 'vehicle.value': 'Valeur du véhicule',
    'vehicle.ageYears': 'Âge du véhicule', 'vehicle.usage': 'Usage du véhicule', 'location.city': 'Ville', 'location.riskZone': 'Zone', coverage: 'Garantie',
  },
  ops: { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'est l’un de', nin: 'n’est aucun de' },
  words: { and: 'et', or: 'ou', not: 'non', yes: 'oui', no: 'non' },
  values: {
    compact: 'citadine', sedan: 'berline', suv: 'SUV', pickup: 'pick-up', luxury: 'luxe',
    private_work: 'privé + trajets travail', private: 'privé', taxi: 'taxi', ride_hailing: 'VTC', rental: 'location', goods_transport: 'transport de marchandises',
    very_high: 'très élevée', high: 'élevée', medium: 'moyenne', low: 'faible', tiers: 'tiers', tous_risques: 'tous risques',
  },
};

const EN = {
  views: { form: 'Form', json: 'JSON' },
  jsonFirst: 'The JSON has an error: fix it in the JSON view to come back to the form.',
  showJson: 'Open the JSON view',
  conditionsHint: 'To add a rule or change a condition, use the JSON view.',
  sections: {
    general: 'General', pricing: 'Tariff', multipliers: 'Loadings and discounts', risk: 'Risk score', eligibility: 'Eligibility',
    zones: 'Geographic zones', documents: 'Documents', policy: 'Policy and payment', limits: 'Limits and escalation',
  },
  f: {
    version: 'Tariff version (your label)', currency: 'Currency (3-letter code)', insurerName: 'Name shown to customers', primaryColor: 'Main color',
    base: 'Base premium', valueRate: 'Rate on the vehicle value (0.012 = 1.2%)', policyFee: 'Policy fee', bandLoading: 'Factor per risk level',
    label: 'Label', factor: 'Factor (1.10 = +10%)', points: 'Points', referAt: 'Threshold to refer to an underwriter', refuseAt: 'Refusal threshold',
    bands: 'Risk levels (maximum score of each level)', outcome: 'Outcome', message: 'Message', condition: 'Condition',
    city: 'City', zone: 'Zone', defaultZone: 'Default zone (other cities)', addCity: 'Add a city', remove: 'Remove',
    required: 'Documents requested', resubmitBelow: 'Ask again if legibility is below (0 to 1)', maxResubmits: 'Maximum number of new requests',
    ageTolerance: 'Tolerated age gap (years)', vehicleAgeTolerance: 'Tolerated vehicle age gap (years)', nameSimilarityMin: 'Minimum name similarity (0 to 1)',
    numberPrefix: 'Policy number prefix', durationMonths: 'Policy duration (months)', startOffsetDays: 'Policy start (days after payment)',
    linkExpiryMinutes: 'Payment link validity (minutes)', underwriterPremiumLimit: 'Highest premium an underwriter may decide', maxAutoVehicleValue: 'Vehicle value above which an underwriter decides',
    minConfidence: 'Minimum confidence of the automatic analysis (0 to 1)', autoDecline: 'Refuse automatically (otherwise refer to an underwriter)',
  },
  outcomes: { refuse: 'Refuse', refer: 'Refer to an underwriter' },
  docTypes: { national_id: 'National ID card', vehicle_registration: 'Vehicle registration' },
  fields: {
    'driver.age': 'Driver age', 'driver.licenseYears': 'Years of license', 'driver.claimsLast3Years': 'Claims (last 3 years)',
    'driver.hasSuspension': 'License suspended', 'vehicle.category': 'Vehicle category', 'vehicle.value': 'Vehicle value',
    'vehicle.ageYears': 'Vehicle age', 'vehicle.usage': 'Vehicle usage', 'location.city': 'City', 'location.riskZone': 'Zone', coverage: 'Coverage',
  },
  ops: { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'is one of', nin: 'is none of' },
  words: { and: 'and', or: 'or', not: 'not', yes: 'yes', no: 'no' },
  values: {
    compact: 'compact', sedan: 'sedan', suv: 'SUV', pickup: 'pickup', luxury: 'luxury',
    private_work: 'private + commuting', private: 'private', taxi: 'taxi', ride_hailing: 'ride-hailing', rental: 'rental', goods_transport: 'goods transport',
    very_high: 'very high', high: 'high', medium: 'medium', low: 'low', tiers: 'third party', tous_risques: 'comprehensive',
  },
};

export const formText = (lang) => (lang === 'en' ? EN : FR);

/** A condition of the rules engine in plain language: "Driver age < 25 and Zone = high". */
export function describeCondition(cond, lang, depth = 0) {
  const x = formText(lang);
  if (!cond || typeof cond !== 'object') return '?';
  const wrap = (s) => (depth > 0 ? `(${s})` : s);
  if (Array.isArray(cond.all)) return wrap(cond.all.map((c) => describeCondition(c, lang, depth + 1)).join(` ${x.words.and} `));
  if (Array.isArray(cond.any)) return wrap(cond.any.map((c) => describeCondition(c, lang, depth + 1)).join(` ${x.words.or} `));
  if (cond.not) return `${x.words.not} ${describeCondition(cond.not, lang, depth + 1)}`;
  const v = (val) => (val === true ? x.words.yes : val === false ? x.words.no : x.values[val] || String(val));
  const value = Array.isArray(cond.value) ? cond.value.map(v).join(', ') : v(cond.value);
  return `${x.fields[cond.field] || cond.field} ${x.ops[cond.op] || cond.op} ${value}`;
}

export const valueLabel = (lang, val) => formText(lang).values[val] || val;
