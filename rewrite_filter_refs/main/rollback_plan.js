#!/usr/bin/env node
// Rollback a plan's PUTs.
//
// For every entry where status === "completed" AND jqlUpdated === true, this
// script reverses the change by PUTing `originalJql` back as the filter's
// JQL. Owner-swap pattern is reused: temporarily own the filter, PUT the
// rollback, restore the original owner.
//
// Safety:
//   • --dry-run     — log what would be reverted, no PUTs.
//   • --avoid-overwrite (default ON for rollback) — pre-GET each filter and
//     compare its current JQL against `rewrittenJql` (what we last PUT).
//     If they DON'T match, skip — someone has edited the filter on Cloud
//     since our PUT, and we don't want to clobber their change. Pass
//     --no-avoid-overwrite to force the rollback regardless.
//   • Eventual-consistency wait + 3-retry on 403 (same as the forward path).
//   • Filters that 404 (deleted on Cloud) are skipped, not failed.
//
// Usage:
//   node main/rollback_plan.js logs/plan_<runId>.json [--dry-run] [--no-avoid-overwrite] [--id-file <p>] [--concurrency N]

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudJiraClient = require("../src/cloudJiraClient");
const PlanManager = require("../src/planManager");
const { sanitizeJql } = require("../src/jqlSanitizer");

const args = process.argv.slice(2);
const hasFlag = (n) => args.includes(n);
const argVal = (n) => {
  const i = args.indexOf(n);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
};

const DRY_RUN = hasFlag("--dry-run");
const NO_AVOID_OVERWRITE = hasFlag("--no-avoid-overwrite");
const AVOID_OVERWRITE = !NO_AVOID_OVERWRITE;
const CONCURRENCY = parseInt(argVal("--concurrency") || "5", 10) || 5;
const ID_FILE = argVal("--id-file");
const PLAN_FILE = path.resolve(
  args.find((a) => !a.startsWith("--") && a.endsWith(".json")) ||
    "logs/plan_1778668082983.json",
);

const log = (...a) => console.log(...a);

