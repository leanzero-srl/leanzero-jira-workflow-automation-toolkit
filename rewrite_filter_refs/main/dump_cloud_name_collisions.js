#!/usr/bin/env node
// Build a name → ALL objectIds multimap from Cloud Assets via the AQL API.
// Cloud truth (not the sibling per-issue plans, which collapse to first-wins).
//
// Why we need this: the collision-aware rewriter in src/assetFieldRewriter.js
// fires ARI emission for an asset name only when that name has ≥2 distinct
// objectIds visible to the rewriter. The default cloudNameToCloudObjectIds
// built from per-issue plans loses multi-objectId info (each issue tends to
// reference only one object per name, and the loader is first-wins by name).
// So Path-1 enrichment goes straight to Cloud Assets API.
//
// Workflow:
//   1. Read the plan, extract every unique asset-field NAME token.
//   2. Batch-query Cloud Assets `Name IN (...)` 25 names at a time.
//   3. Paginate through ALL results per batch (don't stop at first match per
//      name like the sibling script does).
//   4. Emit { name_lowercased: [objectId, objectId, ...] } as JSON.
//   5. Stats: total queried, with 0 matches, 1 match, ≥2 matches (the
//      "ambiguous" set that drives ARI emission).
//
// Safe to re-run. Idempotent. Output JSON overwrites the previous dump.
//
// Usage:
//   node main/dump_cloud_name_collisions.js [--plan-file <path>] [--output <path>]
//                                            [--batch-size <n>] [--all-types]

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudAssetsClient = require("../src/cloudAssetsClient");
const CloudJiraClient = require("../src/cloudJiraClient");
const DatacenterClient = require("../src/datacenterClient");
const PlanManager = require("../src/planManager");
const { buildFieldMap } = require("../src/fieldMapBuilder");
const {
  maskAqlFunctionBlocks,
  classifyValueToken,
  buildFieldNameRegex,
  normalizeName,
} = require("../src/assetFieldRewriter");
const { splitTopLevelCommas } = require("../src/aqlRewriter");

