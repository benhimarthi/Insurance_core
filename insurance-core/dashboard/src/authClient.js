import { normalizeError } from './errors.js';

/**
 * Framework-neutral sign-in state machine. It talks to Firebase only through a `port`
 * (see firebasePort.js), so it can be tested without Firebase and reused with any UI.
 *
 * status:
 *   loading                  waiting for Firebase to restore a session
 *   signed_out               show the login form (state.notice / state.error explain why)
 *   mfa_challenge            password accepted, a second-factor code is needed (state.mfaHints)
 *   needs_email_verification signed in, email not verified yet
 *   needs_mfa_enrollment     verified, but no second factor enrolled (only when requireMfa)
 *   ready                    fully signed in: verified, and signed in with a second factor
 *
 * The server checks the same things on every call (email_verified, MFA): this state machine only
 * makes sure the user is guided there instead of hitting errors.
 */
export function createAuthClient({ port, requireMfa = true }) {
  let state = { status: 'loading', user: null, platformRole: null, mfaHints: [], notice: null, error: null, enrollment: null };
  let mfaResolver = null;
  let pendingEnrollment = null;
  let stopListening = null;
  const listeners = new Set();

  const emit = (patch) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
  const signedOut = (notice = null, error = null) => emit({ status: 'signed_out', user: null, platformRole: null, mfaHints: [], enrollment: null, notice, error });
  const fail = (err) => { emit({ error: normalizeError(err), notice: null }); return false; };

  async function evaluate(user) {
    if (!user) {
      if (state.status === 'mfa_challenge') return; // the password step leaves no user yet: keep the challenge
      return signedOut(state.notice);
    }
    const info = { uid: user.uid, email: user.email, displayName: user.displayName || null };
    const claims = await port.getClaims(user);
    const base = { user: info, platformRole: claims.platformRole, mfaHints: [], error: null };

    if (!user.emailVerified) return emit({ ...base, status: 'needs_email_verification', notice: null });
    if (!requireMfa) return emit({ ...base, status: 'ready', notice: null });
    if (port.enrolledFactorCount(user) === 0) return emit({ ...base, status: 'needs_mfa_enrollment', notice: null });
    if (!claims.secondFactor) { // a restored session that never passed the second factor
      await port.signOut();
      return signedOut('mfa_missing');
    }
    return emit({ ...base, status: 'ready', notice: null });
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },

    /** Starts listening to Firebase. Returns a stop function. */
    start() {
      if (!stopListening) stopListening = port.onAuthStateChanged((user) => { evaluate(user).catch(fail); });
      return () => { if (stopListening) { stopListening(); stopListening = null; } };
    },

    async signIn(email, password) {
      emit({ error: null, notice: null });
      try {
        await port.signIn(email, password);
      } catch (err) {
        if (port.isMfaRequired(err)) {
          mfaResolver = port.getMfaResolver(err);
          emit({ status: 'mfa_challenge', mfaHints: port.describeHints(mfaResolver) });
          return true;
        }
        return fail(err);
      }
      await evaluate(port.currentUser());
      return true;
    },

    async completeMfa(code, hintIndex = 0) {
      if (!mfaResolver) return fail({ code: 'auth/requires-recent-login' });
      emit({ error: null });
      try {
        await port.resolveMfa(mfaResolver, hintIndex, String(code || '').trim());
      } catch (err) { return fail(err); } // stays on mfa_challenge so the user can retry
      mfaResolver = null;
      await evaluate(port.currentUser());
      return true;
    },

    cancelMfa() { mfaResolver = null; signedOut(); },

    async signUp(email, password) {
      emit({ error: null, notice: null });
      try {
        const user = await port.signUp(email, password);
        await port.sendVerificationEmail(user);
      } catch (err) { return fail(err); }
      await evaluate(port.currentUser());
      return true;
    },

    async sendVerificationEmail() {
      try { await port.sendVerificationEmail(port.currentUser()); } catch (err) { return fail(err); }
      emit({ notice: 'verification_sent', error: null });
      return true;
    },

    /** "I verified my email": reload the user AND refresh the token (the server reads email_verified from it). */
    async refresh() {
      const user = port.currentUser();
      if (!user) return signedOut();
      try { await port.reload(user); await evaluate(port.currentUser()); } catch (err) { return fail(err); }
      return true;
    },

    async startMfaEnrollment() {
      try {
        pendingEnrollment = await port.startTotpEnrollment(port.currentUser());
      } catch (err) { return fail(err); }
      emit({ enrollment: { secretKey: pendingEnrollment.secretKey, qrUrl: pendingEnrollment.qrUrl }, error: null });
      return true;
    },

    /** The second factor only counts for sessions that sign in WITH it, so the user signs in again. */
    async finishMfaEnrollment(code) {
      if (!pendingEnrollment) return fail({ code: 'auth/requires-recent-login' });
      try {
        await port.finishTotpEnrollment(pendingEnrollment, String(code || '').trim(), 'Authenticator');
      } catch (err) { return fail(err); }
      pendingEnrollment = null;
      await port.signOut();
      signedOut('mfa_enrolled');
      return true;
    },

    /** Always reports success: never reveal whether an account exists for the address. */
    async resetPassword(email) {
      try { await port.sendPasswordReset(email); } catch (err) {
        if (err && err.code === 'auth/network-request-failed') return fail(err);
      }
      emit({ notice: 'password_reset', error: null });
      return true;
    },

    async signOut(notice = 'signed_out') {
      mfaResolver = null;
      pendingEnrollment = null;
      try { await port.signOut(); } catch (err) { /* local state is cleared anyway */ }
      signedOut(notice);
    },
  };
}
