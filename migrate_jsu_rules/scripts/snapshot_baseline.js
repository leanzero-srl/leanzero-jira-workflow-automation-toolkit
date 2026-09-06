#!/usr/bin/env node
/**
 * snapshot_baseline.js — Phase 0 of Round 3 audit fix.
 *
 * Captures the current emit state for the collect-dir's latest apply_*.json
 * so subsequent phases can prove they don't regress unaffected rules. The
 * snapshot includes:
 *   - Per-workflow appended counts
 *   - Per-workflow autoDisabled counts
 *   - Per-reason CSV bucket counts (from latest unmapped CSV)
 *   - Total rule-id set per workflow (so we can spot rules that DISAPPEAR
 *     in later applies)
 *
 * Output:
 *   triage/baseline_<YYYY-MM-DD>.json
 *
 * Usage:
 *   node scripts/snapshot_baseline.js --collect-dir <path> [--label <name>]
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = { collectDir: null, label: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--collect-dir") args.collectDir = argv[++i];
    else if (argv[i] === "--label") args.label = argv[++i];
  }
  if (!args.collectDir) { console.error("--collect-dir required"); process.exit(2); }
  return args;
}

function latestApply(collectDir) {
  const files = fs.readdirSync(collectDir).filter((f) => /^apply_\d{8}_\d{6}\.json$/.test(f));
  if (files.length === 0) return null;
  return files.sort()[files.length - 1];
}

function latestUnmapped(collectDir) {
  const files = fs.readdirSync(collectDir).filter((f) => /^unmapped_\d{8}_\d{6}\.csv$/.test(f));
  if (files.length === 0) return null;
  return files.sort()[files.length - 1];
}

function bucketReason(reason) {
  const r = String(reason || "");
  const m = r.match(/^([a-z][a-z0-9-]+):/i);
  return m ? m[1] : "other";
}

function main() {
  const { collectDir, label } = parseArgs();
  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.join(__dirname, "..", "triage");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const applyFile = latestApply(collectDir);
  if (!applyFile) { console.error(`No apply_*.json in ${collectDir}`); process.exit(2); }
  const apply = JSON.parse(fs.readFileSync(path.join(collectDir, applyFile), "utf8"));

  const perWorkflow = {};
  let totalAppended = 0;
  let totalAutoDisabled = 0;
  for (const wf of apply.workflows || []) {
    const appended = (wf.appended || []).length;
    const autoDisabled = (wf.appended || []).filter((a) => a.autoDisabled).length;
    perWorkflow[wf.workflowName] = {
      appended,
      autoDisabled,
      ruleIds: (wf.appended || []).map((a) => a.ruleId).filter(Boolean),
    };
    totalAppended += appended;
    totalAutoDisabled += autoDisabled;
  }

  // Per-reason CSV bucket counts
  const reasonCounts = {};
  if (Array.isArray(apply.unmappedRules)) {
    for (const u of apply.unmappedRules) {
      const b = bucketReason(u.reason);
      reasonCounts[b] = (reasonCounts[b] || 0) + 1;
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    label: label || `baseline-${today}`,
    collectDir,
    sourceApply: applyFile,
    sourceUnmapped: latestUnmapped(collectDir),
    totals: {
      workflows: Object.keys(perWorkflow).length,
      appended: totalAppended,
      autoDisabled: totalAutoDisabled,
      unmappedRows: (apply.unmappedRules || []).length,
      alreadyOnCloud: (apply.alreadyOnCloud || []).length,
    },
    reasonCounts,
    perWorkflow,
  };

  const outPath = path.join(outDir, `baseline_${today}.json`);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`Baseline written to ${outPath}`);
  console.log(`  Workflows: ${snapshot.totals.workflows}`);
  console.log(`  Appended:  ${snapshot.totals.appended}`);
  console.log(`  Auto-disabled: ${snapshot.totals.autoDisabled}`);
  console.log(`  Unmapped:  ${snapshot.totals.unmappedRows}`);
  console.log(`  Already-on-cloud: ${snapshot.totals.alreadyOnCloud}`);
  console.log("");
  console.log("CSV reason buckets:");
  for (const [k, v] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)} ${k}`);
  }
}

main();
