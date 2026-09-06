#!/usr/bin/env node
/**
 * mapper_self_test.js — empirically validate every NATIVE_MAPPERS + JMWE_MAPPERS
 * entry against representative DC configurations.
 *
 * Goals:
 *   1. Discover every JSU/JMWE shortName actually used by the migrator on this
 *      tenant pair (sourced from the latest collect dir's dc_workflows/*.json).
 *   2. For each shortName, run BOTH the native and JMWE mappers (where they
 *      exist) and capture the output shape + any mapper-side errors
 *      (mapperReturnedNull, ctx.unresolved entries from macro/field/status).
 *   3. Optionally validate each mapper's output against a live Cloud workflow
 *      via POST /rest/api/3/workflows/update/validation — this surfaces the
 *      silent failures that pure offline mapping can't see (wrong ruleKey,
 *      malformed Connect config, unsupported parameter values).
 *
 * Usage:
 *   node scripts/mapper_self_test.js --collect-dir logs/collected_<TS> [options]
 *
 * Options:
 *   --collect-dir <path>       REQUIRED. Source for DC example configurations.
 *   --out <path>               Output JSON (default: logs/mapper_self_test_<TS>.json).
 *   --short-name <name>        Test a single mapper only.
 *   --strategy native|jmwe|both  Default: both.
 *   --validate <wf-name>       Live mode: POST converted rules to
 *                              /workflows/update/validation against this
 *                              already-existing Cloud workflow. Skipped if absent.
 *   --max-errors-per-mapper N  How many Cloud errors to record per mapper (default: 5).
 *
 * Output:
 *   logs/mapper_self_test_<TS>.json — per-mapper status + evidence.
 *   stdout — green/red summary per shortName.
 *
 * Exit code:
 *   0 if every tested mapper either returns a valid output (offline) or passes
 *     validation (live mode); 1 if any mapper failed.
 */

require("dotenv").config({ path: __dirname + "/../.env" });
const fs = require("fs");
const path = require("path");

const { resolveConfigEnvIndirections, timestampSlug, uuidv4 } = require("../src/utils");
const { hasNativeMapper, convertToNative } = require("../src/jsuNativeMappers");
const { hasJmweMapper, convertToJmwe } = require("../src/jsuJmweMappers");
const { getJsuShortName, JMWE_APP_KEY_DEFAULT } = require("../src/jsuRuleCatalog");

const ROOT = path.resolve(__dirname, "..");

// ──────────────────────────────────────────────────────────────────────────
// CLI parsing
// ──────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    collectDir: null,
    out: null,
    shortName: null,
    strategy: "both",
    validate: null,
    maxErrorsPerMapper: 5,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--collect-dir") args.collectDir = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--short-name") args.shortName = argv[++i];
    else if (a === "--strategy") args.strategy = argv[++i];
    else if (a === "--validate") args.validate = argv[++i];
    else if (a === "--max-errors-per-mapper") args.maxErrorsPerMapper = parseInt(argv[++i], 10) || 5;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else if (a.startsWith("--")) { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  if (!args.collectDir) { console.error("--collect-dir is required"); process.exit(2); }
  args.collectDir = path.isAbsolute(args.collectDir) ? args.collectDir : path.resolve(process.cwd(), args.collectDir);
  if (!fs.existsSync(args.collectDir)) {
    console.error(`Collect dir not found: ${args.collectDir}`);
    process.exit(2);
  }
  if (!args.out) {
    args.out = path.join(ROOT, "logs", `mapper_self_test_${timestampSlug()}.json`);
  }
  if (!["native", "jmwe", "both"].includes(args.strategy)) {
    console.error(`--strategy must be native|jmwe|both`);
    process.exit(2);
  }
  return args;
}

