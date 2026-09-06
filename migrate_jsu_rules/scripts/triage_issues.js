#!/usr/bin/env node
/**
 * triage_issues.js — Phase A.3 of Round 3 audit fix.
 *
 * Reads triage/issues_resolved.json and prints bucket counts × emit status.
 * This is the headline progress metric — re-run after each phase to see
 * which buckets the latest fix actually shrank.
 *
 * Output (stdout): summary table, plus per-bucket sample issues for
 * focus-buckets passed via --focus.
 *
 * Usage:
 *   node scripts/triage_issues.js [--focus bucket1,bucket2]
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = { focus: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--focus") args.focus = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
  }
  return args;
}

function emitStatus(issue) {
  if (issue.matchStatus === "workflow-not-found") return "wf-missing";
  if (issue.matchStatus === "transition-not-found") return "txn-missing";
  if (!Array.isArray(issue.candidates) || issue.candidates.length === 0) return "no-candidates";
  // Aggregate over candidates: did ANY emit succeed, any auto-disabled?
  const anyEmitted = issue.candidates.some((c) => c.emitted);
  const anyDisabled = issue.candidates.some((c) => c.emitted && c.emitted.disabled === "true");
  const anyNull = issue.candidates.some((c) => !c.emitted);
  if (!anyEmitted) return "mapper-null";
  if (anyDisabled) return "auto-disabled";
  if (anyNull) return "partial-emit";
  return "emitted";
}

function main() {
  const { focus } = parseArgs();
  const p = path.join(__dirname, "..", "triage", "issues_resolved.json");
  if (!fs.existsSync(p)) { console.error("Run cross_reference_issues.js first."); process.exit(2); }
  const doc = JSON.parse(fs.readFileSync(p, "utf8"));

  // Bucket × emit-status grid
  const grid = {};
  const bucketTotals = {};
  for (const issue of doc.issues) {
    const b = issue.commentBucket || "?";
    const st = emitStatus(issue);
    if (!grid[b]) grid[b] = {};
    grid[b][st] = (grid[b][st] || 0) + 1;
    bucketTotals[b] = (bucketTotals[b] || 0) + 1;
  }

  // Print main table
  console.log(`Triage report — ${doc.total} issues across ${Object.keys(bucketTotals).length} buckets`);
  console.log("");
  const statuses = ["emitted", "auto-disabled", "mapper-null", "partial-emit", "no-candidates", "txn-missing", "wf-missing"];
  // Header
  const wBucket = Math.max(...Object.keys(bucketTotals).map((s) => s.length), 24);
  console.log(["bucket".padEnd(wBucket), "total".padStart(6), ...statuses.map((s) => s.padStart(13))].join("  "));
  // Rows sorted by total
  const ordered = Object.entries(bucketTotals).sort((a, b) => b[1] - a[1]);
  for (const [b, total] of ordered) {
    const row = [
      b.padEnd(wBucket),
      String(total).padStart(6),
      ...statuses.map((s) => String(grid[b][s] || "").padStart(13)),
    ];
    console.log(row.join("  "));
  }

  // Focus buckets — show samples
  if (focus.length > 0) {
    for (const focusBucket of focus) {
      const issues = doc.issues.filter((i) => i.commentBucket === focusBucket);
      console.log(`\n=== ${focusBucket} (${issues.length}) ===`);
      for (const issue of issues.slice(0, 8)) {
        console.log(`  [#${issue.sNo}] ${issue.workflow} / ${issue.transition}`);
        for (const c of (issue.candidates || []).slice(0, 1)) {
          console.log(`     DC: ${c.shortName} (${c.ruleCategory})`);
          if (c.emitted) {
            console.log(`     Cloud: ${c.emitted.ruleKey} | disabled=${c.emitted.disabled} | problems=[${c.emitted.problems.join(", ")}]`);
          } else {
            console.log(`     Cloud: mapper returned null`);
          }
        }
      }
    }
  }
}

main();
