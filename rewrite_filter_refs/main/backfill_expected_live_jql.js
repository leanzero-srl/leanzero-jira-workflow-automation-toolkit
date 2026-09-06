#!/usr/bin/env node
// One-shot repair: populate `expectedLiveJql` for every entry in the current
// plan based on what was actually on Cloud at the time of the prior runs
// (read from the .prerebuild.json backup).
//
// For each entry:
//   • If backup had status==="completed" AND jqlUpdated===true → we previously
//     PUT this filter; Cloud holds the backup's rewrittenJql.
//   • Otherwise → we never PUT this filter; Cloud holds the originalJql.
//
// Also: reset entries that the most recent execute marked
// "skipped: externally_modified" back to pending — they were false-positive
// skips caused by the empty/stale expectedLiveJql bug. After backfill they
// can be retried with a correct anchor.

const fs = require("fs");
const path = require("path");
const PlanManager = require("../src/planManager");

const log = (...a) => console.log(...a);

(async () => {
  const planArg = process.argv[2];
  const planFile = planArg
    ? path.resolve(planArg)
    : path.resolve(__dirname, "../logs/plan_1778420327435.json");
  const backupFile = planFile.replace(/\.json$/, ".prerebuild.json");

  if (!fs.existsSync(planFile)) {
    console.error("plan not found:", planFile);
    process.exit(1);
  }
  if (!fs.existsSync(backupFile)) {
    console.error("backup not found:", backupFile);
    process.exit(1);
  }
  log(`Plan:    ${planFile}`);
  log(`Backup:  ${backupFile}`);

  const pm = new PlanManager(path.resolve(__dirname, "../logs"), () => {});
  const plan = await pm.loadPlan(planFile);
  if (!plan) { console.error("load plan failed"); process.exit(1); }

  log("Loading prerebuild backup...");
  const backupRaw = fs.readFileSync(backupFile, "utf8");
  // Backup is in our streaming format (newline-per-key). JSON.parse works on it.
  const backup = JSON.parse(backupRaw);
  const backupFilters = backup.filters || {};

  const safeBackup = path.resolve(__dirname, "../logs", `plan_prebackfill_${Date.now()}.json`);
  fs.copyFileSync(planFile, safeBackup);
  log(`Safety copy of pre-backfill plan: ${safeBackup}`);

  const stats = {
    total: 0,
    populated: 0,
    populatedToOriginal: 0,
    populatedToPriorRewrite: 0,
    leftAsIs: 0,
    resetExternallyModified: 0,
  };

  for (const [id, e] of Object.entries(plan.filters)) {
    stats.total++;
    const back = backupFilters[id];

    // Step 1: derive correct expectedLiveJql from the backup state
    let correct;
    if (back && back.status === "completed" && back.jqlUpdated === true) {
      // We PUT this filter at some point — Cloud holds the backup's rewrittenJql
      correct = back.rewrittenJql || back.originalJql || "";
      stats.populatedToPriorRewrite++;
    } else {
      // We never PUT this filter — Cloud still holds originalJql
      correct = e.originalJql || (back && back.originalJql) || "";
      stats.populatedToOriginal++;
    }

    if (correct && e.expectedLiveJql !== correct) {
      e.expectedLiveJql = correct;
      stats.populated++;
    } else {
      stats.leftAsIs++;
    }

    // Step 2: reset false-positive externally_modified entries to pending.
    // Due to a logic gap in executePlan, _executeOne's "skipped" classification
    // got overwritten to "failed" before save, so the entries appear as
    // status=failed with error "externally_modified". We treat both the same.
    const isExternalMiss =
      e.error === "externally_modified" ||
      e.lastStepError === "externally_modified" ||
      (typeof e.error === "string" && e.error.includes("externally_modified")) ||
      (typeof e.lastStepError === "string" && e.lastStepError.includes("externally_modified"));
    if (
      isExternalMiss &&
      (e.status === "skipped" || e.status === "failed")
    ) {
      e.status = "pending";
      e.executionPhase = "idle";
      e.lastStepError = null;
      e.error = null;
      e.updatedAt = null;
      stats.resetExternallyModified++;
    }
  }

  pm.savePlan();
  log("\n=== backfill summary ===");
  log(`  total entries:                       ${stats.total}`);
  log(`  expectedLiveJql populated:           ${stats.populated}`);
  log(`    pointing at originalJql:           ${stats.populatedToOriginal}`);
  log(`    pointing at prior rewrittenJql:    ${stats.populatedToPriorRewrite}`);
  log(`  left as-is (already correct):        ${stats.leftAsIs}`);
  log(`  reset externally_modified→pending:   ${stats.resetExternallyModified}`);
})().catch((err) => {
  console.error("backfill failed:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
