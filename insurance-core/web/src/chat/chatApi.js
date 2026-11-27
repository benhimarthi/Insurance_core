// Client of the web chat endpoint (served on the same origin through Firebase Hosting).
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const randomId = (n = 24) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ID_CHARS[b % 64]).join('');

export class ChatError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

/** getAppCheckToken: optional async () => token (Firebase App Check), sent as x-firebase-appcheck. */
export function createChatApi({ tenantId, key = null, getAppCheckToken = null, fetchImpl = (...a) => fetch(...a), base = '/api/webchat' }) {
  async function post(body) {
    let res;
    try {
      const appCheck = getAppCheckToken ? await getAppCheckToken().catch(() => null) : null;
      res = await fetchImpl(`${base}/${encodeURIComponent(tenantId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { 'x-webchat-key': key } : {}), ...(appCheck ? { 'x-firebase-appcheck': appCheck } : {}) },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ChatError('network', 0);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new ChatError(data.error || 'server', res.status), { retryAfterSec: data.retryAfterSec || null });
    return data.messages || [];
  }
  return {
    // the same messageId on a retry: the server processes a message once
    send: ({ sessionId, text, attachments, messageId = randomId(16) }) => post({ sessionId, text, attachments, messageId }),
    poll: ({ sessionId }) => post({ sessionId, poll: true }),
  };
}

/** A File -> { mimeType, filename, dataBase64 } (the endpoint takes at most 5 MB per file). */
export function fileToAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ mimeType: file.type, filename: file.name, dataBase64: String(reader.result).split(',')[1] || '' });
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
