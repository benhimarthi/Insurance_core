// Framework-neutral core. React bindings: "insurance-dashboard-auth/react". Firebase wiring: "./firebase".
export { createAuthClient } from './authClient.js';
export { createTenantStore } from './tenantStore.js';
export { createMembersApi } from './membersApi.js';
export { createReasonAsker } from './reasonAsker.js';
export { createIdleTimer } from './idleTimer.js';
export { buildInviteLink, parseInviteLink, createInviteKeeper, redeemPendingInvite } from './invitations.js';
export { ApiError, normalizeError, describeError, errorText, MESSAGES, NOTICES } from './errors.js';
export { ROLE_LABELS, TEXT, t, roleLabel } from './i18n.js';