const args = process.argv.slice(2);
function hasFlag(n) { return args.includes(n); }
function getArg(n) {
  const i = args.indexOf(n);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

if (hasFlag("--help")) {
  console.log(`
Usage: node main/dump_cloud_name_collisions.js [options]

Queries Cloud Assets for every asset-field name referenced in the plan
and writes a name → all-objectIds multimap to JSON.

Options:
  --plan-file <path>   Plan to read. Default: latest plan_*.json in logs/.
  --output <path>      JSON output path. Default: logs/cloud_name_multimap.json
  --batch-size <n>     Batch size for Name IN queries (default 25).
  --max-results <n>    Per-page max results for AQL pagination (default 50).
  --include-asset-jql  Also extract names from the rewrittenJql (default: only originalJql).
  --help               Show this help.

No Cloud writes are performed. Reads Cloud Assets via /object/aql.
`);
  process.exit(0);
}

const PLAN_FILE = getArg("--plan-file");
const OUTPUT = getArg("--output");
const BATCH_SIZE = parseInt(getArg("--batch-size") || "25", 10) || 25;
const MAX_RESULTS = parseInt(getArg("--max-results") || "50", 10) || 50;
const INCLUDE_REWRITTEN = hasFlag("--include-asset-jql");

const logsDir = path.resolve(__dirname, "../logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const runId = String(Date.now());
const outputPath = OUTPUT ? path.resolve(OUTPUT) : path.join(logsDir, "cloud_name_multimap.json");
const logFile = path.join(logsDir, `dump_cloud_name_collisions_${runId}.log`);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  try { fs.appendFileSync(logFile, line + "\n"); } catch { /* ignore */ }
}

const missing = ["CLOUD_BASE_URL", "CLOUD_API_TOKEN", "CLOUD_WORKSPACE_ID"].filter((k) => !process.env[k]);
if (missing.length) {
  log(`ERROR: Missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

// Extract every bare-NAME asset-field token from a JQL string. Returns a Set
// of distinct name strings (preserving original case for the first sighting;
// final dedup is via lowercased key downstream).
function extractAssetNameTokens(jql, fieldNameRe, fieldNameSet) {
  if (!jql || !fieldNameRe) return [];
  const out = new Set();
  const { masked } = maskAqlFunctionBlocks(jql);
  const matches = [];
  for (const m of masked.matchAll(fieldNameRe.quoted)) {
    if (!fieldNameSet.has(normalizeName(m[2]))) continue;
    matches.push({ start: m.index, end: m.index + m[0].length });
  }
  if (fieldNameRe.bare) {
    for (const m of masked.matchAll(fieldNameRe.bare)) {
      if (!fieldNameSet.has(normalizeName(m[1]))) continue;
      matches.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  for (const match of matches) {
    const after = masked.slice(match.end);
    const opMatch = after.match(/^\s*(=|!=|\bNOT\s+IN\b|\bIN\b)\s*/i);
    if (!opMatch) continue;
    const op = opMatch[1].toUpperCase().replace(/\s+/g, " ");
    const opEnd = match.end + opMatch[0].length;
    let tokens = [];
    if (op === "IN" || op === "NOT IN") {
      if (masked[opEnd] !== "(") continue;
      let depth = 1, j = opEnd + 1, inQ = false, qC = "";
      while (j < masked.length && depth > 0) {
        const ch = masked[j];
        if (inQ) {
          if (ch === "\\" && j + 1 < masked.length) { j += 2; continue; }
          if (ch === qC) inQ = false;
          j++;
          continue;
        }
        if (ch === '"' || ch === "'") { inQ = true; qC = ch; }
        else if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (depth === 0) break;
        j++;
      }
      if (depth !== 0) continue;
      tokens = splitTopLevelCommas(masked.slice(opEnd + 1, j));
    } else {
      const valSlice = masked.slice(opEnd);
      const v = valSlice.match(/^("[^"]*"|'[^']*'|ari:cloud:[^\s)]+|[A-Z][A-Z0-9_]*-\d+|\d+)/i);
      if (!v) continue;
      tokens = [v[0]];
    }
    for (const t of tokens) {
      const cls = classifyValueToken(t);
      // Plain name tokens are the ones we need to look up; resolved keyed/
      // numeric/ari tokens already give us a specific objectId without an
      // AQL roundtrip (handled by the rewriter's resolveTokenToObject path).
      if (cls.kind === "name" && cls.core) out.add(cls.core);
    }
  }
  return Array.from(out);
}

(async function main() {
  log("============================================================");
  log("Dump Cloud Assets name → multi-objectId map");
  log("============================================================");

  const cloud = new CloudJiraClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_API_TOKEN,
    () => {},
  );
  let dcClient = null;
  if (process.env.DC_BASE_URL && process.env.DC_USERNAME && process.env.DC_PASSWORD) {
    dcClient = new DatacenterClient(
      process.env.DC_BASE_URL,
      process.env.DC_USERNAME,
      process.env.DC_PASSWORD,
      () => {},
    );
  }
  const assets = new CloudAssetsClient(process.env.CLOUD_WORKSPACE_ID, process.env.CLOUD_API_TOKEN);

  log("Loading field map (to learn which fields are Asset fields)...");
  const fm = await buildFieldMap({ cloudClient: cloud, dcClient, log: () => {} });
  const fieldNameSet = fm.cloudAssetFieldNames;
  log(`  Asset fields: ${fieldNameSet.size}`);
  const fieldRe = buildFieldNameRegex(fieldNameSet);
  if (!fieldRe) {
    log("No asset fields known — nothing to do.");
    process.exit(0);
  }

  log("Loading plan...");
  const pm = new PlanManager(logsDir, () => {});
  const planFile = PLAN_FILE
    ? path.resolve(PLAN_FILE)
    : fs.readdirSync(logsDir)
        .filter((f) => /^plan_\d+\.json$/.test(f) && !/prerefresh|preorphan|prerebuild|prebackfill|prefetchdc/.test(f))
        .map((f) => ({ f, m: fs.statSync(path.join(logsDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)
        .map((e) => path.join(logsDir, e.f))[0];
  if (!planFile || !fs.existsSync(planFile)) {
    log("No plan file.");
    process.exit(1);
  }
  log(`  ${planFile}`);
  const plan = await pm.loadPlan(planFile);
  if (!plan) {
    log("Failed to load plan.");
    process.exit(1);
  }

  // Pull every distinct asset-field name token across the plan.
  const allNames = new Set();
  for (const [, e] of Object.entries(plan.filters)) {
    for (const name of extractAssetNameTokens(e.originalJql || "", fieldRe, fieldNameSet)) {
      allNames.add(name);
    }
    if (INCLUDE_REWRITTEN) {
      for (const name of extractAssetNameTokens(e.rewrittenJql || "", fieldRe, fieldNameSet)) {
        allNames.add(name);
      }
    }
  }
  log(`Distinct asset-field name tokens to query: ${allNames.size}`);

  // Query in batches of BATCH_SIZE using Name IN (...). For each batch,
  // paginate fully and collect ALL matches per name (not first-wins).
  const result = new Map(); // lc(name) → Set<objectId>
  const namesArr = Array.from(allNames);
  const totalBatches = Math.ceil(namesArr.length / BATCH_SIZE);
  let queried = 0;
  let apiCalls = 0;
  for (let i = 0; i < namesArr.length; i += BATCH_SIZE) {
    const batch = namesArr.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const quoted = batch.map((n) => `"${CloudAssetsClient.escapeAqlValue(n)}"`).join(", ");
    const aql = `Name IN (${quoted})`;
    let startAt = 0;
    while (true) {
      let resp;
      try {
        resp = await assets.makeRequest(
          "POST",
          `/object/aql?startAt=${startAt}&maxResults=${MAX_RESULTS}&includeAttributes=false`,
          { qlQuery: aql },
        );
      } catch (err) {
        log(`  [batch ${batchNum}/${totalBatches}] AQL failed: ${err.message}`);
        break;
      }
      apiCalls++;
      const objects = resp.values || [];
      for (const obj of objects) {
        const objName = obj.label || obj.name || null;
        if (!objName) continue;
        const lc = objName.toLowerCase().trim();
        if (!result.has(lc)) result.set(lc, new Set());
        result.get(lc).add(String(obj.id));
      }
      if (resp.isLast || objects.length === 0) break;
      startAt += objects.length;
    }
    queried += batch.length;
    if (batchNum % 5 === 0 || batchNum === totalBatches) {
      log(`  batch ${batchNum}/${totalBatches} done (${queried}/${namesArr.length} names queried, ${apiCalls} API calls)`);
    }
  }

  // Build counts + write JSON.
  let zero = 0, one = 0, many = 0;
  const output = {};
  for (const name of namesArr) {
    const lc = name.toLowerCase().trim();
    const ids = result.get(lc);
    if (!ids || ids.size === 0) {
      zero++;
      continue;
    }
    const arr = Array.from(ids).sort();
    output[lc] = arr;
    if (arr.length === 1) one++;
    else many++;
  }

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        workspaceId: process.env.CLOUD_WORKSPACE_ID,
        sourceFile: planFile,
        stats: {
          namesQueried: namesArr.length,
          notFound: zero,
          unique: one,
          ambiguous: many,
        },
        nameToObjectIds: output,
      },
      null,
      2,
    ),
  );

  log("\n=== summary ===");
  log(`  names queried     : ${namesArr.length}`);
  log(`  not found         : ${zero}`);
  log(`  single match      : ${one}`);
  log(`  AMBIGUOUS (≥2)    : ${many}`);
  log(`  API calls         : ${apiCalls}`);
  log(`  output            : ${outputPath}`);
})().catch((err) => {
  log(`FATAL: ${err.message}\n${err.stack || ""}`);
  process.exit(1);
});
