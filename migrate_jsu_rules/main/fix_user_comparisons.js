#!/usr/bin/env node
/**
 * Scan + fix existing Cloud JMWE expression rules that use object-identity
 * user comparisons (e.g. `user != issue.reporter`). Each match is rewritten
 * to `.accountId` form via `src/userComparisonNormalizer.js`.
 *
 * Modes:
 *   default (no flags)        Dry-run scan — emit CSV, no Cloud writes.
 *   --apply --confirm         Live mode — PUT each modified workflow.
 *
 * Selection:
 *   --workflow-names a,b,c    Restrict to specific workflow names.
 *   --workflow-file <path>    Newline-delimited workflow names.
 *   --limit N                 Scan at most N workflows (debug).
 *
 * Output:
 *   logs/fix_user_comparisons_<ts>.csv  (always)
 *
 * Safety:
 *   --apply alone DOES NOTHING; --confirm is required to PUT. validation
 *   runs first; workflows with validation errors are reported and NOT pushed.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const JiraCloudClient = require("../../clone_workflow_rules/src/jiraCloudClient");
const { normalizeUserComparisons } = require("../src/userComparisonNormalizer");
const { resolveConfigEnvIndirections } = require("../src/utils");

const EXPRESSION_RULE_KEYS = new Set([
  "connect:expression-condition",
  "connect:expression-validator",
]);

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    apply: false,
    confirm: false,
    workflowNames: null,
    workflowFile: null,
    limit: null,
    configPath: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply") opts.apply = true;
    else if (a === "--confirm") opts.confirm = true;
    else if (a === "--workflow-names") opts.workflowNames = args[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--workflow-file") opts.workflowFile = args[++i];
    else if (a === "--limit") opts.limit = parseInt(args[++i], 10);
    else if (a === "--config") opts.configPath = args[++i];
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node main/fix_user_comparisons.js [--apply --confirm] [--workflow-names a,b,c] [--workflow-file <path>] [--limit N]");
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function loadConfig(configPath) {
  const cfg = configPath
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : JSON.parse(fs.readFileSync(path.resolve(__dirname, "../config.json"), "utf8"));
  return resolveConfigEnvIndirections(cfg);
}

function buildCloudClient(cfg) {
  const c = cfg.cloud || {};
  if (!c.baseUrl) throw new Error("config.cloud.baseUrl is required");
  if (!c.apiToken) throw new Error("config.cloud.apiToken is required");
  return new JiraCloudClient(c.baseUrl, c.apiToken);
}

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Yield every rule in a workflow with its location breadcrumbs. */
function* iterateRules(workflow) {
  for (const t of workflow.transitions || []) {
    const tname = t.name || "";
    const tid = t.id == null ? "" : String(t.id);
    for (const a of t.actions || []) {
      if (a) yield { rule: a, transitionName: tname, transitionId: tid, category: "postFunction" };
    }
    for (const v of t.validators || []) {
      if (v) yield { rule: v, transitionName: tname, transitionId: tid, category: "validator" };
    }
    const walk = function* (node) {
      if (!node || typeof node !== "object") return;
      for (const c of node.conditions || []) {
        if (c) yield { rule: c, transitionName: tname, transitionId: tid, category: "condition" };
      }
      for (const cg of node.conditionGroups || []) yield* walk(cg);
    };
    yield* walk(t.conditions);
  }
}

/**
 * Inspect a single rule. If it's a JMWE expression rule and its expression
 * contains a user-identity comparison, mutate `rule.parameters.config` in
 * place and return a change record. Returns null when no change is needed.
 */
function scanAndPatch(rule) {
  if (!rule || !rule.parameters) return null;
  if (!EXPRESSION_RULE_KEYS.has(rule.ruleKey)) return null;
  const cfgStr = rule.parameters.config;
  if (typeof cfgStr !== "string" || !cfgStr) return null;
  let cfg;
  try { cfg = JSON.parse(cfgStr); } catch { return null; }
  if (!cfg || typeof cfg.expression !== "string" || !cfg.expression) return null;
  const before = cfg.expression;
  const { output, changes } = normalizeUserComparisons(before);
  if (!changes.length || output === before) return null;
  cfg.expression = output;
  rule.parameters.config = JSON.stringify(cfg);
  return { ruleId: rule.parameters.id || "", ruleKey: rule.ruleKey, before, after: output, snippets: changes };
}

function buildUpdateEnvelope(workflow, topLevelStatuses) {
  const { id, version, _topLevelStatuses, name, ...rest } = workflow;
  void _topLevelStatuses;
  void name;
  return {
    statuses: topLevelStatuses || [],
    workflows: [{ id, version, ...rest }],
  };
}

function validationHasErrors(v) {
  if (!v) return false;
  if (v._error) return true;
  if (Array.isArray(v.errors) && v.errors.some(e => e && (e.level || "ERROR").toUpperCase() === "ERROR")) return true;
  if (Array.isArray(v.errorMessages) && v.errorMessages.length > 0) return true;
  if (v.ruleUpdateErrors && Object.keys(v.ruleUpdateErrors).length > 0) return true;
  const results = v.updateResults || v.validationResults;
  if (Array.isArray(results)) {
    for (const r of results) {
      if (Array.isArray(r.errors) && r.errors.some(e => e && (e.level || "ERROR").toUpperCase() === "ERROR")) return true;
    }
  }
  return false;
}

