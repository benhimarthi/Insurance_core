'use strict';

const fs = require('fs');
const path = require('path');

/**
 * StorageAdapter interface: save(path, bytes, contentType) -> Promise<{ path }>
 * Production: Firebase Storage / Cloud Storage with private objects and signed URLs.
 */

function createMemoryStorage({ now = () => new Date() } = {}) {
  const files = new Map();
  const remove = (match) => { let n = 0; for (const [p, f] of files) if (match(p, f)) { files.delete(p); n += 1; } return n; };
  return {
    async save(filePath, bytes, contentType) {
      files.set(filePath, { bytes: Buffer.from(bytes), contentType, createdAt: now() });
      return { path: filePath };
    },
    async deleteOlderThan(prefix, before) { return remove((p, f) => p.startsWith(prefix) && f.createdAt < before); },
    async deletePrefix(prefix) { return remove((p) => p.startsWith(prefix)); },
    paths: () => [...files.keys()],
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
    /** Data retention: files under `prefix` created before `before`. Pages through the listing. */
    async deleteOlderThan(prefix, before) {
      let deleted = 0;
      let query = { prefix, maxResults: 500, autoPaginate: false };
      while (query) {
        const [files, next] = await bucket.getFiles(query);
        for (const f of files) {
          if (new Date(f.metadata.timeCreated) < before) { await f.delete({ ignoreNotFound: true }); deleted += 1; }
        }
        query = next && next.pageToken ? { ...query, pageToken: next.pageToken } : null;
      }
      return deleted;
    },
    async deletePrefix(prefix) {
      const [files] = await bucket.getFiles({ prefix });
      await Promise.all(files.map((f) => f.delete({ ignoreNotFound: true })));
      return files.length;
    },
  };
}

module.exports = { createMemoryStorage, createFileStorage, createFirebaseStorage };
