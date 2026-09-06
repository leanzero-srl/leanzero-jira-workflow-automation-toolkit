#!/usr/bin/env node
/**
 * inventory_xml_baseline.js — count every workflow rule in the XML corpus by
 * category (JSU, JMWE, BeeCom, Atlassian native system, JSD, ScriptRunner,
 * Insight/Assets, VendorThree, Exocet, Exporter, Other) and by kind (condition,
 * validator, postFunction).
 *
 * Establishes the numerical acceptance test before any --apply:
 *   - JSU + JMWE + BeeCom = the set we WILL try to migrate.
 *   - Everything else = the set we MUST leave alone (JCMA's responsibility).
 *
 * Usage:
 *   node scripts/inventory_xml_baseline.js [--xml-dir ./workflows]
 */

const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

function parseArgs(argv) {
  const args = { xmlDir: "./workflows" };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--xml-dir") args.xmlDir = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node scripts/inventory_xml_baseline.js [--xml-dir <path>]");
      process.exit(0);
    }
  }
  return args;
}

// Map a class.name (Java FQCN) to a category bucket. Returns the category +
// a sub-key so we can also report which specific plugin a rule belongs to.
const CATEGORY_RULES = [
  { prefix: "com.googlecode.jsu.workflow.", category: "JSU" },
  { prefix: "com.innovalog.jmwe.plugins.", category: "JMWE" },
  { prefix: "ch.beecom.jira.jsu.", category: "BeeCom" },
  { prefix: "com.atlassian.jira.workflow.", category: "Atlassian system" },
  { prefix: "com.atlassian.servicedesk.", category: "Atlassian JSD" },
  { prefix: "com.onresolve.jira.groovy.", category: "ScriptRunner" },
  { prefix: "com.riadalabs.jira.plugins.insight.", category: "Insight/Assets" },
  { prefix: "com.example.jira.plugins.vendorthree.", category: "VendorThree" },
  { prefix: "com.example.jira.plugins.vendor.", category: "Third-party vendor" },
  { prefix: "com.xpandit.", category: "Exporter" },
];

function classify(className) {
  if (!className) return "Other / no class.name";
  for (const r of CATEGORY_RULES) {
    if (className.startsWith(r.prefix)) return r.category;
  }
  return "Other (" + className.split(".").slice(0, 3).join(".") + ".*)";
}

// Each <function|validator|condition> arg list. fast-xml-parser flattens
// single-elements; normalize to an array.
function arr(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// Extract `class.name` from an OSWorkflow rule's <args>. The XML shape is
// `<arg name="class.name">com.foo.Bar</arg>`. fast-xml-parser puts attributes
// under `@_name` and text under `#text` when we set those options.
function classNameOf(rule) {
  if (!rule) return null;
  // The new parser config below uses preserveOrder=false + attribute prefix
  // "@_" + textNodeName "#text". Arg can be a single object or array.
  const args = arr(rule.arg);
  for (const a of args) {
    if (a && a["@_name"] === "class.name") {
      return typeof a === "object" ? (a["#text"] || "") : String(a);
    }
  }
  // Some plugin rules use full.module.key instead of class.name (e.g. system
  // post-functions registered via plugin descriptor). Fall back to that.
  for (const a of args) {
    if (a && a["@_name"] === "full.module.key") {
      return typeof a === "object" ? (a["#text"] || "") : String(a);
    }
  }
  return null;
}

function categorize(className) {
  return { className, category: classify(className) };
}

function harvestActions(actions) {
  // An <action> has child elements: <restrict-to>?, <validators>?, <results>
  // which itself has <unconditional-result>/<conditional-result> wrapping
  // <post-functions>. We walk <validators>/<conditions>/<post-functions>
  // wherever they live in this action.
  const rules = []; // [{ kind, className, category }]
  const visit = (node, kindHint) => {
    if (!node || typeof node !== "object") return;
    // Validators
    const validators = arr(node.validators && node.validators.validator);
    for (const v of validators) {
      rules.push({ kind: "validator", ...categorize(classNameOf(v)) });
    }
    // Conditions (may be nested inside <condition><conditions>...)
    const conds = arr(node["condition"]);
    for (const c of conds) {
      // Leaf: has <arg> children
      if (c && c.arg) rules.push({ kind: "condition", ...categorize(classNameOf(c)) });
      // Nested compound
      if (c && c.conditions) visit(c.conditions, "condition");
    }
    const condsArrayed = arr(node.conditions);
    for (const c of condsArrayed) {
      // Composite: may contain <condition> array
      const innerConds = arr(c.condition);
      for (const ic of innerConds) {
        if (ic && ic.arg) rules.push({ kind: "condition", ...categorize(classNameOf(ic)) });
        if (ic && ic.conditions) visit(ic.conditions, "condition");
      }
    }
    // Post-functions
    const pf = arr(node["post-functions"] && node["post-functions"].function);
    for (const p of pf) {
      rules.push({ kind: "postFunction", ...categorize(classNameOf(p)) });
    }
    // Results may hold post-functions
    const results = arr(node.results && node.results["unconditional-result"]);
    for (const r of results) visit(r, kindHint);
    const condResults = arr(node.results && node.results["conditional-result"]);
    for (const r of condResults) visit(r, kindHint);
  };
  for (const action of arr(actions)) visit(action, null);
  return rules;
}

function harvestWorkflowXml(xmlText) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: false,
  });
  const obj = parser.parse(xmlText);
  const wf = obj.workflow || {};
  const rules = [];
  // Initial actions
  const initialActions = arr(wf["initial-actions"] && wf["initial-actions"].action);
  for (const a of initialActions) {
    for (const r of harvestActions([a])) rules.push({ ...r, scope: "initial-action" });
  }
  // Global actions
  const globalActions = arr(wf["global-actions"] && wf["global-actions"].action);
  for (const a of globalActions) {
    for (const r of harvestActions([a])) rules.push({ ...r, scope: "global-action" });
  }
  // Common actions (referenced by steps)
  const commonActions = arr(wf["common-actions"] && wf["common-actions"].action);
  for (const a of commonActions) {
    for (const r of harvestActions([a])) rules.push({ ...r, scope: "common-action" });
  }
  // Step-local actions
  const steps = arr(wf.steps && wf.steps.step);
  for (const s of steps) {
    for (const a of arr(s.actions && s.actions.action)) {
      for (const r of harvestActions([a])) rules.push({ ...r, scope: "step-action" });
    }
  }
  return rules;
}

