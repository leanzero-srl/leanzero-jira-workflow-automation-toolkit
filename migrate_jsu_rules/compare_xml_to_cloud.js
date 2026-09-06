#!/usr/bin/env node
/**
 * compare_xml_to_cloud.js — holistic DC XML ↔ Cloud workflow diff
 *
 * Read-only verification tool. For every plan row from the conversion plan it
 * computes the rule that SHOULD be on Cloud (by re-running the registered
 * native/JMWE mapper) and pairs it against the live Cloud transition's actual
 * rules using shared semantic fingerprints. Each unmatched DC rule, each
 * unmatched Cloud rule, each duplicate, and each matched-but-buggy pair is
 * emitted as a categorised diff entry with cause-of-death evidence.
 *
 * Categorisation:
 *   MISSING_TRANSITION_UNRESOLVED, MISSING_CATALOG_MISS,
 *   MISSING_FIELD_UNMAPPED, MISSING_STATUS_UNMAPPED, MISSING_MAPPER_NULL,
 *   MISSING_OTHER, EXTRA_ON_CLOUD, DUPLICATE_ON_CLOUD,
 *   EXPRESSION_BROKEN, NUNJUCKS_BROKEN, DISABLED_MISMATCH, OK
 *
 * Output:
 *   <out>/compare.json — machine-readable, deterministic key ordering
 *   <out>/compare.md   — human-readable, sorted by severity
 *
 * CLI:
 *   node compare_xml_to_cloud.js \
 *     --collect-dir logs/collected_<ts> \
 *     [--workflow "<DC name>"] [--all] \
 *     [--out <dir>] [--no-fetch] [--concurrency 8] [--self-test]
 */

require("dotenv").config({ path: __dirname + "/.env" });
const fs = require("fs");
const path = require("path");

const { resolveConfigEnvIndirections, uuidv4 } = require("./src/utils");
const cfg = resolveConfigEnvIndirections(JSON.parse(fs.readFileSync(__dirname + "/config.json", "utf8")));
const JiraCloudClient = require("../clone_workflow_rules/src/jiraCloudClient");
const FieldMapper = require("../clone_workflow_rules/src/fieldMapper");
const { hasNativeMapper, convertToNative } = require("./src/jsuNativeMappers");
const { hasJmweMapper, convertToJmwe } = require("./src/jsuJmweMappers");
const { resolveCloudTransition, indexCloudTransitions } = require("./src/transitionMatcher");
const { ruleFingerprint, connectPresenceFp, migrationFingerprint } = require("./src/ruleFingerprint");
const { isCleanNunjucks } = require("./src/groovyToCloud");
const { getJsuShortName } = require("./src/jsuRuleCatalog");
const {
  CATEGORIES,
  SEVERITY,
  classify,
  isExpressionBroken,
  isNunjucksBroken,
  makeMapperCtx,
  snapshotMapperCtx,
} = require("./src/compareDiagnostics");

// ──────────────────────────────────────────────────────────────────────────
// CLI parsing
// ──────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { workflows: [], collectDir: null, out: null, noFetch: false, concurrency: 8, all: false, selfTest: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--collect-dir") args.collectDir = argv[++i];
    else if (a === "--workflow") args.workflows.push(argv[++i]);
    else if (a === "--all") args.all = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--no-fetch") args.noFetch = true;
    else if (a === "--concurrency") args.concurrency = parseInt(argv[++i], 10) || 8;
    else if (a === "--self-test") args.selfTest = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
    else if (a.startsWith("--")) { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  if (!args.collectDir) { console.error("--collect-dir is required"); process.exit(2); }
  args.collectDir = path.isAbsolute(args.collectDir) ? args.collectDir : path.resolve(process.cwd(), args.collectDir);
  if (!args.out) {
    const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
    args.out = path.join(args.collectDir, `compare_${ts}`);
  }
  return args;
}

function printHelp() {
  console.log(`compare_xml_to_cloud.js — DC XML ↔ Cloud workflow diff (read-only)

USAGE
  node compare_xml_to_cloud.js --collect-dir <path> [options]

OPTIONS
  --collect-dir <path>   Required. The logs/collected_<ts>/ directory.
  --workflow "<name>"    Compare one workflow (repeatable).
  --all                  Compare every workflow in the conversion plan.
  --out <dir>            Output dir. Default <collect-dir>/compare_<ts>/.
  --no-fetch             Use cached update_payload_<wf>.json instead of live Cloud.
  --concurrency N        Parallel Cloud fetches (default 8).
  --self-test            Run self-tests and exit.
  -h, --help             Show this help.

EXIT CODES
  0  No blocker-severity diffs.
  1  Blockers present.
  2  Argument error.
`);
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function safeFilename(s) { return String(s).replace(/[^\w.-]+/g, "_"); }

function readJSON(filepath) { return JSON.parse(fs.readFileSync(filepath, "utf8")); }

/** Sorted-key JSON.stringify (deterministic output). */
function canonicalStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(value[k])).join(",") + "}";
}

/** Sort an object's keys deeply for stable JSON output. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortDeep(value[k]);
    return out;
  }
  return value;
}

/**
 * Strip non-deterministic identifiers from a rule shape before serialising.
 * Mappers call `uuidv4()` for each fresh emit; we don't want those new UUIDs
 * to bleed into the comparison output and break round-trip idempotency.
 */
function stripIdsForOutput(rule) {
  if (!rule || typeof rule !== "object") return rule;
  const out = { ruleKey: rule.ruleKey, parameters: { ...(rule.parameters || {}) } };
  if (out.parameters && typeof out.parameters === "object") {
    delete out.parameters.id;
  }
  return out;
}

