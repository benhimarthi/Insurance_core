import { useState, useSyncExternalStore } from 'react';
import { useAuth, useTenants, useInvite } from './hooks.js';
import { errorText, NOTICES } from '../errors.js';
import { t, roleLabel } from '../i18n.js';

/**
 * Ready-made, unstyled components (class names `dash-*`). Needs the "automatic" JSX runtime,
 * which Vite and Next.js use by default. Restyle freely or build your own screens on the hooks.
 */

function Messages({ auth, lang }) {
  const notices = NOTICES[lang] || NOTICES.fr;
  return (
    <>
      {auth.notice && <p role="status" className="dash-notice">{notices[auth.notice]}</p>}
      {auth.error && <p role="alert" className="dash-error">{errorText(auth.error, lang)}</p>}
    </>
  );
}

export function LoginPage({ lang = 'fr', renderQr = null }) {
  const x = t(lang);
  const auth = useAuth();
  const { pending } = useInvite();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const submit = (fn) => (e) => { e.preventDefault(); fn(); };

  switch (auth.status) {
    case 'loading':
      return <p className="dash-loading">{x.loading}</p>;
    case 'ready':
      return null;

    case 'mfa_challenge':
      return (
        <form className="dash-login" onSubmit={submit(() => auth.completeMfa(code))}>
          <h1>{x.mfaTitle}</h1>
          <p>{x.mfaHelp}</p>
          <Messages auth={auth} lang={lang} />
          <label>{x.code}
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} autoFocus />
          </label>
          <button type="submit">{x.confirm}</button>
          <button type="button" onClick={() => auth.cancelMfa()}>{x.cancel}</button>
        </form>
      );

    case 'needs_email_verification':
      return (
        <section className="dash-login">
          <h1>{x.verifyTitle}</h1>
          <p>{x.verifyHelp}</p>
          <Messages auth={auth} lang={lang} />
          <button type="button" onClick={() => auth.refresh()}>{x.verified}</button>
          <button type="button" onClick={() => auth.sendVerificationEmail()}>{x.resend}</button>
          <button type="button" onClick={() => auth.signOut()}>{x.signOut}</button>
        </section>
      );

    case 'needs_mfa_enrollment':
      return (
        <section className="dash-login">
          <h1>{x.enrollTitle}</h1>
          <p>{x.enrollHelp}</p>
          <Messages auth={auth} lang={lang} />
          {!auth.enrollment && <button type="button" onClick={() => auth.startMfaEnrollment()}>{x.enrollStart}</button>}
          {auth.enrollment && (
            <form onSubmit={submit(() => auth.finishMfaEnrollment(code))}>
              {renderQr ? renderQr(auth.enrollment.qrUrl) : null}
              <p>{x.secretKey}: <code className="dash-secret">{auth.enrollment.secretKey}</code></p>
              <label>{x.code}
                <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} />
              </label>
              <button type="submit">{x.confirm}</button>
            </form>
          )}
          <button type="button" onClick={() => auth.signOut()}>{x.signOut}</button>
        </section>
      );

    default: // signed_out
      return (
        <form className="dash-login" onSubmit={submit(() => auth.signIn(email, password))}>
          <h1>{x.signIn}</h1>
          {pending && <p role="note" className="dash-invite">{x.inviteBanner}</p>}
          <Messages auth={auth} lang={lang} />
          <label>{x.email}
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          </label>
          <label>{x.password}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          <button type="submit">{x.signIn}</button>
          {pending && <button type="button" onClick={() => auth.signUp(email, password)}>{x.signUp}</button>}
          <button type="button" onClick={() => auth.resetPassword(email)}>{x.forgot}</button>
        </form>
      );
  }
}

