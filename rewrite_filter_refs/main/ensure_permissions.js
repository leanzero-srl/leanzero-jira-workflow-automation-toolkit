#!/usr/bin/env node
// Stand-alone "permissions-only" pass.
//
// Walks every Cloud filter and ensures the configured group (default
// "org-admins") is present in BOTH `editPermissions` and `sharePermissions`.
// Does NOT modify JQL. Touches even filters the JQL pipeline left as
// `no_change` / `skipped` / `failed`.
//
// Two phases (same shape as rewrite_filter_refs.js):
//   plan-only build → execute (resumable)
//
// Usage:
//   node main/ensure_permissions.js [--dry-run] [--plan-only|--resume|--execute-only]
//                                    [--plan-file <master.json>] [--limit N]
//                                    [--id-file <path>] [--retry-failed]
//                                    [--skip-not-owned] [--concurrency N]
//                                    [--org-admins-group <name>]
//                                    [--avoid-overwrite]

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudJiraClient = require("../src/cloudJiraClient");
const PlanManager = require("../src/planManager");
const PermissionsOnlyProcessor = require("../src/permissionsOnlyProcessor");
const { resolveOrgAdminsGroup } = require("../src/permissions");

const args = process.argv.slice(2);
const hasFlag = (n) => args.includes(n);
const argVal = (n) => {
  const i = args.indexOf(n);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
};

const DRY_RUN = hasFlag("--dry-run");
const PLAN_ONLY = hasFlag("--plan-only");
const EXECUTE_ONLY = hasFlag("--execute-only") || hasFlag("--resume");
const HELP = hasFlag("--help");
const LIMIT = parseInt(argVal("--limit") || "0", 10) || 0;
const CONCURRENCY = parseInt(argVal("--concurrency") || "5", 10) || 5;
const ID_FILE = argVal("--id-file");
const RETRY_FAILED = hasFlag("--retry-failed");
const SKIP_NOT_OWNED = hasFlag("--skip-not-owned");
const PLAN_FILE = argVal("--plan-file");
const ORG_ADMINS_GROUP = argVal("--org-admins-group") || "org-admins";
const AVOID_OVERWRITE = hasFlag("--avoid-overwrite");

if (HELP) {
  console.log(`
Usage: node ensure_permissions.js [options]

Ensures the configured group is present in BOTH sharePermissions AND
editPermissions of every Cloud filter. Does NOT touch JQL. Use this for
the design gap where the JQL rewriter only added permissions to filters
that ALSO had a JQL rewrite — this pass closes the coverage gap.

Phases:
  (default)            build plan, then execute (unless --plan-only)
  --plan-only          build plan, do not execute
  --execute-only       (or --resume) load latest plan, execute

Options:
  --dry-run            preview only; no PUT / POST
  --plan-file <p>      explicit master_<id>.json
  --limit <n>          cap Cloud filters scanned
  --concurrency <n>    parallel workers (default 5)
  --id-file <p>        restrict to newline-separated filter IDs
  --retry-failed       include failed entries on execute
  --skip-not-owned     only touch filters owned by current account
  --org-admins-group <name>   group name (default: org-admins)
  --avoid-overwrite    pre-GET each filter, skip if JQL changed vs plan
  --help               show this

Environment (.env):
  CLOUD_BASE_URL       Cloud site URL (e.g. https://X.atlassian.net)
  CLOUD_API_TOKEN      base64 of <email>:<api_token>
`);
  process.exit(0);
}

const logsDir = path.resolve(__dirname, "../logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, `ensure_permissions_${Date.now()}.log`);
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(message);
  try { fs.appendFileSync(logFile, line + "\n"); } catch {}
}

