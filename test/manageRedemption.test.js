"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { upsertParticipantFromRedemption, upsertParticipantFromSubscription } = require("../script/manageRedemption");
for (const [name, action] of [["ticket", upsertParticipantFromRedemption], ["subscription", upsertParticipantFromSubscription]]) {
  test(`${name} mirrors only current cycle progress when joining the draw`, async () => {
    const cycle = { id:"cycle_active", startedAtMs:1000 };
    const follower = { quest_cycle: { ...cycle, progress_pct:35, streams:[{presence:{seen:true}}] } };
    const values = new Map([["site_config/quest_cycle", cycle], ["followers_all_time/alice", follower]]);
    const db = { collection: name => ({doc:id => ({path:`${name}/${id}`})}),
      runTransaction: fn => fn({get:async ref => ({exists:values.has(ref.path), data:()=>values.get(ref.path)}),
        set:(ref,data)=>values.set(ref.path,data)}) };
    await action(db, { user_login:"alice", user_name:"Alice", user_id:"123" });
    assert.deepEqual(values.get("participants/alice").quest_cycle, { ...cycle, progress_pct:35 });
    assert.equal(values.get("participants/alice").quest_progress_pct,35);
    values.set("site_config/quest_cycle", {...cycle,id:"cycle_next",startedAtMs:2000});
    await action(db, { user_login:"alice", user_name:"Alice", user_id:"123" });
    assert.equal(values.get("participants/alice").quest_cycle.progress_pct,0);
    assert.equal(values.get("followers_all_time/alice").quest_cycle.progress_pct,35);
  });
}
