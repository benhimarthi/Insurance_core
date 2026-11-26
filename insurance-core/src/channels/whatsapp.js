'use strict';

const { safeEqual } = require('../server/util');

/**
 * Channel interface used by the server layer:
 *   verifyRequest(headers) -> boolean
 *   parseInbound(body)     -> [{ messageId, from, text, attachments: [{ mimeType, filename, ... }] }]
 *   sendText(to, text)
 *   sendDocument(to, { url, filename, mimeType, caption })
 *   downloadMedia(attachment) -> Promise<Buffer>
 *
 * WaSender implementation. Grounded in WaSender's public docs and SDKs:
 *   - send:    POST {baseUrl}/send-message, Bearer session API key, body { to, text }
 *   - webhook: header x-webhook-signature equals the webhook secret (a shared secret, not an HMAC);
 *              event "messages.received" with data.messages.{ key.id, key.cleanedSenderPn, key.fromMe, messageBody }
 * NOT verified against live WaSender (check them against the WaSender adapter you already use in
 * Winnyx and adjust only this file): document sending (documentUrl/fileName fields) and media
 * download (the /decrypt-media endpoint, and the imageMessage/documentMessage payload shape).
 */
function createWaSenderChannel({ apiKey, webhookSecret, baseUrl = 'https://www.wasenderapi.com/api', fetchImpl = fetch }) {
  const digits = (s) => String(s || '').replace(/\D/g, '');

  async function post(endpoint, payload) {
    const res = await fetchImpl(`${baseUrl}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`WaSender ${endpoint} failed with HTTP ${res.status}`);
    return res.json();
  }

  return {
    verifyRequest(headers) {
      return safeEqual(headers && headers['x-webhook-signature'], webhookSecret);
    },

    parseInbound(body) {
      if (!body || body.event !== 'messages.received') return [];
      const raw = body.data && body.data.messages;
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const out = [];
      for (const m of list) {
        if (!m || !m.key || m.key.fromMe) continue; // ignore our own echoes
        const from = digits(m.key.cleanedSenderPn);
        if (!from || !m.key.id) continue;
        const attachments = [];
        const media = m.message && (m.message.imageMessage || m.message.documentMessage);
        if (media) {
          attachments.push({
            mimeType: media.mimetype,
            filename: media.fileName || null,
            raw: { key: m.key, message: m.message }, // kept in memory only, used by downloadMedia
          });
        }
        out.push({ messageId: m.key.id, from: `+${from}`, text: m.messageBody || (media && media.caption) || '', attachments });
      }
      return out;
    },

    sendText: (to, text) => post('send-message', { to, text }),

    sendDocument: (to, { url, filename, caption }) =>
      post('send-message', { to, text: caption || '', documentUrl: url, fileName: filename }), // UNVERIFIED field names

    async downloadMedia(attachment) { // UNVERIFIED endpoint and response shape
      const decrypted = await post('decrypt-media', { data: { messages: attachment.raw } });
      const url = decrypted.publicUrl;
      if (!url) throw new Error('WaSender did not return a media URL');
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`Media download failed with HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

/** In-memory channel for tests and local demos: inbound is already normalized, sends are recorded. */
function createMemoryChannel({ secret = 'test-secret' } = {}) {
  const channel = {
    sent: [],
    failNext: 0, // make the next N sends fail
    verifyRequest: (headers) => safeEqual(headers && headers['x-webhook-signature'], secret),
    parseInbound: (body) => body.messages || [],
    async sendText(to, text) {
      if (channel.failNext > 0) { channel.failNext -= 1; throw new Error('send failed'); }
      channel.sent.push({ kind: 'text', to, text });
    },
    async sendDocument(to, doc) {
      if (channel.failNext > 0) { channel.failNext -= 1; throw new Error('send failed'); }
      channel.sent.push({ kind: 'document', to, ...doc });
    },
    async downloadMedia() { return Buffer.from('fake-image-bytes'); },
    texts: () => channel.sent.filter((s) => s.kind === 'text').map((s) => s.text),
  };
  return channel;
}

module.exports = { createWaSenderChannel, createMemoryChannel };
