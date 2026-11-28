'use strict';

const { formatDate, formatMoney } = require('../../../shared/format');

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const QRCode = require('qrcode');

/**
 * Generates the policy PDF (A4) with pdf-lib: pure JavaScript, no native dependency,
 * so it runs in Cloud Functions. Languages: fr, en (darija customers get French).
 *
 * Limitation: the built-in Helvetica font covers Latin text only. Characters outside it
 * (for example Arabic script) are replaced with "?" instead of crashing. To print Arabic
 * names, embed an Arabic font with pdf-lib + fontkit and handle right-to-left shaping.
 */

const TEXT = {
  fr: {
    docTitle: 'CONDITIONS PARTICULIÈRES - ASSURANCE AUTO',
    demo: 'DOCUMENT DE DÉMONSTRATION - SANS VALEUR CONTRACTUELLE',
    policyNo: 'Contrat n°',
    contract: 'Informations du contrat',
    issuedOn: 'Émis le',
    period: 'Période de garantie',
    status: 'Statut',
    active: 'Actif',
    holder: 'Souscripteur',
    name: 'Nom',
    vehicle: 'Véhicule',
    plate: 'Immatriculation',
    makeModel: 'Marque / modèle',
    coverage: 'Garanties',
    formula: 'Formule',
    premium: 'Prime',
    net: 'Prime nette',
    fee: 'Frais de police',
    total: 'Total payé',
    payment: 'Paiement',
    paymentRef: 'Référence',
    paidOn: 'Payé le',
    notice: 'Ce document est généré automatiquement à des fins de démonstration. Il n’a aucune valeur contractuelle et ne constitue pas une attestation d’assurance. Les montants et les garanties sont illustratifs.',
    verifyCaption: 'Vérifier ce contrat',
    verifyLink: 'Vérification d’authenticité du contrat :',
    page: 'Page',
    from: 'du',
    to: 'au',
  },
  en: {
    docTitle: 'POLICY SCHEDULE - MOTOR INSURANCE',
    demo: 'DEMONSTRATION DOCUMENT - NOT CONTRACTUAL',
    policyNo: 'Policy no.',
    contract: 'Policy details',
    issuedOn: 'Issued on',
    period: 'Period of cover',
    status: 'Status',
    active: 'Active',
    holder: 'Policyholder',
    name: 'Name',
    vehicle: 'Vehicle',
    plate: 'Registration plate',
    makeModel: 'Make / model',
    coverage: 'Cover',
    formula: 'Plan',
    premium: 'Premium',
    net: 'Net premium',
    fee: 'Policy fee',
    total: 'Total paid',
    payment: 'Payment',
    paymentRef: 'Reference',
    paidOn: 'Paid on',
    notice: 'This document is generated automatically for demonstration purposes. It has no contractual value and is not a certificate of insurance. Amounts and cover are illustrative.',
    verifyCaption: 'Verify this policy',
    verifyLink: 'Authenticity check of this policy:',
    page: 'Page',
    from: 'from',
    to: 'to',
  },
};

const A4 = [595.28, 841.89];
const MARGIN = 50;

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = parseInt(m ? m[1] : '1F4E79', 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}


/**
 * @param policy    record returned by PolicyAdminAdapter (draft fields + policyNumber)
 * @param payment   { paymentId, paidAt }
 * @param branding  { insurerName, primaryColor }
 * @param coverageInfo  { [coverageKey]: { label: {fr,en}, guarantees: [{fr,en}] } }
 * @param verification  optional { url }: adds a QR code (vector) and the link
 *                      that lets anyone check the policy (see src/verification)
 * @returns Promise<Uint8Array>
 */
