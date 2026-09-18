"use strict";
const assert = require("node:assert/strict");
const clone = (value) => value == null ? value : Array.isArray(value) ? value.map(clone)
  : typeof value === "object" && !value.toMillis ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])) : value;

function createMemoryFirestore(initial = {}) {
  const documents = new Map(Object.entries(initial).map(([key, value]) => [key, clone(value)]));
  const writes = [];
  const reads = [];
  let tail = Promise.resolve();
  let retryCount = 0;
  function apply(reference, data, merge) {
    const output = merge ? clone(documents.get(reference.path) || {}) : {};
    for (const [field, value] of Object.entries(data)) {
      const parts = field.split(".");
      const name = parts.pop();
      let node = output;
      for (const part of parts) node = node[part] ||= {};
      node[name] = clone(value);
    }
    documents.set(reference.path, output);
    writes.push(reference.path);
  }
  function snapshot(reference) {
    if (!reference.query) {
      reads.push(reference.path);
      const value = clone(documents.get(reference.path));
      return { id: reference.path.split("/").pop(), ref: reference, exists: documents.has(reference.path), data: () => clone(value) };
    }
    let rows = [...documents].filter(([key]) => key.startsWith(reference.path + "/") && !key.slice(reference.path.length + 1).includes("/"));
    for (const [field, op, value] of reference.filters) rows = rows.filter(([, data]) => op === "==" && data[field] === value);
    if (reference.order) rows.sort((a, b) => (a[1][reference.order[0]] - b[1][reference.order[0]]) * (reference.order[1] === "desc" ? -1 : 1));
    const docs = rows.slice(0, reference.max || Infinity).map(([key]) => snapshot(ref(key)));
    if (!docs.length) reads.push(reference.path + " (empty query)");
    return { docs, size: docs.length, empty: !docs.length };
  }
  function ref(path, query = false, filters = [], order = null, max = null) {
    return { path, query, filters, order, max,
      collection: (name) => ref(`${path}/${name}`, true), doc: (id) => ref(`${path}/${id}`),
      where: (field, op, value) => ref(path, true, [...filters, [field, op, value]], order, max),
      orderBy: (field, direction) => ref(path, true, filters, [field, direction], max),
      limit: (count) => ref(path, true, filters, order, count),
      select: () => ref(path, true, filters, order, max),
      async get() { return snapshot(this); },
      async set(data, options) { apply(this, data, options?.merge); },
      async update(data) { assert.ok(documents.has(path), `Missing document ${path}`); apply(this, data, true); },
    };
  }
  return {
    documents, writes, reads, collection: (name) => ref(name, true),
    retryNext: (count = 1) => { retryCount = count; },
    async runTransaction(callback) {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        for (;;) {
          const pending = [];
          const tx = {
            async get(reference) { assert.equal(pending.length, 0, "Firestore transactions require all reads before writes"); return snapshot(reference); },
            set(reference, data, options) { pending.push([reference, data, options?.merge]); },
            update(reference, data) { assert.ok(documents.has(reference.path)); pending.push([reference, data, true]); },
          };
          const value = await callback(tx);
          if (retryCount > 0) { retryCount--; continue; }
          pending.forEach((args) => apply(...args));
          return value;
        }
      } finally { release(); }
    },
  };
}
module.exports = { createMemoryFirestore };
