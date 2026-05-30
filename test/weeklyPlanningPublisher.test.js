"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  buildPlanningDraft,
  buildPlanningMessagePayload,
  createWeeklyPlanningPublisher,
  getPlanningWeekRange,
  normalizeWeeklyPlanning,
} = require("../script/weeklyPlanningPublisher");

const DELETE_SENTINEL = { __delete: true };

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function applyPayload(current, payload, options = {}) {
  const next = options.merge ? { ...(current || {}) } : {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (value && value.__delete) {
      delete next[key];
    } else {
      next[key] = clone(value);
    }
  }
  return next;
}

class FakeSnapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = !!data;
    this._data = data ? clone(data) : null;
  }

  data() {
    return this._data ? clone(this._data) : undefined;
  }
}

class FakeDocRef {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = path.split("/").pop();
  }

  async get() {
    return new FakeSnapshot(this, this.db.store.get(this.path) || null);
  }

  async set(payload, options = {}) {
    this.db.store.set(
      this.path,
      applyPayload(this.db.store.get(this.path), payload, options),
    );
  }

  async update(payload) {
    const current = this.db.store.get(this.path);
    assert.ok(current, `missing fake doc ${this.path}`);
    this.db.store.set(this.path, applyPayload(current, payload, { merge: true }));
  }
}

class FakeCollectionRef {
  constructor(db, path) {
    this.db = db;
    this.path = path;
  }

  doc(id) {
    return new FakeDocRef(this.db, `${this.path}/${id}`);
  }
}

class FakeTransaction {
  constructor(db) {
    this.db = db;
  }

  async get(ref) {
    return ref.get();
  }

  update(ref, payload) {
    const current = this.db.store.get(ref.path);
    assert.ok(current, `missing fake doc ${ref.path}`);
    this.db.store.set(ref.path, applyPayload(current, payload, { merge: true }));
  }
}

class FakeDb {
  constructor(initialDocs = {}) {
    this.store = new Map(Object.entries(clone(initialDocs)));
  }

  collection(name) {
    return new FakeCollectionRef(this, name);
  }

  async runTransaction(callback) {
    return callback(new FakeTransaction(this));
  }
}

class FakeChannel {
  constructor(id) {
    this.id = id;
    this.sent = [];
  }

  isTextBased() {
    return true;
  }

  async send(payload) {
    this.sent.push(payload);
    const id = `${this.id}-${this.sent.length}`;
    return {
      id,
      url: `https://discord.test/channels/${this.id}/${id}`,
      async edit() {},
    };
  }
}

function createFakeClient(channels) {
  return {
    channels: {
      fetch: async (id) => channels[id] || null,
    },
  };
}

function createPublisher({ planning }) {
  const review = new FakeChannel("log");
  const publicChannel = new FakeChannel("announcements");
  const db = new FakeDb({
    "weekly_planning/current": planning,
  });
  const client = createFakeClient({
    log: review,
    announcements: publicChannel,
  });
  const admin = {
    firestore: {
      FieldValue: {
        delete: () => DELETE_SENTINEL,
        serverTimestamp: () => "SERVER_TIMESTAMP",
      },
    },
  };
  const publisher = createWeeklyPlanningPublisher({
    db,
    admin,
    client,
    config: {
      timezone: "UTC",
      discord: {
        logChannelId: "log",
        announcementChannelId: "announcements",
      },
      planning: {
        reviewChannelId: "log",
        publicChannelId: "announcements",
        approverUserIds: "",
      },
    },
  });
  return { db, review, publicChannel, publisher };
}

test("normalizes planning slots and removes invalid entries", () => {
  const planning = normalizeWeeklyPlanning({
    timezone: "UTC",
    days: {
      monday: [
        { startTime: "20:00", endTime: "22:00", title: "Live @everyone" },
        { startTime: "12:00", endTime: "11:00", title: "Invalid" },
        { startTime: "xx", title: "Invalid" },
      ],
    },
    monthlyDrawDate: "2026-05-31",
  });

  assert.equal(planning.days.monday.length, 1);
  assert.equal(planning.days.monday[0].title, "Live @\u200beveryone");
  assert.equal(planning.monthlyDrawDate, "2026-05-31");
});

