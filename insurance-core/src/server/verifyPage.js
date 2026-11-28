'use strict';

const { escapeHtml } = require('../shared/format');
// Same base as the demo checkout page: nothing loads but inline styles, no framing, no caching.
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

const T = {
  fr: {
    states: { active: 'Contrat valide', expired: 'Contrat expiré', not_yet_active: 'Contrat pas encore en vigueur', cancelled: 'Contrat annulé', not_found: 'Contrat introuvable' },
    insurer: 'Assureur', policy: 'Contrat n°', holder: 'Souscripteur', plate: 'Immatriculation', cover: 'Formule', period: 'Période de garantie',
    from: 'du', to: 'au',
    check: 'Comparez ces informations avec le document présenté et le véhicule.',
    missing: 'Ce lien ne correspond à aucun contrat. Le document est peut-être falsifié, ou le lien est incomplet.',
    demo: 'DÉMONSTRATION - contrat fictif',
  },
  en: {
    states: { active: 'Valid policy', expired: 'Expired policy', not_yet_active: 'Policy not yet in force', cancelled: 'Cancelled policy', not_found: 'Policy not found' },
    insurer: 'Insurer', policy: 'Policy no.', holder: 'Policyholder', plate: 'Registration plate', cover: 'Plan', period: 'Period of cover',
    from: 'from', to: 'to',
    check: 'Compare this information with the document shown and the vehicle.',
    missing: 'This link does not match any policy. The document may be forged, or the link is incomplete.',
    demo: 'DEMONSTRATION - fictitious policy',
  },
};

const COLORS = { active: '#1b7f3b', expired: '#b3361b', not_yet_active: '#b7791f', cancelled: '#b3361b', not_found: '#b3361b' };
const fmtDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const HEADERS = { ...SECURITY_HEADERS, 'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer' };

function page(lang, inner) {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(T[lang].states.active.split(' ')[0])}</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f6f8;margin:0;padding:20px;color:#1f2933}
.card{max-width:440px;margin:24px auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.badge{display:inline-block;color:#fff;font-weight:700;padding:8px 14px;border-radius:999px;margin-bottom:16px}
.demo{background:#ffece6;color:#b3361b;font-size:12px;font-weight:600;padding:8px 10px;border-radius:6px;margin-bottom:14px}
dl{margin:0}dt{font-size:12px;color:#616e7c;margin-top:12px}dd{margin:2px 0 0;font-size:16px}small{color:#616e7c;display:block;margin-top:18px}</style>
</head><body><div class="card">${inner}</div></body></html>`;
}

/** view: result of publicView(), or null for not found. coverageLabel: optional human label. */
function renderVerifyPage({ view, lang = 'fr', coverageLabel }) {
  const t = T[lang] || T.fr;
  const l = T[lang] ? lang : 'fr';
  if (!view) {
    return page(l, `<span class="badge" style="background:${COLORS.not_found}">${t.states.not_found}</span><p>${t.missing}</p>`);
  }
  const row = (label, value) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`;
  return page(l, `${view.demo ? `<div class="demo">${t.demo}</div>` : ''}
<span class="badge" style="background:${COLORS[view.state]}">${t.states[view.state]}</span>
<dl>${row(t.insurer, view.insurer)}${row(t.policy, view.policyNumber)}${row(t.holder, view.holderInitials)}${row(t.plate, view.plate)}
${row(t.cover, coverageLabel || view.coverage)}${row(t.period, `${t.from} ${fmtDate(view.startDate)} ${t.to} ${fmtDate(view.endDate)}`)}</dl>
<small>${t.check}</small>`);
}

module.exports = { renderVerifyPage, VERIFY_HEADERS: HEADERS };
