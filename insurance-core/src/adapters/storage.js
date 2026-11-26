'use strict';

const fs = require('fs');
const path = require('path');

/**
 * StorageAdapter interface: save(path, bytes, contentType) -> Promise<{ path }>
 * Production: Firebase Storage / Cloud Storage with private objects and signed URLs.
 */

function createMemoryStorage() {
  const files = new Map();
  return {
    async save(filePath, bytes, contentType) {
      files.set(filePath, { bytes: Buffer.from(bytes), contentType });
      return { path: filePath };
    },
    async read(filePath) {
      const f = files.get(filePath);
      if (!f) throw new Error(`File not found: ${filePath}`);
      return f.bytes;
    },
    async getSignedUrl(filePath) { return `memory://${filePath}`; },
    get: (filePath) => files.get(filePath) || null,
    count: () => files.size,
  };
}

/** Writes files to a local folder: handy to open the generated PDFs during a demo. */
function createFileStorage(rootDir) {
  return {
    async save(filePath, bytes) {
      const full = path.join(rootDir, filePath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.from(bytes));
      return { path: filePath };
    },
  };
}

/**
 * Firebase Storage / Cloud Storage adapter. `bucket` comes from firebase-admin getStorage().bucket().
 * Keep the bucket private: customers get short-lived signed URLs only. Signing from Cloud Functions
 * needs the runtime service account to hold the "Service Account Token Creator" role.
 */
function createFirebaseStorage(bucket) {
  return {
    async save(filePath, bytes, contentType) {
      await bucket.file(filePath).save(Buffer.from(bytes), { contentType, resumable: false });
      return { path: filePath };
    },
    async read(filePath) {
      const [buf] = await bucket.file(filePath).download();
      return buf;
    },
    async getSignedUrl(filePath, ttlMs = 15 * 60 * 1000) {
      const [url] = await bucket.file(filePath).getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + ttlMs });
      return url;
    },
  };
}

module.exports = { createMemoryStorage, createFileStorage, createFirebaseStorage };
