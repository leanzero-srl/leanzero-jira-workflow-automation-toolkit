#!/usr/bin/env node
// Re-rebuild rewrittenJql for entries that were skipped as "externally_modified".
//
// Why this exists:
//   --avoid-overwrite correctly skips filters where Cloud's current JQL ≠
//   what we expected. But for many of those filters, the live JQL STILL has
//   patterns our rewriter could fix (`Name (CI-NNN)` keyed form, raw ARIs
//   that resolve to a Cloud object name, etc.). They got past our reach
//   because rewrittenJql was computed from `originalJql` (a stale snapshot
//   from Phase 1), not from the live state.
//
// What this does:
//   1. Loads the plan.
//   2. For each entry with status="skipped" and error/lastStepError contains
//      "externally_modified":
//        a. GET the filter from Cloud → get the *current* JQL.
//        b. Run all rewriter passes on the LIVE JQL.
//        c. If the result == live.jql, mark no_change (nothing to fix).
//        d. If the result differs, store it as rewrittenJql AND set
//           expectedLiveJql = live.jql so --avoid-overwrite will let the
//           next PUT through.
//        e. Filter doesn't exist on Cloud (404) → mark failed:filter_404.
//   3. Save plan.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudJiraClient = require("../src/cloudJiraClient");
const DatacenterClient = require("../src/datacenterClient");
const PlanManager = require("../src/planManager");
const { buildFieldMap } = require("../src/fieldMapBuilder");
const { loadAssetMaps } = require("../src/assetMapLoader");
const { rewriteJql, rewriteAqlFunctionBodies } = require("../src/jqlRewriter");
const { rewriteAql } = require("../src/aqlRewriter");
const { rewriteAssetFieldRefs } = require("../src/assetFieldRewriter");
const { rewriteTrafficLightFields } = require("../src/trafficLightFieldRewriter");
const { sanitizeJql } = require("../src/jqlSanitizer");
const { cleanOrderBy } = require("../src/orderByCleaner");

const log = (...a) => console.log(...a);

