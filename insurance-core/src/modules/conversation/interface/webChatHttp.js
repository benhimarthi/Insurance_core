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
};

/**
 * POST {web chat URL}/{tenantId}   headers: x-webchat-key (real insurers)
 *   body: { sessionId, text?, messageId?, attachments?: [{ mimeType, filename, dataBase64 }], poll?: true }
 *   -> 200 { messages: [{ kind: 'text', text } | { kind: 'document', filename, url, text }] }
 */
function createWebChatHttp(webChat) {
  return async function handle({ tenantId, headers, body }) {
    const b = body || {};
    try {
      const out = await webChat({
        tenantId, key: headers && headers['x-webchat-key'],
        sessionId: b.sessionId, text: b.text, attachments: b.attachments, messageId: b.messageId, poll: b.poll,
      });
      return { status: 200, body: out };
    } catch (err) {
      if (err instanceof AppError && HTTP[err.message]) {
        const [status, error] = HTTP[err.message];
        return { status, body: { error } };
      }
      throw err;
    }
  };
}

module.exports = { createWebChatHttp };
