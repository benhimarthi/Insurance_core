'use strict';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

const TEXT = {
  form: { title: 'Paiement sécurisé (démo)', button: 'Payer', note: 'Démonstration : aucun paiement réel n’est effectué.' },
  paid: { title: 'Paiement confirmé', body: 'Merci ! Vous allez recevoir votre contrat sur WhatsApp.' },
  expired: { title: 'Lien expiré', body: 'Ce lien de paiement a expiré. Revenez dans la conversation pour en obtenir un nouveau.' },
  error: { title: 'Une erreur est survenue', body: 'Le paiement n’a pas pu être traité. Réessayez dans un instant.' },
  missing: { title: 'Lien introuvable', body: 'Ce lien de paiement n’existe pas.' },
};

function layout(title, inner, brand) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f6f8;margin:0;padding:24px;color:#1f2933}
.card{max-width:420px;margin:40px auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.demo{background:#ffece6;color:#b3361b;font-size:12px;font-weight:600;padding:8px 10px;border-radius:6px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 12px}.amount{font-size:32px;font-weight:700;margin:12px 0 20px}
button{width:100%;padding:14px;border:0;border-radius:8px;background:#1f4e79;color:#fff;font-size:16px;cursor:pointer}small{color:#616e7c}</style>
</head><body><div class="card"><div class="demo">DÉMONSTRATION - AUCUN PAIEMENT RÉEL</div>
<div><small>${escapeHtml(brand || '')}</small></div>${inner}</div></body></html>`;
}

/** state: form | paid | expired | error | missing */
function renderPayPage({ state, payment, brand }) {
  if (state === 'form') {
    const t = TEXT.form;
    const amount = `${Number(payment.amount).toFixed(2).replace('.', ',')} ${escapeHtml(payment.currency)}`;
    return layout(t.title, `<h1>${t.title}</h1><div class="amount">${amount}</div>
<form method="POST"><button type="submit">${t.button} ${amount}</button></form><p><small>${t.note}</small></p>`, brand);
  }
  const t = TEXT[state] || TEXT.error;
  return layout(t.title, `<h1>${t.title}</h1><p>${t.body}</p>`, brand);
}

module.exports = { renderPayPage, escapeHtml, SECURITY_HEADERS };