async function chunkedGetWorkflows(cloud, names) {
  // Use the bulk lookup endpoint that returns the NEW shape (with version.id
  // + top-level statuses) needed for /workflows/update.
  const all = [];
  const chunk = 50;
  for (let i = 0; i < names.length; i += chunk) {
    const slice = names.slice(i, i + chunk);
    const res = await cloud.makeRequest("POST", "/rest/api/3/workflows", { workflowNames: slice });
    const wfs = (res && res.workflows) || [];
    // Stash the top-level statuses from this response — required for update.
    // Each workflow in this batch shares the same top-level statuses block.
    for (const w of wfs) w._topLevelStatuses = (res && res.statuses) || [];
    all.push(...wfs);
  }
  return all;
}

(async () => {
  const opts = parseArgs(process.argv);
  const cfg = loadConfig(opts.configPath);
  const cloud = buildCloudClient(cfg);

  const logsDir = path.resolve(__dirname, "../logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  const ts = Date.now();
  const csvPath = path.resolve(logsDir, `fix_user_comparisons_${ts}.csv`);
  const csvRows = ["workflow,transition,category,ruleKey,ruleId,before,after,applyStatus"];

  const mode = opts.apply && opts.confirm ? "LIVE" : (opts.apply ? "APPLY_NO_CONFIRM (dry)" : "DRY_RUN");
  console.log(`Mode:    ${mode}`);
  console.log(`Output:  ${csvPath}`);

  // Resolve workflow names to scan.
  let names;
  if (opts.workflowNames && opts.workflowNames.length) {
    names = opts.workflowNames;
  } else if (opts.workflowFile) {
    names = fs.readFileSync(opts.workflowFile, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } else {
    console.log("Listing all workflows on Cloud...");
    const all = await cloud.getAllWorkflows();
    names = all.map(w => w && w.id && w.id.name).filter(Boolean);
    console.log(`Discovered ${names.length} workflows.`);
  }
  if (opts.limit && opts.limit > 0) names = names.slice(0, opts.limit);

  console.log(`Fetching new-shape workflow bundles for ${names.length} workflow(s)...`);
  const workflows = await chunkedGetWorkflows(cloud, names);
  console.log(`Resolved ${workflows.length}/${names.length} workflows.`);

  const stats = {
    workflowsScanned: 0,
    workflowsWithChanges: 0,
    rulesChanged: 0,
    workflowsValidationError: 0,
    workflowsPushed: 0,
    workflowsPushFailed: 0,
  };

  for (const wf of workflows) {
    stats.workflowsScanned++;
    const changesForThisWf = [];
    for (const { rule, transitionName, category } of iterateRules(wf)) {
      const change = scanAndPatch(rule);
      if (change) {
        changesForThisWf.push({ ...change, transitionName, category });
      }
    }
    if (!changesForThisWf.length) continue;
    stats.workflowsWithChanges++;
    stats.rulesChanged += changesForThisWf.length;

    let applyStatus = mode === "LIVE" ? "PENDING" : (opts.apply ? "DRY_APPLY_NO_CONFIRM" : "DRY_RUN");

    if (mode === "LIVE") {
      const envelope = buildUpdateEnvelope(wf, wf._topLevelStatuses);
      let validation;
      try {
        validation = await cloud.validateUpdateWorkflowsBulk(envelope);
      } catch (e) {
        validation = { _error: e.message };
      }
      if (validationHasErrors(validation)) {
        stats.workflowsValidationError++;
        applyStatus = `VALIDATION_ERROR: ${JSON.stringify(validation).slice(0, 200)}`;
        console.log(`  ${wf.name}: validation error — NOT pushed (${changesForThisWf.length} rule change(s))`);
      } else {
        try {
          await cloud.updateWorkflowsBulk(envelope);
          stats.workflowsPushed++;
          applyStatus = "PUSHED";
          console.log(`  ${wf.name}: pushed (${changesForThisWf.length} rule change(s))`);
        } catch (e) {
          stats.workflowsPushFailed++;
          applyStatus = `PUSH_FAILED: ${e.message}`;
          console.log(`  ${wf.name}: push FAILED — ${e.message}`);
        }
      }
    } else {
      console.log(`  ${wf.name}: ${changesForThisWf.length} rule(s) would change`);
    }

    for (const c of changesForThisWf) {
      csvRows.push([
        wf.name,
        c.transitionName,
        c.category,
        c.ruleKey,
        c.ruleId,
        c.before,
        c.after,
        applyStatus,
      ].map(csvEscape).join(","));
    }
  }

  fs.writeFileSync(csvPath, csvRows.join("\n") + "\n");

  console.log("\n=== summary ===");
  console.log(`  workflows scanned:           ${stats.workflowsScanned}`);
  console.log(`  workflows with changes:      ${stats.workflowsWithChanges}`);
  console.log(`  rule expression changes:     ${stats.rulesChanged}`);
  if (mode === "LIVE") {
    console.log(`  validation errors:           ${stats.workflowsValidationError}`);
    console.log(`  workflows pushed:            ${stats.workflowsPushed}`);
    console.log(`  workflows push failed:       ${stats.workflowsPushFailed}`);
  } else if (stats.workflowsWithChanges > 0) {
    console.log(`\n  Re-run with --apply --confirm to push.`);
  }
  console.log(`\n  report: ${csvPath}`);
})().catch((err) => {
  console.error("fix_user_comparisons failed:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