/** The insurer switcher: a label for one insurer, a grouped dropdown for several. */
export function TenantSwitcher({ lang = 'fr' }) {
  const x = t(lang);
  const { choices, activeTenantId, select } = useTenants();
  if (choices.length === 0) return null;
  const label = (c) => `${c.name} - ${roleLabel(lang, c.role)}`;
  if (choices.length === 1) return <span className="dash-tenant">{label(choices[0])}</span>;

  const mine = choices.filter((c) => c.access === 'member');
  const platform = choices.filter((c) => c.access === 'platform');
  return (
    <label className="dash-tenant-switcher">
      <span>{x.insurer}</span>
      <select value={activeTenantId || ''} onChange={(e) => select(e.target.value)} aria-label={x.switching}>
        {!activeTenantId && <option value="" disabled>{x.chooseTitle}</option>}
        {mine.length > 0 && <optgroup label={x.yourGroup}>{mine.map((c) => <option key={c.tenantId} value={c.tenantId}>{label(c)}</option>)}</optgroup>}
        {platform.length > 0 && <optgroup label={x.platformGroup}>{platform.map((c) => <option key={c.tenantId} value={c.tenantId}>{label(c)}</option>)}</optgroup>}
      </select>
    </label>
  );
}

/** Shows children only once an insurer is active; handles loading, errors, "no access" and "choose". */
export function TenantGate({ lang = 'fr', children }) {
  const x = t(lang);
  const s = useTenants();
  const { error: inviteError } = useInvite();

  if (s.status === 'idle' || s.status === 'loading') return <p className="dash-loading">{x.loading}</p>;
  if (s.status === 'error') {
    return (
      <div role="alert" className="dash-error">
        <p>{errorText(s.error, lang)}</p>
        <button type="button" onClick={() => s.refresh()}>{x.retry}</button>
      </div>
    );
  }
  if (s.choices.length === 0) {
    return (
      <section className="dash-no-access">
        <h2>{x.noAccessTitle}</h2>
        <p>{x.noAccessHelp}</p>
        {inviteError && <p role="alert" className="dash-error">{errorText(inviteError, lang)}</p>}
      </section>
    );
  }
  if (!s.activeTenantId) {
    return (
      <section className="dash-choose">
        <h2>{x.chooseTitle}</h2>
        <ul>
          {s.choices.map((c) => (
            <li key={c.tenantId}><button type="button" onClick={() => s.select(c.tenantId)}>{`${c.name} - ${roleLabel(lang, c.role)}`}</button></li>
          ))}
        </ul>
      </section>
    );
  }
  return <>{children}</>;
}

export function RequireAuth({ lang = 'fr', renderQr = null, children }) {
  const auth = useAuth();
  return auth.status === 'ready' ? <>{children}</> : <LoginPage lang={lang} renderQr={renderQr} />;
}

/** Hides UI the role cannot use. Convenience only: the server enforces every permission. */
export function Can({ permission, fallback = null, children }) {
  const { can } = useTenants();
  return can(permission) ? <>{children}</> : fallback;
}

/** Modal for the audit reason. Render once near the root and pass the same asker to createMembersApi. */
export function ReasonDialog({ asker, lang = 'fr' }) {
  const x = t(lang);
  const pending = useSyncExternalStore(asker.subscribe, asker.getState, asker.getState);
  const [text, setText] = useState('');
  if (!pending) return null;
  const done = (value) => { setText(''); asker.resolve(value); };
  return (
    <div role="dialog" aria-modal="true" aria-label={x.reasonTitle} className="dash-reason">
      <form onSubmit={(e) => { e.preventDefault(); done(text); }}>
        <h2>{x.reasonTitle}</h2>
        <p>{x.reasonHelp}</p>
        <label>{x.reasonLabel}
          <textarea value={text} onChange={(e) => setText(e.target.value)} minLength={5} maxLength={300} autoFocus />
        </label>
        <button type="submit" disabled={text.trim().length < 5}>{x.confirm}</button>
        <button type="button" onClick={() => done(null)}>{x.cancel}</button>
      </form>
    </div>
  );
}

/** Login gate + insurer switcher + sign-out around your screens. */
export function DashboardShell({ lang = 'fr', renderQr = null, children }) {
  const x = t(lang);
  const auth = useAuth();
  return (
    <RequireAuth lang={lang} renderQr={renderQr}>
      <header className="dash-header">
        <TenantSwitcher lang={lang} />
        <button type="button" onClick={() => auth.signOut()}>{x.signOut}</button>
      </header>
      <TenantGate lang={lang}>{children}</TenantGate>
    </RequireAuth>
  );
}
