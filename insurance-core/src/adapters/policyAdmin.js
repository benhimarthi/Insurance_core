'use strict';

/**
 * PolicyAdminAdapter interface (the insurer's core system owns policy numbering and records):
 *   createPolicy(draft) -> Promise<policy>      draft + { policyNumber }
 *   getPolicy(tenantId, policyNumber) -> Promise<policy | null>
 * createPolicy MUST be idempotent on draft.idempotencyKey (payment webhooks get redelivered).
 */
function createMockPolicyAdmin() {
  const byKey = new Map();
  const byNumber = new Map();
  const counters = new Map();

  return {
    async createPolicy(draft) {
      if (byKey.has(draft.idempotencyKey)) return byKey.get(draft.idempotencyKey);
      const year = draft.issuedAt.slice(0, 4);
      const counterKey = `${draft.numberPrefix}-${year}`;
      const seq = (counters.get(counterKey) || 0) + 1;
      counters.set(counterKey, seq);
      const policy = { ...draft, policyNumber: `POL-${draft.numberPrefix}-${year}-${String(seq).padStart(6, '0')}`, status: 'active' };
      byKey.set(draft.idempotencyKey, policy);
      byNumber.set(policy.policyNumber, policy);
      return policy;
    },
    async getPolicy(tenantId, policyNumber) {
      const p = byNumber.get(policyNumber);
      return p && p.tenantId === tenantId ? p : null;
    },
    count: () => byNumber.size,
  };
}

module.exports = { createMockPolicyAdmin };
