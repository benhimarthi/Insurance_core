'use strict';

const { AppError } = require('../../../shared/errors');

/** Stable error code -> HTTP answer of the web chat endpoint (the page relies on these bodies). */
const HTTP = {
  UNKNOWN_TENANT: [404, 'unknown_tenant'],
  BAD_KEY: [401, 'bad_key'],
  WEBCHAT_NOT_ENABLED: [401, 'webchat_not_enabled'],
  BAD_SESSION: [400, 'bad_session'],
  BAD_TEXT: [400, 'bad_text'],
  BAD_MESSAGE_ID: [400, 'bad_message_id'],
  RATE_LIMITED: [429, 'rate_limited'],
};

const APP_CHECK_MODES = ['off', 'monitor', 'enforce'];

/**
 * POST {web chat URL}/{tenantId}   headers: x-webchat-key (real insurers), x-firebase-appcheck
 *   body: { sessionId, text?, messageId?, attachments?: [{ mimeType, filename, dataBase64 }], poll?: true }
 *   -> 200 { messages: [{ kind: 'text', text } | { kind: 'document', filename, url, text }] }
 */
/**
 * appCheck: { mode, verify(token) -> Promise<boolean> }. Firebase App Check proves the request comes
 * from your chat page in a real browser (reCAPTCHA), not from a script.
 *   off      not checked (until the page is set up with a reCAPTCHA key)
 *   monitor  checked and logged, never refused: switch it on first and watch the logs
 *   enforce  requests without a valid token are refused (401 app_check_failed)
 */
function createWebChatHttp(webChat, { appCheck = { mode: 'off' }, logger = console } = {}) {
  const mode = APP_CHECK_MODES.includes(appCheck.mode) ? appCheck.mode : 'off';

  async function appCheckPasses(headers) {
    if (mode === 'off') return true;
    const token = headers && headers['x-firebase-appcheck'];
    let ok = false;
    try { ok = !!token && await appCheck.verify(token); } catch { ok = false; }
    if (!ok) logger.warn(`web chat: ${token ? 'invalid' : 'missing'} App Check token (${mode})`);
    return ok || mode === 'monitor';
  }

  return async function handle({ tenantId, headers, body, clientIp }) {
    const b = body || {};
    if (!(await appCheckPasses(headers))) return { status: 401, body: { error: 'app_check_failed' } };
    try {
      const out = await webChat({
        tenantId, key: headers && headers['x-webchat-key'], clientIp,
        sessionId: b.sessionId, text: b.text, attachments: b.attachments, messageId: b.messageId, poll: b.poll,
      });
      return { status: 200, body: out };
    } catch (err) {
      if (err instanceof AppError && HTTP[err.message]) {
        const [status, error] = HTTP[err.message];
        const retry = err.details && err.details.retryAfterSec;
        return { status, body: retry ? { error, retryAfterSec: retry } : { error }, ...(retry ? { headers: { 'retry-after': String(retry) } } : {}) };
      }
      throw err;
    }
  };
}

module.exports = { createWebChatHttp };
