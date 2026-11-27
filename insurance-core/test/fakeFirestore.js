'use strict';

/**
 * Minimal in-memory Firestore double, covering exactly what the server layer uses:
 * doc/collection refs, get/set(+merge), where(==, <=)/orderBy/limit/select queries and transactions.
 * It is deliberately strict like the real thing: undefined values are rejected.
 */

function assertNoUndefined(value, where) {
  if (value === undefined) throw new Error(`Firestore rejects undefined (at ${where})`);
  if (Array.isArray(value)) value.forEach((v, i) => assertNoUndefined(v, `${where}[${i}]`));
  else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) assertNoUndefined(v, `${where}.${k}`);
  }
}

class DocRef {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').pop(); }
  async get() {
    const d = this.db.docs.get(this.path);
    return { exists: d !== undefined, id: this.id, data: () => structuredClone(d) };
  }
  async set(data, opts) { this._write(data, opts); }
  async delete() { this.db.docs.delete(this.path); }
  _write(data, opts) {
    assertNoUndefined(data, this.path);
    const prev = this.db.docs.get(this.path);
    this.db.docs.set(this.path, opts && opts.merge ? { ...(prev || {}), ...structuredClone(data) } : structuredClone(data));
  }
}

class Query {
  constructor(db, path, filters = [], max, order = null, fields = null) {
    this.db = db; this.path = path; this.filters = filters; this.max = max; this.order = order; this.fields = fields;
  }
  _with(patch) { const q = Object.assign(Object.create(Query.prototype), this, patch); return q; }
  where(field, op, value) { return this._with({ filters: [...this.filters, { field, op, value }] }); }
  limit(n) { return this._with({ max: n }); }
  orderBy(field, dir = 'asc') { return this._with({ order: { field, dir } }); }
  select(...fields) { return this._with({ fields }); }
  async get() {
    const docs = [];
    for (const [p, d] of this.db.docs) {
      if (!p.startsWith(`${this.path}/`) || p.slice(this.path.length + 1).includes('/')) continue;
      const ok = this.filters.every(({ field, op, value }) => (op === '==' ? d[field] === value : op === '<=' ? d[field] <= value : false));
      if (ok) docs.push({ id: p.split('/').pop(), d });
    }
    if (this.order) {
      const { field, dir } = this.order;
      docs.sort((a, b) => (a.d[field] < b.d[field] ? -1 : a.d[field] > b.d[field] ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    const pick = (d) => (this.fields ? Object.fromEntries(this.fields.filter((f) => f in d).map((f) => [f, d[f]])) : d);
    const out = (this.max ? docs.slice(0, this.max) : docs).map(({ id, d }) => ({ id, data: () => structuredClone(pick(d)) }));
    return { docs: out, empty: out.length === 0 };
  }
}

class CollectionRef extends Query {
  constructor(db, path) { super(db, path); }
  doc(id) { return new DocRef(this.db, `${this.path}/${id || `auto${++this.db.seq}`}`); }
}

class FakeFirestore {
  constructor() { this.docs = new Map(); this.seq = 0; this.transactions = 0; }
  doc(path) { return new DocRef(this, path); }
  collection(path) { return new CollectionRef(this, path); }
  async runTransaction(fn) {
    this.transactions += 1;
    const writes = [];
    const tx = {
      get: (ref) => ref.get(),
      set: (ref, data, opts) => { assertNoUndefined(data, ref.path); writes.push(() => ref._write(data, opts)); return tx; },
      delete: (ref) => { writes.push(() => ref.db.docs.delete(ref.path)); return tx; },
    };
    const result = await fn(tx);
    writes.forEach((w) => w());
    return result;
  }
  /** test helper: all documents directly under a collection path */
  list(path) {
    return [...this.docs].filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/')).map(([p, d]) => ({ id: p.split('/').pop(), ...d }));
  }
}

module.exports = { FakeFirestore };
