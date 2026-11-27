import { useState } from 'react';
import { useTenants } from 'insurance-dashboard-auth/react';
import { texts } from './texts.js';
import { messageOf } from './tenantsApi.js';

/** Platform team: create an insurer with starting rules (a template to adapt afterwards). */
export function PlatformPage({ api, lang, onCreated }) {
  const x = texts(lang).platform;
  const common = texts(lang).common;
  const { refresh } = useTenants();
  const [form, setForm] = useState({ tenantId: '', name: '', demo: true, reason: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null); setDone(null);
    try {
      const tenantId = form.tenantId.trim().toLowerCase();
      const res = await api.create({ ...form, tenantId });
      setDone(res);
      setForm({ tenantId: '', name: '', demo: true, reason: '' });
      await refresh(); // the new insurer appears in the switcher
      if (onCreated) onCreated(tenantId);
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <main className="card">
      <h1>{x.title}</h1>
      <p className="muted">{x.help}</p>
      <form onSubmit={submit}>
        <label>{x.id}<input value={form.tenantId} onChange={set('tenantId')} pattern="[a-z0-9][a-z0-9-]{2,39}" required autoCapitalize="off" spellCheck={false} /></label>
        <label>{x.name}<input value={form.name} onChange={set('name')} minLength={2} maxLength={100} required /></label>
        <label className="check"><input type="checkbox" checked={form.demo} onChange={set('demo')} /> {x.demo}</label>
        <label>{common.note}<input value={form.reason} onChange={set('reason')} placeholder={common.notePh} minLength={5} maxLength={500} required /></label>
        <button type="submit" disabled={busy}>{x.create}</button>
      </form>
      {error && <p role="alert" className="dash-error">{messageOf(error, lang)}</p>}
      {done && (
        <div role="status" className="feedback ok">
          <p>{x.created(done.tenantId)}</p>
          {done.webchatKey && <p className="secret">{x.keyShown}<br /><code>{done.webchatKey}</code></p>}
        </div>
      )}
    </main>
  );
}