test("builds current week key and formatted content", () => {
  const range = getPlanningWeekRange(
    "UTC",
    new Date("2026-05-27T10:00:00.000Z"),
  );
  assert.equal(range.weekKey, "2026-05-25_2026-05-31");

  const draft = buildPlanningDraft(
    {
      timezone: "UTC",
      days: {
        wednesday: [{ startTime: "20:00", title: "Jeu commu" }],
      },
      monthlyDrawDate: "2026-05-31",
    },
    { now: new Date("2026-05-27T10:00:00.000Z"), timeZone: "UTC" },
  );

  assert.equal(draft.weekKey, "2026-05-25_2026-05-31");
  assert.match(draft.content, /Mercredi/);
  assert.match(draft.content, /Jeu commu/);
  assert.match(draft.content, /Tirage mensuel/);
});

test("test payload is marked non published and has no buttons", () => {
  const draft = buildPlanningDraft(
    { timezone: "UTC", days: {} },
    { now: new Date("2026-05-27T10:00:00.000Z"), timeZone: "UTC" },
  );
  const payload = buildPlanningMessagePayload(draft, { test: true });

  assert.match(payload.content, /TEST - non publié/);
  assert.equal(payload.components.length, 0);
  assert.match(payload.embeds[0].data.description, /Aucun stream/);
  assert.match(payload.embeds[0].data.fields[0].value, /planning peut encore bouger/);
});

test("preview creation is idempotent for the same week and planning hash", async () => {
  const { db, review, publisher } = createPublisher({
    planning: {
      timezone: "UTC",
      days: {
        monday: [{ startTime: "20:00", title: "Live" }],
      },
    },
  });
  const now = new Date("2026-05-25T10:00:00.000Z");

  const first = await publisher.createPlanningPreview({ now });
  const second = await publisher.createPlanningPreview({ now });

  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(review.sent.length, 1);
  assert.equal(
    db.store.get("weekly_planning_announcements/2026-05-25_2026-05-31")
      .status,
    "pending",
  );
});

test("approval publishes the preview and marks the week as sent", async () => {
  const { db, publicChannel, publisher } = createPublisher({
    planning: {
      timezone: "UTC",
      days: {
        monday: [{ startTime: "20:00", title: "Live" }],
      },
    },
  });
  const now = new Date("2026-05-25T10:00:00.000Z");
  const preview = await publisher.createPlanningPreview({ now });

  await publisher.approvePlanning({
    weekKey: preview.draft.weekKey,
    planningHash: preview.draft.planningHash,
    approvedBy: "42",
    now,
  });

  assert.equal(publicChannel.sent.length, 1);
  assert.equal(
    db.store.get("weekly_planning_announcements/2026-05-25_2026-05-31")
      .status,
    "sent",
  );
});

test("stale approval is refused when the site planning changed", async () => {
  const { db, publisher } = createPublisher({
    planning: {
      timezone: "UTC",
      days: {
        monday: [{ startTime: "20:00", title: "Live" }],
      },
    },
  });
  const now = new Date("2026-05-25T10:00:00.000Z");
  const preview = await publisher.createPlanningPreview({ now });

  db.store.set("weekly_planning/current", {
    timezone: "UTC",
    days: {
      monday: [{ startTime: "20:00", title: "Live modifié" }],
    },
  });

  await assert.rejects(
    () =>
      publisher.approvePlanning({
        weekKey: preview.draft.weekKey,
        planningHash: preview.draft.planningHash,
        approvedBy: "42",
        now,
      }),
    /plus à jour/,
  );
});