const required = ["CLOUD_BASE_URL", "CLOUD_API_TOKEN"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  log(`ERROR: missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

async function main() {
  const startTime = Date.now();
  const runId = String(startTime);

  log("============================================================");
  log("Ensure org-admins permissions on ALL Cloud filters");
  log("============================================================");
  log(`  Cloud:   ${process.env.CLOUD_BASE_URL}`);
  log(`  Mode:    ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  if (PLAN_ONLY) log("  Phase:   PLAN ONLY");
  if (EXECUTE_ONLY) log("  Phase:   EXECUTE ONLY");
  if (LIMIT > 0) log(`  Limit:   ${LIMIT}`);
  if (ID_FILE) log(`  IdFile:  ${ID_FILE}`);
  log(`  Group:   ${ORG_ADMINS_GROUP}`);
  log(`  Concurrency: ${CONCURRENCY}`);
  log("");

  const cloud = new CloudJiraClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_API_TOKEN,
    log,
  );

  log("Step 0: Testing connectivity & resolving current user...");
  try {
    const info = await cloud.testConnection();
    log(`  Cloud: OK (${(info && (info.serverTitle || info.baseUrl)) || "connected"})`);
  } catch (err) {
    log(`  Cloud: FAILED - ${err.message}`);
    process.exit(1);
  }
  let currentAccountId = null;
  try {
    const me = await cloud.getCurrentUser();
    currentAccountId = me.accountId;
    log(`  Cloud account: ${me.emailAddress || me.displayName} (${currentAccountId})`);
  } catch (err) {
    log(`  Cloud /myself failed: ${err.message}. Owner-swap will be disabled.`);
  }

  let orgAdminsGroup = null;
  try {
    orgAdminsGroup = await resolveOrgAdminsGroup(cloud, {
      groupName: ORG_ADMINS_GROUP,
    });
    log(`  Group "${orgAdminsGroup.name}" (groupId=${orgAdminsGroup.groupId})`);
  } catch (err) {
    log(`  ERROR: ${err.message}`);
    process.exit(1);
  }

  const planManager = new PlanManager(logsDir, log);
  const processor = new PermissionsOnlyProcessor({
    cloudClient: cloud,
    planManager,
    options: {
      dryRun: DRY_RUN,
      limit: LIMIT,
      concurrency: CONCURRENCY,
      idFile: ID_FILE,
      retryFailed: RETRY_FAILED,
      skipNotOwned: SKIP_NOT_OWNED,
      avoidOverwrite: AVOID_OVERWRITE,
      currentAccountId,
      orgAdminsGroup,
    },
    log,
  });

  installSignalHandlers(planManager, log);

  if (EXECUTE_ONLY) {
    const master = planManager.loadMasterIndex(PLAN_FILE);
    if (!master) {
      log("  No plan to resume. Exiting.");
      process.exit(1);
    }
    const loaded = await planManager.loadPlan(master.planFile);
    if (!loaded) {
      log("  Could not load plan. Exiting.");
      process.exit(1);
    }
    await processor.executePlan();
  } else {
    await processor.buildPlan(runId);
    if (PLAN_ONLY) {
      log("\n--plan-only: stopping before execution.");
    } else {
      await processor.executePlan();
    }
  }

  printReport(processor, cloud, planManager, startTime);
}

function printReport(processor, cloud, planManager, startTime) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const s = processor.getStats();
  const c = cloud.getStats();
  log("\n============================================================");
  log("FINAL REPORT");
  log("============================================================");
  if (DRY_RUN) log("\n  *** DRY RUN — No changes were made ***");
  log("\n  Filters:");
  log(`    Total scanned:       ${s.totalCloudFilters}`);
  log(`    Already had both:    ${s.alreadyHasBoth}`);
  log(`    Needs edit only:     ${s.needsEdit}`);
  log(`    Needs share only:    ${s.needsShare}`);
  log(`    Needs both:          ${s.needsBoth}`);
  log("\n  Actions:");
  log(`    Edit PUTs:           ${s.editPutsSucceeded}/${s.editPutsAttempted} succeeded (${s.editPutsFailed} failed)`);
  log(`    Share POSTs:         ${s.sharePostsSucceeded}/${s.sharePostsAttempted} succeeded (${s.sharePostsFailed} failed)`);
  log(`    Owner swap failures: ${s.ownerSwapFailures}`);
  log(`    Owner restore fails: ${s.ownerRestoreFailures}`);
  log("\n  Outcomes:");
  log(`    Completed:           ${s.filtersUpdated}`);
  log(`    Failed:              ${s.filtersFailed}`);
  log(`    Skipped:             ${s.filtersSkipped}`);
  log("\n  API:");
  log(`    Cloud: ${c.requestCount} reqs (${c.errorCount} errors, ${c.rateLimitCount} rate-lim)`);
  const summary = planManager.getPlanSummary && planManager.getPlanSummary();
  if (summary) {
    log("\n  Plan file:");
    if (summary.masterFile) log(`    Master: ${summary.masterFile}`);
    if (summary.planFile)   log(`    Plan:   ${summary.planFile}`);
  }
  log(`\n  Log file:    ${logFile}`);
  log(`  Elapsed:     ${elapsed}s`);
  log("============================================================\n");
}

let shuttingDown = false;
function installSignalHandlers(planManager, log) {
  const handle = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\nReceived ${signal}, saving plan and shutting down...`);
    try { planManager.savePlan(); planManager.saveMasterIndex(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));
}

main().catch((err) => {
  log(`\nFATAL ERROR: ${err.message}`);
  if (err.stack) log(err.stack);
  process.exit(1);
});
