#!/usr/bin/env node
// Build a type-aware DC→Cloud asset map.
//
// Why this exists: the sibling sync_asset_ticket_associations plans only
// record (dcAsset.key, cloudAsset.objectId) pairings matched by NAME within
// a single migrated issue. When DC has multiple objects sharing a name but
// with different types (e.g. "Acme Retail" is BOTH an Operator AND a
// Sub-Operator on DC), the sibling sync collapses them — and the wrong
// Cloud objectId gets bound to the wrong DC key. The asset-field rewriter
// then emits ARIs that point to objects in the WRONG type (e.g. a Parent
// Operator ARI in a Sub-Operator field clause), which Cloud silently
// matches against nothing.
//
// This script re-resolves DC→Cloud from primary sources WITH TYPE:
//   1. Scan plan filters for every unique DC asset key referenced in any
//      asset-field clause.
//   2. Batch-query DC Insight to learn each DC key's NAME and OBJECT TYPE.
//   3. Collect unique cloud names → batch-query Cloud Assets for ALL
//      objects of those names, capturing their objectType too.
//   4. For each DC key with (name, dcType), find Cloud candidates that
//      have matching name AND a Cloud type compatible with dcType.
//      Compatibility = case-insensitive type-name equality (Cloud's
//      occasional "Parent Operator" specialisation has no DC counterpart
//      so we ignore it as a candidate when dcType is plain "Operator").
//   5. Save the typed map to logs/dc_typed_asset_map.json:
//      {
//        "CMDB-XXXX": {
//          name: "...",
//          dcType: "Operator",
//          cloudCandidates: [
//             { cloudObjectId: "46197", cloudType: "Operator" }
//          ]
//        },
//        ...
//      }
//      Single-candidate entries are precise (1 Cloud objectId).
//      Multi-candidate entries are within-type ambiguous (the rewriter
//      will emit ARI for all candidates when the filter's per-name rule
//      fires).
//
// Usage:
//   node main/enrich_typed_asset_map.js [--plan-file <path>] [--limit <n>]

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterClient = require("../src/datacenterClient");
const CloudJiraClient = require("../src/cloudJiraClient");
const CloudAssetsClient = require("../src/cloudAssetsClient");
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
const PLAN_FILE = getArg("--plan-file");
const LIMIT = parseInt(getArg("--limit") || "0", 10) || 0;
const DC_BATCH = parseInt(getArg("--dc-batch") || "50", 10) || 50;
const CLOUD_BATCH = parseInt(getArg("--cloud-batch") || "25", 10) || 25;

const logsDir = path.resolve(__dirname, "../logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const runId = String(Date.now());
const logFile = path.join(logsDir, `enrich_typed_${runId}.log`);
const outputPath = path.join(logsDir, "dc_typed_asset_map.json");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  try { fs.appendFileSync(logFile, line + "\n"); } catch { /* ignore */ }
}

const required = ["CLOUD_BASE_URL", "CLOUD_API_TOKEN", "CLOUD_WORKSPACE_ID", "DC_BASE_URL", "DC_USERNAME", "DC_PASSWORD"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  log(`ERROR: missing env: ${missing.join(", ")}`);
  process.exit(1);
}

const cloud = new CloudJiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN, () => {});
const dcClient = new DatacenterClient(process.env.DC_BASE_URL, process.env.DC_USERNAME, process.env.DC_PASSWORD, () => {});
const assets = new CloudAssetsClient(process.env.CLOUD_WORKSPACE_ID, process.env.CLOUD_API_TOKEN);

function aqlQuote(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ── Pass 1: scan plan for every unique DC asset key referenced ──
async function collectDcKeys(planFile, fieldRe, assetFieldNames) {
  const pm = new PlanManager(logsDir, () => {});
  const plan = await pm.loadPlan(planFile);
  if (!plan) throw new Error("plan load failed");
  const keys = new Set();
  for (const [, entry] of Object.entries(plan.filters)) {
    const jql = entry.dcOriginalJql || entry.originalJql || "";
    if (!jql) continue;
    const { masked } = maskAqlFunctionBlocks(jql);
    const matches = [];
    for (const m of masked.matchAll(fieldRe.quoted)) {
      if (!assetFieldNames.has(normalizeName(m[2]))) continue;
      matches.push({ end: m.index + m[0].length });
    }
    if (fieldRe.bare) {
      for (const m of masked.matchAll(fieldRe.bare)) {
        if (!assetFieldNames.has(normalizeName(m[1]))) continue;
        matches.push({ end: m.index + m[0].length });
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
            if (ch === qC) inQ = false; j++; continue;
          }
          if (ch === '"' || ch === "'") { inQ = true; qC = ch; }
          else if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (depth === 0) break; j++;
        }
        if (depth !== 0) continue;
        tokens = splitTopLevelCommas(masked.slice(opEnd + 1, j));
      } else {
        const v = masked.slice(opEnd).match(/^("[^"]*"|'[^']*'|ari:cloud:[^\s)]+|[A-Z][A-Z0-9_]*-\d+|\d+)/i);
        if (!v) continue; tokens = [v[0]];
      }
      for (const t of tokens) {
        const cls = classifyValueToken(t);
        if (cls.kind === "key" || cls.kind === "keyed-key") keys.add(cls.lookupKey);
      }
    }
  }
  return keys;
}