(async () => {
  if (!fs.existsSync(PLAN_FILE)) {
    console.error("plan not found:", PLAN_FILE);
    process.exit(1);
  }
  log(`Plan:    ${PLAN_FILE}`);
  log(`Mode:    ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  log(`Safety:  --avoid-overwrite ${AVOID_OVERWRITE ? "ON" : "OFF"}`);
  log(`Concurrency: ${CONCURRENCY}`);

  const cloud = new CloudJiraClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_API_TOKEN,
    log,
  );
  const me = await cloud.getCurrentUser();
  log(`Calling user: ${me.displayName} (${me.accountId})`);

  const pm = new PlanManager(path.resolve(__dirname, "../logs"), () => {});
  const plan = await pm.loadPlan(PLAN_FILE);
  if (!plan) { console.error("load failed"); process.exit(1); }

  // Select rollback candidates
  let candidates = Object.entries(plan.filters).filter(
    ([, e]) => e.status === "completed" && e.jqlUpdated === true,
  );

  if (ID_FILE) {
    const allowed = new Set(
      fs.readFileSync(ID_FILE, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    );
    const before = candidates.length;
    candidates = candidates.filter(([id]) => allowed.has(String(id)));
    log(`--id-file: ${candidates.length}/${before} candidates match`);
  }

  log(`Candidates to roll back: ${candidates.length}`);
  if (candidates.length === 0) {
    log("Nothing to do.");
    return;
  }

  const stats = {
    total: candidates.length,
    reverted: 0,
    skippedExternallyModified: 0,
    skipped404: 0,
    skippedSameJql: 0,
    failed: 0,
    ownerSwapFailures: 0,
    ownerRestoreFailures: 0,
  };

  let processed = 0;
  let idx = 0;
  const failures = [];

  async function worker() {
    while (idx < candidates.length) {
      const i = idx++;
      const [cloudId, e] = candidates[i];
      try {
        const live = await cloud.getFilter(cloudId);
        const liveJql = sanitizeJql(String(live.jql || "")).sanitized.trim();
        const expected = sanitizeJql(String(e.rewrittenJql || "")).sanitized.trim();
        if (AVOID_OVERWRITE && liveJql !== expected) {
          stats.skippedExternallyModified++;
          processed++;
          continue;
        }
        if (String(e.originalJql || "").trim() === String(live.jql || "").trim()) {
          // Already at originalJql somehow — nothing to do.
          stats.skippedSameJql++;
          processed++;
          continue;
        }
        if (DRY_RUN) {
          stats.reverted++;
          if (processed < 5 || processed % 100 === 0) {
            log(`  [DRY] would revert ${cloudId} "${(e.name||"").slice(0,40)}"`);
          }
          processed++;
          continue;
        }
        const originalOwnerId = e.originalOwner && e.originalOwner.accountId;
        const needSwap = originalOwnerId && originalOwnerId !== me.accountId;
        let swapped = false;
        if (needSwap) {
          try {
            await cloud.setFilterOwner(cloudId, me.accountId);
            swapped = true;
            await new Promise((r) => setTimeout(r, 1500)); // owner-cache propagation
          } catch (err) {
            stats.ownerSwapFailures++;
            stats.failed++;
            failures.push({ id: cloudId, step: "swap", err: err.message });
            processed++;
            continue;
          }
        }
        // PUT with retry on transient 403/5xx
        let putErr;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await cloud.updateFilter(cloudId, {
              name: e.name,
              jql: e.originalJql,
              description: e.description || "",
            });
            putErr = null;
            break;
          } catch (err) {
            putErr = err;
            const retryable = err.statusCode === 403 || (err.statusCode >= 502 && err.statusCode <= 504);
            if (!retryable || attempt === 3) break;
            await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
          }
        }
        if (putErr) {
          stats.failed++;
          failures.push({ id: cloudId, step: "put", err: putErr.message });
        } else {
          stats.reverted++;
          e.status = "rolled_back";
          e.jqlUpdated = false;
          e.error = null;
          e.updatedAt = new Date().toISOString();
        }
        if (swapped && originalOwnerId) {
          try {
            await cloud.setFilterOwner(cloudId, originalOwnerId);
          } catch (err) {
            stats.ownerRestoreFailures++;
            failures.push({ id: cloudId, step: "restore", err: err.message });
          }
        }
      } catch (err) {
        if (err.statusCode === 404) {
          stats.skipped404++;
        } else {
          stats.failed++;
          failures.push({ id: cloudId, step: "fetch", err: err.message });
        }
      }
      processed++;
      if (processed % 100 === 0) {
        log(`  ${processed}/${candidates.length} (reverted=${stats.reverted}, skip=${stats.skippedExternallyModified + stats.skipped404 + stats.skippedSameJql}, failed=${stats.failed})`);
        if (!DRY_RUN) pm.savePlan();
      }
    }
  }
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  if (!DRY_RUN) pm.savePlan();

  log("\n=== rollback summary ===");
  log(`  candidates:                  ${stats.total}`);
  log(`  reverted (PUT successful):   ${stats.reverted}`);
  log(`  skipped: externally modified: ${stats.skippedExternallyModified}`);
  log(`  skipped: 404 (deleted):      ${stats.skipped404}`);
  log(`  skipped: already at original: ${stats.skippedSameJql}`);
  log(`  failed:                      ${stats.failed}`);
  log(`  owner-swap failures:         ${stats.ownerSwapFailures}`);
  log(`  owner-restore failures:      ${stats.ownerRestoreFailures}`);
  if (failures.length) {
    const csv = path.resolve(__dirname, `../logs/rollback_failures_${Date.now()}.csv`);
    fs.writeFileSync(
      csv,
      "filterId,step,error\n" +
        failures.map((f) => `${f.id},${f.step},"${String(f.err).replace(/"/g, '""')}"`).join("\n"),
    );
    log(`  failures CSV: ${csv}`);
  }
})().catch((err) => {
  console.error("rollback failed:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
