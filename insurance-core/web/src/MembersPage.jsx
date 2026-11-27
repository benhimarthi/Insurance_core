import { useCallback, useEffect, useState } from 'react';
import { useDashboard, useTenants, Can } from 'insurance-dashboard-auth/react';
import { buildInviteLink, errorText, roleLabel } from 'insurance-dashboard-auth';

const ROLES = ['tenant_admin', 'underwriter', 'underwriting_manager', 'auditor'];
const TEXT = {
  fr: { title: 'Membres', invite: 'Inviter', email: 'E-mail', role: 'Rôle', send: 'Créer l’invitation', link: 'Lien d’invitation (à envoyer à la personne, valable 7 jours, une seule fois) :',
    copy: 'Copier', pending: 'Invitations en attente', revoke: 'Annuler', disable: 'Désactiver', enable: 'Réactiver', remove: 'Retirer', confirmRemove: 'Retirer ce membre ?',
    none: 'Aucun membre.', noAccess: 'Votre rôle ne permet pas de voir les membres.', status: { active: 'actif', disabled: 'désactivé' }, expires: 'expire le' },
  en: { title: 'Members', invite: 'Invite', email: 'Email', role: 'Role', send: 'Create invitation', link: 'Invitation link (send it to the person; valid 7 days, single use):',
    copy: 'Copy', pending: 'Pending invitations', revoke: 'Revoke', disable: 'Disable', enable: 'Enable', remove: 'Remove', confirmRemove: 'Remove this member?',
    none: 'No members.', noAccess: 'Your role cannot see members.', status: { active: 'active', disabled: 'disabled' }, expires: 'expires' },
};

/** Member management for the active insurer. Every action is checked again by the server. */
export function MembersPage({ lang = 'fr' }) {
  const x = TEXT[lang] || TEXT.fr;
  const { api } = useDashboard();
  const { active, can } = useTenants();
  const tenantId = active && active.tenantId;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [link, setLink] = useState(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('underwriter');

  const load = useCallback(async () => {
    if (!tenantId || !can('members:read')) return;
    try { setData(await api.list(tenantId)); setError(null); } catch (err) { setError(err); }
  }, [api, tenantId, can]);
  useEffect(() => { setData(null); setLink(null); load(); }, [load]);

  const run = (fn) => async (...args) => {
    try { setError(null); await fn(...args); await load(); } catch (err) { setError(err); }
  };
  const invite = run(async (e) => {
    e.preventDefault();
    const res = await api.invite(tenantId, { email, role });
    setLink(buildInviteLink(window.location.origin, { tenantId, invitationId: res.invitationId, token: res.token }));
    setEmail('');
  });

  if (!tenantId) return null;
  if (!can('members:read')) return <p>{x.noAccess}</p>;

  return (
    <main className="members">
      <h1>{x.title} · {active.name}</h1>
      {error && <p role="alert" className="dash-error">{errorText(error, lang)}</p>}

      <Can permission="members:manage">
        <form className="invite" onSubmit={invite}>
          <h2>{x.invite}</h2>
          <label>{x.email}<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>{x.role}
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => <option key={r} value={r}>{roleLabel(lang, r)}</option>)}
            </select>
          </label>
          <button type="submit">{x.send}</button>
        </form>
        {link && (
          <p className="invite-link">{x.link}<br /><code>{link}</code>{' '}
            <button type="button" onClick={() => navigator.clipboard && navigator.clipboard.writeText(link)}>{x.copy}</button>
          </p>
        )}
      </Can>

      {data && (
        <>
          <table>
            <thead><tr><th>{x.email}</th><th>{x.role}</th><th /><th /></tr></thead>
            <tbody>
              {data.members.length === 0 && <tr><td colSpan="4">{x.none}</td></tr>}
              {data.members.map((m) => (
                <tr key={m.uid}>
                  <td>{m.email || m.uid}</td>
                  <td>{roleLabel(lang, m.role)}</td>
                  <td>{x.status[m.status] || m.status}</td>
                  <td>
                    <Can permission="members:manage">
                      <button type="button" onClick={run(() => api.setStatus(tenantId, m.uid, m.status === 'active' ? 'disabled' : 'active'))}>
                        {m.status === 'active' ? x.disable : x.enable}
                      </button>
                      <button type="button" onClick={run(async () => { if (window.confirm(x.confirmRemove)) await api.remove(tenantId, m.uid); })}>{x.remove}</button>
                    </Can>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {data.invitations.length > 0 && (
            <>
              <h2>{x.pending}</h2>
              <ul>
                {data.invitations.map((i) => (
                  <li key={i.id}>
                    {i.email} · {roleLabel(lang, i.role)} · {x.expires} {new Date(i.expiresAt).toLocaleDateString(lang)}{' '}
                    <Can permission="members:manage"><button type="button" onClick={run(() => api.revokeInvitation(tenantId, i.id))}>{x.revoke}</button></Can>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </main>
  );
}
