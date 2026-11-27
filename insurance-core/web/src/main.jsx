import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { createFirebasePort, createCallable } from 'insurance-dashboard-auth/firebase';
import { createAuthClient, createTenantStore, createMembersApi, createReasonAsker, createInviteKeeper } from 'insurance-dashboard-auth';
import { DashboardProvider, DashboardShell, ReasonDialog } from 'insurance-dashboard-auth/react';
import { firebaseConfig } from './firebaseConfig.js';
import { MembersPage } from './MembersPage.jsx';
import { QrCode } from './QrCode.jsx';
import './styles.css';

// Composition root of the web app: the only place that knows Firebase and wires the dashboard core.
const lang = import.meta.env.VITE_LANG === 'en' ? 'en' : 'fr';
const requireMfa = import.meta.env.VITE_REQUIRE_MFA !== 'false';

const app = initializeApp(firebaseConfig);
const client = createAuthClient({ port: createFirebasePort({ auth: getAuth(app) }), requireMfa });
const asker = createReasonAsker();
let store;
const api = createMembersApi({
  call: createCallable({ app }),
  askReason: (action) => asker.ask(action),
  getContext: () => { const c = store.getActive(); return c && { tenantId: c.tenantId, access: c.access }; },
  lang,
});
store = createTenantStore({ api, storage: window.localStorage });
const keeper = createInviteKeeper({ win: window });
keeper.capture(); // reads an invitation link (#t=...&i=...&k=...) and removes the token from the address bar

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DashboardProvider client={client} store={store} api={api} keeper={keeper}>
      <DashboardShell lang={lang} renderQr={(url) => <QrCode value={url} />}>
        <MembersPage lang={lang} />
      </DashboardShell>
      <ReasonDialog asker={asker} lang={lang} />
    </DashboardProvider>
  </StrictMode>,
);
