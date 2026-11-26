import {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  sendEmailVerification, sendPasswordResetEmail, multiFactor, getMultiFactorResolver,
  TotpMultiFactorGenerator, setPersistence, browserSessionPersistence, browserLocalPersistence,
} from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

/**
 * The only file that touches the Firebase SDK. The function names used here are checked against
 * the installed SDK by test/firebasePort.test.js, but the flows themselves (especially TOTP
 * enrolment and sign-in) must be tried once against your real project: they need Identity Platform.
 *
 *   const auth = getAuth(app);
 *   const port = createFirebasePort({ auth });
 *   const call = createCallable({ app });            // (name, data) => Promise<data>
 *
 * persistence: 'session' (default, signed out when the tab closes: safer for personal data) or 'local'.
 * Only authenticator-app (TOTP) second factors are supported here; SMS needs a reCAPTCHA flow.
 */
export function createFirebasePort({ auth, persistence = 'session', issuer = 'Underwriting Dashboard' }) {
  const ready = setPersistence(auth, persistence === 'local' ? browserLocalPersistence : browserSessionPersistence);
  ready.catch(() => {}); // a failure is not swallowed: signIn/signUp await `ready` and surface it (never silently fall back to local storage)

  return {
    onAuthStateChanged: (cb) => onAuthStateChanged(auth, cb),
    currentUser: () => auth.currentUser,

    async signIn(email, password) { await ready; return signInWithEmailAndPassword(auth, email, password); },
    async signUp(email, password) { await ready; return (await createUserWithEmailAndPassword(auth, email, password)).user; },
    signOut: () => signOut(auth),
    sendVerificationEmail: (user) => sendEmailVerification(user),
    sendPasswordReset: (email) => sendPasswordResetEmail(auth, email),

    /** reload + force a new ID token: the server reads email_verified from the token. */
    async reload(user) { await user.reload(); await user.getIdToken(true); },

    async getClaims(user) {
      const { claims } = await user.getIdTokenResult();
      return { platformRole: claims.platformRole || null, secondFactor: !!(claims.firebase && claims.firebase.sign_in_second_factor) };
    },

    enrolledFactorCount: (user) => multiFactor(user).enrolledFactors.length,

    // sign-in with a second factor
    isMfaRequired: (err) => !!err && err.code === 'auth/multi-factor-auth-required',
    getMfaResolver: (err) => getMultiFactorResolver(auth, err),
    describeHints: (resolver) => resolver.hints.map((h, index) => ({ index, factorId: h.factorId, displayName: h.displayName || null })),
    async resolveMfa(resolver, hintIndex, code) {
      const hint = resolver.hints[hintIndex];
      if (!hint || hint.factorId !== TotpMultiFactorGenerator.FACTOR_ID) throw new Error('Only authenticator-app codes are supported.');
      return resolver.resolveSignIn(TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code));
    },

    // second-factor enrolment (TOTP)
    async startTotpEnrollment(user) {
      const session = await multiFactor(user).getSession();
      const secret = await TotpMultiFactorGenerator.generateSecret(session);
      return { secretKey: secret.secretKey, qrUrl: secret.generateQrCodeUrl(user.email, issuer), secret };
    },
    async finishTotpEnrollment(pending, code, displayName) {
      const assertion = TotpMultiFactorGenerator.assertionForEnrollment(pending.secret, code);
      await multiFactor(auth.currentUser).enroll(assertion, displayName);
    },
  };
}

/** Wraps Cloud Functions callables as (name, data) => Promise<data>. */
export function createCallable({ app, region = 'europe-west1' }) {
  const functions = getFunctions(app, region);
  return async (name, data) => (await httpsCallable(functions, name)(data)).data;
}
