#!/usr/bin/env node
/**
 * One-off diagnostic: list every workflow on the configured Cloud tenant by
 * name, paginated through /rest/api/3/workflow/search. Used to fill in
 * `config.json.workflowNameOverrides` when DC XML export mangled `:` / `/`
 * into `_` and the migrator can't find the workflow by its mangled name.
 *
 * Usage:
 *   node scripts/list_cloud_workflows.js [--match <substring>]
 */

require("dotenv").config({ path: __dirname + "/../.env" });
const path = require("path");
const fs = require("fs");
const { resolveConfigEnvIndirections } = require("../src/utils");

async function main() {
  const args = process.argv.slice(2);
  const matchIdx = args.indexOf("--match");
  const matchFilter = matchIdx >= 0 ? (args[matchIdx + 1] || "").toLowerCase() : null;

  const cfg = resolveConfigEnvIndirections(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8")),
  );
  if (!cfg.cloud || !cfg.cloud.baseUrl || !cfg.cloud.apiToken) {
    throw new Error("config.json missing cloud.baseUrl or cloud.apiToken");
  }
  const JiraCloudClient = require("../../clone_workflow_rules/src/jiraCloudClient");
  const cloud = new JiraCloudClient(cfg.cloud.baseUrl, cfg.cloud.apiToken);
  console.log(`Cloud: ${cloud.baseUrl}`);

  const names = [];
  let startAt = 0;
  for (;;) {
    const res = await cloud.makeRequest(
      "GET",
      `/rest/api/3/workflow/search?startAt=${startAt}&maxResults=50`,
    );
    const values = (res && res.values) || [];
    for (const w of values) {
      if (!w) continue;
      const n = (w.id && w.id.name) || w.name;
      if (n) names.push(n);
    }
    if (res.isLast || values.length === 0) break;
    startAt += values.length;
    if (startAt > 5000) break; // safety
  }

  const sorted = names.sort((a, b) => a.localeCompare(b));
  console.log(`Total workflows on tenant: ${sorted.length}`);
  console.log("");
  if (matchFilter) {
    const hits = sorted.filter((n) => n.toLowerCase().includes(matchFilter));
    console.log(`Filtered by "${matchFilter}": ${hits.length} match(es)`);
    for (const n of hits) console.log("  " + n);
  } else {
    for (const n of sorted) console.log("  " + n);
  }
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
