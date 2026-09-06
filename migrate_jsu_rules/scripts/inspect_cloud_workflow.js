#!/usr/bin/env node
/**
 * One-off: fetch a Cloud workflow and dump its rules with all parameters.
 * Used to verify whether Cloud persists our `migrationSourceId` and `tag`
 * fields, which is the precondition for --clean and dedup to work.
 *
 * Usage: node scripts/inspect_cloud_workflow.js "<workflow name>"
 */
require("dotenv").config({ path: __dirname + "/../.env" });
const path = require("path");
const fs = require("fs");
const { resolveConfigEnvIndirections } = require("../src/utils");

async function main() {
  const name = process.argv[2];
  if (!name) {
    console.error('Usage: node scripts/inspect_cloud_workflow.js "<workflow name>"');
    process.exit(2);
  }
  const cfg = resolveConfigEnvIndirections(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8")),
  );
  const JiraCloudClient = require("../../clone_workflow_rules/src/jiraCloudClient");
  const cloud = new JiraCloudClient(cfg.cloud.baseUrl, cfg.cloud.apiToken);
  console.log("Cloud:", cloud.baseUrl, "  Workflow:", name);
  const res = await cloud.makeRequest("POST", "/rest/api/3/workflows", { workflowNames: [name] });
  const wf = ((res && res.workflows) || []).find((w) => w && w.name === name);
  if (!wf) { console.error("Not found on Cloud."); process.exit(1); }
  for (const t of wf.transitions || []) {
    console.log("\n--- Transition: " + t.name + " (id=" + t.id + ") ---");
    const summarize = (rule, kind, idx) => {
      const p = rule.parameters || {};
      const keys = Object.keys(p).sort();
      console.log(`  ${kind}[${idx}] ${rule.ruleKey}`);
      console.log(`    keys: ${keys.join(", ")}`);
      // Highlight tag + migrationSourceId
      console.log(`    tag=${p.tag || "(absent)"}  migrationSourceId=${p.migrationSourceId || "(absent)"}  id=${(p.id || "").slice(0, 8)}...`);
      // If Connect rule, parse config and show its keys
      if (rule.ruleKey && rule.ruleKey.startsWith("connect:") && p.config) {
        try {
          const cfg2 = JSON.parse(p.config);
          console.log(`    config keys: ${Object.keys(cfg2).join(", ")}`);
        } catch {}
      }
    };
    (t.actions || []).forEach((r, i) => summarize(r, "action", i));
    (t.validators || []).forEach((r, i) => summarize(r, "validator", i));
    const walk = (n, prefix) => {
      if (!n) return;
      (n.conditions || []).forEach((r, i) => summarize(r, prefix + "condition", i));
      (n.conditionGroups || []).forEach((cg, i) => walk(cg, prefix + "group[" + i + "]."));
    };
    if (t.conditions) walk(t.conditions, "");
  }
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
