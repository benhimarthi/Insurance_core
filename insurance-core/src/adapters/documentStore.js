'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * DocumentStoreAdapter interface:
 *   save({ path, bytes, contentType }) -> Promise<{ path }>
 *   (production: Cloud Storage, private bucket, short-lived signed URLs when sending to the customer)
 */

function createMemoryDocumentStore() {
  const files = new Map();
  return {
    async save({ path: p, bytes, contentType }) {
      files.set(p, { bytes, contentType });
      return { path: p };
    },
    get: (p) => files.get(p),
    _files: files,
  };
}

function createFileDocumentStore(rootDir) {
  return {
    async save({ path: p, bytes }) {
      const target = path.join(rootDir, p);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
      return { path: target };
    },
  };
}

module.exports = { createMemoryDocumentStore, createFileDocumentStore };
