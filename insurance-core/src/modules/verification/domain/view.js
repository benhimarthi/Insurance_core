'use strict';

/**
 * Policy verification (the QR code on the PDF): what a link may reveal, and the formats.
 *
 * URL:  {baseUrl}/{tenantId}/{policyNumber}/{code}
 * code: HMAC-SHA256(secret, "tenantId|policyNumber"), first 20 hex chars (80 bits): see
 *       infrastructure/hmacVerifier.js.
 *
 * Why a code: policy numbers are sequential, so without it anyone could walk through
 * POL-...-000001, 000002... and read other customers' details. The code makes each link
 * unguessable, and the verifier checks it BEFORE any database lookup, so a wrong code and an
 * unknown policy look exactly the same (no way to probe which policies exist).
 * Rotating the secret invalidates every printed QR code: treat it like a signing key.
 */

const CODE_LENGTH = 20;
const CODE_RE = new RegExp(`^[0-9a-f]{${CODE_LENGTH}}$`);
const POLICY_NUMBER_RE = /^POL-[A-Z0-9]{1,12}-\d{4}-\d{6}$/;

/** active | not_yet_active | expired | cancelled, from the policy dates (UTC, ISO yyyy-mm-dd). */
function policyState(policy, today) {
  if (policy.status === 'cancelled') return 'cancelled';
  if (today < policy.startDate) return 'not_yet_active';
  if (today > policy.endDate) return 'expired';
  return 'active';
}

/** "Amine Benali" -> "A. B." : enough to recognise the holder, not enough to identify them. */
function initials(fullName) {
  return String(fullName || '').split(/\s+/).filter(Boolean).slice(0, 4)
    .map((t) => `${Array.from(t)[0].toUpperCase()}.`).join(' ');
}

/**
 * The ONLY data a verification link ever reveals: no full name, no premium, no contact details,
 * no documents. The plate is public information (it is on the car).
 */
function publicView(policy, { tenant, today }) {
  const state = policyState(policy, today);
  return {
    valid: state === 'active',
    state,
    insurer: tenant.name,
    policyNumber: policy.policyNumber,
    holderInitials: initials(policy.holder && policy.holder.fullName),
    plate: policy.vehicle && policy.vehicle.plate,
    coverage: policy.coverage,
    startDate: policy.startDate,
    endDate: policy.endDate,
    demo: !!tenant.demo,
  };
}

module.exports = { policyState, publicView, initials, CODE_LENGTH, CODE_RE, POLICY_NUMBER_RE };