function printHelp() {
  console.log(`mapper_self_test.js — empirically validate every JSU/JMWE mapper

USAGE
  node scripts/mapper_self_test.js --collect-dir <path> [options]

OPTIONS
  --collect-dir <path>          Required. Source for DC example configurations.
  --out <path>                  Output JSON (default: logs/mapper_self_test_<TS>.json).
  --short-name <name>           Test a single mapper only.
  --strategy native|jmwe|both   Default: both.
  --validate <wf-name>          Live mode: validate against this Cloud workflow.
  --max-errors-per-mapper N     Default 5.
  -h, --help                    Show help.

EXIT
  0  all mappers green
  1  some mappers failed (see <out>)
`);
}

// ──────────────────────────────────────────────────────────────────────────
// Example discovery — walk dc_workflows/ and harvest one config per shortName
// ──────────────────────────────────────────────────────────────────────────

function harvestExamples(collectDir) {
  const dir = path.join(collectDir, "dc_workflows");
  if (!fs.existsSync(dir)) {
    console.error(`No dc_workflows/ inside ${collectDir} — run --collect first.`);
    process.exit(2);
  }
  // shortName → { configuration, dcType, ruleCategory, sourceWorkflow, sourceTransition }
  const examples = {};
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    let wf;
    try { wf = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")); }
    catch { continue; }
    for (const t of wf.transitions || []) {
      const rules = t.rules || {};
      const collectFromArray = (arr, category) => {
        for (const rule of arr || []) {
          recordExample(examples, rule, category, wf.name, t.name);
        }
      };
      collectFromArray(rules.validators, "validator");
      collectFromArray(rules.postFunctions, "postFunction");
      // conditions may live as a tree
      const walkConds = (node) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { node.forEach(walkConds); return; }
        if (node.type && node.configuration !== undefined) {
          recordExample(examples, node, "condition", wf.name, t.name);
        }
        if (Array.isArray(node.conditions)) node.conditions.forEach(walkConds);
      };
      if (rules.conditionsTree) walkConds(rules.conditionsTree);
      if (rules.conditions) walkConds(rules.conditions);
    }
  }
  return examples;
}

