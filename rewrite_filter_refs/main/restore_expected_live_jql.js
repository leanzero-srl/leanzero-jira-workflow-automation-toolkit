#!/usr/bin/env node
// One-shot: restore expectedLiveJql from a known-good snapshot into the
// current plan. Use when a buggy rebuild clobbered the field.

const fs = require("fs");
const path = require("path");
const PlanManager = require("../src/planManager");

(async () => {
  const planPath = path.resolve(process.argv[2] || "logs/plan_1778420327435.json");
  const snapPath = path.resolve(process.argv[3] || "logs/plan_1778420327435.prev5.json");
  if (!fs.existsSync(planPath) || !fs.existsSync(snapPath)) {
    console.error("missing file:", { planPath, snapPath });
    process.exit(1);
  }
  console.log(`Plan:     ${planPath}`);
  console.log(`Snapshot: ${snapPath}`);

  const pm = new PlanManager(path.resolve(__dirname, "../logs"), () => {});
  const plan = await pm.loadPlan(planPath);
  const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));

  let restored = 0, kept = 0, missingInSnap = 0;
  for (const [id, e] of Object.entries(plan.filters)) {
    const s = snap.filters[id];
    if (!s) { missingInSnap++; continue; }
    const target = s.expectedLiveJql;
    if (!target || String(target).trim().length === 0) {
      kept++;
      continue;
    }
    if (e.expectedLiveJql !== target) {
      e.expectedLiveJql = target;
      restored++;
    } else {
      kept++;
    }
  }
  pm.savePlan();
  console.log(`\n  restored:        ${restored}`);
  console.log(`  unchanged:       ${kept}`);
  console.log(`  not in snapshot: ${missingInSnap}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
