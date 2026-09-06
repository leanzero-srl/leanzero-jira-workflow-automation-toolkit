#!/usr/bin/env node
// Compare the plan's rewrittenJql against Cloud's current live JQL, write a
// CSV review file. No Cloud writes. Use this AFTER rebuild_plan_from_original
// (and optionally fetch_dc_originals) to eyeball exactly what would change
// before any --execute-only run.
//
// Each pending entry is GET'd from Cloud, both sides are sanitized with the
// same passes --avoid-overwrite uses, and a row is emitted with:
//   cloudId, name, owner, status, externallyModified, changeKind, sourceUsed,
//   currentCloudJql, plannedRewrittenJql, dcOriginalJql, originalJql
//
// changeKind values:
//   ari_collision   — ariCollisions[] is non-empty on this entry
//   asset_field     — asset-field rewrites without ARI
//   sanitize_only   — only sanitizer / op-uppercase / quote changes
//   filter_refs     — filter-id rewrites (DC→Cloud)
//   mixed           — combination
//   none            — rewrittenJql identical to currentCloudJql post-sanitize
//
// externallyModified flag mirrors --avoid-overwrite logic exactly.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudJiraClient = require("../src/cloudJiraClient");
const PlanManager = require("../src/planManager");
const { sanitizeJql } = require("../src/jqlSanitizer");

