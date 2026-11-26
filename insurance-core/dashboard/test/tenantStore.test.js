import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantStore } from '../src/tenantStore.js';
import { createFakeApi, createMemoryStorage, member, settle } from './helpers.js';

const A = member('alpha-insurer', 'Alpha Assurance', 'underwriter', ['case:read', 'case:decide']);
const B = member('beta-insurer', 'Beta Assurance', 'auditor', ['case:read', 'audit:read']);

test('no insurer: nothing active; one insurer: opened automatically; several: the user chooses', async () => {
  let store = createTenantStore({ api: createFakeApi() });
  await store.load('u1');
  assert.deepEqual([store.getState().status, store.getState().choices.length, store.getState().activeTenantId], ['ready', 0, null]);

  store = createTenantStore({ api: createFakeApi({ memberships: [A] }) });
  await store.load('u1');
  assert.equal(store.getState().activeTenantId, 'alpha-insurer');

  store = createTenantStore({ api: createFakeApi({ memberships: [B, A] }) });
  await store.load('u1');
  assert.equal(store.getState().activeTenantId, null);
  assert.deepEqual(store.getState().choices.map((c) => c.name), ['Alpha Assurance', 'Beta Assurance']); // sorted
});

test('the last insurer is remembered per user, and only if it is still valid', async () => {
  const storage = createMemoryStorage();
  const api = createFakeApi({ memberships: [A, B] });
  const store = createTenantStore({ api, storage });
  await store.load('user-1');
  store.select('beta-insurer');
  assert.equal(storage.getItem('dashboard.activeTenant.user-1'), 'beta-insurer');

  const again = createTenantStore({ api, storage });
  await again.load('user-1');
  assert.equal(again.getState().activeTenantId, 'beta-insurer');

  const other = createTenantStore({ api, storage }); // another person on the same browser
  await other.load('user-2');
  assert.equal(other.getState().activeTenantId, null);

  storage.setItem('dashboard.activeTenant.user-1', 'removed-insurer'); // access was revoked meanwhile
  const stale = createTenantStore({ api, storage });
  await stale.load('user-1');
  assert.equal(stale.getState().activeTenantId, null);

  const broken = createTenantStore({ api, storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  await broken.load('user-1'); // blocked storage must not break the app
  broken.select('alpha-insurer');
  assert.equal(broken.getState().activeTenantId, 'alpha-insurer');
});

test('select: unknown insurers are refused; permissions follow the active insurer', async () => {
  const store = createTenantStore({ api: createFakeApi({ memberships: [A, B] }) });
  await store.load('u1');
  assert.throws(() => store.select('ghost-insurer'), /Unknown insurer/);
  assert.equal(store.can('case:decide'), false); // nothing active yet
  store.select('alpha-insurer');
  assert.equal(store.can('case:decide'), true);
  store.select('beta-insurer');
  assert.equal(store.can('case:decide'), false); // an auditor there
  assert.equal(store.can('audit:read'), true);
});

test('platform staff: all insurers are listed, flagged as platform access; a real role wins', async () => {
  const api = createFakeApi({
    memberships: [A], platformRole: 'platform_admin', platformPermissions: ['members:read', 'members:manage'],
    tenants: [{ tenantId: 'alpha-insurer', name: 'Alpha Assurance' }, { tenantId: 'zeta-insurer', name: 'Zeta Assurance' }],
  });
  const store = createTenantStore({ api });
  await store.load('u1');
  const { choices, platformRole } = store.getState();
  assert.equal(platformRole, 'platform_admin');
  assert.deepEqual(choices.map((c) => [c.tenantId, c.access, c.role]), [['alpha-insurer', 'member', 'underwriter'], ['zeta-insurer', 'platform', 'platform_admin']]);
  store.select('zeta-insurer');
  assert.equal(store.can('case:read'), false);       // no case access through the platform role
  assert.equal(store.can('members:manage'), true);
  assert.deepEqual(api.calls, ['myTenants', 'allTenants']);
});

test('switching insurers tears down the old subscription BEFORE starting the new one (no cross-insurer leaks)', async () => {
  const store = createTenantStore({ api: createFakeApi({ memberships: [A, B] }) });
  await store.load('u1');
  const log = [];
  const delivered = [];
  let deliverToA;

  const stopWatching = store.watchActive((choice, { isCurrent }) => {
    log.push(`start ${choice.tenantId}`);
    // a listener that delivers data asynchronously, like a Firestore snapshot
    const deliver = (row) => { if (isCurrent()) delivered.push(`${choice.tenantId}:${row}`); };
    if (choice.tenantId === 'alpha-insurer') deliverToA = deliver;
    return () => log.push(`stop ${choice.tenantId}`);
  });
  assert.deepEqual(log, []); // nothing active yet

  store.select('alpha-insurer');
  deliverToA('case-1');
  store.select('beta-insurer');
  assert.deepEqual(log, ['start alpha-insurer', 'stop alpha-insurer', 'start beta-insurer']); // stop strictly before start
  deliverToA('case-2'); // a late snapshot from A arrives after the switch
  assert.deepEqual(delivered, ['alpha-insurer:case-1']);       // and is dropped

  store.deselect();
  assert.equal(log.at(-1), 'stop beta-insurer');
  stopWatching();
  store.select('alpha-insurer');
  assert.equal(log.at(-1), 'stop beta-insurer'); // the removed watcher no longer runs
});

test('a watcher added later starts at once for the current insurer; a failing stop does not break switching', async () => {
  const store = createTenantStore({ api: createFakeApi({ memberships: [A, B] }) });
  await store.load('u1');
  store.select('alpha-insurer');
  const seen = [];
  store.watchActive((c) => { seen.push(c.tenantId); return () => { throw new Error('boom'); }; });
  assert.deepEqual(seen, ['alpha-insurer']);
  store.select('beta-insurer');
  assert.deepEqual(seen, ['alpha-insurer', 'beta-insurer']);
});

test('sign-out clears the state and stops every watcher; reloading keeps a still-valid selection', async () => {
  const api = createFakeApi({ memberships: [A, B] });
  const store = createTenantStore({ api });
  await store.load('u1');
  store.select('alpha-insurer');
  const log = [];
  store.watchActive((c) => { log.push(`start ${c.tenantId}`); return () => log.push(`stop ${c.tenantId}`); });

  await store.refresh();
  assert.equal(store.getState().activeTenantId, 'alpha-insurer');
  assert.deepEqual(log, ['start alpha-insurer']); // not restarted needlessly

  api.state.memberships = [B]; // access to alpha was revoked: the one remaining insurer opens
  await store.refresh();
  assert.equal(store.getState().activeTenantId, 'beta-insurer');
  assert.deepEqual(log, ['start alpha-insurer', 'stop alpha-insurer', 'start beta-insurer']);

  store.clear();
  assert.equal(log.at(-1), 'stop beta-insurer');
  assert.deepEqual([store.getState().status, store.getState().choices, store.getState().activeTenantId], ['idle', [], null]);
});

test('load errors are reported and can be retried', async () => {
  const api = createFakeApi({ memberships: [A] });
  api.failNext = new Error('offline');
  const store = createTenantStore({ api });
  await store.load('u1');
  assert.equal(store.getState().status, 'error');
  await store.refresh();
  assert.equal(store.getState().status, 'ready');
  assert.equal(store.getState().activeTenantId, 'alpha-insurer');
});

test('subscribers hear about changes', async () => {
  const store = createTenantStore({ api: createFakeApi({ memberships: [A, B] }) });
  let n = 0;
  const off = store.subscribe(() => { n += 1; });
  await store.load('u1');
  store.select('alpha-insurer');
  assert.ok(n >= 3);
  off();
  const before = n;
  store.select('beta-insurer');
  assert.equal(n, before);
  await settle();
});
