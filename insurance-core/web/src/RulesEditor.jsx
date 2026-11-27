import { useCallback, useEffect, useRef, useState } from 'react';
import { texts } from './texts.js';
import { messageOf, reasonOf } from './tenantsApi.js';

const pretty = (config) => (config ? JSON.stringify(config, null, 2) : '{\n}');

/** JSON.parse with a line and column for the person editing (engines word their errors differently). */
function parseJson(text) {
  try { return { value: JSON.parse(text) }; } catch (e) {
    const msg = String(e.message || e);
    let pos = null;
    const atPos = /position (\d+)/.exec(msg);
    const lineCol = /line (\d+) column (\d+)/.exec(msg);
    if (atPos) pos = Number(atPos[1]);
    else if (lineCol) {
      const lines = text.split('\n');
      pos = lines.slice(0, Number(lineCol[1]) - 1).reduce((n, l) => n + l.length + 1, 0) + Number(lineCol[2]) - 1;
    }
    if (pos === null) return { error: { line: 1, col: 1, pos: 0, message: msg } };
    const before = text.slice(0, pos).split('\n');
    return { error: { line: before.length, col: before[before.length - 1].length + 1, pos, message: msg.replace(/\s*\(line \d+ column \d+\)/, '').replace(/ in JSON at position \d+.*/, '') } };
  }
}

/**
 * The rules JSON editor of one insurer: check, save as a new revision with a reason, history,
 * view and restore. The server is the judge (same validator as the save); the browser only
 * catches JSON syntax errors early and points at them.
 */
