"use strict";

const assert = require("node:assert/strict");
const { FieldValue } = require("firebase-admin/firestore");
const clone = value => structuredClone(value);

// Apply update paths to document state, keeping literal FieldPath keys distinct.
// A patch recorder would miss the old set({"communityLevel.rank":...}) bug.
class CommunityRankDb {
  constructor(followers = {}, participants = {}) {
    this.tables = { followers_all_time: clone(followers), participants: clone(participants),
      function_cache: { public_home_followers_v1: { revision: "before", leaseOwner: "active", leaseExpiresAtMs: 123 } } };
    this.reads = [];
    this.updates = [];
    this.cacheWrites = 0;
    this.commits = 0;
  }

  collection(name) {
    assert.ok(this.tables[name], name);
    const doc = id => ({ id, path: `${name}/${id}`,
      get: async () => snapshot(id),
      set: async (patch, options) => {
        assert.equal(name, "function_cache");
        assert.deepEqual(options, { merge: true });
        this.cacheWrites++;
        Object.assign(this.tables[name][id], clone(patch));
      } });
    const snapshot = id => ({ id, ref: doc(id), exists: !!this.tables[name][id],
      data: () => clone(this.tables[name][id]) });
    return { doc, get: async () => {
      this.reads.push(name);
      const docs = Object.keys(this.tables[name]).map(snapshot);
      return { docs, forEach: callback => docs.forEach(callback) };
    } };
  }

  batch() {
    const operations = [];
    return {
      update: (ref, ...args) => {
        const fields = [];
        for (let i = 0; i < args.length; i += 2) {
          const key = args[i];
          const path = typeof key === "string" ? key.split(".") : [key.toString().slice(1, -1)];
          fields.push({ path, value: args[i + 1] });
        }
        operations.push({ ref, fields });
      },
      commit: async () => {
        if (this.failCommitAt === this.commits + 1) throw new Error("simulated_commit_failure");
        assert.ok(operations.length <= 450);
        for (const operation of operations) {
          const [table, id] = operation.ref.path.split("/");
          assert.ok(this.tables[table][id], "updates must not create documents");
          for (const { path, value } of operation.fields) {
            let target = this.tables[table][id];
            for (const segment of path.slice(0, -1)) target = target[segment] ||= {};
            const key = path.at(-1);
            if (typeof value?.isEqual === "function" && value.isEqual(FieldValue.delete())) delete target[key];
            else target[key] = clone(value);
          }
          this.updates.push(operation);
        }
        this.commits++;
      },
    };
  }
}

module.exports = { CommunityRankDb };
