import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { createFirebasePort, createCallable } from 'insurance-dashboard-auth/firebase';
import { createAuthClient, createTenantStore, createMembersApi, createReasonAsker, createInviteKeeper } from 'insurance-dashboard-auth';
import { DashboardProvider, ReasonDialog } from 'insurance-dashboard-auth/react';
import { firebaseConfig } from './firebaseConfig.js';
import { AppShell } from './AppShell.jsx';
import { createTenantsApi } from './tenantsApi.js';
import { createCasesApi } from './casesApi.js';
import { QrCode } from './QrCode.jsx';
import './styles.css';

// Composition root of the web app: the only place that knows Firebase and wires the dashboard core.
const lang = import.meta.env.VITE_LANG === 'en' ? 'en' : 'fr';
const requireMfa = import.meta.env.VITE_REQUIRE_MFA !== 'false';

const app = initializeApp(firebaseConfig);
const client = createAuthClient({ port: createFirebasePort({ auth: getAuth(app) }), requireMfa });
const asker = createReasonAsker();
let store;
const call = createCallable({ app });
const getContext = () => { const c = store.getActive(); return c && { tenantId: c.tenantId, access: c.access, platformOnly: c.platformOnly || [] }; };
const api = createMembersApi({
  call,
  askReason: (action) => asker.ask(action),
  getContext,
  lang,
});
const tenantsApi = createTenantsApi({ call, askReason: (action) => asker.ask(action), getContext });
const casesApi = createCasesApi({ call });
store = createTenantStore({ api, storage: window.localStorage });
const keeper = createInviteKeeper({ win: window });
keeper.capture(); // reads an invitation link (#t=...&i=...&k=...) and removes the token from the address bar

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DashboardProvider client={client} store={store} api={api} keeper={keeper}>
      <AppShell lang={lang} renderQr={(url) => <QrCode value={url} />} tenantsApi={tenantsApi} casesApi={casesApi} />
      <ReasonDialog asker={asker} lang={lang} />
    </DashboardProvider>
  </StrictMode>,
);
