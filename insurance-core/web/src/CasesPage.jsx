import { useCallback, useEffect, useState } from 'react';
import { useTenants } from 'insurance-dashboard-auth/react';
import { casesText } from './casesText.js';
import { caseErrorText } from './casesApi.js';
import { formText, valueLabel } from './rulesFormText.js';

const money = (n, cur, lang) => (n == null ? '—' : `${new Intl.NumberFormat(lang === 'en' ? 'en' : 'fr-FR').format(n)} ${cur || ''}`.trim());
const when = (iso, lang) => (iso ? new Date(iso).toLocaleString(lang === 'en' ? 'en' : 'fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '');
const shortId = (id) => (id ? id.slice(0, 8) : '');

/** Flattens the validated answers: { 'driver.age': 38, ... } in a stable order. */
function flatten(obj, prefix = '') {
  return Object.entries(obj || {}).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));
}

/** The review queue and one case: everything needed to decide, and the decision. */
export function CasesPage({ api, lang }) {
  const x = casesText(lang);
  const { active } = useTenants();
  const tenantId = active && active.tenantId;
  const [view, setView] = useState('waiting');
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    if (!tenantId) return;
    setError(null);
    try { setList((await api.list(tenantId, view)).cases); } catch (err) { setError(err); setList([]); }
  }, [api, tenantId, view]);
  useEffect(() => { setList(null); setSelected(null); load(); }, [load]);

  if (!tenantId) return null;
  return (
    <main className={`cases ${selected ? 'has-selection' : ''}`}>
      <section className="case-list card">
        <div className="case-list-head">
          <div className="view-switch" role="tablist" aria-label={x.title}>
            {['waiting', 'recent'].map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>{x[v]}</button>
            ))}
          </div>
          <button type="button" onClick={load}>{x.refresh}</button>
        </div>
        {error && <p role="alert" className="dash-error">{caseErrorText(error, lang)}</p>}
        {list === null && <p className="muted">…</p>}
        {list && list.length === 0 && <p className="muted">{view === 'waiting' ? x.emptyWaiting : x.empty}</p>}
        {list && list.length > 0 && (
          <ul>
            {list.map((c) => (
              <li key={c.caseId}>
                <button type="button" className={`case-item ${selected === c.caseId ? 'active' : ''}`} onClick={() => setSelected(c.caseId)}>
                  <span className="case-item-top">
                    <strong>{c.waitingBecause ? (x.why[c.waitingBecause] || c.waitingBecause) : (x.status[c.status] || c.status)}</strong>
                    <span className="muted">{when(c.updatedAt, lang)}</span>
                  </span>
                  <span className="case-item-sub muted">
                    {shortId(c.caseId)} · {x.channel[c.channel] || c.channel}
                    {c.proposedPremium != null && ` · ${money(c.proposedPremium, c.currency, lang)}`}
                    {c.documentFlags.length > 0 && <span className="badge warn">{c.documentFlags.length} ⚠</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="case-detail">
        {selected
          ? <CaseDetail key={selected} api={api} tenantId={tenantId} caseId={selected} lang={lang} onBack={() => setSelected(null)} onChanged={load} />
          : <p className="muted card">{x.select}</p>}
      </section>
    </main>
  );
}

function CaseDetail({ api, tenantId, caseId, lang, onBack, onChanged }) {
  const x = casesText(lang);
  const f = formText(lang);
  const { can } = useTenants();
  const [c, setC] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try { setC(await api.get(tenantId, caseId)); setError(null); } catch (err) { setError(err); }
  }, [api, tenantId, caseId]);
  useEffect(() => { load(); }, [load]);

  const run = (fn) => async (...args) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(...args); } catch (err) { setError(err); } finally { setBusy(false); }
  };
  const decide = (decision) => run(async () => {
    if (decision === 'reject' && !window.confirm(x.confirmReject)) return;
    const adjustedPremium = decision === 'adjust' ? Number(String(amount).replace(/\s/g, '').replace(',', '.')) : undefined;
    const res = await api.decide(tenantId, { caseId, decision, adjustedPremium, note: note.trim() || undefined });
    setNotice(x.decided[res.status] || res.status);
    setNote(''); setAmount('');
    await load(); onChanged();
  })();
  const openPhoto = (docType) => run(async () => {
    const tab = window.open('', '_blank', 'noopener');
    const { url } = await api.documentLink(tenantId, caseId, docType);
    if (tab) tab.location = url; else window.location.assign(url);
  })();
  const resend = () => run(async () => {
    await api.resendPolicy(tenantId, caseId);
    setNotice(x.resent);
    await load();
  })();
  const sendMessage = run(async (e) => {
    e.preventDefault();
    await api.message(tenantId, caseId, msg.trim());
    setMsg(''); setNotice(x.sent);
    await load();
  });

  if (!c) return <div className="card">{error ? <p role="alert" className="dash-error">{caseErrorText(error, lang)}</p> : <p className="muted">…</p>}</div>;
  const e = c.engine;
  const canDecide = can('case:decide') && c.status === 'pending_review';
  const answer = (v) => (v === true ? f.words.yes : v === false ? f.words.no : valueLabel(lang, v));

  return (
    <div className="case">
      <button type="button" className="back" onClick={onBack}>{x.back}</button>
      <div className="card">
        <h1>
          {c.waitingBecause ? (x.why[c.waitingBecause] || c.waitingBecause) : (x.status[c.status] || c.status)}{' '}
          <span className={`badge ${c.status === 'pending_review' ? 'warn' : ''}`}>{x.status[c.status] || c.status}</span>
        </h1>
        <dl className="facts">
          <div><dt>{x.contact}</dt><dd>{c.contact && c.contact.phone ? <a href={`tel:${c.contact.phone}`}>{c.contact.phone}</a> : x.noPhone}{c.contact && c.contact.language ? ` · ${c.contact.language}` : ''}</dd></div>
          <div><dt>{x.created}</dt><dd>{when(c.createdAt, lang)}</dd></div>
          <div><dt>{x.updated}</dt><dd>{when(c.updatedAt, lang)}</dd></div>
          <div><dt>{x.premium}</dt><dd>{money(c.proposedPremium, c.currency, lang)}</dd></div>
          {c.review && <div><dt>{x.final}</dt><dd>{money(c.finalPremium, c.currency, lang)}</dd></div>}
        </dl>
        <p className="muted">#{c.caseId} · {x.channel[c.channel] || c.channel}</p>
        {error && <p role="alert" className="dash-error">{caseErrorText(error, lang)}</p>}
        {notice && <p role="status" className="feedback ok">{notice}</p>}
      </div>

      {canDecide && (
        <div className="card decision">
          <h2>{x.decide}</h2>
          <label>{x.note}<textarea value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={500} rows={2} /></label>
          <div className="toolbar">
            {c.proposedPremium != null && <button type="button" className="primary" onClick={() => decide('approve')} disabled={busy}>{x.approve} · {money(c.proposedPremium, c.currency, lang)}</button>}
            <button type="button" className="danger" onClick={() => decide('reject')} disabled={busy}>{x.reject}</button>
          </div>
          {e && (
            <form className="adjust" onSubmit={(ev) => { ev.preventDefault(); decide('adjust'); }}>
              <label>{x.amount} ({c.currency})<input inputMode="decimal" value={amount} onChange={(ev) => setAmount(ev.target.value)} required /></label>
              <button type="submit" disabled={busy || !amount}>{x.adjust}</button>
            </form>
          )}
          {!e && <p className="muted">{x.errors.CONVERSATION_NOT_FINISHED}</p>}
        </div>
      )}

      {c.policy && (
        <div className="card">
          <h2>{x.policy}</h2>
          <p><strong>{c.policy.policyNumber}</strong> · {c.policy.startDate} → {c.policy.endDate}</p>
          {can('case:decide') && <button type="button" onClick={resend} disabled={busy}>{x.resend}</button>}
        </div>
      )}

      {c.review && (
        <div className="card">
          <h2>{x.review}</h2>
          <p>{x.status[c.status] || c.status} · {when(c.review.decidedAt, lang)}{c.review.note ? ` · « ${c.review.note} »` : ''}</p>
        </div>
      )}

      <div className="card">
        <h2>{x.engine}</h2>
        {!e && <p className="muted">{x.noEngine}</p>}
        {e && (
          <>
            <dl className="facts">
              <div><dt>{x.recommendation}</dt><dd>{x.rec[e.status] || e.status}</dd></div>
              <div><dt>{x.score}</dt><dd>{e.riskScore} · {valueLabel(lang, e.riskBand)}</dd></div>
              <div><dt>{x.confidence}</dt><dd>{e.confidence != null ? `${Math.round(e.confidence * 100)} %` : '—'}</dd></div>
            </dl>
            {e.reasons.length > 0 && (
              <>
                <h3>{x.reasons}</h3>
                <ul className="reasons">
                  {e.reasons.map((r, i) => <li key={i} className={r.outcome || r.type}><code>{r.code}</code> {r.message}{r.points ? ` (+${r.points})` : ''}</li>)}
                </ul>
              </>
            )}
            {e.premium && (
              <>
                <h3>{x.breakdown}</h3>
                <table className="breakdown"><tbody>
                  {e.premium.breakdown.map((b, i) => <tr key={i}><td>{b.label}</td><td>{money(b.amount, e.premium.currency, lang)}</td></tr>)}
                  <tr className="total"><td>Total</td><td>{money(e.premium.total, e.premium.currency, lang)}</td></tr>
                </tbody></table>
              </>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>{x.answers}</h2>
        <dl className="facts">
          {flatten(c.input).filter(([, v]) => v != null && v !== '').map(([k, v]) => <div key={k}><dt>{f.fields[k] || k}</dt><dd>{answer(v)}</dd></div>)}
        </dl>
      </div>

      <div className="card">
        <h2>{x.documents}</h2>
        {c.documents.length === 0 && <p className="muted">—</p>}
        {c.documents.map((d) => (
          <div key={d.type} className="doc">
            <div className="doc-head">
              <strong>{x.docTypes[d.type] || d.type}</strong>
              <span className="muted">{x.docConfidence} {d.confidence != null ? `${Math.round(d.confidence * 100)} %` : '—'}</span>
              {d.hasFile && <button type="button" onClick={() => openPhoto(d.type)} disabled={busy}>{x.viewPhoto}</button>}
            </div>
            <dl className="facts">{Object.entries(d.fields).map(([k, v]) => <div key={k}><dt>{x.docFields[k] || k}</dt><dd>{String(v)}</dd></div>)}</dl>
          </div>
        ))}
        <h3>{x.flags}</h3>
        {c.documentFlags.length === 0 ? <p className="muted">{x.noFlags}</p> : (
          <ul className="reasons">{c.documentFlags.map((fl, i) => <li key={i} className="refer"><code>{fl.code}</code> {fl.message}</li>)}</ul>
        )}
      </div>

      {can('case:decide') && (
        <form className="card" onSubmit={sendMessage}>
          <h2>{x.message}</h2>
          <p className="muted">{x.messageHelp}</p>
          <textarea value={msg} onChange={(ev) => setMsg(ev.target.value)} maxLength={1000} rows={3} required />
          <button type="submit" disabled={busy || !msg.trim()}>{x.send}</button>
        </form>
      )}

      <div className="card">
        <h2>{x.timeline}</h2>
        <ol className="timeline">
          {c.events.map((ev, i) => (
            <li key={i}><span className="muted">{when(ev.at, lang)}</span> {x.events[ev.type] || ev.type}{ev.payload && ev.payload.decision ? ` · ${ev.payload.decision}` : ''}{ev.actor && ev.actor.kind === 'human' ? ` · ${ev.payload.reviewerRole || ev.payload.role || ''}` : ''}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}
