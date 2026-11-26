/**
 * Lets the API layer ask a person "why?" before a platform-staff action on an insurer, without
 * knowing about any UI. The UI renders <ReasonDialog asker={asker} /> and the API calls
 * asker.ask(action), which resolves with the reason or null if cancelled.
 */
export function createReasonAsker() {
  let pending = null;
  const listeners = new Set();
  const emit = () => listeners.forEach((l) => l());
  return {
    ask(action) {
      if (pending) { const old = pending; pending = null; old.resolve(null); } // only one question at a time
      return new Promise((resolve) => { pending = { action, resolve }; emit(); });
    },
    resolve(reason) {
      if (!pending) return;
      const p = pending;
      pending = null;
      emit();
      p.resolve(reason);
    },
    getState: () => pending,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
