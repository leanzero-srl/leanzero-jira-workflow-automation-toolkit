#!/usr/bin/env node
/**
 * analyze_groovy_residue.js — triage the auto-disabled (Groovy-residue) rules
 * from a collect dir.
 *
 * For every rule that the applier emitted with `disabled: true` because
 * Groovy syntax survived translation, this script:
 *   1. Locates the original DC configuration in `dc_workflows/<wf>.json`.
 *   2. Identifies the plugin source (JMWE / ScriptRunner / other).
 *   3. Extracts the actual Groovy snippet that tripped the residue gate.
 *   4. Classifies by pattern (def / return / try / customFields. / issue.get
 *      / =~ / unconverted-gstring / import / new / class).
 *   5. Emits a triage table the operator (or this script's author) can use
 *      to write targeted translator improvements.
 *
 * Usage:
 *   node scripts/analyze_groovy_residue.js --collect-dir logs/collected_<TS>
 */

const fs = require("fs");
const path = require("path");
const { getJsuShortName } = require("../src/jsuRuleCatalog");
const { detectGroovyResidue, scanString } = require("../src/groovyResidueDetector");

function parseArgs() {
  const args = { collectDir: null, top: 30 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--collect-dir") args.collectDir = argv[++i];
    else if (argv[i] === "--top") args.top = parseInt(argv[++i], 10) || 30;
    else if (argv[i] === "--help") { console.log("Usage: --collect-dir <path>"); process.exit(0); }
  }
  if (!args.collectDir) { console.error("--collect-dir required"); process.exit(2); }
  return args;
}

const JMWE_PREFIX = "com.innovalog.jmwe.";
const SCRIPTRUNNER_PREFIX = "com.onresolve.jira.groovy.";

function classifyPlugin(dcType) {
  if (!dcType) return "(unknown)";
  if (dcType.startsWith(JMWE_PREFIX)) return "JMWE";
  if (dcType.startsWith(SCRIPTRUNNER_PREFIX)) return "ScriptRunner";
  if (dcType.startsWith("com.googlecode.jsu.")) return "JSU";
  if (dcType.startsWith("ch.beecom.")) return "BeeCom";
  return "other";
}

// The DC plugin's Groovy lives in different config keys depending on rule type.
const GROOVY_BEARING_KEYS = [
  "groovyExpression",         // JMWE GroovyValidator/Condition primary
  "script",                   // ScriptRunner + generic
  "expression",               // generic
  "conditionalExecutionScript",
  "conditionalValidationScript",
  "comment",                  // JMWE CommentIssue / EmailIssue body
  "subject", "textBody", "htmlBody",
  "toEmailsScript",
  // SetFieldValueFunction stashes per-field Groovy in copyFieldsConfig (JSON).
  "copyFieldsConfig",
  // Sometimes the value is JSON-encoded — embedded `value` keys handled by walker
];

