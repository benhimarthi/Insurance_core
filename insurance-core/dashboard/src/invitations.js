/**
 * Invitation links. The secret token travels in the URL FRAGMENT (#...), which browsers never send
 * to servers or log in referrers:  https://dashboard.example/invite#t=<tenant>&i=<id>&k=<token>
 *
 * Flow: the page loads -> capture() reads and stores the invitation in sessionStorage and removes
 * the fragment from the address bar -> the person signs in (or creates an account) -> redeem()
 * calls members.accept and opens that insurer.
 */

const TENANT_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
const STORAGE_KEY = 'dashboard.pendingInvite';

export function buildInviteLink(baseUrl, { tenantId, invitationId, token }) {
  const q = new URLSearchParams({ t: tenantId, i: invitationId, k: token });
  return `${baseUrl.replace(/[#?].*$/, '')}#${q.toString()}`;
}

/** Accepts a fragment ("#t=...") or a full URL. Returns { tenantId, invitationId, token } or null. */
export function parseInviteLink(input) {
  const raw = String(input || '');
  const hash = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : raw.replace(/^#/, '');
  const p = new URLSearchParams(hash);
  const invite = { tenantId: p.get('t'), invitationId: p.get('i'), token: p.get('k') };
  if (!TENANT_RE.test(invite.tenantId || '') || !ID_RE.test(invite.invitationId || '') || !TOKEN_RE.test(invite.token || '')) return null;
  return invite;
}

/** `win` is the browser window (injected so the logic is testable): { location, history, sessionStorage }. */
export function createInviteKeeper({ win }) {
  const read = () => { try { return JSON.parse(win.sessionStorage.getItem(STORAGE_KEY)); } catch { return null; } };
  return {
    /** Call once at startup. */
    capture() {
      const invite = parseInviteLink(win.location.hash);
      if (!invite) return read();
      try { win.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(invite)); } catch { /* private mode: still usable this load */ }
      win.history.replaceState(null, '', win.location.pathname + win.location.search); // the token leaves the address bar and history
      return invite;
    },
    pending: read,
    clear() { try { win.sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ } },
  };
}

/**
 * Redeems the pending invitation once the person is fully signed in. A definitive failure
 * (invalid, expired, wrong account) clears it; a network failure keeps it so it can be retried.
 * Returns { tenantId } on success, null when nothing was pending. Throws the ApiError otherwise.
 */
export async function redeemPendingInvite({ api, store, keeper }) {
  const invite = keeper.pending();
  if (!invite) return null;
  try {
    await api.accept(invite);
  } catch (err) {
    if (!err.retryable) keeper.clear();
    throw err;
  }
  keeper.clear();
  await store.refresh();
  store.select(invite.tenantId);
  return { tenantId: invite.tenantId };
}