/**
 * Walk a Cloud transition and return ALL Connect/system rules with their
 * category and a path string for stable references.
 */
function collectCloudRules(transition) {
  const out = []; // [{rule, category, path}]
  for (let i = 0; i < (transition.actions || []).length; i++) {
    out.push({ rule: transition.actions[i], category: "action", path: `actions[${i}]` });
  }
  for (let i = 0; i < (transition.validators || []).length; i++) {
    out.push({ rule: transition.validators[i], category: "validator", path: `validators[${i}]` });
  }
  function walk(node, p) {
    if (!node || typeof node !== "object") return;
    for (let i = 0; i < (node.conditions || []).length; i++) {
      out.push({ rule: node.conditions[i], category: "condition", path: `${p}.conditions[${i}]` });
    }
    for (let i = 0; i < (node.conditionGroups || []).length; i++) {
      walk(node.conditionGroups[i], `${p}.conditionGroups[${i}]`);
    }
  }
  if (transition.conditions) walk(transition.conditions, "conditions");
  return out;
}

/**
 * Re-run a mapper with cause-of-death tracking. Returns
 * `{converted, evidence}` where `converted` may be null and `evidence` is the
 * snapshot ready to embed in a diff entry.
 */
function applyMapperWithEvidence(row, ctxBase) {
  const strat = row.strategy || row.defaultStrategy;
  const ctx = makeMapperCtx({
    ...ctxBase,
    ruleId: uuidv4(),
  });
  let converted = null;
  let mapperUsed = null;
  let catalogMiss = false;
  // Catalog lookup mirrors the applier.
  if (!row.shortName || !getJsuShortName(row.dcType || "")) {
    // dcType unknown → catalog miss. (`getJsuShortName` returns null for
    // entirely-unknown classes; for known prefixes with unknown class it
    // returns a synthetic `dc-class:*` / `jmwe-class:*` shortName which the
    // mapper registry won't have.)
    const lookup = getJsuShortName(row.dcType || "");
    if (lookup == null) catalogMiss = true;
    else if (typeof lookup === "string" && (lookup.startsWith("dc-class:") || lookup.startsWith("jmwe-class:") || lookup.startsWith("beecom-class:"))) {
      catalogMiss = true;
    }
  }
  if (strat === "native" && hasNativeMapper(row.shortName)) {
    converted = convertToNative(row.shortName, row.configuration, ctx);
    mapperUsed = "convertToNative";
  } else if (strat === "jmwe" && hasJmweMapper(row.shortName)) {
    converted = convertToJmwe(row.shortName, row.configuration, ctx);
    mapperUsed = "convertToJmwe";
  } else {
    catalogMiss = true; // no registered mapper for this shortName
  }
  const evidence = snapshotMapperCtx(ctx, {
    mapperReturnedNull: converted === null && !catalogMiss,
    catalogMiss,
    mapperUsed,
  });
  return { converted, evidence };
}

/**
 * Bipartite match expected vs actual rules on a transition by fingerprint.
 * Returns { pairs, unmatchedExpected, unmatchedActual, duplicateActuals }.
 *
 * Matching has two passes: strict semantic fingerprint, then connect
 * module-level presence (mirrors audit_oneforone.js).
 *
 * For multi-field `system:validate-field-value` fieldRequired: the applier
 * merges plan rows into a single Cloud rule with the union of fields. We
 * detect that here too — a per-field synthetic fingerprint matches the merged
 * Cloud rule.
 */
