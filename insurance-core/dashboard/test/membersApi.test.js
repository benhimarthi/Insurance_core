import test from 'node:test';
import assert from 'node:assert/strict';
import { createMembersApi } from '../src/membersApi.js';
import { createReasonAsker } from '../src/reasonAsker.js';
import { ApiError, normalizeError, describeError, errorText, MESSAGES, NOTICES } from '../src/errors.js';

const recorder = (reply = { ok: true }) => {
  const calls = [];
  return { calls, call: async (name, data) => { calls.push([name, data]); if (reply instanceof Error) throw reply; return reply; } };
};

test('member access: calls go through unchanged, with no reason asked', async () => {
  const { calls, call } = recorder();
  let asked = 0;
  const api = createMembersApi({ call, getContext: () => ({ tenantId: 'alpha-insurer', access: 'member' }), askReason: async () => { asked += 1; return 'x'.repeat(10); } });
  await api.invite('alpha-insurer', { email: 'a@b.example', role: 'auditor' });
  await api.changeRole('alpha-insurer', 'uid1', 'underwriter');
  await api.setStatus('alpha-insurer', 'uid1', 'disabled');
  await api.remove('alpha-insurer', 'uid1');
  await api.list('alpha-insurer');
  await api.revokeInvitation('alpha-insurer', 'inv1');
  assert.equal(asked, 0);
  assert.deepEqual(calls[0], ['members', { tenantId: 'alpha-insurer', action: 'invite', email: 'a@b.example', role: 'auditor' }]);
  assert.deepEqual(calls.map(([n]) => n), Array(6).fill('members'));
});

test('platform access: the person is asked why, before every action, and the reason is sent', async () => {
  const { calls, call } = recorder();
  const asked = [];
  const api = createMembersApi({ call, getContext: () => ({ tenantId: 'zeta-insurer', access: 'platform' }), askReason: async (action) => { asked.push(action); return '  Onboarding the first admin  '; } });
  await api.invite('zeta-insurer', { email: 'a@b.example', role: 'tenant_admin' });
  await api.list('zeta-insurer');
  assert.deepEqual(asked, ['invite', 'list']);
  assert.equal(calls[0][1].reason, 'Onboarding the first admin'); // trimmed
  assert.equal(calls[1][1].reason, 'Onboarding the first admin');
});

test('platform access: cancelling or a too-short reason stops the call; no asker at all is an error', async () => {
  const { calls, call } = recorder();
  const ctx = () => ({ tenantId: 'zeta-insurer', access: 'platform' });
  for (const answer of [null, '', 'ok', '    ']) {
    const api = createMembersApi({ call, getContext: ctx, askReason: async () => answer });
    await assert.rejects(api.remove('zeta-insurer', 'u1'), (e) => e instanceof ApiError && e.reason === 'REASON_CANCELLED');
  }
  await assert.rejects(createMembersApi({ call, getContext: ctx }).remove('zeta-insurer', 'u1'), (e) => e.reason === 'REASON_REQUIRED');
  assert.deepEqual(calls, []); // nothing reached the server
});

test('a reason is only asked for the insurer being acted on, never for sign-in calls', async () => {
  const { calls, call } = recorder();
  let asked = 0;
  const api = createMembersApi({ call, getContext: () => ({ tenantId: 'zeta-insurer', access: 'platform' }), askReason: async () => { asked += 1; return 'a good reason'; } });
  await api.myTenants();
  await api.allTenants();
  await api.accept({ tenantId: 'zeta-insurer', invitationId: 'i', token: 't'.repeat(24) });
  await api.list('other-insurer'); // not the active one: not our business to prompt
  assert.equal(asked, 0);
  assert.equal(calls.length, 4);
});

test('decisions use their own callable', async () => {
  const { calls, call } = recorder({ ok: true, status: 'approved' });
  const api = createMembersApi({ call });
  assert.deepEqual(await api.decide('alpha-insurer', { caseId: 'c1', decision: 'adjust', adjustedPremium: 4200, note: 'n' }), { ok: true, status: 'approved' });
  assert.deepEqual(calls[0], ['underwriterDecision', { tenantId: 'alpha-insurer', caseId: 'c1', decision: 'adjust', adjustedPremium: 4200, note: 'n' }]);
});

test('server errors become ApiErrors with a reason, a message and a next step', async () => {
  const fail = (code, message) => Object.assign(new Error(message), { code: `functions/${code}` });
  const cases = [
    [fail('permission-denied', 'MFA_REQUIRED'), 'MFA_REQUIRED', 'sign_in_again', false],
    [fail('permission-denied', 'EMAIL_NOT_VERIFIED'), 'EMAIL_NOT_VERIFIED', 'verify_email', false],
    [fail('failed-precondition', 'LAST_ADMIN'), 'LAST_ADMIN', null, false],
    [fail('failed-precondition', 'INVITATION_INVALID'), 'INVITATION_INVALID', 'check_invitation', false],
    [fail('permission-denied', 'LIMIT_EXCEEDED'), 'LIMIT_EXCEEDED', null, false],
    [fail('unauthenticated', 'Sign in first.'), 'unauthenticated', 'sign_in_again', false],
    [fail('unavailable', 'x'), 'unavailable', null, true],
    [fail('internal', 'Internal error.'), 'default', null, true],
    [{ code: 'auth/network-request-failed' }, 'auth/network-request-failed', null, true],
    [new Error('???'), 'default', null, false],
  ];
  for (const [err, reason, action, retryable] of cases) {
    const api = createMembersApi({ call: async () => { throw err; } });
    await assert.rejects(api.list('alpha-insurer'), (e) => e instanceof ApiError && e.reason === reason && e.action === action && e.retryable === retryable, reason);
  }
  assert.equal(describeError(fail('permission-denied', 'LAST_ADMIN'), 'en'), MESSAGES.en.LAST_ADMIN);
});

test('messages exist in both languages for every reason; text follows the language shown', () => {
  assert.deepEqual(Object.keys(MESSAGES.fr).sort(), Object.keys(MESSAGES.en).sort());
  assert.deepEqual(Object.keys(NOTICES.fr).sort(), Object.keys(NOTICES.en).sort());
  const err = normalizeError({ code: 'functions/permission-denied', message: 'FORBIDDEN' });
  assert.equal(errorText(err, 'fr'), MESSAGES.fr.FORBIDDEN);
  assert.equal(errorText(err, 'en'), MESSAGES.en.FORBIDDEN);
  assert.equal(errorText(null, 'en'), MESSAGES.en.default);
});

test('reason asker: one question at a time, resolves with the answer', async () => {
  const asker = createReasonAsker();
  let changes = 0;
  asker.subscribe(() => { changes += 1; });
  const first = asker.ask('invite');
  assert.equal(asker.getState().action, 'invite');
  const second = asker.ask('remove'); // replaces the first, which is cancelled
  assert.equal(await first, null);
  asker.resolve('Support for the pilot');
  assert.equal(await second, 'Support for the pilot');
  assert.equal(asker.getState(), null);
  asker.resolve('ignored'); // nothing pending: no effect
  assert.ok(changes >= 3);
});
