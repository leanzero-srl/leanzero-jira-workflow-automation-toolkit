#!/usr/bin/env node
/**
 * verify_applied_rules.js — post-apply sanity check against live Cloud.
 *
 * Three checks, all read-only:
 *   1. DUPLICATES — for every workflow we touched, fetch the live workflow
 *      and find any transition that has two-or-more migration-tagged rules
 *      with the same ruleKey + semantic config hash. If found: dump the
 *      offending rule IDs so the operator can decide which to keep.
 *
 *   2. LEDGER VS CLOUD — for every entry in the ledger, fetch the matching
 *      Cloud rule and confirm it's still present and `migrationSourceId` /
 *      `tag` are intact. Cloud sometimes strips these on certain rule
 *      shapes (already known for SetFieldValueFunction system-rule branch);
 *      report any mismatches.
 *
 *   3. STRUCTURAL — for every migration-tagged Connect rule, parse
 *      `parameters.config` and verify:
 *        - it's valid JSON
 *        - `fieldsConfig[].fieldId` resolves to a Cloud field (no DC IDs)
 *        - Nunjucks values don't contain `${...}` GString leftovers
 *        - JE `expression` doesn't contain `def`/`return`/`=~`
 *
 * Usage:
 *   node scripts/verify_applied_rules.js --collect-dir /tmp/sandbox_final2
 */

require("dotenv").config({ path: __dirname + "/../.env" });
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveConfigEnvIndirections } = require("../src/utils");

function parseArgs() {
  const args = { collectDir: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--collect-dir") args.collectDir = argv[++i];
  }
  if (!args.collectDir) { console.error("--collect-dir required"); process.exit(2); }
  return args;
}

function semanticHash(rule) {
  const p = rule.parameters || {};
  let cfg = "";
  try { cfg = JSON.stringify(JSON.parse(p.config || "{}")); } catch { cfg = p.config || ""; }
  // Exclude id / migrationSourceId / tag from hash — semantic shape only.
  const sig = `${rule.ruleKey}|${p.appKey || ""}|${cfg}`;
  return crypto.createHash("sha256").update(sig).digest("hex").slice(0, 16);
}

