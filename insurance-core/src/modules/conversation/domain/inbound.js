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
const isAllowedUpload = (mimeType, size) => ALLOWED_MIME.includes(mimeType) && size > 0 && size <= MAX_UPLOAD_BYTES;

/** Web chat visitors have no phone number: their session id is their contact. */
const webContact = (sessionId) => `web:${sessionId}`;

module.exports = { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, ALLOWED_MIME, MAX_TEXT_LENGTH, SESSION_RE, isTerminal, acceptsUploads, isAllowedUpload, webContact };
