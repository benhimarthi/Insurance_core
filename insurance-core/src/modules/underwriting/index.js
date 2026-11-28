'use strict';

/**
 * Underwriting module: deciding on applications.
 *   - the rules engine (domain/engine.js): eligibility, risk score, premium, referral; pure and audited
 *   - the human side: the review queue, a case in full, its documents, decisions (approve / adjust /
 *     reject within the premium limit) and messages to the customer
 * This file is the composition root and the only public entry point.
 */

const { evaluateCase, evalCondition } = require('./domain/engine');
const { makeCaseQueries } = require('./application/useCases/cases');
const { makeCaseActions } = require('./application/useCases/decide');
const { createUnderwritingController } = require('./interface/underwritingController');
const { DECISIONS } = require('./domain/decision');

/**
 * Ports (application/ports.js): authorize (auth module), store, tenants ({ load }), notifier ({ announce }),
 * delivery (optional), files ({ exists, getSignedUrl }).
 * Every method takes the raw Firebase `auth` ({ uid, token }) as callables receive it.
 */
function createUnderwritingModule({ authorize, store, tenants, notifier, delivery = null, files, now = () => new Date(), logger = console }) {
  if (typeof authorize !== 'function') throw new Error('createUnderwritingModule needs an authorize function (from the auth module).');
  const deps = { authorizer: { authorize }, store, tenants, notifier, delivery, files, clock: { now }, logger };
  const useCases = { ...makeCaseQueries(deps), ...makeCaseActions(deps) };
  const api = {};
  for (const [name, useCase] of Object.entries(useCases)) api[name] = ({ auth, ...rest } = {}) => useCase({ caller: auth, ...rest });
  api.handle = createUnderwritingController(api);
  return api;
}

module.exports = { createUnderwritingModule, evaluateCase, evalCondition, DECISIONS };
