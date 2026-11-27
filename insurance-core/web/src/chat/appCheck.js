// Firebase App Check for the chat page: proves requests come from this page in a real browser.
// Loaded only when VITE_RECAPTCHA_SITE_KEY is set, so the page stays small otherwise.
import { firebaseConfig } from '../firebaseConfig.js';

export async function createAppCheckTokenGetter(siteKey) {
  if (!siteKey) return null;
  const [{ initializeApp }, { initializeAppCheck, ReCaptchaEnterpriseProvider, getToken }] = await Promise.all([
    import('firebase/app'), import('firebase/app-check'),
  ]);
  const app = initializeApp(firebaseConfig, 'chat');
  const appCheck = initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(siteKey), isTokenAutoRefreshEnabled: true });
  return async () => (await getToken(appCheck, false)).token;
}
