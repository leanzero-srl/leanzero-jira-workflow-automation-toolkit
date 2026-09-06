#!/usr/bin/env node
// Refresh an existing plan file in place: re-run the new v2.2 passes on each
// entry's `rewrittenJql` (NOT on `originalJql` — we want to preserve any
// filter-ID rewrites that the original plan already did). The new passes are
// all idempotent, so layering them on top of the prior rewrittenJql is safe.
//
// For every entry whose rewrittenJql changes, we:
//   - update entry.rewrittenJql to the new value
//   - reset execution state to "pending" so executePlan re-PUTs the filter
//   - clear jqlUpdated / ownerSwapped / ownerRestored / executionPhase
//   - record the new change lists (assetFieldReplacements,
//     trafficLightChanges, orderByStripped) for audit
//
// Entries whose rewrittenJql is unchanged are left untouched.
//
// Usage:
//   node main/refresh_plan.js [path/to/plan_<runId>.json]
//
// Then run `node main/rewrite_filter_refs.js --execute-only --plan-file
// <master_<runId>.json>` to PUT the refreshed JQL to Cloud.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudJiraClient = require("../src/cloudJiraClient");
const DatacenterClient = require("../src/datacenterClient");
const PlanManager = require("../src/planManager");
const { buildFieldMap } = require("../src/fieldMapBuilder");
const { loadAssetMaps } = require("../src/assetMapLoader");
const { rewriteAssetFieldRefs } = require("../src/assetFieldRewriter");
const { rewriteTrafficLightFields } = require("../src/trafficLightFieldRewriter");
const { cleanOrderBy } = require("../src/orderByCleaner");
const { sanitizeJql } = require("../src/jqlSanitizer");

const log = (...a) => console.log(...a);