async function generatePolicyPdf({ policy, payment, branding = {}, coverageInfo = {}, verification = null, language = 'fr' }) {
  const lang = TEXT[language] ? language : 'fr';
  const T = TEXT[lang];

  const doc = await PDFDocument.create();
  doc.setTitle(`${T.docTitle} ${policy.policyNumber}`);
  doc.setSubject(`${T.policyNo} ${policy.policyNumber}`);
  doc.setCreator(branding.insurerName || 'Insurer');
  doc.setProducer('insurance-core demo');
  doc.setCreationDate(new Date(policy.issuedAt)); // deterministic output

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(font.getCharacterSet());
  const safe = (s) => Array.from(String(s).replace(/[\u00A0\u2007\u202F]/g, ' '))
    .map((ch) => (charset.has(ch.codePointAt(0)) ? ch : '?')).join('');

  const primary = hexToRgb(branding.primaryColor);
  const ink = rgb(0.12, 0.12, 0.14);
  const gray = rgb(0.45, 0.45, 0.5);
  const white = rgb(1, 1, 1);
  const [W, H] = A4;

  let page;
  let y;
  let gutter = null; // { yTop, yBottom, width }: area reserved on the right for the QR code
  const rightLimit = () => (gutter && y <= gutter.yTop && y >= gutter.yBottom ? W - MARGIN - gutter.width : W - MARGIN);
  const newPage = () => { page = doc.addPage(A4); y = H - MARGIN; gutter = null; };
  const ensure = (h) => { if (y - h < MARGIN + 30) newPage(); };
  const draw = (str, x, size, f = font, color = ink) => page.drawText(safe(str), { x, y, size, font: f, color });
  const widthOf = (str, size, f = font) => f.widthOfTextAtSize(safe(str), size);

  function wrap(str, size, f, maxWidth) {
    const lines = [];
    let line = '';
    for (const word of String(str).split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (widthOf(test, size, f) > maxWidth && line) { lines.push(line); line = word; } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }

  function paragraph(str, { size = 10, f = font, x = MARGIN, color = ink } = {}) {
    for (const line of wrap(str, size, f, rightLimit() - x)) {
      ensure(size * 1.5);
      draw(line, x, size, f, color);
      y -= size * 1.5;
    }
  }

  function section(title) {
    ensure(50);
    y -= 12;
    draw(title.toUpperCase(), MARGIN, 10, bold, primary);
    y -= 6;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: rightLimit(), y }, thickness: 0.8, color: primary });
    y -= 16;
  }

  function row(label, value) {
    ensure(20);
    draw(label, MARGIN, 9, font, gray);
    const valueX = MARGIN + 170;
    const lines = wrap(value, 11, font, rightLimit() - valueX);
    for (const line of lines) { draw(line, valueX, 11); y -= 16; }
  }

  function money(label, amount, strong = false) {
    ensure(20);
    const text = formatMoney(amount, policy.premium.currency, lang);
    const f = strong ? bold : font;
    draw(label, MARGIN, strong ? 11 : 10, f);
    draw(text, W - MARGIN - widthOf(text, strong ? 11 : 10, f), strong ? 11 : 10, f);
    y -= 18;
  }

  // ----- page 1: header band -----
  newPage();
  page.drawRectangle({ x: 0, y: H - 95, width: W, height: 95, color: primary });
  y = H - 42;
  draw(branding.insurerName || 'Insurer', MARGIN, 20, bold, white);
  y = H - 64;
  draw(T.docTitle, MARGIN, 10, font, white);
  const numberText = `${T.policyNo} ${policy.policyNumber}`;
  y = H - 42;
  draw(numberText, W - MARGIN - widthOf(numberText, 12, bold), 12, bold, white);

  y = H - 95 - 16;
  page.drawRectangle({ x: MARGIN, y: y - 8, width: W - 2 * MARGIN, height: 22, color: rgb(1, 0.93, 0.9) });
  draw(T.demo, MARGIN + 10, 9, bold, rgb(0.7, 0.2, 0.1));
  y -= 20;

  // ----- QR code (top right, beside the contract details) -----
  if (verification && verification.url) {
    const qr = QRCode.create(verification.url, { errorCorrectionLevel: 'M' });
    const modules = qr.modules.size;
    const quiet = 4; // quiet zone required by the QR spec, in modules
    const cell = Math.max(1.9, Math.min(2.6, 100 / (modules + 2 * quiet)));
    const box = (modules + 2 * quiet) * cell;
    const x0 = W - MARGIN - box;
    const top = y;
    // vector QR: one rectangle per horizontal run of dark modules (sharp at any print size)
    for (let r = 0; r < modules; r += 1) {
      let c = 0;
      while (c < modules) {
        if (!qr.modules.get(r, c)) { c += 1; continue; }
        let end = c;
        while (end + 1 < modules && qr.modules.get(r, end + 1)) end += 1;
        page.drawRectangle({ x: x0 + (quiet + c) * cell, y: top - (quiet + r + 1) * cell, width: (end - c + 1) * cell, height: cell, color: rgb(0, 0, 0) });
        c = end + 1;
      }
    }
    const caption = safe(T.verifyCaption);
    page.drawText(caption, { x: x0 + (box - font.widthOfTextAtSize(caption, 7)) / 2, y: top - box + 2, size: 7, font, color: gray });
    gutter = { yTop: top, yBottom: top - box - 4, width: box + 16 };
  }

  // ----- body -----
  section(T.contract);
  row(T.policyNo, policy.policyNumber);
  row(T.issuedOn, formatDate(policy.issuedAt.slice(0, 10)));
  row(T.period, `${T.from} ${formatDate(policy.startDate)} ${T.to} ${formatDate(policy.endDate)}`);
  row(T.status, T.active);

  section(T.holder);
  row(T.name, policy.holder.fullName);

  section(T.vehicle);
  row(T.plate, policy.vehicle.plate);
  const makeModel = [policy.vehicle.make, policy.vehicle.model].filter(Boolean).join(' ');
  if (makeModel) row(T.makeModel, makeModel);

  const info = coverageInfo[policy.coverage];
  section(T.coverage);
  row(T.formula, info ? (info.label[lang] || info.label.fr) : policy.coverage);
  if (info) {
    y -= 2;
    for (const g of info.guarantees) paragraph(`•  ${g[lang] || g.fr}`, { x: MARGIN + 10 });
  }

  section(T.premium);
  money(T.net, policy.premium.net);
  money(T.fee, policy.premium.fee);
  page.drawLine({ start: { x: MARGIN, y: y + 10 }, end: { x: W - MARGIN, y: y + 10 }, thickness: 0.5, color: gray });
  y -= 4;
  money(T.total, policy.premium.total, true);

  if (payment) {
    section(T.payment);
    row(T.paymentRef, payment.paymentId);
    if (payment.paidAt) row(T.paidOn, formatDate(payment.paidAt.slice(0, 10)));
  }

  y -= 10;
  paragraph(T.notice, { size: 8, color: gray });
  if (verification && verification.url) {
    y -= 4;
    paragraph(T.verifyLink, { size: 7, color: gray });
    paragraph(verification.url, { size: 7, color: gray });
  }

  // ----- footer on every page -----
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(safe(`${T.demo}   |   ${T.page} ${i + 1}/${pages.length}`), { x: MARGIN, y: 28, size: 8, font, color: gray });
  });

  return doc.save();
}

module.exports = { generatePolicyPdf, formatMoney, formatDate };
