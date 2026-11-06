"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { recalculateCommunityLevelRanks } = require("../script/communityLevel");

function parseOptions(args) {
  const { values } = parseArgs({ args, options: {
    apply: { type: "boolean", default: false },
    report: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  }, allowPositionals: false });
  if (values.apply && !values.report && !values.help) throw new Error("--apply requires --report <new audit file>");
  return values;
}

async function reconcileCommunityRanks({ db, config = {}, apply = false, projectId,
  saveReport = async () => {} } = {}) {
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(),
    mode: apply ? "apply" : "dry-run", projectId, status: "planned", changes: [] };
  try {
    report.result = await recalculateCommunityLevelRanks(db, config, {
      dryRun: !apply,
      onPlan: async changes => {
        report.changes = changes.map(({ ref, rank, before, patch, deleteFields }) =>
          ({ path: ref.path, rank, before, patch, deleteFields }));
        // Persist the exact proposed changes before any production write.
        await saveReport(report);
      },
    });
    if (apply && !report.result.skipped) {
      let remaining = [];
      await recalculateCommunityLevelRanks(db, config, { dryRun: true, onPlan: changes => { remaining = changes; } });
      report.remainingPaths = remaining.map(change => change.ref.path);
      report.verified = remaining.length === 0;
      if (!report.verified) throw new Error("Read-back found remaining rank differences; inspect the audit before retrying");
    }
    report.status = report.result.skipped ? "skipped" : apply ? "verified" : "dry-run";
    report.finishedAt = new Date().toISOString();
    await saveReport(report);
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    report.finishedAt = new Date().toISOString();
    await saveReport(report);
    throw error;
  }
}

async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) {
    console.log("Usage: node scripts/reconcile-community-ranks.js [--report <new audit.json>] [--apply]\n" +
      "Default: read-only dry-run. --apply requires an audit path and verifies the result by reading it back.\n" +
      "Credentials: FIREBASE_KEY_JSON or Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS).");
    return;
  }
  require("dotenv").config({ quiet: true });
  const admin = require("firebase-admin");
  const { initializeFirestore } = require("firebase-admin/firestore");
  let credential;
  if (process.env.FIREBASE_KEY_JSON) {
    let key;
    try { key = JSON.parse(process.env.FIREBASE_KEY_JSON); }
    catch { throw new Error("FIREBASE_KEY_JSON must contain valid service-account JSON"); }
    credential = admin.credential.cert(key);
  } else credential = admin.credential.applicationDefault();
  const app = admin.initializeApp({ credential });
  let reportCreated = false;
  const reportPath = options.report ? path.resolve(options.report) : null;
  const saveReport = async report => {
    if (!reportPath) return;
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n",
      { flag: reportCreated ? "w" : "wx", mode: 0o600 });
    reportCreated = true;
  };
  try {
    const db = initializeFirestore(app, { preferRest: true });
    const configDoc = await db.collection("site_config").doc("community_level").get();
    const report = await reconcileCommunityRanks({ db, config: configDoc.data() || {},
      apply: options.apply, projectId: db.projectId, saveReport });
    console.log(JSON.stringify(report, null, 2));
  } finally { await app.delete(); }
}

if (require.main === module) main().catch(error => {
  console.error("[community-ranks]", error.message);
  process.exitCode = 1;
});

module.exports = { parseOptions, reconcileCommunityRanks };
