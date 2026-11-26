import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInviteLink, parseInviteLink, createInviteKeeper, redeemPendingInvite } from '../src/invitations.js';
import { createIdleTimer } from '../src/idleTimer.js';
import { ApiError } from '../src/errors.js';
import { createFakeWindow, createFakeApi, member } from './helpers.js';
import { createTenantStore } from '../src/tenantStore.js';

const invite = { tenantId: 'alpha-insurer', invitationId: 'abc123DEF', token: 'T0kenT0kenT0kenT0ken_-xyz' };

test('invitation links carry the secret in the fragment and round-trip', () => {
  const link = buildInviteLink('https://dash.example/invite?x=1#old', invite);
  assert.ok(link.startsWith('https://dash.example/invite#'));
  assert.ok(!link.includes('?'), 'no query string: only the fragment is kept out of server logs');
  assert.deepEqual(parseInviteLink(link), invite);
  assert.deepEqual(parseInviteLink(new URL(link).hash), invite);
});

test('malformed or tampered links are rejected', () => {
  const bad = [
    '', null, undefined, '#', '#t=alpha-insurer', '#t=Alpha&i=abc&k=' + 'a'.repeat(24),
    '#t=alpha-insurer&i=a/b&k=' + 'a'.repeat(24), '#t=alpha-insurer&i=abc&k=short',
    '#t=../etc&i=abc&k=' + 'a'.repeat(24), '#t=alpha-insurer&i=abc&k=' + 'a'.repeat(200),
    '#t=alpha-insurer&i=abc&k=' + '<script>alert(1)</script>',
  ];
  for (const input of bad) assert.equal(parseInviteLink(input), null, String(input));
});

test('keeper: captures once, hides the token from the address bar, survives the login redirect', () => {
  const win = createFakeWindow(new URL(buildInviteLink('https://dash.example/invite', invite)).hash);
  const keeper = createInviteKeeper({ win });
  assert.deepEqual(keeper.capture(), invite);
  assert.equal(win.location.hash, '');
  assert.deepEqual(win.history.calls[0], [null, '', '/invite']);
  assert.deepEqual(keeper.capture(), invite); // a reload without the fragment still finds it
  assert.deepEqual(keeper.pending(), invite);
  keeper.clear();
  assert.equal(keeper.pending(), null);
  assert.equal(createInviteKeeper({ win: createFakeWindow('#nothing') }).capture(), null);
});

test('keeper copes with blocked storage', () => {
  const win = createFakeWindow(new URL(buildInviteLink('https://dash.example/invite', invite)).hash);
  win.sessionStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const keeper = createInviteKeeper({ win });
  assert.deepEqual(keeper.capture(), invite);
  assert.equal(keeper.pending(), null);
  assert.doesNotThrow(() => keeper.clear());
});

test('redeeming: accepts, reloads insurers and opens the new one', async () => {
  const win = createFakeWindow(new URL(buildInviteLink('https://dash.example/invite', invite)).hash);
  const keeper = createInviteKeeper({ win });
  keeper.capture();
  const api = createFakeApi({ memberships: [member('other-insurer', 'Other')] });
  const store = createTenantStore({ api });
  await store.load('u1');
  assert.equal(store.getState().activeTenantId, 'other-insurer');

  assert.deepEqual(await redeemPendingInvite({ api, store, keeper }), { tenantId: 'alpha-insurer' });
  assert.equal(keeper.pending(), null);
  assert.equal(store.getState().activeTenantId, 'alpha-insurer');
  assert.equal(store.getState().choices.length, 2);
  assert.equal(await redeemPendingInvite({ api, store, keeper }), null); // nothing left to redeem
});

test('redeeming: a definitive failure clears the invitation, a network failure keeps it for a retry', async () => {
  const win = createFakeWindow(new URL(buildInviteLink('https://dash.example/invite', invite)).hash);
  const keeper = createInviteKeeper({ win });
  keeper.capture();
  const api = createFakeApi();
  const store = createTenantStore({ api });
  await store.load('u1');

  api.acceptError = new ApiError({ code: 'unavailable', reason: 'unavailable', message: 'x', retryable: true });
  await assert.rejects(redeemPendingInvite({ api, store, keeper }), (e) => e.retryable);
  assert.deepEqual(keeper.pending(), invite);

  api.acceptError = new ApiError({ code: 'failed-precondition', reason: 'INVITATION_INVALID', message: 'x', retryable: false });
  await assert.rejects(redeemPendingInvite({ api, store, keeper }), (e) => e.reason === 'INVITATION_INVALID');
  assert.equal(keeper.pending(), null);
});

test('idle timer: fires after the timeout, activity postpones it, stop cancels it', () => {
  let now = 0;
  const timers = new Map();
  let id = 0;
  const setTimer = (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; };
  const clearTimer = (h) => timers.delete(h);
  const advance = (ms) => { now += ms; for (const [h, t] of [...timers]) if (t.at <= now) { timers.delete(h); t.fn(); } };

  let fired = 0;
  const timer = createIdleTimer({ timeoutMs: 1000, onTimeout: () => { fired += 1; }, setTimer, clearTimer });
  timer.touch(); // not started: ignored
  assert.equal(timers.size, 0);
  timer.start();
  advance(900); timer.touch(); advance(900);
  assert.equal(fired, 0);
  advance(200);
  assert.equal(fired, 1);
  timer.touch(); // fired and stopped: ignored until started again
  advance(5000);
  assert.equal(fired, 1);
  timer.start(); timer.stop(); advance(5000);
  assert.equal(fired, 1);
});
