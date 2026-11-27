/**
 * The active-insurer ("tenant") state, framework-neutral.
 *
 * choices: every insurer the user can open, each { tenantId, name, role, access, permissions, platformOnly? }
 *   access 'member'   a role at that insurer (from myTenants), plus the platform role's permissions if any
 *   access 'platform' your team, via the global platform role (from allTenants); no case access
 *
 * The rule this file exists to enforce: nothing from insurer A may ever show under insurer B.
 * Anything tied to the active insurer (live listeners, caches) goes through watchActive(), which
 * tears down the old subscription BEFORE creating the new one and tells late callbacks that they
 * are stale (isCurrent()).
 */
export function createTenantStore({ api, storage = null, storageKey = 'dashboard.activeTenant' }) {
  const initial = { status: 'idle', uid: null, choices: [], platformRole: null, activeTenantId: null, error: null };
  let state = { ...initial };
  const listeners = new Set();
  const watchers = new Set(); // { factory, stop }
  let generation = 0;

  const emit = (patch) => { state = { ...state, ...patch }; listeners.forEach((l) => l()); };
  const keyFor = (uid) => `${storageKey}.${uid}`; // per user: a shared browser never leaks the last insurer
  const safe = (fn) => { try { return fn(); } catch { return null; } };
  const active = () => state.choices.find((c) => c.tenantId === state.activeTenantId) || null;

  function stopWatchers() {
    for (const w of watchers) { if (w.stop) { safe(w.stop); w.stop = null; } }
  }

  function startWatchers() {
    const choice = active();
    const g = generation;
    for (const w of watchers) {
      w.stop = choice ? w.factory(choice, { isCurrent: () => g === generation && state.activeTenantId === choice.tenantId }) : null;
    }
  }

  function setActive(tenantId) {
    stopWatchers();   // 1. old subscriptions end first
    generation += 1;  // 2. late callbacks of the old insurer become stale
    emit({ activeTenantId: tenantId });
    startWatchers();  // 3. only then the new ones start
  }

  function buildChoices(mine, platformTenants) {
    // Someone with a role at an insurer AND a platform role may use both there (the server tries the
    // membership first, then the platform role): their permissions are the union of the two.
    // `platformOnly` lists what only the platform role allows; the server wants a reason for those.
    const platformPerms = mine.platformRole ? (mine.platformPermissions || []) : [];
    const choices = mine.memberships.map((m) => {
      const platformOnly = platformPerms.filter((p) => !m.permissions.includes(p));
      return { tenantId: m.tenantId, name: m.name, role: m.role, access: 'member', permissions: [...m.permissions, ...platformOnly], platformOnly };
    });
    const have = new Set(choices.map((c) => c.tenantId));
    for (const t of platformTenants) {
      if (have.has(t.tenantId)) continue; // a real role at that insurer wins over platform access
      choices.push({ tenantId: t.tenantId, name: t.name, role: mine.platformRole, access: 'platform', permissions: mine.platformPermissions || [] });
    }
    return choices.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function load(uid) {
    emit({ status: 'loading', uid, error: null });
    try {
      const mine = await api.myTenants();
      const platformTenants = mine.platformRole ? (await api.allTenants()).tenants : [];
      const choices = buildChoices(mine, platformTenants);

      const remembered = storage ? safe(() => storage.getItem(keyFor(uid))) : null;
      const keep = state.activeTenantId && choices.some((c) => c.tenantId === state.activeTenantId) ? state.activeTenantId : null;
      const pick = keep
        || (choices.some((c) => c.tenantId === remembered) ? remembered : null)
        || (choices.length === 1 ? choices[0].tenantId : null); // several insurers: the user chooses
      emit({ status: 'ready', choices, platformRole: mine.platformRole });
      if (pick !== state.activeTenantId || !keep) setActive(pick);
    } catch (error) {
      emit({ status: 'error', error });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getActive: active,

    load,
    refresh: () => load(state.uid),

    select(tenantId) {
      const choice = state.choices.find((c) => c.tenantId === tenantId);
      if (!choice) throw new Error('Unknown insurer.');
      if (tenantId === state.activeTenantId) return;
      setActive(tenantId);
      if (storage && state.uid) safe(() => storage.setItem(keyFor(state.uid), tenantId));
    },

    /** Same as select but clears the choice (back to the chooser). */
    deselect() { setActive(null); },

    /**
     * Runs factory(choice, { isCurrent }) for the active insurer, and again after every switch.
     * factory returns a stop function. Returns a function that removes the watcher.
     */
    watchActive(factory) {
      const w = { factory, stop: null };
      watchers.add(w);
      const choice = active();
      if (choice) { const g = generation; w.stop = factory(choice, { isCurrent: () => g === generation && state.activeTenantId === choice.tenantId }); }
      return () => { if (w.stop) safe(w.stop); watchers.delete(w); };
    },

    can(permission) { const c = active(); return !!c && c.permissions.includes(permission); },

    /** Sign-out: stop everything, forget everything. */
    clear() {
      stopWatchers();
      generation += 1;
      state = { ...initial };
      listeners.forEach((l) => l());
    },
  };
}
