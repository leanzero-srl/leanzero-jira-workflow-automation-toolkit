#!/usr/bin/env node
/**
 * Repoint workflows from the off-screen MIGRATED Approvers field to the on-screen twin,
 * IN PLACE: customfield_10196 (Approvers (migrated)) -> customfield_10003 (Approvers).
 * Covers approvalConfiguration.fieldId (JSM approval step) AND transition action field refs.
 * Reuses CcWorkflowApplier's read/strip/envelope/validate/update steps; the only change is
 * a deep string swap instead of rule-copying.
 * Env: TARGET_URL (default the production site), CLOUD_API_TOKEN (base64). DRY=1 = validate only.
 */
const JiraCloudClient = require("./src/jiraCloudClient");
const CcWorkflowApplier = require("./src/ccWorkflowApplier");
const fs = require("fs");
const E = process.env;
const TOKEN = E.CLOUD_API_TOKEN || fs.readFileSync(__dirname + "/.env", "utf8").split(/\n/).find((l) => l.startsWith("CLOUD_API_TOKEN=")).split("=").slice(1).join("=").trim();
const URL = E.TARGET_URL || "https://your-site.atlassian.net";
const DRY = E.DRY === "1";

const NAMES = [
  "Default Email Service Desk Workflow",
  "New Software Request",
  "IT Service Desk Workflow V1 with priority",
  "SD: Change Management workflow for Jira Service Management",
  "LDS: Service Request Fulfilment with Approvals workflow for Jira Service Management",
  "Payments Ledger",
  "Standard Normal Change",
  "Payments Card",
  "FIN: Jira Service Management default workflow",
];

// deep swap customfield_10196 -> customfield_10003 (word-boundary), counting hits
function swap(obj, ctr) {
  if (typeof obj === "string") { const n = obj.replace(/customfield_10196\b/g, () => { ctr.n++; return "customfield_10003"; }); return n; }
  if (Array.isArray(obj)) return obj.map((v) => swap(v, ctr));
  if (obj && typeof obj === "object") { const o = {}; for (const k of Object.keys(obj)) o[k] = swap(obj[k], ctr); return o; }
  return obj;
}

(async () => {
  const client = new JiraCloudClient(URL, TOKEN);
  const info = await client.testConnection();
  if (!info) throw new Error("cannot connect to " + URL);
  console.log(`Connected: ${info.baseUrl} | mode: ${DRY ? "DRY (validate only)" : "APPLY"}`);
  const applier = new CcWorkflowApplier(client, { log: () => {}, collectDir: __dirname + "/logs/prod_scan" });

  let ok = 0, fail = 0;
  for (const name of NAMES) {
    try {
      let wf = await applier._fetchTargetWorkflow(name);
      if (!wf) { console.log(`  ✗ "${name}": not found on target`); fail++; continue; }
      const ctr = { n: 0 };
      // swap on the workflow incl. its enumerable _topLevelStatuses prop
      const top = wf._topLevelStatuses;
      wf = swap(wf, ctr);
      if (top) wf._topLevelStatuses = swap(top, ctr);
      applier._stripReadOnlyFields(wf);
      const envelope = applier._buildUpdateEnvelope(wf, wf._topLevelStatuses || []);
      const validation = await applier._callValidate(envelope);
      const hasErr = applier._validationHasErrors(validation);
      console.log(`  ${hasErr ? "✗" : "✓"} "${name}": ${ctr.n} ref(s) swapped 10196->10003 | validation: ${hasErr ? "ERRORS" : "clean"}`);
      if (hasErr) { console.log("      " + JSON.stringify(validation).slice(0, 300)); fail++; continue; }
      if (!DRY) { await client.updateWorkflowsBulk(envelope); console.log("      => UPDATED"); }
      ok++;
    } catch (e) { console.log(`  ✗ "${name}": ${e.message}`); fail++; }
  }
  console.log(`\n${DRY ? "DRY " : ""}DONE — ${ok} ok, ${fail} failed/err`);
})().catch((e) => { console.error("FATAL", e.stack || e.message); process.exit(1); });
