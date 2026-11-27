import { useCallback, useEffect, useState } from 'react';
import { useAuth, useTenants } from 'insurance-dashboard-auth/react';
import { texts } from './texts.js';
import { messageOf, reasonOf } from './tenantsApi.js';
import { RulesEditor } from './RulesEditor.jsx';

/** The active insurer: its identity (managed by the platform team) and its rules. */
export function SettingsPage({ api, lang }) {
  const x = texts(lang).settings;
  const common = texts(lang).common;
  const { active, can } = useTenants();
  const { platformRole } = useAuth();
  const tenantId = active && active.tenantId;
  const [state, setState] = useState({ status: 'loading' });

  const load = useCallback(async () => {
    if (!tenantId) return;
    setState({ status: 'loading' });
    try { setState({ status: 'ready', ...(await api.get(tenantId)) }); } catch (err) {
      setState(reasonOf(err) === 'TENANT_NOT_FOUND' ? { status: 'missing' } : { status: 'error', error: err });
    }
  }, [api, tenantId]);
  useEffect(() => { load(); }, [load]);

  if (!tenantId) return null;
  if (state.status === 'loading') return <p className="muted">{common.loading}</p>;
  if (state.status === 'error') return <p role="alert" className="dash-error">{messageOf(state.error, lang)}</p>;
  if (state.status === 'missing') {
    return (
      <section className="card">
        <h1>{active.name}</h1>
        <p>{x.notFound}</p>
        <p className="muted">{platformRole ? x.notFoundPlatform : x.notFoundOther}</p>
      </section>
    );
  }

  const { tenant, rules } = state;
  return (
    <main className="settings">
      <section className="card">
        <h1>
          {tenant.name}{' '}
          <span className={`badge ${tenant.status === 'active' ? '' : 'warn'}`}>{x.status[tenant.status] || tenant.status}</span>
          {tenant.demo && <span className="badge">{x.demo}</span>}
        </h1>
        <p className="muted">{x.id}: <code>{tenant.tenantId}</code></p>
        {can('tenants:manage') && <ManageTenant api={api} tenant={tenant} lang={lang} onChanged={load} />}
      </section>
      <RulesEditor key={`${tenantId}:${rules.revision}`} api={api} tenantId={tenantId} rules={rules} canWrite={can('config:write')} lang={lang} />
    </main>
  );
}

/** Platform team: rename, demo flag, suspend/reactivate, new web chat key. Every change carries a note. */
function ManageTenant({ api, tenant, lang, onChanged }) {
  const x = texts(lang).settings;
  const common = texts(lang).common;
  const [name, setName] = useState(tenant.name);
  const [demo, setDemo] = useState(tenant.demo);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [key, setKey] = useState(null);
  const ready = note.trim().length >= 5 && !busy;

  const run = (fn) => async () => {
    setBusy(true); setError(null);
    try { await fn(); setNote(''); await onChanged(); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const saveInfo = run(() => api.update(tenant.tenantId, {
    name: name !== tenant.name ? name : undefined, demo: demo !== tenant.demo ? demo : undefined, reason: note,
  }));
  const toggleStatus = run(async () => {
    if (tenant.status === 'active' && !window.confirm(x.suspendConfirm)) throw Object.assign(new Error('REASON_CANCELLED'), { silent: true });
    await api.setStatus(tenant.tenantId, { status: tenant.status === 'active' ? 'suspended' : 'active', reason: note });
  });
  const rotate = async () => {
    setBusy(true); setError(null);
    try { setKey((await api.rotateWebchatKey(tenant.tenantId, { reason: note })).webchatKey); setNote(''); } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <details className="manage">
      <summary>{x.manage}</summary>
      <label>{x.name}<input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></label>
      <label className="check"><input type="checkbox" checked={demo} onChange={(e) => setDemo(e.target.checked)} /> {x.isDemo}</label>
      <label>{common.note}<input value={note} onChange={(e) => setNote(e.target.value)} placeholder={common.notePh} maxLength={500} /></label>
      <div className="toolbar">
        <button type="button" onClick={saveInfo} disabled={!ready || (name === tenant.name && demo === tenant.demo)}>{x.saveInfo}</button>
        <button type="button" onClick={toggleStatus} disabled={!ready}>{tenant.status === 'active' ? x.suspend : x.reactivate}</button>
        <button type="button" onClick={rotate} disabled={!ready}>{x.rotate}</button>
      </div>
      {error && !error.silent && <p role="alert" className="dash-error">{messageOf(error, lang)}</p>}
      {key && <p className="secret">{x.keyShown}<br /><code>{key}</code></p>}
    </details>
  );
}
