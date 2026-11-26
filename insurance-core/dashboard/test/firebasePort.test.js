import test from 'node:test';
import assert from 'node:assert/strict';
import * as authSdk from 'firebase/auth';
import * as functionsSdk from 'firebase/functions';
import { initializeApp, deleteApp } from 'firebase/app';
import { createFirebasePort, createCallable } from '../src/firebasePort.js';

test('every Firebase SDK symbol the port uses exists in the installed SDK', () => {
  const needed = ['onAuthStateChanged', 'signInWithEmailAndPassword', 'createUserWithEmailAndPassword', 'signOut', 'sendEmailVerification',
    'sendPasswordResetEmail', 'multiFactor', 'getMultiFactorResolver', 'TotpMultiFactorGenerator', 'setPersistence', 'browserSessionPersistence', 'browserLocalPersistence'];
  assert.deepEqual(needed.filter((n) => !(n in authSdk)), []);
  const totp = authSdk.TotpMultiFactorGenerator;
  for (const fn of ['generateSecret', 'assertionForEnrollment', 'assertionForSignIn']) assert.equal(typeof totp[fn], 'function', fn);
  assert.equal(totp.FACTOR_ID, 'totp');
  assert.equal(typeof authSdk.TotpSecret.prototype.generateQrCodeUrl, 'function');
  assert.equal(typeof functionsSdk.getFunctions, 'function');
  assert.equal(typeof functionsSdk.httpsCallable, 'function');
  assert.equal(typeof createCallable, 'function');
});

test('port helpers read claims and error shapes correctly', async () => {
  // a persistence failure must reach signIn instead of silently falling back to local storage
  const app = initializeApp({ apiKey: 'demo-key', projectId: 'demo-project' });
  const port = createFirebasePort({ auth: authSdk.getAuth(app) });
  // In Node there is no sessionStorage, so applying session persistence fails: signIn must surface that error
  // instead of silently continuing with the default (longer-lived) storage.
  await assert.rejects(port.signIn('a@b.example', 'pw'));
  await deleteApp(app);

  assert.equal(port.isMfaRequired({ code: 'auth/multi-factor-auth-required' }), true);
  assert.equal(port.isMfaRequired({ code: 'auth/wrong-password' }), false);
  assert.equal(port.isMfaRequired(null), false);

  const user = (claims) => ({ getIdTokenResult: async () => ({ claims }) });
  assert.deepEqual(await port.getClaims(user({ platformRole: 'platform_admin', firebase: { sign_in_second_factor: 'totp' } })), { platformRole: 'platform_admin', secondFactor: true });
  assert.deepEqual(await port.getClaims(user({ firebase: { sign_in_provider: 'password' } })), { platformRole: null, secondFactor: false });
  assert.deepEqual(await port.getClaims(user({})), { platformRole: null, secondFactor: false });

  const resolver = { hints: [{ factorId: 'totp', displayName: 'App', uid: 'h1' }, { factorId: 'phone', uid: 'h2' }] };
  assert.deepEqual(port.describeHints(resolver), [{ index: 0, factorId: 'totp', displayName: 'App' }, { index: 1, factorId: 'phone', displayName: null }]);
  await assert.rejects(port.resolveMfa(resolver, 1, '123456'), /authenticator-app/); // SMS second factors are not supported here
  await assert.rejects(port.resolveMfa(resolver, 5, '123456'), /authenticator-app/);

  let reloaded = false; let refreshed = false;
  await port.reload({ reload: async () => { reloaded = true; }, getIdToken: async (force) => { refreshed = force; } });
  assert.deepEqual([reloaded, refreshed], [true, true]); // the server reads email_verified from the token, so it is refreshed too
});
