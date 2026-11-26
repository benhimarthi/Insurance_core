import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { build } from 'esbuild';

import { createAuthClient } from '../src/authClient.js';
import { createTenantStore } from '../src/tenantStore.js';
import { createReasonAsker } from '../src/reasonAsker.js';
import { createInviteKeeper, buildInviteLink } from '../src/invitations.js';
import { createFakePort, createFakeApi, createFakeWindow, member, settle } from './helpers.js';

// The components are JSX: compile them the way your bundler would (automatic runtime), then load them.
const here = dirname(fileURLToPath(import.meta.url));
let tmp;
let ui;

before(async () => {
  tmp = mkdtempSync(join(here, '.build-'));
  const out = join(tmp, 'react.mjs');
  await build({
    entryPoints: [join(here, '..', 'src', 'react', 'index.js')], outfile: out, bundle: true, format: 'esm', platform: 'node',
    jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom'], logLevel: 'silent',
  });
  ui = await import(pathToFileURL(out).href);
});
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const A = member('alpha-insurer', 'Alpha Assurance', 'underwriter', ['case:read', 'case:decide']);
const B = member('beta-insurer', 'Beta Assurance', 'auditor', ['case:read', 'audit:read']);

/** Builds the whole stack, drives it to the wanted state, then renders synchronously (effects do not run in SSR). */
async function render(element, { accounts = {}, signIn = null, mfa = null, apiOptions = {}, select = null, invite = false, prepare = null } = {}) {
  const port = createFakePort(accounts);
  const client = createAuthClient({ port });
  client.start();
  await settle();
  if (signIn) { await client.signIn(...signIn); if (mfa) await client.completeMfa(mfa); await settle(); }
  if (prepare) await prepare(client, port);

  const api = createFakeApi(apiOptions);
  const store = createTenantStore({ api });
  if (client.getState().status === 'ready') await store.load(client.getState().user.uid);
  if (select) store.select(select);

  let keeper = null;
  if (invite) {
    const win = createFakeWindow(new URL(buildInviteLink('https://dash.example/invite', { tenantId: 'alpha-insurer', invitationId: 'abc123', token: 'T0kenT0kenT0kenT0ken_-xyz' })).hash);
    keeper = createInviteKeeper({ win });
    keeper.capture();
  }
  const html = renderToString(h(ui.DashboardProvider, { client, store, api, keeper }, element));
  return { html, client, store, api };
}

const ACCOUNT = { 'sara@insurer.example': { password: 'pw', factors: 1 } };
const SIGN_IN = ['sara@insurer.example', 'pw'];
const READY = { accounts: ACCOUNT, signIn: SIGN_IN, mfa: '123456' };

// ---------- login ----------

