'use strict';

/**
 * Enforces the clean-architecture dependency rule for every module under src/modules:
 *   domain          -> domain, src/shared
 *   application     -> application, domain, src/shared
 *   infrastructure  -> anything inside its module (and npm packages)
 *   interface       -> anything inside its module
 * and modules talk to each other only through their index.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MODULES_DIR = path.join(__dirname, '..', 'src', 'modules');
const SHARED_DIR = path.join(__dirname, '..', 'src', 'shared');
const ALLOWED = {
  domain: ['domain'],
  application: ['application', 'domain'],
  infrastructure: ['infrastructure', 'application', 'domain', 'interface'],
  interface: ['interface', 'application', 'domain', 'infrastructure'],
};
const NODE_BUILTINS = new Set(require('module').builtinModules);

const filesUnder = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? filesUnder(p) : (p.endsWith('.js') ? [p] : []);
});
const requiresOf = (file) => [...fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);

const modules = fs.existsSync(MODULES_DIR) ? fs.readdirSync(MODULES_DIR).filter((m) => fs.statSync(path.join(MODULES_DIR, m)).isDirectory()) : [];

test('architecture: every module has an index.js entry point', () => {
  assert.ok(modules.length > 0);
  for (const m of modules) assert.ok(fs.existsSync(path.join(MODULES_DIR, m, 'index.js')), `${m} has no index.js`);
});

test('architecture: layers only depend inwards; domain and application stay free of npm and Firebase', () => {
  const violations = [];
  for (const m of modules) {
    const root = path.join(MODULES_DIR, m);
    for (const file of filesUnder(root)) {
      const rel = path.relative(root, file);
      const layer = rel.split(path.sep)[0];
      if (!ALLOWED[layer]) continue; // index.js: the composition root may wire everything
      for (const spec of requiresOf(file)) {
        if (!spec.startsWith('.')) {
          const pure = layer === 'domain' || layer === 'application';
          if (pure && !NODE_BUILTINS.has(spec)) violations.push(`${m}/${rel} requires package "${spec}"`);
          if (pure && NODE_BUILTINS.has(spec)) violations.push(`${m}/${rel} requires "${spec}": do I/O and crypto behind a port`);
          continue;
        }
        const target = path.resolve(path.dirname(file), spec);
        if (target.startsWith(SHARED_DIR)) continue;
        if (!target.startsWith(root + path.sep)) { violations.push(`${m}/${rel} reaches outside its module: ${spec}`); continue; }
        const targetLayer = path.relative(root, target).split(path.sep)[0];
        if (!ALLOWED[layer].includes(targetLayer)) violations.push(`${m}/${rel} (${layer}) depends on ${targetLayer}: ${spec}`);
      }
    }
  }
  assert.deepStrictEqual(violations, []);
});

// (unit tests in test/ may reach into a module's layers to test them in isolation)
test('architecture: code outside a module imports it only through its index.js', () => {
  const src = path.join(__dirname, '..');
  const outside = [...filesUnder(path.join(src, 'src')), ...filesUnder(path.join(src, 'scripts')), path.join(src, 'index.js')]
    .filter((f) => !f.startsWith(MODULES_DIR + path.sep));
  const violations = [];
  for (const file of outside) {
    for (const spec of requiresOf(file)) {
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec);
      if (!target.startsWith(MODULES_DIR + path.sep)) continue;
      const inner = path.relative(MODULES_DIR, target).split(path.sep);
      if (inner.length > 1 && !(inner.length === 2 && /^index(\.js)?$/.test(inner[1]))) violations.push(`${path.relative(src, file)} -> ${spec}`);
    }
  }
  assert.deepStrictEqual(violations, []);
});