function matchRules(expected, cloudRules, fieldRemap) {
  // Build fingerprint indexes for cloudRules. Track usage so we can detect
  // duplicates and leftover (extra) cloud rules.
  const cloudByFp = new Map();        // fp → [indices]
  const cloudByPresence = new Map();  // presenceFp → [indices]
  const cloudByMigrationId = new Map();  // migration:<id> → [indices]
  const cloudByFieldRequired = new Map(); // `system:validate-field-value|fieldRequired|<fieldId>` → [indices]
  for (let i = 0; i < cloudRules.length; i++) {
    const r = cloudRules[i].rule;
    const fp = ruleFingerprint(r, fieldRemap);
    if (fp) {
      if (!cloudByFp.has(fp)) cloudByFp.set(fp, []);
      cloudByFp.get(fp).push(i);
    }
    const pfp = connectPresenceFp(r);
    if (pfp) {
      if (!cloudByPresence.has(pfp)) cloudByPresence.set(pfp, []);
      cloudByPresence.get(pfp).push(i);
    }
    const mfp = migrationFingerprint(r);
    if (mfp) {
      if (!cloudByMigrationId.has(mfp)) cloudByMigrationId.set(mfp, []);
      cloudByMigrationId.get(mfp).push(i);
    }
    // fieldRequired multi-field merging
    const p = r && r.parameters;
    if (r && r.ruleKey === "system:validate-field-value" && p && p.ruleType === "fieldRequired" && typeof p.fieldsRequired === "string") {
      for (const f of p.fieldsRequired.split(",").map((s) => s.trim()).filter(Boolean)) {
        const synthFp = `system:validate-field-value|fieldRequired|${f}`;
        if (!cloudByFieldRequired.has(synthFp)) cloudByFieldRequired.set(synthFp, []);
        cloudByFieldRequired.get(synthFp).push(i);
      }
    }
  }

  const used = new Array(cloudRules.length).fill(false);
  const pairs = [];        // [{expected, expectedIdx, cloudIdx}]
  const unmatchedExpected = []; // [{expected, expectedIdx}]

  // Pass 0: identity match by migrationSourceId. Highest confidence — the same
  // deterministic id was stamped on both the expected (re-mapped) rule and the
  // cloud rule from a prior apply run. Wins over semantic fingerprints (which
  // drift across mapper revisions).
  const matchedByMigration = new Array(expected.length).fill(false);
  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    if (!exp.converted) continue;
    const mfp = migrationFingerprint(exp.converted);
    if (!mfp) continue;
    const cands = cloudByMigrationId.get(mfp) || [];
    let matched = -1;
    for (const idx of cands) {
      if (!used[idx]) { matched = idx; break; }
    }
    if (matched >= 0) {
      used[matched] = true;
      pairs.push({ expected: exp, expectedIdx: i, cloudIdx: matched, matchedBy: "migrationSourceId" });
      matchedByMigration[i] = true;
    }
  }

  // Pass 1: strict semantic fingerprint match.
  // For fieldRequired-multi-field plan rows, we expand to per-field synthetic
  // fingerprints — operator's plan row maps to each field's slot in the merged
  // Cloud rule.
  for (let i = 0; i < expected.length; i++) {
    if (matchedByMigration[i]) continue;
    const exp = expected[i];
    if (!exp.converted) { unmatchedExpected.push({ expected: exp, expectedIdx: i }); continue; }
    const c = exp.converted;
    let matched = -1;
    if (c.ruleKey === "system:validate-field-value" && c.parameters && c.parameters.ruleType === "fieldRequired" && typeof c.parameters.fieldsRequired === "string") {
      // Match on every field; if ALL of them resolve to a single cloud rule
      // (or rules), use the first. We don't mark cloud rules as fully used
      // here since multiple plan rows may share the same merged cloud rule.
      const fields = c.parameters.fieldsRequired.split(",").map((s) => s.trim()).filter(Boolean);
      let ok = fields.length > 0;
      let firstIdx = -1;
      for (const f of fields) {
        const cands = cloudByFieldRequired.get(`system:validate-field-value|fieldRequired|${f}`) || [];
        if (cands.length === 0) { ok = false; break; }
        if (firstIdx === -1) firstIdx = cands[0];
      }
      if (ok && firstIdx >= 0) matched = firstIdx;
    } else {
      const fp = ruleFingerprint(c, fieldRemap);
      const cands = (fp && cloudByFp.get(fp)) || [];
      for (const idx of cands) {
        if (!used[idx]) { matched = idx; break; }
      }
    }
    if (matched >= 0) {
      // Don't mark fieldRequired matches as exclusively used — they can match
      // multiple plan rows pointing at the same merged Cloud rule.
      const isFieldReq = c.ruleKey === "system:validate-field-value" && c.parameters && c.parameters.ruleType === "fieldRequired";
      if (!isFieldReq) used[matched] = true;
      pairs.push({ expected: exp, expectedIdx: i, cloudIdx: matched, matchedBy: "fingerprint" });
    } else {
      unmatchedExpected.push({ expected: exp, expectedIdx: i });
    }
  }

  // Pass 2: for any unmatched-expected Connect rule, try module-level presence.
  for (let n = 0; n < unmatchedExpected.length; n++) {
    const { expected: exp, expectedIdx } = unmatchedExpected[n];
    const c = exp.converted;
    if (!c || typeof c.ruleKey !== "string" || !c.ruleKey.startsWith("connect:")) continue;
    const pfp = connectPresenceFp(c);
    const cands = (pfp && cloudByPresence.get(pfp)) || [];
    let matched = -1;
    for (const idx of cands) {
      if (!used[idx]) { matched = idx; break; }
    }
    if (matched >= 0) {
      used[matched] = true;
      pairs.push({ expected: exp, expectedIdx, cloudIdx: matched, matchedBy: "presence" });
      unmatchedExpected.splice(n, 1);
      n--;
    }
  }

  // Cloud rules that nothing matched against.
  const unmatchedActual = [];
  for (let i = 0; i < cloudRules.length; i++) {
    if (!used[i]) unmatchedActual.push({ cloud: cloudRules[i], cloudIdx: i });
  }

  // Duplicate detection: within cloudRules, are there two with the same
  // identity fingerprint? (Independent of expected matching.)
  const duplicateActuals = [];
  for (const [fp, indices] of cloudByFp) {
    if (indices.length > 1) {
      // Only flag duplicates we recognise (skip null/raw fingerprints? — already filtered)
      if (fp) duplicateActuals.push({ fp, cloudIdxs: indices });
    }
  }

  return { pairs, unmatchedExpected, unmatchedActual, duplicateActuals };
}

/**
 * For a matched pair, scan the Cloud rule's text fields for known bug patterns
 * and return an evidence object.
 */
