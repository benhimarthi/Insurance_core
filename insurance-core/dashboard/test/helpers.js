// Test doubles shared by the dashboard tests.

export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fake of the Firebase port: users, passwords, email verification and TOTP second factors. */
export function createFakePort(accounts = {}) {
  const records = new Map(Object.entries(accounts).map(([email, r]) => [email, { email, uid: `uid-${email.split('@')[0]}`, emailVerified: true, factors: 0, mfaCode: '123456', ...r }]));
  let session = null; // { rec, secondFactor }
  const listeners = new Set();
  const calls = { verificationEmails: 0, passwordResets: [], signOuts: 0, reloads: 0 };
  const userOf = (rec) => ({ uid: rec.uid, email: rec.email, emailVerified: rec.emailVerified, displayName: null });
  const notify = () => listeners.forEach((cb) => cb(session ? userOf(session.rec) : null));

  const port = {
    calls, records,
    failNext: null, // set to an error to make the next network call fail
    onAuthStateChanged(cb) { listeners.add(cb); Promise.resolve().then(() => cb(session ? userOf(session.rec) : null)); return () => listeners.delete(cb); },
    currentUser: () => (session ? userOf(session.rec) : null),

    async signIn(email, password) {
      if (port.failNext) { const e = port.failNext; port.failNext = null; throw e; }
      const rec = records.get(email);
      if (!rec || rec.password !== password) throw { code: 'auth/invalid-credential' };
      if (rec.disabled) throw { code: 'auth/user-disabled' };
      if (rec.factors > 0) throw { code: 'auth/multi-factor-auth-required', rec };
      session = { rec, secondFactor: false };
      notify();
    },
    async signUp(email, password) {
      if (records.has(email)) throw { code: 'auth/email-already-in-use' };
      const rec = { email, uid: `uid-${email.split('@')[0]}`, password, emailVerified: false, factors: 0, mfaCode: '123456' };
      records.set(email, rec);
      session = { rec, secondFactor: false };
      notify();
      return userOf(rec);
    },
    async signOut() { calls.signOuts += 1; session = null; notify(); },
    async sendVerificationEmail() { calls.verificationEmails += 1; },
    async sendPasswordReset(email) {
      if (port.failNext) { const e = port.failNext; port.failNext = null; throw e; }
      calls.passwordResets.push(email);
      if (!records.has(email)) throw { code: 'auth/user-not-found' };
    },
    async reload() { calls.reloads += 1; if (session.rec.verifyOnReload) session.rec.emailVerified = true; },

    async getClaims() { return { platformRole: session.rec.platformRole || null, secondFactor: session.secondFactor }; },
    enrolledFactorCount: () => session.rec.factors,

    isMfaRequired: (err) => !!err && err.code === 'auth/multi-factor-auth-required',
    getMfaResolver: (err) => ({ rec: err.rec, hints: [{ factorId: 'totp', displayName: 'Authenticator' }] }),
    describeHints: (resolver) => resolver.hints.map((h, index) => ({ index, ...h })),
    async resolveMfa(resolver, hintIndex, code) {
      if (code !== resolver.rec.mfaCode) throw { code: 'auth/invalid-verification-code' };
      session = { rec: resolver.rec, secondFactor: true };
      notify();
    },

    async startTotpEnrollment() { return { secretKey: 'JBSWY3DPEHPK3PXP', qrUrl: 'otpauth://totp/Dashboard:x?secret=JBSWY3DPEHPK3PXP' }; },
    async finishTotpEnrollment(pending, code) {
      if (code !== '654321') throw { code: 'auth/invalid-verification-code' };
      session.rec.factors = 1;
    },
    /** test helper: pretend a session was restored from storage */
    restore(email, secondFactor) { const rec = records.get(email); session = { rec, secondFactor }; notify(); },
  };
  return port;
}

export function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
}

/** A fake window for the invitation keeper. */
export function createFakeWindow(hash = '') {
  const win = {
    location: { hash, pathname: '/invite', search: '' },
    history: { calls: [], replaceState(...args) { this.calls.push(args); win.location.hash = ''; } },
    sessionStorage: createMemoryStorage(),
  };
  return win;
}

/** A fake members API for the tenant store. */
export function createFakeApi({ memberships = [], platformRole = null, platformPermissions = [], tenants = [] } = {}) {
  const api = {
    calls: [],
    state: { memberships, platformRole, platformPermissions, tenants },
    failNext: null,
    async myTenants() {
      api.calls.push('myTenants');
      if (api.failNext) { const e = api.failNext; api.failNext = null; throw e; }
      return { memberships: api.state.memberships, platformRole: api.state.platformRole, platformPermissions: api.state.platformPermissions };
    },
    async allTenants() { api.calls.push('allTenants'); return { tenants: api.state.tenants }; },
    async accept(invite) {
      api.calls.push(['accept', invite.tenantId]);
      if (api.acceptError) throw api.acceptError;
      api.state.memberships = [...api.state.memberships, { tenantId: invite.tenantId, name: 'Joined Insurer', role: 'underwriter', permissions: ['case:read', 'case:decide'] }];
    },
  };
  return api;
}

export const member = (tenantId, name, role = 'underwriter', permissions = ['case:read', 'case:decide']) => ({ tenantId, name, role, permissions });