const args = process.argv.slice(2);
function hasFlag(n) { return args.includes(n); }
function getArg(n) {
  const i = args.indexOf(n);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

if (hasFlag("--help")) {
  console.log(`
Usage: node main/review_changes.js [options]

For each plan entry whose status is "pending" (i.e. will be PUT on next
execute), fetch Cloud's current JQL and emit a CSV row showing the diff.

Options:
  --plan-file <path>     Explicit plan file. Default: latest plan_*.json.
  --id-file <path>       Restrict to specific cloud filter IDs.
  --limit <n>            Cap entries reviewed.
  --concurrency <n>      Parallel GETs (default 5).
  --include <kinds>      Comma-separated changeKinds to include (default all).
                         e.g. --include ari_collision,asset_field
  --only-changing        Drop rows where changeKind === none.
  --output <path>        CSV output path. Default: logs/review_changes_<runId>.csv
  --help                 Show this help.

No Cloud writes are ever performed.
`);
  process.exit(0);
}

const PLAN_FILE = getArg("--plan-file");
const ID_FILE = getArg("--id-file");
const LIMIT = parseInt(getArg("--limit") || "0", 10) || 0;
const CONCURRENCY = parseInt(getArg("--concurrency") || "5", 10) || 5;
const INCLUDE = (getArg("--include") || "").split(",").map((s) => s.trim()).filter(Boolean);
const ONLY_CHANGING = hasFlag("--only-changing");
const OUTPUT = getArg("--output");
// --no-overwrite-check: omit the externallyModified column entirely.
// Useful when you intend to execute WITHOUT --avoid-overwrite (so every
// listed filter will actually be PUT, regardless of manual edits).
const NO_OVERWRITE_CHECK = hasFlag("--no-overwrite-check");

const logsDir = path.resolve(__dirname, "../logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const runId = String(Date.now());
const outputCsv = OUTPUT ? path.resolve(OUTPUT) : path.join(logsDir, `review_changes_${runId}.csv`);
const logFile = path.join(logsDir, `review_changes_${runId}.log`);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  try { fs.appendFileSync(logFile, line + "\n"); } catch { /* ignore */ }
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v).replace(/"/g, '""');
  return /[",\n\r]/.test(s) ? `"${s}"` : s;
}

function csvRow(values) {
  return values.map(csvCell).join(",") + "\n";
}

function classifyChange(entry, currentLive, planned) {
  const liveS = sanitizeJql(currentLive || "").sanitized.trim();
  const planS = sanitizeJql(planned || "").sanitized.trim();
  if (liveS === planS) return "none";
  const hasAri = (entry.ariCollisions || []).length > 0;
  const hasAsset = (entry.assetFieldReplacements || []).length > 0;
  const hasRefs = (entry.refs || []).some((r) => r.resolution === "ok");
  const hasSan = (entry.sanitizerChanges || []).length > 0;
  const kinds = [];
  if (hasAri) kinds.push("ari_collision");
  if (hasAsset) kinds.push("asset_field");
  if (hasRefs) kinds.push("filter_refs");
  if (hasSan && kinds.length === 0) kinds.push("sanitize_only");
  if (kinds.length === 0) return "other";
  if (kinds.length === 1) return kinds[0];
  return "mixed:" + kinds.join("|");
}

function isExternallyModified(entry, currentLiveRaw) {
  // Mirror --avoid-overwrite logic. Expected = expectedLiveJql or originalJql.
  const elj = entry.expectedLiveJql;
  const hasExpected = typeof elj === "string" && elj.trim().length > 0;
  const expectedRaw = hasExpected ? elj : (entry.originalJql || "");
  const expected = expectedRaw ? sanitizeJql(expectedRaw).sanitized.trim() : "";
  const liveJql = (currentLiveRaw || "").trim()
    ? sanitizeJql(currentLiveRaw).sanitized.trim()
    : "";
  if (!expected) return false;
  return liveJql !== expected;
}

(async function main() {
  const missing = ["CLOUD_BASE_URL", "CLOUD_API_TOKEN"].filter((k) => !process.env[k]);
  if (missing.length) {
    log(`ERROR: Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }

  log("============================================================");
  log("Review changes — compare planned rewrittenJql vs Cloud live");
  log("============================================================");

  const cloud = new CloudJiraClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_API_TOKEN,
    log,
  );

  const pm = new PlanManager(logsDir, log);
  let planFile = PLAN_FILE
    ? path.resolve(PLAN_FILE)
    : fs.readdirSync(logsDir)
        .filter((f) => /^plan_\d+\.json$/.test(f) && !/prerefresh|preorphan|prerebuild|prebackfill|prefetchdc/.test(f))
        .map((f) => ({ f, m: fs.statSync(path.join(logsDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)
        .map((e) => path.join(logsDir, e.f))[0];

  if (!planFile || !fs.existsSync(planFile)) {
    log("No plan file found.");
    process.exit(1);
  }
  log(`Plan: ${planFile}`);
  const plan = await pm.loadPlan(planFile);
  if (!plan) {
    log("Failed to load plan.");
    process.exit(1);
  }

  let entries = Object.entries(plan.filters);
  // Pending = something to change. We still allow no_change in case the user
  // wants the full audit, but default scope is pending + failed (eligible for
  // PUT on a retry-failed run).
  entries = entries.filter(([, e]) => e.status === "pending" || e.status === "failed");

  if (ID_FILE) {
    const allowed = new Set(
      fs.readFileSync(ID_FILE, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    );
    entries = entries.filter(([cid]) => allowed.has(cid));
  }
  // Pre-filter when --include is exactly ari_collision: skip the live-GET
  // for entries that don't already have ariCollisions in the plan. Saves
  // thousands of Cloud round-trips when the user just wants the collision
  // spot-check.
  if (INCLUDE.length === 1 && INCLUDE[0] === "ari_collision") {
    entries = entries.filter(([, e]) => (e.ariCollisions || []).length > 0);
    log(`  pre-filtered to ari_collision-only: ${entries.length} entries`);
  }
  if (LIMIT > 0) entries = entries.slice(0, LIMIT);

  log(`Reviewing ${entries.length} entries (status ∈ {pending, failed})`);

  // Header — omit externallyModified column when --no-overwrite-check is set.
  const headerCols = NO_OVERWRITE_CHECK
    ? ["cloudId", "name", "ownerDisplayName", "status",
       "changeKind", "currentCloudJql", "plannedRewrittenJql",
       "dcOriginalJql", "originalJql",
       "ariCollisionsCount", "lastStepError"]
    : ["cloudId", "name", "ownerDisplayName", "status", "externallyModified",
       "changeKind", "currentCloudJql", "plannedRewrittenJql",
       "dcOriginalJql", "originalJql", "expectedLiveJql",
       "ariCollisionsCount", "lastStepError"];
  fs.writeFileSync(outputCsv, csvRow(headerCols));

  const stats = {
    total: entries.length,
    fetched: 0,
    fetchFail: 0,
    externallyModified: 0,
    byKind: new Map(),
    written: 0,
  };

  let idx = 0;
  async function worker() {
    while (true) {
      const myIdx = idx++;
      if (myIdx >= entries.length) return;
      const [cloudId, entry] = entries[myIdx];
      let live;
      try {
        live = await cloud.getFilter(cloudId);
        stats.fetched++;
      } catch (err) {
        stats.fetchFail++;
        live = { jql: "" };
        entry._fetchErr = `${err.statusCode || ""} ${err.message}`;
      }
      const currentLiveRaw = (live && live.jql) || "";
      const externally = isExternallyModified(entry, currentLiveRaw);
      if (externally) stats.externallyModified++;
      const kind = classifyChange(entry, currentLiveRaw, entry.rewrittenJql || "");
      stats.byKind.set(kind, (stats.byKind.get(kind) || 0) + 1);

      if (ONLY_CHANGING && kind === "none") continue;
      if (INCLUDE.length > 0 && !INCLUDE.some((k) => kind === k || kind.startsWith("mixed") && kind.includes(k))) continue;

      const ownerName = entry.originalOwner && entry.originalOwner.displayName || "";
      const rowCols = NO_OVERWRITE_CHECK
        ? [cloudId, entry.name || "", ownerName, entry.status,
           kind, currentLiveRaw, entry.rewrittenJql || "",
           entry.dcOriginalJql || "", entry.originalJql || "",
           (entry.ariCollisions || []).length,
           entry.lastStepError || entry._fetchErr || ""]
        : [cloudId, entry.name || "", ownerName, entry.status,
           externally ? "Y" : "N", kind, currentLiveRaw,
           entry.rewrittenJql || "", entry.dcOriginalJql || "",
           entry.originalJql || "", entry.expectedLiveJql || "",
           (entry.ariCollisions || []).length,
           entry.lastStepError || entry._fetchErr || ""];
      fs.appendFileSync(outputCsv, csvRow(rowCols));
      stats.written++;
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, entries.length); i++) workers.push(worker());
  await Promise.all(workers);

  log("\n=== review summary ===");
  log(`  reviewed       : ${stats.total}`);
  log(`  cloud GETs OK  : ${stats.fetched}`);
  log(`  cloud GETs FAIL: ${stats.fetchFail}`);
  log(`  externally mod : ${stats.externallyModified}`);
  log(`  written rows   : ${stats.written}`);
  for (const [k, v] of [...stats.byKind.entries()].sort((a, b) => b[1] - a[1])) {
    log(`    ${k.padEnd(20)} ${v}`);
  }
  log(`\n  CSV: ${outputCsv}`);
})().catch((err) => {
  log(`FATAL: ${err.message}\n${err.stack || ""}`);
  process.exit(1);
});
