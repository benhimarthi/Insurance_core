# Dashboard login and tenant switcher

Framework-neutral core (`src/`) plus React bindings (`src/react/`). Talks to the backend through
the `members` and `underwriterDecision` callables.

## Wire it (React + Vite or Next.js, Firebase v10+)
```js
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { createFirebasePort, createCallable } from './dashboard/src/firebasePort.js';
import { createAuthClient, createTenantStore, createMembersApi, createReasonAsker, createInviteKeeper } from './dashboard/src/index.js';
import { DashboardProvider, DashboardShell, ReasonDialog } from './dashboard/src/react/index.js';

const app = initializeApp(firebaseConfig);
const client = createAuthClient({ port: createFirebasePort({ auth: getAuth(app) }), requireMfa: true });
const asker = createReasonAsker();
let store;
const api = createMembersApi({ call: createCallable({ app }), askReason: (a) => asker.ask(a),
  getContext: () => { const c = store.getActive(); return c && { tenantId: c.tenantId, access: c.access }; } });
store = createTenantStore({ api, storage: window.localStorage });
const keeper = createInviteKeeper({ win: window });
keeper.capture(); // reads an invitation link (#t=...&i=...&k=...) and hides the token

root.render(
  <DashboardProvider client={client} store={store} api={api} keeper={keeper}>
    <DashboardShell lang="fr">{/* your screens */}</DashboardShell>
    <ReasonDialog asker={asker} />
  </DashboardProvider>
);
```
- `useAuth()`, `useTenants()`, `useCan('case:decide')`, `<Can permission="...">` for your own screens.
- Anything tied to the active insurer (Firestore listeners, caches) must go through
  `store.watchActive((tenant, { isCurrent }) => unsubscribe)`: the old subscription is stopped before the new one
  starts, and `isCurrent()` tells late callbacks to drop their data.
- Vue, Flutter or plain JS: reuse `authClient`, `tenantStore`, `membersApi` as they are (no React in them) and
  build your own screens, or port the same state machine.

## Needs checking against your real Firebase project
The tests use a fake of Firebase and confirm every SDK function name exists in the installed SDK, but sign-in
with a TOTP second factor and enrolment need Identity Platform and should be tried once for real. Create-account
should be limited to invited people (for example with an Identity Platform blocking function): without it,
anyone can create an account, although an account with no role can do nothing.

`npm install && npm test` runs 55 tests (including rendering of the components).