export function RulesEditor({ api, tenantId, rules, canWrite, lang }) {
  const x = texts(lang).rules;
  const common = texts(lang).common;
  const area = useRef(null);
  const [revision, setRevision] = useState(rules.revision);
  const [meta, setMeta] = useState({ updatedAt: rules.updatedAt, updatedBy: rules.updatedBy, updatedByEmail: rules.updatedByEmail });
  const [baseline, setBaseline] = useState(pretty(rules.config));
  const [text, setText] = useState(pretty(rules.config));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null); // { kind: ok|error|conflict, text, errors?, current? }
  const [history, setHistory] = useState(null);
  const [viewing, setViewing] = useState(null); // a version with its config
  const [restoreNote, setRestoreNote] = useState('');
  const dirty = text !== baseline;

  const loadHistory = useCallback(async () => {
    try { setHistory((await api.listVersions(tenantId)).versions); } catch { setHistory([]); }
  }, [api, tenantId]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = x.leave; return x.leave; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, x.leave]);

  const showJsonError = (err) => {
    setFeedback({ kind: 'error', text: x.jsonError(err.line, err.col, err.message) });
    const el = area.current;
    if (el) { el.focus(); el.setSelectionRange(err.pos, Math.min(err.pos + 1, text.length)); }
  };

  const parsed = () => {
    const r = parseJson(text);
    if (r.error) { showJsonError(r.error); return null; }
    return r.value;
  };

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } catch (err) {
      const reason = reasonOf(err);
      if (reason === 'CONFIG_INVALID') setFeedback({ kind: 'error', text: x.invalidTitle(err.details.errors.length), errors: err.details.errors });
      else if (reason === 'CONFIG_CHANGED') setFeedback({ kind: 'conflict', text: x.changed(err.details && err.details.currentRevision), current: err.details && err.details.currentRevision });
      else if (reason !== 'REASON_CANCELLED') setFeedback({ kind: 'error', text: messageOf(err, lang) });
    } finally { setBusy(false); }
  };

  const format = () => { const v = parsed(); if (v) { setText(pretty(v)); setFeedback(null); } };

  const check = () => run(async () => {
    const v = parsed();
    if (!v) return;
    const res = await api.checkRules(tenantId, v);
    setFeedback(res.ok ? { kind: 'ok', text: x.valid } : { kind: 'error', text: x.invalidTitle(res.errors.length), errors: res.errors });
  });

  const afterSave = async (res) => {
    const fresh = await api.get(tenantId);
    const t = pretty(fresh.rules.config);
    setRevision(fresh.rules.revision);
    setMeta({ updatedAt: fresh.rules.updatedAt, updatedBy: fresh.rules.updatedBy, updatedByEmail: fresh.rules.updatedByEmail });
    setBaseline(t); setText(t); setNote(''); setRestoreNote(''); setViewing(null);
    setFeedback({ kind: 'ok', text: x.saved(res.revision) });
    loadHistory();
  };

  const save = () => run(async () => {
    const v = parsed();
    if (!v) return;
    const res = await api.updateRules(tenantId, { config: v, expectedRevision: revision, reason: note });
    await afterSave(res);
  });

  const reload = () => run(async () => {
    const fresh = await api.get(tenantId);
    const t = pretty(fresh.rules.config);
    setRevision(fresh.rules.revision);
    setMeta({ updatedAt: fresh.rules.updatedAt, updatedBy: fresh.rules.updatedBy, updatedByEmail: fresh.rules.updatedByEmail });
    setBaseline(t); setText(t); setFeedback(null);
    loadHistory();
  });

  const view = (rev) => run(async () => { setViewing(await api.getVersion(tenantId, rev)); setRestoreNote(''); });
  const restore = () => run(async () => {
    const res = await api.restoreVersion(tenantId, { revision: viewing.revision, expectedRevision: revision, reason: restoreNote });
    await afterSave(res);
  });

  const onKeyDown = (e) => {
    if (e.key === 'Tab' && !e.shiftKey && canWrite) { // two spaces instead of leaving the editor
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: end } = el;
      const next = `${text.slice(0, s)}  ${text.slice(end)}`;
      setText(next);
      requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
    }
  };

  const when = (iso) => (iso ? new Date(iso).toLocaleString(lang) : '');

  return (
    <section className="rules">
      <div className="rules-head">
        <h2>{x.title}</h2>
        <p className="muted">
          {x.revision} {revision || 0}
          {meta.updatedAt ? ` · ${when(meta.updatedAt)} ${x.by} ${meta.updatedByEmail || meta.updatedBy}` : ` · ${x.never}`}
          {dirty && <span className="badge warn">{x.unsaved}</span>}
        </p>
      </div>
      {!canWrite && <p className="muted">{x.readOnly}</p>}

      <textarea
        ref={area} className="json" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown}
        readOnly={!canWrite || busy} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" rows={28} aria-label={x.title}
      />

      <div className="toolbar">
        {canWrite && <button type="button" onClick={format} disabled={busy}>{x.format}</button>}
        <button type="button" onClick={check} disabled={busy}>{x.check}</button>
        {canWrite && dirty && <button type="button" onClick={() => { setText(baseline); setFeedback(null); }} disabled={busy}>{x.reset}</button>}
      </div>

      {feedback && (
        <div role={feedback.kind === 'ok' ? 'status' : 'alert'} className={`feedback ${feedback.kind}`}>
          <p>{feedback.text}</p>
          {feedback.errors && (
            <ul className="errors">{feedback.errors.map((e, i) => <li key={i}><code>{e.path || '(root)'}</code> {e.message}</li>)}</ul>
          )}
          {feedback.kind === 'conflict' && <button type="button" onClick={reload} disabled={busy}>{x.reload}</button>}
        </div>
      )}

      {canWrite && (
        <form className="save" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <label>{common.note}
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={common.notePh} minLength={5} maxLength={500} required />
          </label>
          <button type="submit" disabled={busy || !dirty || note.trim().length < 5}>{x.saveAs((revision || 0) + 1)}</button>
        </form>
      )}

      <h3>{x.history}</h3>
      {history === null && <p className="muted">{common.loading}</p>}
      {history && history.length === 0 && <p className="muted">{x.noHistory}</p>}
      {history && history.length > 0 && (
        <ul className="history">
          {history.map((v) => (
            <li key={v.revision}>
              <span><strong>{x.revision} {v.revision}</strong>{v.revision === revision && <span className="badge">{x.current}</span>}</span>
              <span className="muted">{when(v.savedAt)} · {v.savedByEmail || v.savedBy}{v.restoredFrom ? ` · ${x.restored(v.restoredFrom)}` : ''}</span>
              <span className="note">{v.note}</span>
              <button type="button" onClick={() => view(v.revision)} disabled={busy}>{x.view}</button>
            </li>
          ))}
        </ul>
      )}

      {viewing && (
        <div className="viewer">
          <div className="viewer-head">
            <strong>{x.viewing(viewing.revision)}</strong>
            <button type="button" onClick={() => setViewing(null)}>{common.close}</button>
          </div>
          <pre className="json">{pretty(viewing.config)}</pre>
          {canWrite && viewing.revision !== revision && (
            <form className="save" onSubmit={(e) => { e.preventDefault(); restore(); }}>
              <label>{x.restoreNote}
                <input value={restoreNote} onChange={(e) => setRestoreNote(e.target.value)} minLength={5} maxLength={500} required />
              </label>
              <button type="submit" disabled={busy || restoreNote.trim().length < 5}>{x.restore} → {x.revision} {(revision || 0) + 1}</button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