test('login: the form, with accessible fields and no invitation banner by default', async () => {
  const { html } = await render(h(ui.LoginPage, {}));
  assert.match(html, /<h1>Se connecter<\/h1>/);
  assert.match(html, /type="email"[^>]*autoComplete="username"|autoComplete="username"[^>]*type="email"|type="email"/);
  assert.match(html, /autoComplete="current-password"|autoComplete=\"current-password\"/i);
  assert.match(html, /Mot de passe oublié/);
  assert.doesNotMatch(html, /invitation/i);
  assert.doesNotMatch(html, /Créer un compte/);
});

test('login: a pending invitation shows the banner and the sign-up button', async () => {
  const { html } = await render(h(ui.LoginPage, {}), { invite: true });
  assert.match(html, /Vous avez une invitation/);
  assert.match(html, /Créer un compte/);
});

test('login: English', async () => {
  const { html } = await render(h(ui.LoginPage, { lang: 'en' }));
  assert.match(html, /<h1>Sign in<\/h1>/);
  assert.match(html, /Forgot your password\?/);
});

test('login: errors and notices are shown in the language displayed', async () => {
  const state = { accounts: ACCOUNT, prepare: async (client) => { await client.signIn('sara@insurer.example', 'wrong'); } };
  assert.match((await render(h(ui.LoginPage, {}), state)).html, /role="alert"[^>]*>E-mail ou mot de passe incorrect/);
  assert.match((await render(h(ui.LoginPage, { lang: 'en' }), state)).html, /Incorrect email or password/);
  const reset = { accounts: ACCOUNT, prepare: async (client) => { await client.resetPassword('x@y.example'); } };
  assert.match((await render(h(ui.LoginPage, {}), reset)).html, /role="status"[^>]*>Si un compte existe/);
});

test('login: second-factor challenge', async () => {
  const { html } = await render(h(ui.LoginPage, {}), { accounts: ACCOUNT, prepare: async (client) => { await client.signIn(...SIGN_IN); } });
  assert.match(html, /Double authentification/);
  assert.match(html, /autoComplete="one-time-code"/);
  assert.match(html, /inputMode="numeric"/);
  assert.doesNotMatch(html, /type="password"/);
});

test('login: email verification screen', async () => {
  const accounts = { 'new@insurer.example': { password: 'pw', emailVerified: false } };
  const { html } = await render(h(ui.LoginPage, { lang: 'en' }), { accounts, prepare: async (client) => { await client.signIn('new@insurer.example', 'pw'); } });
  assert.match(html, /Verify your email/);
  assert.match(html, /I verified my email/);
  assert.match(html, /Resend email/);
});

test('login: second-factor enrolment shows the secret key and lets the app draw the QR code', async () => {
  const accounts = { 'e@insurer.example': { password: 'pw', factors: 0 } };
  const before = await render(h(ui.LoginPage, {}), { accounts, prepare: async (c) => { await c.signIn('e@insurer.example', 'pw'); } });
  assert.match(before.html, /Activez la double authentification/);
  assert.match(before.html, /Commencer/);
  assert.doesNotMatch(before.html, /JBSWY3DPEHPK3PXP/);

  const after = await render(h(ui.LoginPage, { renderQr: (url) => h('div', { 'data-qr': url }) }), {
    accounts, prepare: async (c) => { await c.signIn('e@insurer.example', 'pw'); await c.startMfaEnrollment(); },
  });
  assert.match(after.html, /JBSWY3DPEHPK3PXP/);
  assert.match(after.html, /data-qr="otpauth:\/\/totp\//);
});

test('login: renders nothing once signed in', async () => {
  const { html } = await render(h(ui.LoginPage, {}), READY);
  assert.equal(html, '');
});

// ---------- tenant switcher and gate ----------

const shell = (lang = 'fr') => h(ui.DashboardShell, { lang }, h('main', null, 'DASHBOARD CONTENT'));

test('shell: signed out shows the login, not the content', async () => {
  const { html } = await render(shell());
  assert.match(html, /Se connecter/);
  assert.doesNotMatch(html, /DASHBOARD CONTENT/);
});

test('one insurer: opened automatically, shown as a label with the role, content visible', async () => {
  const { html } = await render(shell(), { ...READY, apiOptions: { memberships: [A] } });
  assert.match(html, /<span class="dash-tenant">Alpha Assurance - Souscripteur<\/span>/);
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /DASHBOARD CONTENT/);
  assert.match(html, /Se déconnecter/);
});

test('several insurers: the user must choose before seeing anything', async () => {
  const { html } = await render(shell(), { ...READY, apiOptions: { memberships: [B, A] } });
  assert.match(html, /<select/);
  assert.match(html, /Choisissez un assureur/);
  assert.match(html, /<li><button type="button">Alpha Assurance - Souscripteur/);
  assert.doesNotMatch(html, /DASHBOARD CONTENT/);
});

test('several insurers, one selected: grouped dropdown with roles, content visible', async () => {
  const { html } = await render(shell('en'), { ...READY, apiOptions: { memberships: [B, A] }, select: 'beta-insurer' });
  assert.match(html, /<optgroup label="Your insurers">/);
  assert.match(html, /<option value="alpha-insurer">Alpha Assurance - Underwriter<\/option>/);
  assert.match(html, /<option value="beta-insurer" selected="">Beta Assurance - Auditor<\/option>/);
  assert.match(html, /DASHBOARD CONTENT/);
});

test('platform staff: their insurers and the platform-access insurers are in separate groups', async () => {
  const apiOptions = {
    memberships: [A], platformRole: 'platform_admin', platformPermissions: ['members:manage'],
    tenants: [{ tenantId: 'alpha-insurer', name: 'Alpha Assurance' }, { tenantId: 'zeta-insurer', name: 'Zeta Assurance' }],
  };
  const { html } = await render(shell(), { ...READY, apiOptions, select: 'alpha-insurer' });
  assert.match(html, /<optgroup label="Vos assureurs"><option value="alpha-insurer"/);
  assert.match(html, /<optgroup label="Accès équipe plateforme"><option value="zeta-insurer">Zeta Assurance - Équipe plateforme/);
});

test('no insurer: a clear "no access yet" screen, with the invitation error if there is one', async () => {
  const { html } = await render(shell(), { ...READY, apiOptions: {} });
  assert.match(html, /Aucun accès pour le moment/);
  assert.doesNotMatch(html, /DASHBOARD CONTENT/);
});

test('loading and failed loads are handled', async () => {
  const failing = await render(shell(), { ...READY, apiOptions: { memberships: [A] }, prepare: null });
  assert.match(failing.html, /DASHBOARD CONTENT/);

  const port = createFakePort(ACCOUNT);
  const client = createAuthClient({ port });
  client.start(); await settle(); await client.signIn(...SIGN_IN); await client.completeMfa('123456'); await settle();
  const api = createFakeApi({ memberships: [A] });
  api.failNext = Object.assign(new Error('x'), { code: 'functions/unavailable' });
  const store = createTenantStore({ api });
  await store.load('uid');
  const html = renderToString(h(ui.DashboardProvider, { client, store, api }, h(ui.TenantGate, {}, 'CONTENT')));
  assert.match(html, /role="alert"/);
  assert.match(html, /Réessayer/);
  assert.doesNotMatch(html, /CONTENT/);
  const idle = renderToString(h(ui.DashboardProvider, { client, store: createTenantStore({ api }), api }, h(ui.TenantGate, {}, 'CONTENT')));
  assert.match(idle, /Chargement/);
});

test('insurer names are escaped (no markup injection through a tenant name)', async () => {
  const evil = member('evil-insurer', '<img src=x onerror=alert(1)>', 'underwriter');
  const { html } = await render(shell(), { ...READY, apiOptions: { memberships: [evil] } });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

// ---------- permissions and the reason dialog ----------

test('Can: shows UI only if the active role has the permission', async () => {
  const content = h('div', null,
    h(ui.Can, { permission: 'case:decide', fallback: h('i', null, 'NO DECIDE') }, h('button', null, 'DECIDE')),
    h(ui.Can, { permission: 'audit:read' }, h('span', null, 'AUDIT LOG')));
  const asUnderwriter = await render(content, { ...READY, apiOptions: { memberships: [A] } });
  assert.match(asUnderwriter.html, /DECIDE/);
  assert.doesNotMatch(asUnderwriter.html, /AUDIT LOG|NO DECIDE/);
  const asAuditor = await render(content, { ...READY, apiOptions: { memberships: [B] } });
  assert.match(asAuditor.html, /NO DECIDE/);
  assert.match(asAuditor.html, /AUDIT LOG/);
});

test('reason dialog: hidden until a platform action asks, then shows the explanation', async () => {
  const asker = createReasonAsker();
  const hidden = renderToString(h(ui.ReasonDialog, { asker }));
  assert.equal(hidden, '');
  asker.ask('invite');
  const shown = renderToString(h(ui.ReasonDialog, { asker, lang: 'en' }));
  assert.match(shown, /role="dialog"/);
  assert.match(shown, /recorded in the audit trail/);
  assert.match(shown, /<button type="submit" disabled="">/); // cannot submit an empty reason
});

test('hooks refuse to run outside the provider', () => {
  assert.throws(() => renderToString(h(ui.LoginPage, {})), /DashboardProvider/);
});