// ── Pass 2: batch-query DC Insight for each key's (name, type) ──
async function fetchDcKeyInfo(keys) {
  const out = new Map(); // CMDB-X → {name, dcType, dcTypeId}
  const list = Array.from(keys);
  const total = list.length;
  log(`DC Insight: fetching ${total} keys in batches of ${DC_BATCH}...`);
  for (let i = 0; i < list.length; i += DC_BATCH) {
    const batch = list.slice(i, i + DC_BATCH);
    const iql = `Key IN (${batch.map(aqlQuote).join(", ")})`;
    try {
      const r = await dcClient.makeRequest(
        "GET",
        `/rest/insight/1.0/iql/objects?iql=${encodeURIComponent(iql)}&resultPerPage=${DC_BATCH + 5}`,
      );
      for (const e of (r && r.objectEntries) || []) {
        const ot = e.objectType || {};
        out.set(e.objectKey, {
          name: e.label || e.name || null,
          dcType: ot.name || null,
          dcTypeId: ot.id != null ? String(ot.id) : null,
        });
      }
    } catch (err) {
      log(`  DC batch ${i / DC_BATCH + 1} failed: ${err.message}`);
    }
    if ((i / DC_BATCH + 1) % 5 === 0 || i + DC_BATCH >= list.length) {
      log(`  DC progress: ${Math.min(i + DC_BATCH, total)}/${total}`);
    }
  }
  log(`  DC resolved: ${out.size}/${total}`);
  return out;
}

// ── Pass 3: batch-query Cloud Assets for ALL objects of each unique name ──
async function fetchCloudObjectsByNames(names) {
  const out = new Map(); // name (case-preserved) → [{ cloudObjectId, cloudType, cloudTypeId }]
  const list = Array.from(names);
  const total = list.length;
  log(`Cloud Assets: fetching ${total} unique names in batches of ${CLOUD_BATCH}...`);
  for (let i = 0; i < list.length; i += CLOUD_BATCH) {
    const batch = list.slice(i, i + CLOUD_BATCH);
    const iql = `Name IN (${batch.map((n) => `"${CloudAssetsClient.escapeAqlValue(n)}"`).join(", ")})`;
    let startAt = 0;
    try {
      while (true) {
        const r = await assets.makeRequest(
          "POST",
          `/object/aql?startAt=${startAt}&maxResults=50&includeAttributes=false`,
          { qlQuery: iql },
        );
        const objects = r.values || [];
        for (const obj of objects) {
          const n = obj.label || obj.name;
          if (!n) continue;
          if (!out.has(n)) out.set(n, []);
          out.get(n).push({
            cloudObjectId: String(obj.id),
            cloudObjectKey: obj.objectKey,
            cloudType: obj.objectType && obj.objectType.name || null,
            cloudTypeId: obj.objectType && obj.objectType.id != null ? String(obj.objectType.id) : null,
          });
        }
        if (r.isLast || objects.length === 0) break;
        startAt += objects.length;
      }
    } catch (err) {
      log(`  Cloud batch ${i / CLOUD_BATCH + 1} failed: ${err.message}`);
    }
    if ((i / CLOUD_BATCH + 1) % 5 === 0 || i + CLOUD_BATCH >= list.length) {
      log(`  Cloud progress: ${Math.min(i + CLOUD_BATCH, total)}/${total}`);
    }
  }
  log(`  Cloud resolved: ${out.size}/${total} names with ≥1 match`);
  return out;
}

