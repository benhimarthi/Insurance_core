'use strict';

/**
 * Verification module: the QR code on each policy and the public page it opens.
 *   - what a link may reveal (domain/view.js): insurer, number, holder initials, plate, plan, period,
 *     state (valid / expired / not yet in force / cancelled); never the name, premium or contacts
 *   - unguessable links (infrastructure/hmacVerifier.js), checked before any read
 * The policy module prints verifier.url(policy) as the QR code; this module answers the scans.
 * This file is the composition root and the only public entry point.
 */

const { makeVerifyPolicy } = require('./application/useCases/verifyPolicy');
const { createVerifyHttp } = require('./interface/http');
const { createVerifier } = require('./infrastructure/hmacVerifier');
const { policyState, publicView, initials, CODE_RE, POLICY_NUMBER_RE } = require('./domain/view');

/** Ports: verifier (createVerifier), tenants ({ load }), policies ({ getPolicy } of the policy module). */
function createVerificationModule({ verifier, tenants, policies, now = () => new Date() }) {
  const verifyPolicy = makeVerifyPolicy({ verifier, tenants, policies, clock: { now } });
  return { verifyPolicy, handleVerify: createVerifyHttp(verifyPolicy) };
}

module.exports = { createVerificationModule, createVerifier, policyState, publicView, initials, CODE_RE, POLICY_NUMBER_RE };