function extractGroovyStrings(configuration) {
  const out = [];
  const walk = (val, path) => {
    if (val == null) return;
    if (Array.isArray(val)) { val.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (typeof val === "object") {
      for (const [k, v] of Object.entries(val)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    if (typeof val !== "string") return;
    // Look for actual Groovy content using the same patterns the detector uses.
    const hits = scanString(val);
    if (hits.length > 0) {
      out.push({ path, snippet: val.length > 250 ? val.slice(0, 250) + "..." : val, patterns: hits.map((h) => h.pattern) });
    }
  };
  for (const [k, v] of Object.entries(configuration || {})) {
    if (GROOVY_BEARING_KEYS.includes(k) && typeof v === "string") {
      // For copyFieldsConfig the value is JSON of [{sourceField, destinationField}].
      // Try parse and walk; otherwise scan raw.
      if (k === "copyFieldsConfig" || k.endsWith("Config")) {
        try {
          const parsed = JSON.parse(v);
          walk(parsed, k);
          continue;
        } catch {}
      }
      const hits = scanString(v);
      if (hits.length > 0) {
        out.push({ path: k, snippet: v.length > 250 ? v.slice(0, 250) + "..." : v, patterns: hits.map((h) => h.pattern) });
      }
    } else if (typeof v === "string") {
      // Some configs nest Groovy inside non-standard keys; scan all string values.
      const hits = scanString(v);
      if (hits.length > 0) {
        out.push({ path: k, snippet: v.length > 250 ? v.slice(0, 250) + "..." : v, patterns: hits.map((h) => h.pattern) });
      }
    }
  }
  return out;
}

function main() {
  const { collectDir, top } = parseArgs();
  const planPath = path.join(collectDir, "conversion_plan.json");
  if (!fs.existsSync(planPath)) {
    console.error(`No conversion_plan.json at ${collectDir}`);
    process.exit(2);
  }
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));

  const groovyRules = []; // [{ workflow, transition, dcType, shortName, plugin, patterns, snippet, path }]
  for (const row of plan.rows || []) {
    const groovyStrings = extractGroovyStrings(row.configuration);
    if (groovyStrings.length === 0) continue;
    for (const g of groovyStrings) {
      groovyRules.push({
        workflow: row.workflowName,
        transition: row.transitionName,
        transitionId: row.transitionId,
        dcType: row.dcType,
        shortName: row.shortName,
        plugin: classifyPlugin(row.dcType),
        configKey: g.path,
        patterns: g.patterns,
        snippet: g.snippet,
        migrationSourceId: row.migrationSourceId,
      });
    }
  }

  console.log(`Found ${groovyRules.length} Groovy-bearing rule string(s) across the plan.\n`);

  // Bucket by plugin × rule shortName.
  const byPluginShortName = {};
  for (const r of groovyRules) {
    const k = `${r.plugin} :: ${r.shortName}`;
    byPluginShortName[k] = (byPluginShortName[k] || 0) + 1;
  }
  console.log("=== BY PLUGIN × shortName ===");
  for (const [k, v] of Object.entries(byPluginShortName).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.toString().padStart(4)}  ${k}`);
  }
  console.log("");

  // Bucket by pattern.
  const byPattern = {};
  for (const r of groovyRules) {
    for (const p of r.patterns) byPattern[p] = (byPattern[p] || 0) + 1;
  }
  console.log("=== BY GROOVY PATTERN (one rule can hit multiple) ===");
  for (const [k, v] of Object.entries(byPattern).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.toString().padStart(4)}  ${k}`);
  }
  console.log("");

  // Bucket by configKey (so we know WHERE the Groovy lives).
  const byConfigKey = {};
  for (const r of groovyRules) {
    byConfigKey[r.configKey] = (byConfigKey[r.configKey] || 0) + 1;
  }
  console.log("=== BY CONFIG-KEY (where the Groovy lives in the DC config) ===");
  for (const [k, v] of Object.entries(byConfigKey).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.toString().padStart(4)}  ${k}`);
  }
  console.log("");

  // Sample N entries per pattern (so we see actual snippets).
  console.log(`=== SAMPLE SNIPPETS (up to ${top}) ===`);
  const seen = new Set();
  for (const r of groovyRules) {
    const key = r.snippet.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > top) break;
    console.log(`  [${r.plugin} ${r.shortName}]`);
    console.log(`     ${r.workflow.slice(0, 50)} / ${r.transition}`);
    console.log(`     patterns: ${r.patterns.join(", ")}`);
    console.log(`     ${r.snippet.replace(/\s+/g, " ").slice(0, 200)}`);
    console.log("");
  }

  // Save full report.
  const outPath = path.join(collectDir, "groovy_residue_triage.json");
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    collectDir,
    total: groovyRules.length,
    byPluginShortName,
    byPattern,
    byConfigKey,
    rules: groovyRules,
  }, null, 2));
  console.log(`Full triage JSON saved to ${outPath}`);
}

main();
