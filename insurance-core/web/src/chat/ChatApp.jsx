import { useCallback, useEffect, useRef, useState } from 'react';
import { createChatApi, fileToAttachment, randomId } from './chatApi.js';

const TEXT = {
  fr: {
    title: 'Assurance auto', subtitle: 'Obtenez votre devis en quelques minutes', placeholder: 'Votre réponse…', send: 'Envoyer',
    attach: 'Joindre un document', demoDocs: 'Documents de démonstration', restart: 'Nouvelle conversation', start: 'Bonjour',
    hello: 'Écrivez « Bonjour » pour commencer.', you: 'Vous', bot: 'Assistant', sending: 'Envoi…', typing: 'L’assistant répond…',
    tooBig: 'Fichier trop lourd (5 Mo maximum).', badType: 'Format accepté : photo (JPEG, PNG, WebP) ou PDF.',
    errors: { network: 'Connexion impossible. Vérifiez votre réseau et réessayez.', unknown_tenant: 'Ce chat n’existe pas.', webchat_not_enabled: 'Ce chat n’est pas encore ouvert.', bad_key: 'Ce chat n’est pas accessible.', app_check_failed: 'Ce navigateur n’a pas pu être vérifié. Rechargez la page.', rate_limited: 'Trop de messages d’un coup. Patientez un instant puis réessayez.', default: 'Une erreur est survenue. Réessayez.' },
    restartConfirm: 'Recommencer une nouvelle conversation ?', privacy: 'Vos réponses servent uniquement à établir votre devis.',
  },
  en: {
    title: 'Car insurance', subtitle: 'Get your quote in a few minutes', placeholder: 'Your answer…', send: 'Send',
    attach: 'Attach a document', demoDocs: 'Demo documents', restart: 'New conversation', start: 'Hello',
    hello: 'Write “Hello” to start.', you: 'You', bot: 'Assistant', sending: 'Sending…', typing: 'The assistant is replying…',
    tooBig: 'File too large (5 MB maximum).', badType: 'Accepted: photo (JPEG, PNG, WebP) or PDF.',
    errors: { network: 'Cannot connect. Check your network and try again.', unknown_tenant: 'This chat does not exist.', webchat_not_enabled: 'This chat is not open yet.', bad_key: 'This chat is not available.', app_check_failed: 'This browser could not be verified. Reload the page.', rate_limited: 'Too many messages at once. Wait a moment and try again.', default: 'Something went wrong. Please try again.' },
    restartConfirm: 'Start a new conversation?', privacy: 'Your answers are only used to prepare your quote.',
  },
};
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const POLL_MS = 5000;
const POLL_FOR_MS = 30 * 60 * 1000; // keep checking for replies (e.g. an underwriter's decision) for 30 minutes
const KEEP_LOG_MS = 24 * 3600 * 1000; // on a shared computer, the next person must not read the conversation
// 1x1 PNG: the demo documents only need a valid file; the scenario is in demoFixture (demo insurers only)
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const store = {
  get(k) { try { return JSON.parse(window.localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: this tab only */ } },
  del(k) { try { window.localStorage.removeItem(k); } catch { /* ignore */ } },
};

/** Plain text with clickable links (payment links later); nothing is rendered as HTML. */
function Linkified({ text }) {
  const parts = String(text).split(/(https?:\/\/[^\s<>"]+)/g);
  return parts.map((p, i) => (/^https?:\/\//.test(p)
    ? <a key={i} href={p} target="_blank" rel="noopener noreferrer">{p}</a>
    : <span key={i}>{p}</span>));
}

export function ChatApp({ tenantId, lang, demo, apiKey, getAppCheckToken = null }) {
  const x = TEXT[lang] || TEXT.fr;
  const sessionKey = `chat.session.${tenantId}`;
  const logKey = (s) => `chat.log.${tenantId}.${s}`;
  // a conversation untouched for 24 hours is forgotten by this browser (a new one starts)
  const [sessionId, setSessionId] = useState(() => {
    const saved = store.get(sessionKey);
    const fresh = saved && typeof saved === 'object' && Date.now() - saved.at < KEEP_LOG_MS;
    if (fresh) return saved.id;
    if (saved) store.del(logKey(typeof saved === 'object' ? saved.id : saved));
    const s = randomId();
    store.set(sessionKey, { id: s, at: Date.now() });
    return s;
  });
  const [log, setLog] = useState(() => store.get(logKey(sessionId)) || []);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const api = useRef(createChatApi({ tenantId, key: apiKey, getAppCheckToken })).current;
  const end = useRef(null);
  const fileInput = useRef(null);
  const lastActivity = useRef(Date.now());

  useEffect(() => {
    store.set(logKey(sessionId), log.slice(-200));
    store.set(sessionKey, { id: sessionId, at: Date.now() }); // activity keeps it for another 24 hours
  }, [log, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current && end.current.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [log, busy]);

  const addBot = (messages) => { if (messages.length) setLog((l) => [...l, ...messages.map((m) => ({ from: 'bot', ...m }))]); };
  const fail = (err) => setError(x.errors[err && err.code] || x.errors.default);

  const send = useCallback(async ({ body, shown }) => {
    setBusy(true); setError(null);
    lastActivity.current = Date.now();
    setLog((l) => [...l, { from: 'me', ...shown }]);
    const messageId = randomId(16);
    try {
      let messages;
      try { messages = await api.send({ sessionId, messageId, ...body }); } catch (err) {
        if (err.code !== 'network') throw err;
        messages = await api.send({ sessionId, messageId, ...body }); // one retry, same id: processed once
      }
      addBot(messages);
    } catch (err) { fail(err); } finally { setBusy(false); }
  }, [api, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // later replies (e.g. an underwriter's decision) arrive by polling while the page is open and recent
  useEffect(() => {
    if (!log.length) return undefined;
    const id = setInterval(async () => {
      if (document.hidden || busy || Date.now() - lastActivity.current > POLL_FOR_MS) return;
      try { addBot(await api.poll({ sessionId })); } catch { /* next time */ }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [api, sessionId, busy, log.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    send({ body: { text: t }, shown: { text: t } });
  };

  const onFiles = async (e) => {
    const files = Array.from(e.target.files || []).slice(0, 3);
    e.target.value = '';
    if (!files.length) return;
    if (files.some((f) => !TYPES.includes(f.type))) { setError(x.badType); return; }
    if (files.some((f) => f.size > MAX_BYTES)) { setError(x.tooBig); return; }
    const attachments = await Promise.all(files.map(fileToAttachment));
    send({ body: { text: '', attachments }, shown: { files: files.map((f) => f.name) } });
  };

  const sendDemoDocs = () => send({
    body: { text: '', attachments: [
      { mimeType: 'image/png', filename: 'demo-cin.png', dataBase64: PIXEL, demoFixture: 'demo_id_ok' },
      { mimeType: 'image/png', filename: 'demo-carte-grise.png', dataBase64: PIXEL, demoFixture: 'demo_registration_ok' },
    ] },
    shown: { files: ['demo-cin.png', 'demo-carte-grise.png'] },
  });

  const restart = () => {
    if (log.length && !window.confirm(x.restartConfirm)) return;
    store.del(logKey(sessionId));
    const s = randomId();
    store.set(sessionKey, { id: s, at: Date.now() });
    setSessionId(s); setLog([]); setError(null);
  };

  return (
    <div className="chat">
      <header className="chat-head">
        <div>
          <h1>{x.title}</h1>
          <p>{x.subtitle}</p>
        </div>
        <button type="button" className="ghost" onClick={restart}>{x.restart}</button>
      </header>

      <main className="chat-log" aria-live="polite">
        {log.length === 0 && (
          <div className="chat-empty">
            <p>{x.hello}</p>
            <button type="button" onClick={() => send({ body: { text: x.start }, shown: { text: x.start } })} disabled={busy}>{x.start}</button>
          </div>
        )}
        {log.map((m, i) => (
          <div key={i} className={`bubble ${m.from}`}>
            <span className="sr-only">{m.from === 'me' ? x.you : x.bot} : </span>
            {m.files ? <span className="files">📎 {m.files.join(', ')}</span> : null}
            {m.kind === 'document'
              ? <span><Linkified text={m.text || ''} /> <a href={m.url} target="_blank" rel="noopener noreferrer">📄 {m.filename}</a></span>
              : m.text ? <Linkified text={m.text} /> : null}
          </div>
        ))}
        {busy && <div className="bubble bot typing" aria-label={x.typing}><span /><span /><span /></div>}
        <div ref={end} />
      </main>

      {error && <p role="alert" className="chat-error">{error}</p>}

      <form className="composer" onSubmit={submit}>
        <button type="button" className="icon" onClick={() => fileInput.current && fileInput.current.click()} disabled={busy} aria-label={x.attach} title={x.attach}>📎</button>
        <input ref={fileInput} type="file" accept={TYPES.join(',')} multiple hidden onChange={onFiles} />
        <input className="text" value={text} onChange={(e) => setText(e.target.value)} placeholder={x.placeholder} maxLength={1000} aria-label={x.placeholder} enterKeyHint="send" autoComplete="off" />
        <button type="submit" disabled={busy || !text.trim()}>{busy ? x.sending : x.send}</button>
      </form>
      <footer className="chat-foot">
        {demo && <button type="button" className="ghost" onClick={sendDemoDocs} disabled={busy}>{x.demoDocs}</button>}
        <span>{x.privacy}</span>
      </footer>
    </div>
  );
}
