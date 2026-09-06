#!/usr/bin/env node
// Verify post-apply: GET every entry in the plan that was marked completed
// and compare Cloud's CURRENT live JQL against the plan's rewrittenJql.
// Reports drift — filters where the live state diverges from what we last PUT.
//
// Reasons drift can happen:
//   • Cloud silently dropped part of our PUT (sharePermissions quirk, etc.)
//   • Someone manually edited the filter on Cloud since our PUT
//   • A subsequent run modified the filter again with different JQL
//   • Filter was deleted (404)
//
// Output:
//   logs/verify_after_apply_<runId>.csv with columns:
//     filterId, name, status, expected, actual, drift_type
//   drift_type ∈ { match, drift, drift_after_sanitize, deleted, fetch_error }
//
// Usage:
//   node main/verify_after_apply.js [plan_<runId>.json] [--id-file <p>]
//                                    [--include-no-change] [--concurrency N]

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

const INCLUDE_NO_CHANGE = hasFlag("--include-no-change");
const CONCURRENCY = parseInt(argVal("--concurrency") || "8", 10) || 8;
const ID_FILE = argVal("--id-file");
const PLAN_FILE = path.resolve(
  args.find((a) => !a.startsWith("--") && a.endsWith(".json")) ||
    "logs/plan_1778668082983.json",
);

const log = (...a) => console.log(...a);

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

(async () => {
  if (!fs.existsSync(PLAN_FILE)) {
    console.error("plan not found:", PLAN_FILE);
    process.exit(1);
  }
  log(`Plan: ${PLAN_FILE}`);

  const cloud = new CloudJiraClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_API_TOKEN,
    () => {},
  );
  const pm = new PlanManager(path.resolve(__dirname, "../logs"), () => {});
  const plan = await pm.loadPlan(PLAN_FILE);
  if (!plan) { console.error("load failed"); process.exit(1); }

  // Pick what to verify
  let entries = Object.entries(plan.filters).filter(([, e]) => {
    if (INCLUDE_NO_CHANGE) {
      return e.status === "completed" || e.status === "no_change" || e.jqlUpdated;
    }
    return e.status === "completed" && e.jqlUpdated;
  });

  if (ID_FILE) {
    const allowed = new Set(
      fs.readFileSync(ID_FILE, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    );
    entries = entries.filter(([id]) => allowed.has(String(id)));
  }
  log(`Verifying ${entries.length} entries (concurrency=${CONCURRENCY})...`);

  const stats = {
    total: entries.length,
    match: 0,
    matchAfterSanitize: 0,
    drift: 0,
    deleted: 0,
    fetchError: 0,
  };

  const csvRows = ["filterId,name,status,drift_type,expected,actual,err"];
  const driftSamples = [];

  let processed = 0;
  let idx = 0;
  async function worker() {
    while (idx < entries.length) {
      const i = idx++;
      const [cloudId, e] = entries[i];
      let live, errMsg;
      try {
        live = await cloud.getFilter(cloudId);
      } catch (err) {
        if (err.statusCode === 404) {
          stats.deleted++;
          csvRows.push([cloudId, e.name, e.status, "deleted", e.rewrittenJql || "", "", ""].map(csvEscape).join(","));
        } else {
          stats.fetchError++;
          errMsg = err.message;
          csvRows.push([cloudId, e.name, e.status, "fetch_error", e.rewrittenJql || "", "", errMsg].map(csvEscape).join(","));
        }
        processed++;
        continue;
      }
      const expectedRaw = String(e.rewrittenJql || "").trim();
      const actualRaw = String(live.jql || "").trim();
      const expectedSan = sanitizeJql(expectedRaw).sanitized.trim();
      const actualSan = sanitizeJql(actualRaw).sanitized.trim();
      if (expectedRaw === actualRaw) {
        stats.match++;
      } else if (expectedSan === actualSan) {
        stats.matchAfterSanitize++;
        csvRows.push([cloudId, e.name, e.status, "match_after_sanitize", expectedRaw, actualRaw, ""].map(csvEscape).join(","));
      } else {
        stats.drift++;
        if (driftSamples.length < 8) driftSamples.push({ id: cloudId, expected: expectedRaw, actual: actualRaw, name: e.name });
        csvRows.push([cloudId, e.name, e.status, "drift", expectedRaw, actualRaw, ""].map(csvEscape).join(","));
      }
      processed++;
      if (processed % 200 === 0) {
        log(`  ${processed}/${entries.length} (match=${stats.match}, sanMatch=${stats.matchAfterSanitize}, drift=${stats.drift}, 404=${stats.deleted})`);
      }
    }
  }
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  const ts = Date.now();
  const csv = path.resolve(__dirname, `../logs/verify_after_apply_${ts}.csv`);
  fs.writeFileSync(csv, csvRows.join("\n") + "\n");

  log("\n=== verification summary ===");
  log(`  total verified:              ${stats.total}`);
  log(`  match (byte-for-byte):       ${stats.match}`);
  log(`  match after sanitize:        ${stats.matchAfterSanitize}`);
  log(`  drift (Cloud diverged):      ${stats.drift}`);
  log(`  404 (filter deleted):        ${stats.deleted}`);
  log(`  fetch errors:                ${stats.fetchError}`);
  log(`\n  report: ${csv}`);

  if (driftSamples.length) {
    log("\n  Sample drifts:");
    for (const d of driftSamples) {
      log(`\n    filter ${d.id}: ${(d.name||"").slice(0,55)}`);
      log(`      EXPECTED: ${d.expected.slice(0, 240)}`);
      log(`      ACTUAL:   ${d.actual.slice(0, 240)}`);
    }
  }
})().catch((err) => {
  console.error("verify failed:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
