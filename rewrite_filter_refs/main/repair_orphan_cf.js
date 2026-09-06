#!/usr/bin/env node
// One-shot repair tool: scans the plan for entries whose rewrittenJql has the
// "orphan cf[N]/customfield_N before AND/OR" pattern (left by the previous
// cleanupJql empty-IN regex bug), and applies the patched cleanupJql to each.
// Reverts the entry's status to "pending" so the next execute-only run can
// retry the now-well-formed JQL.
//
// Usage:
//   node main/repair_orphan_cf.js [path/to/plan_<runId>.json]

const fs = require("fs");
const path = require("path");
const PlanManager = require("../src/planManager");
const { cleanupJql } = require("../src/brokenFunctionStripper");

const log = (...a) => console.log(...a);

function findLatestPlan() {
  const dir = path.resolve(__dirname, "../logs");
  return fs.readdirSync(dir)
    .filter((f) => /^plan_\d+\.json$/.test(f) && !/prerefresh|preorphan/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((e) => path.join(dir, e.f))[0];
}

(async () => {
  const planFile = process.argv[2] ? path.resolve(process.argv[2]) : findLatestPlan();
  if (!planFile || !fs.existsSync(planFile)) {
    console.error("no plan file");
    process.exit(1);
  }
  log(`Repairing plan: ${planFile}`);

  const pm = new PlanManager(path.resolve(__dirname, "../logs"), () => {});
  const plan = await pm.loadPlan(planFile);
  if (!plan) { console.error("load failed"); process.exit(1); }

  const backup = planFile.replace(/\.json$/, ".preorphan.json");
  fs.copyFileSync(planFile, backup);
  log(`Backup saved: ${backup}`);

  // Pattern marker: orphan cf[N]/customfield_N immediately before AND/OR/ORDER BY
  const ORPHAN_RE =
    /(?:\bcf\[\d+\]|\bcustomfield_\d+)\s+(?=(?:AND|OR)\b|ORDER\s+BY\b)/i;

  let repaired = 0;
  let resetToPending = 0;
  const samples = [];

  for (const [id, e] of Object.entries(plan.filters)) {
    const jql = e.rewrittenJql || "";
    if (!jql || !ORPHAN_RE.test(jql)) continue;
    const cleaned = cleanupJql(jql);
    if (cleaned === jql) continue;

    // If the entry was failed/skipped due to this corruption, reset to
    // pending so the next execute retries it.
    const wasTerminal =
      e.status === "failed" ||
      e.status === "completed" ||
      e.status === "skipped" ||
      e.status === "no_change";

    e.rewrittenJql = cleaned;
    if (wasTerminal) {
      e.status = "pending";
      e.jqlUpdated = false;
      e.permissionsAdded = false;
      e.ownerSwapped = false;
      e.ownerRestored = false;
      e.executionPhase = "idle";
      e.lastStepError = null;
      e.error = null;
      e.updatedAt = null;
      e.sharePermissionPosted = false;
      // expectedLiveJql stays as-is — Cloud either has the corrupted form
      // (if we PUT it) or the prior good form (if we never PUT it).
      // --avoid-overwrite uses it to detect external edits, not to detect
      // our own prior PUT of malformed JQL.
      resetToPending++;
    }
    repaired++;
    if (samples.length < 5) {
      samples.push({ id, before: jql.slice(0, 200), after: cleaned.slice(0, 200) });
    }
  }

  if (repaired === 0) {
    log("No corrupted entries found.");
    return;
  }

  pm.savePlan();
  log(`\nRepaired ${repaired} entries (reset ${resetToPending} to pending).\n`);

  log("=== samples (truncated to 200 chars) ===");
  for (const s of samples) {
    log(`\n  filter ${s.id}`);
    log(`    BEFORE: ${s.before}`);
    log(`    AFTER : ${s.after}`);
  }
})().catch((err) => {
  console.error("repair failed:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
