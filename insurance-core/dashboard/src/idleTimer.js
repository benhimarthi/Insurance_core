/**
 * Signs staff out after a period without activity: this dashboard shows personal data.
 * Framework-neutral; the React provider calls touch() on user activity.
 */
export function createIdleTimer({ timeoutMs = 30 * 60 * 1000, onTimeout, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let handle = null;
  let running = false;
  const arm = () => { if (handle) clearTimer(handle); handle = setTimer(() => { running = false; handle = null; onTimeout(); }, timeoutMs); };
  return {
    start() { running = true; arm(); },
    touch() { if (running) arm(); },
    stop() { running = false; if (handle) clearTimer(handle); handle = null; },
  };
}