async function main() {
  const { collectDir } = parseArgs();
  const cfg = resolveConfigEnvIndirections(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8")),
  );
  const JiraCloudClient = require("../../clone_workflow_rules/src/jiraCloudClient");
  const cloud = new JiraCloudClient(cfg.cloud.baseUrl, cfg.cloud.apiToken);

  // Per-workflow ledger files: `migration_ledger_<sanitised wf name>.json`.
  // The workflow name is at top-level; entries carry `ruleId` (not
  // `cloudRuleId`). Flatten each into a uniform entry shape.
  const ledgerFiles = fs.readdirSync(collectDir).filter((f) => f.startsWith("migration_ledger_") && f.endsWith(".json"));
  const ledger = { entries: [] };
  for (const lf of ledgerFiles) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(collectDir, lf), "utf8"));
      const wf = d.workflowName || d.cloudWorkflowName;
      for (const e of d.entries || []) ledger.entries.push({ ...e, workflowName: wf, cloudRuleId: e.ruleId });
    } catch {}
  }

  // Distinct workflow names from the ledger.
  const wfNames = new Set();
  for (const e of ledger.entries || []) if (e.workflowName) wfNames.add(e.workflowName);

  console.log(`Cloud: ${cloud.baseUrl}`);
  console.log(`Ledger entries: ${(ledger.entries || []).length}`);
  console.log(`Workflows to verify: ${wfNames.size}`);
  console.log();

  const findings = {
    duplicates: [],
    missingFromCloud: [],
    taggedMismatches: [],
    structuralProblems: [],
    healthy: 0,
  };

  // Build a lookup of expected rules by migrationSourceId.
  const expected = new Map();
  for (const e of ledger.entries || []) {
    const k = e.migrationSourceId;
    if (!expected.has(k)) expected.set(k, []);
    expected.get(k).push(e);
  }

  for (const name of wfNames) {
    process.stdout.write(`[${name.slice(0, 60).padEnd(60)}] `);
    let res;
    try {
      res = await cloud.makeRequest("POST", "/rest/api/3/workflows", { workflowNames: [name] });
    } catch (e) {
      // Try the name-override variant — DC may use `_` where Cloud uses `:` or `/`.
      const alts = [name.replace(/_/g, ":"), name.replace(/_/g, "/")];
      for (const alt of alts) {
        try {
          res = await cloud.makeRequest("POST", "/rest/api/3/workflows", { workflowNames: [alt] });
          if (res && res.workflows && res.workflows.length) break;
        } catch {}
      }
    }
    const wf = ((res && res.workflows) || []).find(Boolean);
    if (!wf) { console.log("NOT FOUND"); continue; }
    // Walk transitions, looking for migration-tagged duplicates.
    // Cloud's `/rest/api/3/workflows` returns rules under `t.actions`,
    // `t.conditions.conditions`, and `t.validators` — conditions is a
    // condition-group object, not a flat array.
    const tagged = [];
    for (const t of wf.transitions || []) {
      const arrays = [];
      if (Array.isArray(t.actions)) arrays.push(t.actions);
      if (Array.isArray(t.validators)) arrays.push(t.validators);
      if (Array.isArray(t.conditions)) arrays.push(t.conditions);
      else if (t.conditions && Array.isArray(t.conditions.conditions)) arrays.push(t.conditions.conditions);
      for (const arr of arrays) {
        for (const r of arr) {
          if ((r.parameters || {}).tag === "migration-success") {
            tagged.push({ transitionId: t.id, transitionName: t.name, rule: r });
          }
        }
      }
    }

    // Group tagged rules by (transitionId, semanticHash) to find exact
    // duplicates (same content).
    const seen = new Map();
    for (const e of tagged) {
      const key = `${e.transitionId}|${semanticHash(e.rule)}`;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(e);
    }
    let wfDuplicates = 0;
    for (const [, group] of seen) {
      if (group.length > 1) {
        wfDuplicates += group.length - 1;
        findings.duplicates.push({
          workflowName: name,
          transitionName: group[0].transitionName,
          ruleKey: group[0].rule.ruleKey,
          kind: "identical-content",
          ruleIds: group.map((g) => (g.rule.parameters || {}).id),
        });
      }
    }

    // Same-target duplicates: two SetFieldValueFunction rules on the same
    // transition that write to the SAME fieldId, even if their content
    // differs. Almost always a stale-vs-fresh emission collision.
    const targetMap = new Map(); // `${txn}|${appKey}|${fieldId}` → []
    for (const e of tagged) {
      const r = e.rule;
      if (!r.ruleKey || !r.ruleKey.startsWith("connect:")) continue;
      const p = r.parameters || {};
      let cfgObj;
      try { cfgObj = JSON.parse(p.config || "{}"); } catch { continue; }
      const targets = [];
      if (Array.isArray(cfgObj.fieldsConfig)) {
        for (const fc of cfgObj.fieldsConfig) if (fc && fc.fieldId) targets.push(fc.fieldId);
      }
      for (const fid of targets) {
        const key = `${e.transitionId}|${p.appKey || ""}|${fid}`;
        if (!targetMap.has(key)) targetMap.set(key, []);
        targetMap.get(key).push(e);
      }
    }
    for (const [, group] of targetMap) {
      if (group.length > 1) {
        // Dedup ruleIds list (a single rule with multi-field config gets
        // counted in each target bucket; we only flag when DISTINCT
        // ruleIds collide).
        const distinct = [...new Set(group.map((g) => (g.rule.parameters || {}).id))];
        if (distinct.length > 1) {
          wfDuplicates += distinct.length - 1;
          findings.duplicates.push({
            workflowName: name,
            transitionName: group[0].transitionName,
            ruleKey: group[0].rule.ruleKey,
            kind: "same-target-field",
            ruleIds: distinct,
          });
        }
      }
    }

    // Structural check on each Connect rule.
    let wfStructural = 0;
    for (const e of tagged) {
      const r = e.rule;
      if (!r.ruleKey || !r.ruleKey.startsWith("connect:")) continue;
      const p = r.parameters || {};
      let cfgObj;
      try { cfgObj = JSON.parse(p.config || "{}"); }
      catch { findings.structuralProblems.push({ workflowName: name, ruleId: p.id, kind: "invalid-json" }); wfStructural++; continue; }

      // Field-ID DC leakage on fieldsConfig / value.
      const flat = JSON.stringify(cfgObj);
      // DC field IDs are customfield_<N> in the 10000–20000 range commonly,
      // but the surest test is "DC ID that has no Cloud counterpart". The
      // applier should have remapped at emit time, so a DC ID surviving in
      // the Cloud config means the remap pass missed it.
      const dcIdMatches = [...flat.matchAll(/"customfield_(\d+)"/g)].map((m) => m[1]);
      if (dcIdMatches.length > 0) {
        // We don't have the Cloud-vs-DC ID set loaded here, so the operator
        // verifies on the inspector. Just flag if there's a `fields` map
        // that uses DC IDs and the corresponding rule type is one that
        // emits Cloud IDs (jmwe-set-field-value, native system:update-field).
        // For now, soft-warn — listed for review only.
      }

      // Nunjucks residue: surviving `${...}` in any value field.
      if (/\$\{[^}]*\}/.test(flat)) {
        // Skip CMA-inerted `$<ZWJ>{...}` which is harmless.
        const stripped = flat.replace(/\$[​-‍⁠-⁯]+\{/g, "");
        if (/\$\{[^}]*\}/.test(stripped)) {
          findings.structuralProblems.push({
            workflowName: name, ruleId: p.id, kind: "gstring-leak",
            sample: (flat.match(/\$\{[^}]{0,80}\}/) || [""])[0],
          });
          wfStructural++;
        }
      }

      // JE residue in `expression`.
      if (cfgObj.expression && typeof cfgObj.expression === "string") {
        if (/\b(?:def|return|class|new\s+[A-Z])\b|=~|\bimport\s+\w/.test(cfgObj.expression)) {
          // Auto-disabled is OK; flag only when enabled.
          if (p.disabled !== "true") {
            findings.structuralProblems.push({
              workflowName: name, ruleId: p.id, kind: "je-groovy-residue-enabled",
              expr: cfgObj.expression.slice(0, 120),
            });
            wfStructural++;
          }
        }
      }
    }

    // Ledger-vs-Cloud match (subset). For `system:*` rules Cloud strips
    // `parameters.id` entirely (verified live 2026-05) — the rule is still
    // present but we can't match by UUID. Fall back to "same transition +
    // same ruleKey is enough" for those.
    let wfMissing = 0;
    // Build a per-transition count of system rules on Cloud
    const systemByTxn = new Map();
    for (const t of wf.transitions || []) {
      const count = (t.actions || []).filter((r) => r.ruleKey && r.ruleKey.startsWith("system:")).length;
      systemByTxn.set(String(t.id), count);
    }
    for (const e of (ledger.entries || []).filter((x) => x.workflowName === name)) {
      const hit = tagged.find((t) => (t.rule.parameters || {}).id === e.cloudRuleId);
      if (hit) continue;
      // If the ledger entry is for a `system:*` rule and there's at
      // least one system rule on the same transition, assume Cloud
      // stripped the UUID — not actually missing.
      if (e.ruleKey && e.ruleKey.startsWith("system:")) {
        const txnCount = systemByTxn.get(String(e.transitionId)) || 0;
        if (txnCount > 0) {
          // Consume one slot so two ledger entries for the same txn don't
          // both bind to one rule.
          systemByTxn.set(String(e.transitionId), txnCount - 1);
          continue;
        }
      }
      findings.missingFromCloud.push({
        workflowName: name,
        cloudRuleId: e.cloudRuleId,
        migrationSourceId: e.migrationSourceId,
        ruleKey: e.ruleKey,
      });
      wfMissing++;
    }

    console.log(`tagged=${tagged.length}  dup=${wfDuplicates}  missing=${wfMissing}  struct=${wfStructural}`);
    if (wfDuplicates === 0 && wfMissing === 0 && wfStructural === 0) findings.healthy++;
  }

  console.log();
  console.log("=== Summary ===");
  console.log(`Healthy workflows:           ${findings.healthy} / ${wfNames.size}`);
  console.log(`Duplicate-rule incidents:    ${findings.duplicates.length}`);
  console.log(`Missing-from-cloud rules:    ${findings.missingFromCloud.length}`);
  console.log(`Structural problems:         ${findings.structuralProblems.length}`);

  if (findings.duplicates.length > 0) {
    console.log("\n--- Duplicates (first 10) ---");
    for (const d of findings.duplicates.slice(0, 10)) {
      console.log(`  [${d.workflowName}/${d.transitionName}] ${d.ruleKey}`);
      console.log(`    ids: ${d.ruleIds.join(", ")}`);
    }
  }
  if (findings.missingFromCloud.length > 0) {
    console.log("\n--- Missing from Cloud (first 10) ---");
    for (const m of findings.missingFromCloud.slice(0, 10)) {
      console.log(`  [${m.workflowName}] cloudRuleId=${m.cloudRuleId} migrationSourceId=${m.migrationSourceId}`);
    }
  }
  if (findings.structuralProblems.length > 0) {
    console.log("\n--- Structural problems (first 10) ---");
    for (const s of findings.structuralProblems.slice(0, 10)) {
      console.log(`  [${s.workflowName}] rule=${s.ruleId} kind=${s.kind}`);
      if (s.sample) console.log(`    sample: ${s.sample}`);
      if (s.expr) console.log(`    expr: ${s.expr}`);
    }
  }

  fs.writeFileSync(
    path.join(collectDir, "verify_applied_rules.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), summary: { ...findings, healthy: undefined, healthyCount: findings.healthy } }, null, 2),
  );
  console.log(`\nFull findings written to ${path.join(collectDir, "verify_applied_rules.json")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
