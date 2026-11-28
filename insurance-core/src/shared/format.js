'use strict';

/** Display helpers shared by the modules that talk to customers (chat, PDF, pages). */

/** "2026-11-21" -> "21/11/2026" */
const formatDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** 3696 -> "3 696,00 MAD" (fr) or "MAD 3,696.00" (en) */
function formatMoney(amount, currency, lang) {
  const [int, dec] = Number(amount).toFixed(2).split('.');
  if (lang === 'en') return `${currency} ${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${dec} ${currency}`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = { formatDate, formatMoney, escapeHtml };