function diagnoseMatched(cloudRule) {
  const p = cloudRule.parameters || {};
  const cfgStr = (typeof p.config === "string" && p.config) ||
                 (typeof p.value === "string" && p.value) || "";
  let cfg = {};
  if (cfgStr) { try { cfg = JSON.parse(cfgStr); } catch { cfg = {}; } }

  const evidence = {
    expressionBroken: false,
    nunjucksBroken: false,
    disabledOnCloud: p.disabled === "true" || p.disabled === true,
    disabledExpected: false, // DC has no concept of "disabled"; always false
    brokenSamples: [],
  };

  // Expression-bearing fields → check for object-vs-string bug.
  for (const k of ["expression", "conditionalExecutionScript"]) {
    const v = cfg[k];
    if (typeof v === "string" && isExpressionBroken(v)) {
      evidence.expressionBroken = true;
      evidence.brokenSamples.push({ field: k, value: v.slice(0, 200) });
    }
  }
  // Nunjucks-bearing fields.
  for (const k of ["comment", "subject", "textBody", "htmlBody", "script"]) {
    const v = cfg[k];
    if (typeof v === "string" && v && isNunjucksBroken(v, isCleanNunjucks)) {
      evidence.nunjucksBroken = true;
      evidence.brokenSamples.push({ field: k, value: v.slice(0, 200) });
    }
  }
  if (Array.isArray(cfg.fieldsConfig)) {
    for (const f of cfg.fieldsConfig) {
      if (f && typeof f.value === "string" && isNunjucksBroken(f.value, isCleanNunjucks)) {
        evidence.nunjucksBroken = true;
        evidence.brokenSamples.push({ field: `fieldsConfig[${f.fieldId || "?"}].value`, value: f.value.slice(0, 200) });
      }
    }
  }
  return evidence;
}

// ──────────────────────────────────────────────────────────────────────────
// Cloud workflow fetching (with fuzzy resolver, mirrors apply pipeline)
// ──────────────────────────────────────────────────────────────────────────

function buildFuzzyCandidates(declared) {
  const set = new Set([declared]);
  set.add(declared.replace(/_ /g, ": "));
  set.add(declared.replace(/_/g, ":"));
  set.add(declared.replace(/_ /g, "/ "));
  set.add(declared.replace(/_/g, "/"));
  set.add(declared.replace(/_/, ":"));
  set.add(declared.replace(/_/, "/"));
  set.delete(""); // safety
  return Array.from(set);
}

async function fetchCloudWorkflow(cloud, declared) {
  const candidates = buildFuzzyCandidates(declared);
  for (const name of candidates) {
    try {
      const res = await cloud.makeRequest("POST", "/rest/api/3/workflows", { workflowNames: [name] });
      const wf = (res.workflows || []).find((w) => w && w.name === name);
      if (wf) return { wf, resolvedName: name, candidates };
    } catch { /* try next */ }
  }
  return { wf: null, resolvedName: null, candidates };
}

/**
 * --no-fetch fallback: read the post-apply `update_payload_<wf>.json` if
 * present. The payload is the stripped envelope we PUT to /workflows/update,
 * so it contains the fully-patched workflow definitions array.
 */
function loadCachedWorkflow(collectDir, declared) {
  const variants = buildFuzzyCandidates(declared);
  for (const v of variants) {
    const filename = `update_payload_${safeFilename(v)}.json`;
    const fp = path.join(collectDir, filename);
    if (fs.existsSync(fp)) {
      try {
        const env = JSON.parse(fs.readFileSync(fp, "utf8"));
        const wfs = env.workflows || env.workflow ? (Array.isArray(env.workflows) ? env.workflows : [env.workflow]) : [];
        if (wfs.length > 0) return { wf: wfs[0], resolvedName: wfs[0].name || v, candidates: variants };
      } catch { /* corrupt; try next variant */ }
    }
  }
  return { wf: null, resolvedName: null, candidates: variants };
}

// ──────────────────────────────────────────────────────────────────────────
// Main comparison
// ──────────────────────────────────────────────────────────────────────────