// ── Type compatibility ──
// Default rule: case-insensitive type-name equality. Cloud has occasional
// type specialisations (e.g. "Parent Operator") that have no DC counterpart;
// those are NOT considered compatible with a DC plain "Operator". Callers
// can pre-load a custom mapping from `logs/dc_type_to_cloud_type.json` if
// JCMA at this tenant did something fancier.
function buildTypeCompat() {
  const customPath = path.join(logsDir, "dc_type_to_cloud_type.json");
  let custom = null;
  if (fs.existsSync(customPath)) {
    try { custom = JSON.parse(fs.readFileSync(customPath, "utf8")); log(`  Loaded custom DC type→Cloud type map: ${customPath}`); }
    catch (err) { log(`  ⚠  Could not parse ${customPath}: ${err.message}`); }
  }
  return (dcType, cloudType) => {
    if (!dcType || !cloudType) return false;
    if (custom && Array.isArray(custom[dcType])) {
      return custom[dcType].some((t) => t.toLowerCase() === cloudType.toLowerCase());
    }
    return dcType.toLowerCase() === cloudType.toLowerCase();
  };
}

(async function main() {
  log("============================================================");
  log("Build type-aware DC→Cloud asset map");
  log("============================================================");

  let planFile = PLAN_FILE;
  if (!planFile) {
    planFile = fs.readdirSync(logsDir)
      .filter((f) => /^plan_\d+\.json$/.test(f) && !/prerefresh|preorphan|prerebuild|prebackfill|prefetchdc/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(logsDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .map((e) => path.join(logsDir, e.f))[0];
  } else {
    planFile = path.resolve(planFile);
  }
  log(`Plan: ${planFile}`);

  const fm = await buildFieldMap({ cloudClient: cloud, dcClient, log: () => {} });
  const fieldRe = buildFieldNameRegex(fm.cloudAssetFieldNames);
  if (!fieldRe) { log("no asset fields → nothing to do"); process.exit(0); }

  log("Scanning plan for unique DC asset keys...");
  let dcKeys = await collectDcKeys(planFile, fieldRe, fm.cloudAssetFieldNames);
  log(`  ${dcKeys.size} unique DC keys in plan filters`);
  if (LIMIT > 0) {
    dcKeys = new Set(Array.from(dcKeys).slice(0, LIMIT));
    log(`  --limit ${LIMIT}: scoping to ${dcKeys.size} keys`);
  }
  if (dcKeys.size === 0) { log("no keys to enrich"); process.exit(0); }

  const dcKeyToInfo = await fetchDcKeyInfo(dcKeys);
  const dcNames = new Set();
  for (const v of dcKeyToInfo.values()) if (v.name) dcNames.add(v.name);
  log(`  unique DC names to look up on Cloud: ${dcNames.size}`);

  const cloudByName = await fetchCloudObjectsByNames(dcNames);

  const typeCompat = buildTypeCompat();

  const typedMap = {};
  let precise = 0, ambiguous = 0, noCandidate = 0, dcUnknownType = 0;
  for (const [dcKey, info] of dcKeyToInfo.entries()) {
    if (!info.name) continue;
    if (!info.dcType) dcUnknownType++;
    const allCloudForName = cloudByName.get(info.name) || [];
    const compatible = info.dcType
      ? allCloudForName.filter((c) => typeCompat(info.dcType, c.cloudType))
      : allCloudForName; // no DC type known → fall back to any name match
    const entry = {
      name: info.name,
      dcType: info.dcType,
      dcTypeId: info.dcTypeId,
      cloudCandidates: compatible.map((c) => ({
        cloudObjectId: c.cloudObjectId,
        cloudObjectKey: c.cloudObjectKey,
        cloudType: c.cloudType,
        cloudTypeId: c.cloudTypeId,
      })),
    };
    typedMap[dcKey] = entry;
    if (compatible.length === 1) precise++;
    else if (compatible.length > 1) ambiguous++;
    else noCandidate++;
  }

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        workspaceId: process.env.CLOUD_WORKSPACE_ID,
        sourcePlan: planFile,
        stats: {
          dcKeysQueried: dcKeyToInfo.size,
          dcUnknownType,
          preciseSingleCandidate: precise,
          ambiguousMultipleCandidates: ambiguous,
          noCandidate,
        },
        keys: typedMap,
      },
      null,
      2,
    ),
  );

  log("\n=== summary ===");
  log(`  DC keys queried     : ${dcKeyToInfo.size}/${dcKeys.size}`);
  log(`  DC unknown type     : ${dcUnknownType}`);
  log(`  precise (1 candidate): ${precise}`);
  log(`  ambiguous (≥2)       : ${ambiguous}`);
  log(`  no candidate         : ${noCandidate}`);
  log(`  output               : ${outputPath}`);
})().catch((err) => {
  log(`FATAL: ${err.message}\n${err.stack || ""}`);
  process.exit(1);
});