(async () => {
  const planPath = path.resolve(
    process.argv[2] || "logs/plan_1778420327435.json",
  );
  if (!fs.existsSync(planPath)) {
    console.error("plan not found:", planPath);
    process.exit(1);
  }
  log(`Plan: ${planPath}`);

  const cloud = new CloudJiraClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_API_TOKEN,
    () => {},
  );

  let dcClient = null;
  if (process.env.DC_BASE_URL && process.env.DC_USERNAME && process.env.DC_PASSWORD) {
    dcClient = new DatacenterClient(
      process.env.DC_BASE_URL,
      process.env.DC_USERNAME,
      process.env.DC_PASSWORD,
      () => {},
    );
    try { if (!(await dcClient.testConnection())) dcClient = null; }
    catch { dcClient = null; }
  }

  log("Loading field map (Cloud + DC)...");
  const fm = await buildFieldMap({ cloudClient: cloud, dcClient, log });
  log("Loading asset maps from sibling plans...");
  const am = await loadAssetMaps(
    "../sync_asset_ticket_associations/logs/plan_*.json",
    { log, cwd: path.resolve(__dirname, "..") },
  );

  function applyPasses(jql, refs) {
    let s = jql;
    const dcToCloudFilterMap = new Map();
    for (const r of refs || []) {
      if (r && r.kind === "filter" && r.resolution === "ok" && r.dcId && r.cloudId) {
        dcToCloudFilterMap.set(String(r.dcId), String(r.cloudId));
      }
    }
    if (dcToCloudFilterMap.size > 0) {
      s = rewriteJql(s, dcToCloudFilterMap).rewritten;
    }
    s = rewriteAqlFunctionBodies(s, (b) => rewriteAql(b, am)).rewritten;
    const aR = rewriteAssetFieldRefs(s, {
      assetFieldNames: fm.cloudAssetFieldNames,
      dcKeyToCloudName: am.dcKeyToCloudName,
      dcObjectIdToCloudName: am.dcObjectIdToCloudName,
      cloudObjectIdToCloudName: am.cloudObjectIdToCloudName,
      cloudKeyToCloudName: am.cloudKeyToCloudName,
    });
    s = aR.rewritten;
    const tR = rewriteTrafficLightFields(s, {
      trafficLightFieldNames: fm.cloudTrafficLightFieldNames,
    });
    s = tR.rewritten;
    const sR = sanitizeJql(s, {
      cfMap: Object.fromEntries(fm.dcIdToCloudId.entries()),
    });
    s = sR.sanitized;
    const oR = cleanOrderBy(s, { assetFieldNames: fm.cloudAssetFieldNames });
    s = oR.rewritten;
    return {
      final: s,
      assetFieldReplacements: aR.replacements,
      assetFieldUnresolved: aR.unresolved,
      trafficLightChanges: tR.replacements,
      orderByStripped: oR.stripped,
      sanitizerChanges: sR.changes,
    };
  }

  const pm = new PlanManager(path.resolve(__dirname, "../logs"), () => {});
  const plan = await pm.loadPlan(planPath);
  if (!plan) { console.error("load failed"); process.exit(1); }

  const backupPath = planPath.replace(/\.json$/, `.prerebuildfromlive_${Date.now()}.json`);
  fs.copyFileSync(planPath, backupPath);
  log(`Backup: ${backupPath}`);

  // Collect target entries: skipped + externally_modified
  const targets = [];
  for (const [id, e] of Object.entries(plan.filters)) {
    const errStr = String(e.error || e.lastStepError || "");
    if (e.status === "skipped" && errStr.includes("externally_modified")) {
      targets.push(id);
    }
  }
  log(`Targets (status=skipped, externally_modified): ${targets.length}`);

  const stats = {
    total: targets.length,
    fetched: 0,
    fetch404: 0,
    fetchErr: 0,
    flippedPending: 0,
    markedNoChange: 0,
    rateLimitWait: 0,
  };

  let processed = 0;
  // Use a small worker pool for the GET phase.
  const concurrency = 5;
  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const i = idx++;
      const id = targets[i];
      const e = plan.filters[id];
      try {
        const live = await cloud.getFilter(id, {});
        stats.fetched++;
        const liveJql = String(live.jql || "");
        const r = applyPasses(liveJql, e.refs || []);
        e.expectedLiveJql = liveJql; // anchor for next avoid-overwrite check
        if (r.final === liveJql) {
          e.rewrittenJql = liveJql;
          e.status = "no_change";
          stats.markedNoChange++;
        } else {
          e.rewrittenJql = r.final;
          e.status = "pending";
          e.jqlUpdated = false;
          e.ownerSwapped = false;
          e.ownerRestored = false;
          e.executionPhase = "idle";
          e.lastStepError = null;
          e.error = null;
          e.updatedAt = null;
          e.sharePermissionPosted = false;
          e.sharePermissionPostError = null;
          e.assetFieldReplacements = r.assetFieldReplacements;
          e.assetFieldUnresolved = r.assetFieldUnresolved;
          e.trafficLightChanges = r.trafficLightChanges;
          e.orderByStripped = r.orderByStripped;
          e.sanitizerChanges = r.sanitizerChanges;
          stats.flippedPending++;
        }
      } catch (err) {
        if (err.statusCode === 404) {
          stats.fetch404++;
          e.status = "failed";
          e.error = "filter_404";
          e.lastStepError = "filter_404";
        } else if (err.statusCode === 429) {
          stats.rateLimitWait++;
          await new Promise((r) => setTimeout(r, 10000));
          idx--; // requeue
        } else {
          stats.fetchErr++;
          // leave entry alone
        }
      }
      processed++;
      if (processed % 50 === 0) {
        log(`  ${processed}/${targets.length} processed (flipped=${stats.flippedPending}, noChange=${stats.markedNoChange}, 404=${stats.fetch404}, err=${stats.fetchErr})`);
        pm.savePlan();
      }
    }
  }
  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  pm.savePlan();
  log("\n=== rebuild-from-live summary ===");
  log(`  targets:                ${stats.total}`);
  log(`  fetched:                ${stats.fetched}`);
  log(`  flipped to pending:     ${stats.flippedPending}`);
  log(`  marked no_change:       ${stats.markedNoChange}`);
  log(`  404 (filter deleted):   ${stats.fetch404}`);
  log(`  other fetch errors:     ${stats.fetchErr}`);
  log(`  rate-limit waits:       ${stats.rateLimitWait}`);

  log("\nNext step (apply with manual-edit protection):");
  log(`  node main/rewrite_filter_refs.js --execute-only --plan-file ${planPath.replace(/\/plan_/, "/master_")} --avoid-overwrite --no-share-org-admins`);
})().catch((err) => {
  console.error("rebuild-from-live failed:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
