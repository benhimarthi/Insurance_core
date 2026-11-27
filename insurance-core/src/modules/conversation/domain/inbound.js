'use strict';

/**
 * Rules about what a customer may send and which case a message belongs to.
 */

const ISSUED_WINDOW_MS = 24 * 3600 * 1000; // after issuance the chat stays on the same case for a day
const MAX_ATTACHMENTS = 3;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const MAX_TEXT_LENGTH = 1000;
const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** A finished case: the next message starts a new one. */
const isTerminal = (c, now) => !!c.flow && (
  c.flow.stage === 'closed'
  || (c.flow.stage === 'issued' && now.getTime() - new Date(c.updatedAt).getTime() > ISSUED_WINDOW_MS)
);

/** Uploads are only kept while the flow is actually waiting for documents. */
const acceptsUploads = (c) => !!c && !!c.flow && c.flow.stage === 'documents';

/**
 * What a file really is, from its first bytes: the type a browser or a provider declares is not
 * trusted. Returns one of ALLOWED_MIME, or null.
 */
function sniffMime(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'image/png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** An upload is kept only if its declared type is allowed, its content IS that type, and its size fits. */
const isAllowedUpload = (mimeType, bytes) => ALLOWED_MIME.includes(mimeType) && !!bytes
  && bytes.length > 0 && bytes.length <= MAX_UPLOAD_BYTES && sniffMime(bytes) === mimeType;

/** Web chat visitors have no phone number: their session id is their contact. */
const webContact = (sessionId) => `web:${sessionId}`;

module.exports = { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, ALLOWED_MIME, MAX_TEXT_LENGTH, SESSION_RE, isTerminal, acceptsUploads, sniffMime, isAllowedUpload, webContact };
