import { createContext, createElement, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createIdleTimer } from '../idleTimer.js';
import { redeemPendingInvite } from '../invitations.js';

/**
 * React bindings (no JSX in this file). Wire it once:
 *
 *   <DashboardProvider client={authClient} store={tenantStore} api={membersApi} keeper={inviteKeeper}>
 *     <DashboardShell>...your screens...</DashboardShell>
 *   </DashboardProvider>
 *
 * The provider listens to Firebase, loads the user's insurers once fully signed in (then redeems a
 * pending invitation), clears everything on sign-out, and signs staff out when idle.
 */

const Ctx = createContext(null);
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'touchstart', 'scroll', 'click'];

export function DashboardProvider({ client, store, api, keeper = null, idleMs = 30 * 60 * 1000, children }) {
  const auth = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  const [inviteError, setInviteError] = useState(null);

  useEffect(() => client.start(), [client]);

  const uid = auth.status === 'ready' && auth.user ? auth.user.uid : null;
  useEffect(() => {
    if (!uid) { store.clear(); return undefined; }
    let cancelled = false;
    (async () => {
      await store.load(uid);
      if (!keeper || cancelled) return;
      try { await redeemPendingInvite({ api, store, keeper }); setInviteError(null); } catch (err) { setInviteError(err); }
    })();
    return () => { cancelled = true; };
  }, [uid, store, api, keeper]);

  useEffect(() => {
    if (auth.status !== 'ready' || typeof window === 'undefined') return undefined;
    const timer = createIdleTimer({ timeoutMs: idleMs, onTimeout: () => client.signOut('idle_timeout') });
    let last = 0;
    const onActivity = () => { const now = Date.now(); if (now - last > 5000) { last = now; timer.touch(); } }; // throttled
    timer.start();
    ACTIVITY_EVENTS.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    return () => { timer.stop(); ACTIVITY_EVENTS.forEach((e) => window.removeEventListener(e, onActivity)); };
  }, [auth.status, client, idleMs]);

  const value = useMemo(() => ({ client, store, api, keeper, inviteError }), [client, store, api, keeper, inviteError]);
  return createElement(Ctx.Provider, { value }, children);
}

export function useDashboard() {
  const v = useContext(Ctx);
  if (!v) throw new Error('Wrap your app in <DashboardProvider>.');
  return v;
}

/** { status, user, platformRole, error, notice, mfaHints, enrollment, signIn, signUp, ... } */
export function useAuth() {
  const { client } = useDashboard();
  const state = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  return { ...state, signIn: client.signIn, signUp: client.signUp, completeMfa: client.completeMfa, cancelMfa: client.cancelMfa,
    sendVerificationEmail: client.sendVerificationEmail, refresh: client.refresh, startMfaEnrollment: client.startMfaEnrollment,
    finishMfaEnrollment: client.finishMfaEnrollment, resetPassword: client.resetPassword, signOut: client.signOut };
}

/** { status, choices, activeTenantId, active, select, can, refresh, error } */
export function useTenants() {
  const { store } = useDashboard();
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const active = state.choices.find((c) => c.tenantId === state.activeTenantId) || null;
  return { ...state, active, select: store.select, deselect: store.deselect, can: store.can, refresh: store.refresh };
}

export const useCan = (permission) => useTenants().can(permission);

/** The pending invitation (if any) and the last error from redeeming it. */
export function useInvite() {
  const { keeper, inviteError } = useDashboard();
  return { pending: keeper ? keeper.pending() : null, error: inviteError };
}