async function run() {
  const args = parseArgs(process.argv);

  if (args.selfTest) {
    return runSelfTest(args);
  }

  const collectDir = args.collectDir;
  if (!fs.existsSync(collectDir)) {
    console.error(`collect-dir not found: ${collectDir}`);
    process.exit(2);
  }
  const plan = readJSON(path.join(collectDir, "conversion_plan.json"));
  const dcInventory = readJSON(path.join(collectDir, "jsu_rule_inventory.json"));
  const fieldMappingRaw = readJSON(path.join(collectDir, "field_mapping.json"));
  let statusRemapping = {};
  const srPath = path.join(collectDir, "status_remapping_resolved.json");
  if (fs.existsSync(srPath)) {
    try { statusRemapping = readJSON(srPath); } catch {}
  }

  const cloud = new JiraCloudClient(cfg.cloud.baseUrl, cfg.cloud.apiToken);
  const dcNames = fieldMappingRaw;
  const named = Object.entries(dcNames).filter(([, n]) => n);
  const fm = new FieldMapper(cloud, () => {});
  const fieldRemapping = await fm.buildMapping(Object.fromEntries(named));

  // Group plan rows by workflow
  const rowsByWf = new Map();
  for (const r of plan.rows) {
    if (!rowsByWf.has(r.workflowName)) rowsByWf.set(r.workflowName, []);
    rowsByWf.get(r.workflowName).push(r);
  }

  // Filter to requested workflows.
  let target;
  if (args.workflows.length > 0) {
    target = args.workflows.filter((w) => rowsByWf.has(w));
    const missing = args.workflows.filter((w) => !rowsByWf.has(w));
    if (missing.length) console.error(`Plan does not contain: ${missing.join(", ")}`);
  } else if (args.all) {
    target = Array.from(rowsByWf.keys());
  } else {
    // Default: show summary across plan, no per-workflow details.
    target = Array.from(rowsByWf.keys());
  }
  target.sort();

  const overrides = cfg.workflowNameOverrides || {};

  fs.mkdirSync(args.out, { recursive: true });

  // Process workflows with bounded concurrency.
  const workflowReports = {};
  let inFlight = 0;
  let nextIdx = 0;
  const completed = new Promise((resolve) => {
    function pump() {
      while (inFlight < args.concurrency && nextIdx < target.length) {
        const idx = nextIdx++;
        const wfName = target[idx];
        inFlight++;
        compareWorkflow(wfName, rowsByWf.get(wfName) || [], {
          cloud, collectDir, fieldRemapping, statusRemapping, dcInventory,
          overrides, noFetch: args.noFetch,
        }).then((rep) => {
          workflowReports[wfName] = rep;
        }).catch((e) => {
          workflowReports[wfName] = { status: "error", error: e.message || String(e) };
        }).finally(() => {
          inFlight--;
          if (nextIdx >= target.length && inFlight === 0) resolve();
          else pump();
        });
      }
    }
    pump();
  });
  await completed;

  // Summarise.
  const summary = computeSummary(workflowReports);
  const report = {
    generatedAt: new Date().toISOString(),
    collectDir,
    summary,
    workflows: sortDeep(workflowReports),
  };

  const jsonPath = path.join(args.out, "compare.json");
  // Use canonicalStringify to keep the body stable across runs (with a
  // minimal indent for readability).
  fs.writeFileSync(jsonPath, prettyCanonicalJson(report) + "\n");

  const mdPath = path.join(args.out, "compare.md");
  fs.writeFileSync(mdPath, renderMarkdown(report));

  // Console summary.
  console.log(`\n=== compare_xml_to_cloud summary ===`);
  console.log(`Collect dir: ${collectDir}`);
  console.log(`Workflows compared: ${summary.workflowsCompared}`);
  console.log(`Workflows not on Cloud: ${summary.workflowsNotOnCloud}`);
  console.log(`Total diffs: ${summary.totalDiffs}  (BLOCKER ${summary.blockerCount} / HIGH ${summary.highCount} / MEDIUM ${summary.mediumCount} / OK ${summary.okCount})`);
  console.log(`By category:`);
  for (const [cat, n] of Object.entries(summary.diffsByCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(34, " ")} ${n}`);
  }
  console.log(`\nOutput: ${args.out}`);

  process.exit(summary.blockerCount > 0 ? 1 : 0);
}

/**
 * Compare a single workflow. Produces an entry like:
 *   { status, cloudName, candidates, transitions: { <dcTxnId>: { cloudTxnId, diffs: [...] } } }
 */
async function compareWorkflow(wfName, rows, opts) {
  const { cloud, collectDir, fieldRemapping, statusRemapping, dcInventory, overrides, noFetch } = opts;
  const declared = overrides[wfName] || wfName;
  const fetched = noFetch
    ? loadCachedWorkflow(collectDir, declared)
    : await fetchCloudWorkflow(cloud, declared);
  if (!fetched.wf) {
    return { status: "not-on-cloud", candidates: fetched.candidates };
  }
  const wf = fetched.wf;
  const idx = indexCloudTransitions(wf);
  const transitionsOut = {};

  // Group rows by transition (DC transitionId), preserving order.
  const byTxnId = new Map();
  for (const r of rows) {
    const tid = String(r.transitionId || "");
    if (!byTxnId.has(tid)) byTxnId.set(tid, []);
    byTxnId.get(tid).push(r);
  }

  // Track cloud transitions that get exercised so we can flag any never-touched
  // transitions whose rules become EXTRA_ON_CLOUD candidates.
  const cloudTxnsTouched = new Set();

  for (const [dcTxnId, dcRows] of byTxnId) {
    const sample = dcRows[0];
    const resolved = resolveCloudTransition(idx, sample);
    if (!resolved.transition) {
      // Every row on this transition becomes MISSING_TRANSITION_UNRESOLVED.
      const diffs = dcRows.map((row) => ({
        kind: "missing",
        ruleCategory: row.ruleCategory,
        shortName: row.shortName,
        expected: null,
        actual: null,
        evidence: { transitionUnresolved: true, dcTransitionName: row.transitionName, dcTransitionId: row.transitionId },
        dcSource: { type: row.dcType, configuration: row.configuration },
      })).map((d) => ({ ...classify(d), ...d }));
      transitionsOut[dcTxnId] = { cloudTxnId: null, dcTransitionName: sample.transitionName, diffs };
      continue;
    }
    cloudTxnsTouched.add(resolved.transition.id);
    // Compute expected rules by re-running mappers.
    const expected = [];
    for (const row of dcRows) {
      const strat = row.strategy || row.defaultStrategy;
      if (strat === "skip" || strat === "manual-review") {
        // These are intentionally not migrated; not an issue for diffing.
        expected.push({ row, converted: null, evidence: { mapperUsed: null, mapperReturnedNull: false, catalogMiss: false, skipped: strat } });
        continue;
      }
      const { converted, evidence } = applyMapperWithEvidence(row, {
        fieldRemapping, statusRemapping, jmweAppKey: cfg.jmwe.appKey, dcInventory,
      });
      expected.push({ row, converted, evidence });
    }
    const cloudRules = collectCloudRules(resolved.transition);
    const { pairs, unmatchedExpected, unmatchedActual, duplicateActuals } = matchRules(expected, cloudRules, fieldRemapping);

    const diffs = [];
    for (const p of pairs) {
      const evidence = diagnoseMatched(cloudRules[p.cloudIdx].rule);
      const d = {
        kind: "matched",
        ruleCategory: p.expected.row.ruleCategory,
        shortName: p.expected.row.shortName,
        expected: stripIdsForOutput(p.expected.converted),
        actual: { ...stripIdsForOutput(cloudRules[p.cloudIdx].rule), path: cloudRules[p.cloudIdx].path },
        evidence,
        dcSource: { type: p.expected.row.dcType, configuration: p.expected.row.configuration },
        matchedBy: p.matchedBy,
      };
      diffs.push({ ...classify(d), ...d });
    }
    for (const u of unmatchedExpected) {
      // Skip diff entries for rows the operator has explicitly deferred via
      // strategy=skip/manual-review — they're not bugs.
      const ev = u.expected.evidence || {};
      if (ev.skipped) continue;
      const d = {
        kind: "missing",
        ruleCategory: u.expected.row.ruleCategory,
        shortName: u.expected.row.shortName,
        expected: stripIdsForOutput(u.expected.converted),
        actual: null,
        evidence: ev,
        dcSource: { type: u.expected.row.dcType, configuration: u.expected.row.configuration },
      };
      diffs.push({ ...classify(d), ...d });
    }
    // Build a set of cloud indices that participate in any duplicate group.
    // The DUPLICATE_ON_CLOUD diff surfaces the issue once for the whole group;
    // we don't want to also emit EXTRA_ON_CLOUD for the unpaired members and
    // double-count.
    const dupExtraIdxs = new Set();
    for (const dup of duplicateActuals) {
      for (const i of dup.cloudIdxs) dupExtraIdxs.add(i);
    }
    // Index of (ruleKey, appKey, moduleName) shapes that DO have at least one
    // plan row targeting this transition. Used to demote multi-instance cloud
    // siblings (e.g. EmailIssueFunction configured 2-3 times on a Service
    // Management transition) from EXTRA_ON_CLOUD/BLOCKER to MULTI_INSTANCE_OK/
    // INFO. The bipartite matcher pairs ONE expected per DC row; siblings on
    // Cloud become "extra" but they're legitimate emits of ours, not orphans.
    const expectedShapes = new Set();
    for (const e of expected) {
      const c = e.converted;
      if (!c || typeof c.ruleKey !== "string") continue;
      const appKey = (c.parameters && c.parameters.appKey) || "";
      const mod = appKey.includes("__") ? appKey.slice(appKey.lastIndexOf("__") + 2) : "";
      expectedShapes.add(`${c.ruleKey}|${appKey}|${mod}`);
      // Also index a coarser (ruleKey, module) key so CMA-tagged Connect
      // siblings whose appKey contains a transient ext-id segment still match
      // a plan row by module alone.
      if (mod) expectedShapes.add(`${c.ruleKey}||${mod}`);
    }
    for (const e of unmatchedActual) {
      if (dupExtraIdxs.has(e.cloudIdx)) continue; // already covered by DUPLICATE_ON_CLOUD
      const ce = e.cloud;
      const tag = ce.rule.parameters && ce.rule.parameters.tag;
      // CMA-placed native Jira rules (PermissionCondition, InProjectRoleCondition,
      // standard FieldsRequiredValidator) end up on Cloud as `system:*` rules
      // with NO migration tag. Our own emits always carry tag="migration-success"
      // (or "migration-manual" for CMA-translated ones). When a system:* rule
      // we couldn't pair has no tag, presume it's native-Jira-originated and
      // demote it to PRESUMED_NATIVE_JIRA / INFO. Operator can still scan
      // those entries to verify but they're not blockers.
      const presumedNativeJira = (typeof ce.rule.ruleKey === "string"
                                  && ce.rule.ruleKey.startsWith("system:")
                                  && tag !== "migration-success"
                                  && tag !== "migration-manual");
      // multiInstanceOk: this cloud rule IS one of ours (carries migration tag)
      // AND a plan row exists for the same (ruleKey, appKey/module) shape on
      // this transition. The pair just got consumed by an earlier expected
      // row; the sibling is legitimate.
      let multiInstanceOk = false;
      if (!presumedNativeJira &&
          typeof ce.rule.ruleKey === "string" &&
          (tag === "migration-success" || tag === "migration-manual")) {
        const appKey = (ce.rule.parameters && ce.rule.parameters.appKey) || "";
        const mod = appKey.includes("__") ? appKey.slice(appKey.lastIndexOf("__") + 2) : "";
        if (expectedShapes.has(`${ce.rule.ruleKey}|${appKey}|${mod}`) ||
            (mod && expectedShapes.has(`${ce.rule.ruleKey}||${mod}`))) {
          multiInstanceOk = true;
        }
      }
      const d = {
        kind: "extra",
        ruleCategory: ce.category,
        shortName: ce.rule.ruleKey + (ce.rule.parameters && ce.rule.parameters.appKey ? "/" + ce.rule.parameters.appKey : ""),
        expected: null,
        actual: { ...stripIdsForOutput(ce.rule), path: ce.path, tag: tag || null },
        evidence: { presumedNativeJira, multiInstanceOk },
        dcSource: null,
      };
      diffs.push({ ...classify(d), ...d });
    }
    for (const dup of duplicateActuals) {
      const d = {
        kind: "duplicate",
        ruleCategory: cloudRules[dup.cloudIdxs[0]].category,
        shortName: cloudRules[dup.cloudIdxs[0]].rule.ruleKey,
        expected: null,
        actual: { ruleKey: cloudRules[dup.cloudIdxs[0]].rule.ruleKey, fingerprint: dup.fp, instances: dup.cloudIdxs.map((i) => cloudRules[i].path) },
        evidence: { count: dup.cloudIdxs.length },
        dcSource: null,
      };
      diffs.push({ ...classify(d), ...d });
    }

    transitionsOut[dcTxnId] = {
      cloudTxnId: resolved.transition.id,
      dcTransitionName: sample.transitionName,
      cloudTransitionName: resolved.transition.name,
      diffs,
    };
  }

  return {
    status: "compared",
    cloudName: fetched.resolvedName,
    fuzzy: fetched.resolvedName !== declared,
    transitions: transitionsOut,
  };
}

function computeSummary(workflowReports) {
  const out = {
    workflowsCompared: 0,
    workflowsNotOnCloud: 0,
    workflowsErrored: 0,
    totalDiffs: 0,
    blockerCount: 0,
    highCount: 0,
    mediumCount: 0,
    infoCount: 0,
    okCount: 0,
    diffsByCategory: {},
  };
  for (const [, rep] of Object.entries(workflowReports)) {
    if (rep.status === "not-on-cloud") { out.workflowsNotOnCloud++; continue; }
    if (rep.status === "error") { out.workflowsErrored++; continue; }
    out.workflowsCompared++;
    for (const t of Object.values(rep.transitions || {})) {
      for (const d of t.diffs || []) {
        out.totalDiffs++;
        out.diffsByCategory[d.category] = (out.diffsByCategory[d.category] || 0) + 1;
        if (d.severity === SEVERITY.BLOCKER) out.blockerCount++;
        else if (d.severity === SEVERITY.HIGH) out.highCount++;
        else if (d.severity === SEVERITY.MEDIUM) out.mediumCount++;
        else if (d.severity === SEVERITY.INFO) out.infoCount++;
        if (d.category === "OK") out.okCount++;
      }
    }
  }
  return out;
}

/**
 * Pretty-print JSON with sorted keys (deterministic) and 2-space indent.
 */
function prettyCanonicalJson(value) {
  return JSON.stringify(sortDeep(value), null, 2);
}

function renderMarkdown(report) {
  const lines = [];
  const ts = report.generatedAt;
  const s = report.summary;
  lines.push(`# Compare report — ${ts}`);
  lines.push("");
  lines.push(`Collect dir: \`${report.collectDir}\``);
  lines.push("");
  lines.push(`## Summary`);
  lines.push("");
  lines.push(`- Workflows compared: **${s.workflowsCompared}**`);
  lines.push(`- Workflows not on Cloud: **${s.workflowsNotOnCloud}**`);
  if (s.workflowsErrored) lines.push(`- Workflows that errored: **${s.workflowsErrored}**`);
  lines.push(`- Total diffs: **${s.totalDiffs}** — BLOCKER ${s.blockerCount} / HIGH ${s.highCount} / MEDIUM ${s.mediumCount} / OK ${s.okCount}`);
  lines.push("");
  lines.push(`### By category`);
  lines.push("");
  lines.push(`| Category | Severity | Count |`);
  lines.push(`|---|---|---|`);
  const sortedCats = Object.entries(s.diffsByCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, n] of sortedCats) {
    const sev = (CATEGORIES.find((c) => c.name === cat) || {}).severity || "";
    lines.push(`| \`${cat}\` | ${sev} | ${n} |`);
  }
  lines.push("");

  // Group diffs by category, then workflow.
  const byCat = new Map();
  for (const [wfName, rep] of Object.entries(report.workflows)) {
    if (!rep || !rep.transitions) continue;
    for (const [dcTxnId, t] of Object.entries(rep.transitions)) {
      for (const d of t.diffs || []) {
        if (d.category === "OK") continue;
        const key = d.category;
        if (!byCat.has(key)) byCat.set(key, []);
        byCat.get(key).push({ wfName, dcTxnId, dcTxnName: t.dcTransitionName, cloudTxnId: t.cloudTxnId, diff: d });
      }
    }
  }
  // Sort categories by severity then count.
  const sevOrder = { BLOCKER: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };
  const orderedCats = [...byCat.keys()].sort((a, b) => {
    const sa = (CATEGORIES.find((c) => c.name === a) || { severity: "INFO" }).severity;
    const sb = (CATEGORIES.find((c) => c.name === b) || { severity: "INFO" }).severity;
    return (sevOrder[sa] || 9) - (sevOrder[sb] || 9) || (byCat.get(b).length - byCat.get(a).length) || a.localeCompare(b);
  });
  for (const cat of orderedCats) {
    const items = byCat.get(cat);
    const sev = (CATEGORIES.find((c) => c.name === cat) || { severity: "" }).severity;
    lines.push(`## ${cat} (${sev}, ${items.length})`);
    lines.push("");
    // Group items per workflow.
    const byWf = new Map();
    for (const it of items) {
      if (!byWf.has(it.wfName)) byWf.set(it.wfName, []);
      byWf.get(it.wfName).push(it);
    }
    for (const [wfName, wfItems] of [...byWf.entries()].sort()) {
      lines.push(`<details><summary><b>${wfName}</b> — ${wfItems.length}</summary>`);
      lines.push("");
      for (const it of wfItems) {
        const d = it.diff;
        const head = `${it.dcTxnName || "?"} (${it.dcTxnId})`;
        const what = `${d.ruleCategory || "?"} / ${d.shortName || "?"}`;
        lines.push(`- **${head}** — ${what}`);
        if (d.kind === "missing") {
          if (d.evidence && Array.isArray(d.evidence.unresolvedFields) && d.evidence.unresolvedFields.length) {
            lines.push(`    - unresolved fields: \`${d.evidence.unresolvedFields.join(", ")}\``);
          }
          if (d.evidence && Array.isArray(d.evidence.unresolvedStatuses) && d.evidence.unresolvedStatuses.length) {
            lines.push(`    - unresolved statuses: \`${d.evidence.unresolvedStatuses.join(", ")}\``);
          }
          if (d.evidence && d.evidence.catalogMiss) lines.push(`    - catalog miss: \`${d.dcSource && d.dcSource.type}\``);
          if (d.evidence && d.evidence.mapperReturnedNull) lines.push(`    - mapper returned null (mapper: \`${d.evidence.mapperUsed}\`)`);
          if (d.evidence && d.evidence.transitionUnresolved) lines.push(`    - transition not resolvable on Cloud`);
        } else if (d.kind === "extra") {
          lines.push(`    - rule: \`${d.actual && d.actual.ruleKey}\` at \`${d.actual && d.actual.path}\``);
        } else if (d.kind === "duplicate") {
          lines.push(`    - count: ${d.evidence && d.evidence.count}; instances: \`${(d.actual && d.actual.instances || []).join(", ")}\``);
        } else if (d.kind === "matched") {
          if (d.evidence && Array.isArray(d.evidence.brokenSamples) && d.evidence.brokenSamples.length) {
            for (const s of d.evidence.brokenSamples) {
              lines.push(`    - \`${s.field}\`: \`${s.value.replace(/`/g, "\\`")}\``);
            }
          }
          if (d.evidence && d.evidence.disabledOnCloud && !d.evidence.disabledExpected) {
            lines.push(`    - disabled on Cloud (DC has it enabled)`);
          }
        }
      }
      lines.push("");
      lines.push(`</details>`);
      lines.push("");
    }
  }

  // Workflows not on Cloud
  const notOnCloud = Object.entries(report.workflows).filter(([, r]) => r && r.status === "not-on-cloud");
  if (notOnCloud.length) {
    lines.push(`## Workflows not on Cloud (${notOnCloud.length})`);
    lines.push("");
    for (const [n, r] of notOnCloud.sort()) {
      lines.push(`- **${n}**${r.candidates && r.candidates.length ? ` — tried: ${r.candidates.map((c) => `\`${c}\``).join(", ")}` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Self-tests
// ──────────────────────────────────────────────────────────────────────────

function runSelfTest() {
  // Test the bug-class predicates against synthetic diff inputs.
  const cases = [
    { in: { kind: "matched", evidence: { expressionBroken: true } }, expect: "EXPRESSION_BROKEN" },
    { in: { kind: "matched", evidence: { nunjucksBroken: true } }, expect: "NUNJUCKS_BROKEN" },
    { in: { kind: "matched", evidence: { disabledOnCloud: true, disabledExpected: false } }, expect: "DISABLED_MISMATCH" },
    { in: { kind: "matched", evidence: {} }, expect: "OK" },
    { in: { kind: "missing", evidence: { transitionUnresolved: true } }, expect: "MISSING_TRANSITION_UNRESOLVED" },
    { in: { kind: "missing", evidence: { catalogMiss: true } }, expect: "MISSING_CATALOG_MISS" },
    { in: { kind: "missing", evidence: { unresolvedFields: ["customfield_10000"] } }, expect: "MISSING_FIELD_UNMAPPED" },
    { in: { kind: "missing", evidence: { unresolvedStatuses: ["10000"] } }, expect: "MISSING_STATUS_UNMAPPED" },
    { in: { kind: "missing", evidence: { mapperReturnedNull: true } }, expect: "MISSING_MAPPER_NULL" },
    { in: { kind: "missing", evidence: {} }, expect: "MISSING_OTHER" },
    { in: { kind: "extra", evidence: {} }, expect: "EXTRA_ON_CLOUD" },
    { in: { kind: "extra", evidence: { presumedNativeJira: true } }, expect: "PRESUMED_NATIVE_JIRA" },
    { in: { kind: "extra", evidence: { multiInstanceOk: true } }, expect: "MULTI_INSTANCE_OK" },
    { in: { kind: "duplicate", evidence: {} }, expect: "DUPLICATE_ON_CLOUD" },
  ];
  let pass = 0, fail = 0;
  for (const c of cases) {
    const got = classify(c.in);
    if (got.category === c.expect) { pass++; }
    else { fail++; console.error(`FAIL: kind=${c.in.kind}, evidence=${JSON.stringify(c.in.evidence)} → expected ${c.expect}, got ${got.category}`); }
  }
  // isExpressionBroken
  const exprPos = isExpressionBroken('issue.issuetype == "Defect"');
  const exprNeg = isExpressionBroken('issue.issuetype.name == "Defect"');
  if (exprPos) pass++; else { fail++; console.error("FAIL: isExpressionBroken should detect issue.issuetype == ..."); }
  if (!exprNeg) pass++; else { fail++; console.error("FAIL: isExpressionBroken should NOT flag issue.issuetype.name == ..."); }
  // isNunjucksBroken (without helper)
  const nunjPos = isNunjucksBroken("hello ${issue.summary}", null);
  const nunjNeg = isNunjucksBroken("hello {{ issue.fields.summary }}", null);
  if (nunjPos) pass++; else { fail++; console.error("FAIL: isNunjucksBroken should detect ${...}"); }
  if (!nunjNeg) pass++; else { fail++; console.error("FAIL: isNunjucksBroken should NOT flag clean Nunjucks"); }
  console.log(`Self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

// ──────────────────────────────────────────────────────────────────────────

run().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
