'use strict';

const { AppError } = require('../../../shared/errors');

/**
 * The `members` callable: one endpoint, { action, ...fields }. Maps each action to a use case of
 * the module's API (which takes the raw Firebase `auth`). Adding an action = one line here.
 */
function createMembersController(api) {
  const actions = {
    myTenants: ({ auth }) => api.myTenants({ auth }),
    allTenants: ({ auth }) => api.allTenants({ auth }),
    list: ({ common }) => api.listMembers(common),
    invite: ({ common, d }) => api.invite({ ...common, email: d.email, role: d.role }),
    accept: ({ auth, d }) => api.acceptInvitation({ auth, tenantId: d.tenantId, invitationId: d.invitationId, token: d.token }),
    revokeInvitation: ({ common, d }) => api.revokeInvitation({ ...common, invitationId: d.invitationId }),
    changeRole: ({ common, d }) => api.changeRole({ ...common, uid: d.uid, role: d.role }),
    setStatus: ({ common, d }) => api.setStatus({ ...common, uid: d.uid, status: d.status }),
    remove: ({ common, d }) => api.removeMember({ ...common, uid: d.uid }),
  };

  return async function handle({ auth, data }) {
    const d = data || {};
    const action = Object.prototype.hasOwnProperty.call(actions, d.action) ? actions[d.action] : null;
    if (!action) throw new AppError('invalid-argument', 'Unknown action.');
    return action({ auth, d, common: { auth, tenantId: d.tenantId, reason: d.reason } });
  };
}

module.exports = { createMembersController };
