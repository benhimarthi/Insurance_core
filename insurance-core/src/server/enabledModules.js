'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The modules this deployment defines Cloud Functions for (ENABLED_MODULES: "auth", "app", "all").
 *
 * At runtime Firebase puts the values of `.env.<project>` in process.env. But while the Firebase CLI
 * analyses index.js before a deploy, it gives the code only the project id (FIREBASE_CONFIG /
 * GCLOUD_PROJECT), not those values. So when the variable is missing we read it from
 * `.env.<project>` next to index.js ourselves. Default: every module.
 */
function projectIdFrom(env) {
  if (env.GCLOUD_PROJECT) return env.GCLOUD_PROJECT;
  try { return JSON.parse(env.FIREBASE_CONFIG || '{}').projectId || null; } catch { return null; }
}

function readDotenvValue(file, key) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return undefined; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === key) return m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

function resolveEnabledModules({ env = process.env, dir } = {}) {
  let raw = env.ENABLED_MODULES;
  if (raw === undefined && dir) {
    const project = projectIdFrom(env);
    if (project && /^[a-z0-9-]+$/.test(project)) raw = readDotenvValue(path.join(dir, `.env.${project}`), 'ENABLED_MODULES');
  }
  const list = String(raw || 'all').split(',').map((m) => m.trim()).filter(Boolean);
  return list.length ? list : ['all'];
}

module.exports = { resolveEnabledModules };
