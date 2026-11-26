import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthClient } from '../src/authClient.js';
import { createFakePort, settle } from './helpers.js';

const boot = async (accounts, opts = {}) => {
  const port = createFakePort(accounts);
  const client = createAuthClient({ port, ...opts });
  client.start();
  await settle();
  return { port, client, state: () => client.getState() };
};

test('starts loading, then signed_out when there is no session', async () => {
  const port = createFakePort({});
  const client = createAuthClient({ port });
  assert.equal(client.getState().status, 'loading');
  client.start();
  await settle();
  assert.equal(client.getState().status, 'signed_out');
});

test('password sign-in with a second factor enrolled: challenge, wrong code, right code, ready', async () => {
  const { client, state } = await boot({ 'sara@insurer.example': { password: 'pw', factors: 1, platformRole: 'platform_admin' } });
  await client.signIn('sara@insurer.example', 'pw');
  assert.equal(state().status, 'mfa_challenge');
  assert.deepEqual(state().mfaHints.map((h) => h.factorId), ['totp']);

  await client.completeMfa('000000');
  assert.equal(state().status, 'mfa_challenge'); // stays, so the user can retry
  assert.equal(state().error.reason, 'auth/invalid-verification-code');

  await client.completeMfa('123456');
  await settle();
  assert.equal(state().status, 'ready');
  assert.equal(state().user.email, 'sara@insurer.example');
  assert.equal(state().platformRole, 'platform_admin');
  assert.equal(state().error, null);
});

test('wrong password and unknown account give the same message; limits and network errors are named', async () => {
  const { client, port, state } = await boot({ 'a@x.example': { password: 'pw' } });
  await client.signIn('a@x.example', 'nope');
  const wrong = state().error;
  await client.signIn('ghost@x.example', 'pw');
  assert.equal(state().error.message, wrong.message);
  assert.equal(state().status, 'signed_out');

  port.failNext = { code: 'auth/too-many-requests' };
  await client.signIn('a@x.example', 'pw');
  assert.equal(state().error.reason, 'auth/too-many-requests');
  port.failNext = { code: 'auth/network-request-failed' };
  await client.signIn('a@x.example', 'pw');
  assert.equal(state().error.retryable, true);
});

test('unverified email: guided to verify, then ready after the refresh', async () => {
  const { client, port, state } = await boot({ 'new@x.example': { password: 'pw', emailVerified: false, verifyOnReload: true, factors: 1 } });
  await client.signIn('new@x.example', 'pw'); // second factor first, then the unverified email is caught
  await client.completeMfa('123456');
  await settle();
  assert.equal(state().status, 'needs_email_verification');

  await client.sendVerificationEmail();
  assert.equal(port.calls.verificationEmails, 1);
  assert.equal(state().notice, 'verification_sent');

  await client.refresh(); // reload + token refresh, then re-evaluate
  assert.equal(port.calls.reloads, 1);
  assert.equal(state().status, 'ready');
});

test('MFA enrolment: needed, started, wrong code, finished, then the user signs in again', async () => {
  const { client, port, state } = await boot({ 'e@x.example': { password: 'pw', factors: 0 } });
  await client.signIn('e@x.example', 'pw');
  assert.equal(state().status, 'needs_mfa_enrollment');

  await client.startMfaEnrollment();
  assert.equal(state().enrollment.secretKey, 'JBSWY3DPEHPK3PXP');
  assert.match(state().enrollment.qrUrl, /^otpauth:\/\/totp\//);

  await client.finishMfaEnrollment('111111');
  assert.equal(state().status, 'needs_mfa_enrollment');
  assert.equal(state().error.reason, 'auth/invalid-verification-code');

  await client.finishMfaEnrollment('654321');
  assert.equal(state().status, 'signed_out');
  assert.equal(state().notice, 'mfa_enrolled');
  assert.ok(port.calls.signOuts >= 1);

  await client.signIn('e@x.example', 'pw'); // now a challenge
  assert.equal(state().status, 'mfa_challenge');
});

test('a restored session without a second-factor sign-in is not trusted', async () => {
  const { client, port, state } = await boot({ 'r@x.example': { password: 'pw', factors: 1 } });
  port.restore('r@x.example', false);
  await settle();
  assert.equal(state().status, 'signed_out');
  assert.equal(state().notice, 'mfa_missing');
  port.restore('r@x.example', true);
  await settle();
  assert.equal(state().status, 'ready');
});

test('requireMfa: false lets verified users straight in (early demos)', async () => {
  const { client, state } = await boot({ 'd@x.example': { password: 'pw', factors: 0 } }, { requireMfa: false });
  await client.signIn('d@x.example', 'pw');
  assert.equal(state().status, 'ready');
});

test('sign-up sends the verification email and waits for it', async () => {
  const { client, port, state } = await boot({});
  await client.signUp('invitee@x.example', 'longenough');
  assert.equal(state().status, 'needs_email_verification');
  assert.equal(port.calls.verificationEmails, 1);
  await client.signUp('invitee@x.example', 'longenough');
  assert.equal(state().error.reason, 'auth/email-already-in-use');
});

test('password reset always reports success, except when the network is down', async () => {
  const { client, port, state } = await boot({ 'a@x.example': { password: 'pw' } });
  await client.resetPassword('ghost@x.example');
  assert.equal(state().notice, 'password_reset');           // no way to tell if the account exists
  port.failNext = { code: 'auth/network-request-failed' };
  await client.resetPassword('a@x.example');
  assert.equal(state().error.retryable, true);
});

test('sign-out and cancelling the challenge clear everything; subscribers are notified', async () => {
  const { client, state } = await boot({ 'a@x.example': { password: 'pw', factors: 1 } });
  let notifications = 0;
  const unsubscribe = client.subscribe(() => { notifications += 1; });
  await client.signIn('a@x.example', 'pw');
  client.cancelMfa();
  assert.equal(state().status, 'signed_out');
  assert.equal(await client.completeMfa('123456'), false); // no challenge any more
  await client.signOut('idle_timeout');
  assert.equal(state().notice, 'idle_timeout');
  assert.equal(state().user, null);
  assert.ok(notifications >= 3);
  unsubscribe();
  const before = notifications;
  await client.signOut();
  assert.equal(notifications, before);
});
