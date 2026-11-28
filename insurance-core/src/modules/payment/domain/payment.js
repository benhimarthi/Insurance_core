'use strict';

const { CASE_STATUS } = require('../../../shared/cases');

/**
 * Payment rules.
 *   - only a quoted (auto-accepted) or human-approved case, whose customer accepted the premium, can pay
 *   - the amount paid must be exactly the amount asked, in the same currency: otherwise nothing is
 *     issued and a person looks at it
 *   - a still-valid link for the same amount is reused; a new amount or an expired link gets a new one
 */
const PAYABLE_STATUSES = Object.freeze([CASE_STATUS.QUOTED, CASE_STATUS.APPROVED, CASE_STATUS.ADJUSTED, CASE_STATUS.AWAITING_PAYMENT]);
const DEFAULT_LINK_MINUTES = 1440;

const amountsDiffer = (a, b) => Math.abs(Number(a) - Number(b)) > 0.005;
const canReuseLink = (payment, amount, now) => !!payment && payment.status === 'pending' && payment.amount === amount && new Date(payment.expiresAt) > now;
const linkExpiry = (config, now) => new Date(now.getTime() + ((config.payment && config.payment.linkExpiryMinutes) || DEFAULT_LINK_MINUTES) * 60000).toISOString();

module.exports = { PAYABLE_STATUSES, amountsDiffer, canReuseLink, linkExpiry };
