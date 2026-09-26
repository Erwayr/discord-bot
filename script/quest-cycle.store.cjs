"use strict";
const { QUEST_CYCLE_PATH, normalizeQuestCycle } = require("./quest-cycle.shared.cjs");
async function readQuestCycle(db, tx = null) {
  const ref = db.collection("site_config").doc("quest_cycle");
  const snapshot = await (tx ? tx.get(ref) : ref.get());
  return normalizeQuestCycle(snapshot.data());
}
module.exports = { readQuestCycle };