function findLatestPlan() {
  const dir = path.resolve(__dirname, "../logs");
  const files = fs.readdirSync(dir)
    .filter((f) => /^plan_\d+\.json$/.test(f) && !/prerefresh/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(dir, files[0].f) : null;
}

(async () => {
  const argPath = process.argv[2];
  const planFile = argPath ? path.resolve(argPath) : findLatestPlan();
  if (!planFile || !fs.existsSync(planFile)) {
    log("ERROR: no plan file found. Pass a path or place a plan_*.json in logs/.");
    process.exit(1);
  }
  log(`Refreshing plan: ${planFile}`);

  const cloud = new CloudJiraClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_API_TOKEN,
    () => {},
  );

  // Use DC if creds are available so the DC→Cloud cf[N] / customfield_N
  // remap is populated. Without DC, the sanitizer pass below is a no-op for
  // these references — and many filters reference DC custom fields that
  // got new IDs (or were dropped) on Cloud.
  let dcClient = null;
  if (
    process.env.DC_BASE_URL &&
    process.env.DC_USERNAME &&
    process.env.DC_PASSWORD
  ) {
    dcClient = new DatacenterClient(
      process.env.DC_BASE_URL,
      process.env.DC_USERNAME,
      process.env.DC_PASSWORD,
      () => {},
    );
    try {
      const ok = await dcClient.testConnection();
      if (!ok) {
        log("  ⚠  DC connectivity test failed — continuing without DC.");
        dcClient = null;
      } else {
        log("  DC connectivity OK");
      }
    } catch (e) {
      log(`  ⚠  DC connectivity test threw — continuing without DC: ${e.message}`);
      dcClient = null;
    }
  } else {
    log("  ⚠  DC creds not in .env — refresh will NOT remap cf[N] / customfield_N");
  }

  log("Loading Cloud + DC field map...");
  const fm = await buildFieldMap({ cloudClient: cloud, dcClient, log });
  log("Loading DC→Cloud asset map from sibling plans...");
  const am = await loadAssetMaps(
    "../sync_asset_ticket_associations/logs/plan_*.json",
    { log, cwd: path.resolve(__dirname, "..") },
  );

  function newPasses(jql) {
    let s = jql;
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
    // Sanitize is included for safety (it's idempotent), in case the prior
    // plan was built before the customfield_N long-form rewrite landed.
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
      sanitizerExtra: sR.changes,
    };
  }

  // Reuse PlanManager so the streaming line format is preserved exactly.
  const pm = new PlanManager(path.resolve(__dirname, "../logs"), log);
  const plan = await pm.loadPlan(planFile);
  if (!plan) {
    log("ERROR: failed to load plan.");
    process.exit(1);
  }

  // Backup before we mutate.
  const backupPath = planFile.replace(/\.json$/, ".prerefresh.json");
  fs.copyFileSync(planFile, backupPath);
  log(`Backup saved: ${backupPath}`);

  const stats = {
    total: 0,
    refreshed: 0,
    assetField: 0,
    trafficLight: 0,
    orderBy: 0,
    sanitizerOnly: 0,
    untouched: 0,
    statusFlipped: { completed: 0, failed: 0, skipped: 0, no_change: 0, pending: 0 },
  };

  for (const [, e] of Object.entries(plan.filters)) {
    stats.total++;
    const base = e.rewrittenJql || e.originalJql || "";
    if (!base) {
      stats.untouched++;
      continue;
    }
    const r = newPasses(base);
    if (r.final === base) {
      stats.untouched++;
      continue;
    }

    const priorStatus = e.status || "pending";
    if (stats.statusFlipped[priorStatus] != null) {
      stats.statusFlipped[priorStatus]++;
    }

    // Capture what we expect to find on Cloud right now (so --avoid-overwrite
    // can detect external edits between our prior PUT and now). If the prior
    // run actually PUT this filter (jqlUpdated=true on a completed entry),
    // Cloud should currently hold the prior rewrittenJql. Otherwise Cloud
    // still has the originalJql.
    const priorActuallyPut =
      priorStatus === "completed" && (e.jqlUpdated === true);
    e.expectedLiveJql = priorActuallyPut ? base : (e.originalJql || base);

    e.rewrittenJql = r.final;
    e.status = "pending";
    e.jqlUpdated = false;
    e.permissionsAdded = false;
    e.ownerSwapped = false;
    e.ownerRestored = false;
    e.executionPhase = "idle";
    e.lastStepError = null;
    e.error = null;
    e.updatedAt = null;

    e.assetFieldReplacements = r.assetFieldReplacements;
    e.assetFieldUnresolved = r.assetFieldUnresolved;
    e.trafficLightChanges = r.trafficLightChanges;
    e.orderByStripped = r.orderByStripped;

    if (r.assetFieldReplacements.length) stats.assetField++;
    if (r.trafficLightChanges.length) stats.trafficLight++;
    if (r.orderByStripped.length) stats.orderBy++;
    if (
      r.assetFieldReplacements.length === 0 &&
      r.trafficLightChanges.length === 0 &&
      r.orderByStripped.length === 0 &&
      r.sanitizerExtra.length > 0
    ) {
      stats.sanitizerOnly++;
    }
    stats.refreshed++;
  }

  pm.savePlan();
  log("\nPlan saved in original streaming format.");

  log("\n=== summary ===");
  log(`  total entries:           ${stats.total}`);
  log(`  refreshed (jql changed): ${stats.refreshed}`);
  log(`  asset-field rewrites:    ${stats.assetField} filter(s)`);
  log(`  traffic-light rewrites:  ${stats.trafficLight} filter(s)`);
  log(`  ORDER BY strips:         ${stats.orderBy} filter(s)`);
  log(`  sanitizer-only refresh:  ${stats.sanitizerOnly} filter(s)`);
  log(`  untouched:               ${stats.untouched} filter(s)`);
  log("\n  prior status of refreshed entries (re-set to pending):");
  for (const [k, v] of Object.entries(stats.statusFlipped)) {
    if (v > 0) log(`    was ${k.padEnd(10)}: ${v} filter(s)`);
  }

  // Hint about how to apply
  const masterGuess = planFile
    .replace(/\/plan_/, "/master_")
    .replace(/\.json$/, ".json");
  log("\nNext step (apply the refreshed JQL to Cloud):");
  log(`  node main/rewrite_filter_refs.js --execute-only --plan-file ${masterGuess}`);
  log("\n(Add --dry-run first if you want to preview the PUTs.)");
})().catch((err) => {
  console.error("REFRESH FAILED:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
