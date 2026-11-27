import { useState } from 'react';
import { RequireAuth, TenantGate, TenantSwitcher, useAuth, useTenants } from 'insurance-dashboard-auth/react';
import { t as dashText } from 'insurance-dashboard-auth';
import { texts } from './texts.js';
import { MembersPage } from './MembersPage.jsx';
import { SettingsPage } from './SettingsPage.jsx';
import { PlatformPage } from './PlatformPage.jsx';

/**
 * Login gate, header (insurer switcher, pages, sign-out) and the pages. The platform page sits
 * outside the insurer gate: the platform team must be able to create the very first insurer.
 */
export function AppShell({ lang, renderQr, tenantsApi }) {
  return (
    <RequireAuth lang={lang} renderQr={renderQr}>
      <Pages lang={lang} tenantsApi={tenantsApi} />
    </RequireAuth>
  );
}

function Pages({ lang, tenantsApi }) {
  const x = texts(lang).nav;
  const auth = useAuth();
  const { can, select } = useTenants();
  const [page, setPage] = useState('members');
  const tabs = [
    { id: 'members', label: x.members, show: can('members:read') },
    { id: 'settings', label: x.settings, show: can('config:read') },
    { id: 'platform', label: x.platform, show: !!auth.platformRole },
  ].filter((tab) => tab.show);
  const current = tabs.some((tab) => tab.id === page) ? page : (tabs[0] && tabs[0].id) || 'members';

  return (
    <>
      <header className="dash-header">
        <TenantSwitcher lang={lang} />
        <nav className="tabs" aria-label="Pages">
          {tabs.map((tab) => (
            <button key={tab.id} type="button" className={tab.id === current ? 'active' : ''} aria-current={tab.id === current ? 'page' : undefined} onClick={() => setPage(tab.id)}>
              {tab.label}
            </button>
          ))}
        </nav>
        <button type="button" onClick={() => auth.signOut()}>{dashText(lang).signOut}</button>
      </header>
      {current === 'platform'
        ? <PlatformPage api={tenantsApi} lang={lang} onCreated={(id) => { try { select(id); } catch { /* not in the list yet */ } setPage('settings'); }} />
        : (
          <TenantGate lang={lang}>
            {current === 'settings' ? <SettingsPage api={tenantsApi} lang={lang} /> : <MembersPage lang={lang} />}
          </TenantGate>
        )}
    </>
  );
}