function main() {
  const args = parseArgs(process.argv);
  const dir = path.resolve(args.xmlDir);
  if (!fs.existsSync(dir)) {
    console.error(`XML dir not found: ${dir}`);
    process.exit(2);
  }
  const xmlFiles = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".xml"));
  if (xmlFiles.length === 0) {
    console.error(`No .xml files in ${dir}`);
    process.exit(2);
  }
  console.log(`Scanning ${xmlFiles.length} XML file(s) in ${dir}\n`);

  const byCategory = {};
  const byCategoryAndKind = {};
  const perWorkflow = {};
  let total = 0;
  let parseErrors = 0;

  for (const file of xmlFiles) {
    const wfName = path.basename(file, path.extname(file));
    let rules;
    try {
      rules = harvestWorkflowXml(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch (e) {
      console.error(`  ${file}: parse error — ${e.message}`);
      parseErrors++;
      continue;
    }
    const wfCounts = { JSU: 0, JMWE: 0, BeeCom: 0, "Atlassian system": 0, other: 0, total: 0 };
    for (const r of rules) {
      total++;
      wfCounts.total++;
      const cat = r.category;
      byCategory[cat] = (byCategory[cat] || 0) + 1;
      const ckKey = `${cat} :: ${r.kind}`;
      byCategoryAndKind[ckKey] = (byCategoryAndKind[ckKey] || 0) + 1;
      if (cat === "JSU") wfCounts.JSU++;
      else if (cat === "JMWE") wfCounts.JMWE++;
      else if (cat === "BeeCom") wfCounts.BeeCom++;
      else if (cat === "Atlassian system") wfCounts["Atlassian system"]++;
      else wfCounts.other++;
    }
    perWorkflow[wfName] = wfCounts;
  }

  console.log("=== Per-workflow (rule counts; total / JSU / JMWE / BeeCom / Atlassian-system / other) ===");
  const wfSorted = Object.entries(perWorkflow).sort((a, b) => b[1].total - a[1].total);
  for (const [n, c] of wfSorted) {
    if (c.total === 0) continue;
    console.log(
      `  ${c.total.toString().padStart(4)}  | JSU=${c.JSU.toString().padStart(3)} JMWE=${c.JMWE.toString().padStart(3)} BeeCom=${c.BeeCom.toString().padStart(2)} sys=${c["Atlassian system"].toString().padStart(3)} other=${c.other.toString().padStart(3)}  | ${n}`,
    );
  }

  console.log("\n=== By category ===");
  const catSorted = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, n] of catSorted) {
    const pct = ((100 * n) / total).toFixed(1).padStart(5);
    console.log(`  ${n.toString().padStart(4)}  (${pct}%)  ${cat}`);
  }

  console.log("\n=== By category × kind ===");
  const ckSorted = Object.entries(byCategoryAndKind).sort((a, b) => b[1] - a[1]);
  for (const [k, n] of ckSorted) {
    console.log(`  ${n.toString().padStart(4)}  ${k}`);
  }

  // Migration scope summary
  const jsu = byCategory["JSU"] || 0;
  const jmwe = byCategory["JMWE"] || 0;
  const beecom = byCategory["BeeCom"] || 0;
  const sys = byCategory["Atlassian system"] || 0;
  const willMigrate = jsu + jmwe + beecom;
  const leaveAlone = total - willMigrate;

  console.log("\n=== Migration scope ===");
  console.log(`  Total rules in XMLs:        ${total}`);
  console.log(`  Parse errors (files):       ${parseErrors}`);
  console.log("");
  console.log(`  WILL try to migrate:        ${willMigrate}`);
  console.log(`    - JSU rules:              ${jsu}`);
  console.log(`    - JMWE rules:             ${jmwe}`);
  console.log(`    - BeeCom rules:           ${beecom}`);
  console.log("");
  console.log(`  MUST leave alone:           ${leaveAlone}`);
  console.log(`    - Atlassian system:       ${sys}`);
  console.log(`    - Other plugins:          ${leaveAlone - sys}`);
  console.log("");
  console.log("=== Acceptance test for --apply ===");
  console.log(`  Cloud append target (DC):   ${willMigrate} rules`);
  console.log(`  Cloud must not modify/remove any of: ${leaveAlone} non-JSU/JMWE/BeeCom rules (JCMA's territory)`);

  // Save as machine-readable JSON for the post-apply comparator
  const outPath = path.join(__dirname, "..", "logs", `xml_baseline_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        xmlDir: dir,
        xmlFiles: xmlFiles.length,
        totals: { total, willMigrate, leaveAlone, parseErrors },
        byCategory,
        byCategoryAndKind,
        perWorkflow,
      },
      null,
      2,
    ),
  );
  console.log(`\nBaseline JSON saved to ${outPath}`);
}

main();