function recordExample(examples, rule, ruleCategory, workflowName, transitionName) {
  if (!rule || !rule.type) return;
  const shortName = getJsuShortName(rule.type);
  if (!shortName) return;
  if (examples[shortName]) return; // first occurrence wins
  examples[shortName] = {
    dcType: rule.type,
    ruleCategory,
    configuration: rule.configuration || {},
    sourceWorkflow: workflowName,
    sourceTransition: transitionName,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Mapper invocation
// ──────────────────────────────────────────────────────────────────────────

function buildCtx() {
  // Identity-mapping for fields/statuses; this is offline so we don't have a
  // resolved sandbox catalog. Tests check mapper SHAPE, not mapping correctness.
  return {
    fieldRemapping: {},
    cloudFieldNames: {},
    statusRemapping: {},
    dcStatusCatalog: {},
    dcFieldNames: {},
    idRemapping: {},
    jmweAppKey: JMWE_APP_KEY_DEFAULT,
    dcInventory: { workflows: {} },
    warnings: [],
    ruleId: uuidv4(),
    unresolved: new Set(),
  };
}

function runOneMapper(strategy, shortName, configuration) {
  if (strategy === "native" && !hasNativeMapper(shortName)) {
    return { skipped: true, reason: "no native mapper" };
  }
  if (strategy === "jmwe" && !hasJmweMapper(shortName)) {
    return { skipped: true, reason: "no jmwe mapper" };
  }
  const ctx = buildCtx();
  let converted = null;
  let mapperError = null;
  try {
    if (strategy === "native") converted = convertToNative(shortName, configuration, ctx);
    else converted = convertToJmwe(shortName, configuration, ctx);
  } catch (e) {
    mapperError = e.message + (e.stack ? `\n${e.stack.split("\n").slice(0, 4).join("\n")}` : "");
  }
  return {
    skipped: false,
    converted,
    mapperReturnedNull: converted === null,
    unresolved: Array.from(ctx.unresolved || []),
    warnings: ctx.warnings || [],
    mapperError,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Optional live validation
// ──────────────────────────────────────────────────────────────────────────

async function loadCloudClient() {
  const cfgPath = path.join(ROOT, "config.json");
  const cfg = resolveConfigEnvIndirections(JSON.parse(fs.readFileSync(cfgPath, "utf8")));
  if (!cfg.cloud || !cfg.cloud.baseUrl || !cfg.cloud.apiToken) {
    throw new Error("config.json missing cloud.baseUrl or cloud.apiToken (check .env wiring)");
  }
  const JiraCloudClient = require("../../clone_workflow_rules/src/jiraCloudClient");
  return new JiraCloudClient(cfg.cloud.baseUrl, cfg.cloud.apiToken);
}

async function fetchScratchWorkflow(cloud, name) {
  const res = await cloud.makeRequest("POST", "/rest/api/3/workflows", { workflowNames: [name] });
  const wf = ((res && res.workflows) || []).find((w) => w && w.name === name);
  if (!wf) throw new Error(`Scratch workflow "${name}" not found on Cloud`);
  wf._topLevelStatuses = (res && res.statuses) || [];
  return wf;
}

// Pick a transition that has a non-INITIAL type and at least one link so the
// added rules have somewhere natural to land. Falls back to the first
// DIRECTED transition.
function pickTargetTransition(wf) {
  const directed = (wf.transitions || []).filter((t) => t && t.type !== "INITIAL");
  if (directed.length === 0) return null;
  return directed[0];
}

function buildValidationEnvelope(wf, transitionId, ruleCategory, converted) {
  const cloned = JSON.parse(JSON.stringify(wf));
  const top = cloned._topLevelStatuses || [];
  delete cloned._topLevelStatuses;
  const txn = cloned.transitions.find((t) => String(t.id) === String(transitionId));
  if (!txn) throw new Error(`transition ${transitionId} missing from cloned envelope`);
  // Inject the rule into the right bucket
  if (ruleCategory === "validator") {
    txn.validators = (txn.validators || []).slice();
    txn.validators.push(converted);
  } else if (ruleCategory === "postFunction") {
    txn.actions = (txn.actions || []).slice();
    txn.actions.push(converted);
  } else if (ruleCategory === "condition") {
    if (!txn.conditions) {
      txn.conditions = { conditions: [], conditionGroups: [], operation: "ALL" };
    }
    txn.conditions = JSON.parse(JSON.stringify(txn.conditions));
    txn.conditions.conditions = (txn.conditions.conditions || []).slice();
    txn.conditions.conditions.push(converted);
  } else {
    throw new Error(`unknown ruleCategory ${ruleCategory}`);
  }
  return { statuses: top, workflows: [cloned] };
}

async function callValidate(cloud, envelope) {
  try {
    return await cloud.makeRequest("POST", "/rest/api/3/workflows/update/validation", envelope);
  } catch (e) {
    return { _error: e.message, statusCode: e.statusCode || null };
  }
}

function categorizeValidation(validation, maxErrors = 5) {
  if (!validation) return { level: "unknown", errors: [], warnings: [] };
  if (validation._error) {
    return { level: "transport_error", errors: [{ message: validation._error, statusCode: validation.statusCode }], warnings: [] };
  }
  const errors = [];
  const warnings = [];
  for (const e of validation.errors || []) {
    const lvl = (e.level || "ERROR").toUpperCase();
    const entry = { code: e.code, message: e.message, ruleId: e.elementReference && e.elementReference.ruleId };
    if (lvl === "ERROR") errors.push(entry);
    else warnings.push(entry);
    if (errors.length >= maxErrors) break;
  }
  return { level: errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "ok", errors, warnings };
}

// ──────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const examples = harvestExamples(args.collectDir);
  let shortNames = Object.keys(examples).sort();
  if (args.shortName) shortNames = shortNames.filter((n) => n === args.shortName);
  if (shortNames.length === 0) {
    console.error(`No examples found${args.shortName ? ` for ${args.shortName}` : ""}.`);
    process.exit(2);
  }

  let cloud = null;
  let scratchWf = null;
  let scratchTxn = null;
  if (args.validate) {
    try {
      cloud = await loadCloudClient();
      console.log(`Cloud: ${cloud.baseUrl}`);
      scratchWf = await fetchScratchWorkflow(cloud, args.validate);
      scratchTxn = pickTargetTransition(scratchWf);
      if (!scratchTxn) throw new Error(`No usable transition in scratch workflow`);
      console.log(`Scratch workflow: "${args.validate}" (id=${scratchWf.id}, target transition="${scratchTxn.name}" id=${scratchTxn.id})`);
    } catch (e) {
      console.error(`Live validation setup failed: ${e.message}`);
      console.error(`Continuing in offline mode.`);
      cloud = null;
    }
  }

  const results = {};
  const strategies = args.strategy === "both" ? ["native", "jmwe"] : [args.strategy];
  let failures = 0;
  for (const sn of shortNames) {
    const ex = examples[sn];
    const row = { shortName: sn, ruleCategory: ex.ruleCategory, dcType: ex.dcType,
                  sourceWorkflow: ex.sourceWorkflow, sourceTransition: ex.sourceTransition,
                  strategies: {} };
    for (const strategy of strategies) {
      const m = runOneMapper(strategy, sn, ex.configuration);
      if (m.skipped) {
        row.strategies[strategy] = { status: "skipped", reason: m.reason };
        continue;
      }
      const out = { mapperReturnedNull: m.mapperReturnedNull, unresolved: m.unresolved, warnings: m.warnings, mapperError: m.mapperError };
      if (m.mapperError) {
        out.status = "mapper_exception";
        failures++;
      } else if (m.mapperReturnedNull) {
        out.status = "mapper_returned_null";
        // Only count as failure when unresolved indicates a real problem
        // (vs intentional manual-review macro detection).
        if (!m.unresolved.some((u) => u.startsWith("macro:"))) failures++;
      } else {
        // Live validation if configured
        if (cloud && scratchWf && scratchTxn) {
          const envelope = buildValidationEnvelope(scratchWf, scratchTxn.id, ex.ruleCategory, m.converted);
          const raw = await callValidate(cloud, envelope);
          const cat = categorizeValidation(raw, args.maxErrorsPerMapper);
          out.status = cat.level === "ok" ? "validated" : cat.level === "warning" ? "validated_with_warnings" : "validation_error";
          out.validation = cat;
          if (cat.level === "error" || cat.level === "transport_error") failures++;
        } else {
          out.status = "mapped_offline_ok";
        }
        // Strip the actual converted rule from the row body — too noisy in
        // summaries. Just record ruleKey + appKey (if Connect) for context.
        const c = m.converted;
        out.ruleKey = c.ruleKey;
        out.appKey = (c.parameters && c.parameters.appKey) || null;
      }
      row.strategies[strategy] = out;
    }
    results[sn] = row;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    collectDir: args.collectDir,
    cloud: cloud ? cloud.baseUrl : null,
    scratchWorkflow: args.validate,
    totalShortNames: shortNames.length,
    failures,
    perShortName: results,
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(summary, null, 2));

  // stdout summary
  console.log("");
  console.log(`=== mapper_self_test summary ===`);
  console.log(`Mappers tested: ${shortNames.length}, failures: ${failures}`);
  console.log(`Output: ${args.out}`);
  console.log("");
  for (const sn of shortNames) {
    const row = results[sn];
    const parts = [];
    for (const s of strategies) {
      const r = row.strategies[s];
      if (!r) continue;
      const tag = ({
        skipped: "·",
        mapped_offline_ok: "○",
        validated: "✓",
        validated_with_warnings: "⚠",
        validation_error: "✗",
        mapper_returned_null: "∅",
        mapper_exception: "💥",
        transport_error: "🔌",
      })[r.status] || "?";
      parts.push(`${s}=${tag}${r.status === "validation_error" ? ` (${(r.validation && r.validation.errors[0] && r.validation.errors[0].code) || "?"})` : ""}`);
    }
    console.log(`  ${sn}  ${parts.join("  ")}`);
  }
  console.log("");
  console.log(`Legend: ✓ validated  ○ mapped offline ok  · skipped  ∅ mapper returned null  ✗ validation error  💥 mapper exception  🔌 transport`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
