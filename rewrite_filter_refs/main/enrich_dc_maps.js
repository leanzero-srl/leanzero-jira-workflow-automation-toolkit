#!/usr/bin/env node
// Build two enrichment artifacts the rebuild script consumes:
//
//   logs/dc_project_id_to_key.json
//     Map<dcProjectIdString, projectKey>. Built from DC /rest/api/2/project.
//     Drives the projectIdRewriter pass — rewrites `project = "<dc_id>"` to
//     `project = "<key>"` since project keys are preserved by JCMA.
//
//   logs/dc_asset_key_enrichment.json
//     {
//       dcKeyToCloudName:     {CI-NNNN: "Asset Name"},
//       dcKeyToCloudObjectId: {CI-NNNN: "<cloud_objectId>"},
//     }
//     For DC asset keys that appear in plan filters but are missing from the
//     sibling sync_asset_ticket_associations maps (because no migrated
//     issue referenced them). For each such CI key:
//       1. Query DC Insight `Key = "CMDB-X"` → learn the DC asset NAME.
//       2. Look up that name on Cloud Assets `Name = "<n>"` → get cloud
//          objectId. If multiple matches (ambiguous on Cloud), record the
//          first; the strict per-name rule means this entry can still
//          contribute to per-filter ambiguity detection.
//
// Both files are safe to re-run; they overwrite their previous selves.
//
// Usage:
//   node main/enrich_dc_maps.js [--plan-file <path>] [--dry-run]

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterClient = require("../src/datacenterClient");
const CloudJiraClient = require("../src/cloudJiraClient");
const CloudAssetsClient = require("../src/cloudAssetsClient");
const PlanManager = require("../src/planManager");
const { loadAssetMaps } = require("../src/assetMapLoader");
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
const DRY_RUN = hasFlag("--dry-run");

const logsDir = path.resolve(__dirname, "../logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const requiredEnv = ["CLOUD_BASE_URL", "CLOUD_API_TOKEN", "CLOUD_WORKSPACE_ID", "DC_BASE_URL", "DC_USERNAME", "DC_PASSWORD"];
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Missing env vars:", missing.join(", "));
  process.exit(1);
}

const log = (...a) => console.log(...a);
const cloud = new CloudJiraClient(process.env.CLOUD_BASE_URL, process.env.CLOUD_API_TOKEN, () => {});
const dcClient = new DatacenterClient(process.env.DC_BASE_URL, process.env.DC_USERNAME, process.env.DC_PASSWORD, () => {});
const assets = new CloudAssetsClient(process.env.CLOUD_WORKSPACE_ID, process.env.CLOUD_API_TOKEN);

// ─── Project map ───
async function buildProjectMap() {
  log("Fetching DC project list...");
  const projs = await dcClient.makeRequest("GET", "/rest/api/2/project");
  const out = {};
  for (const p of projs || []) {
    if (p && p.id != null && p.key) out[String(p.id)] = String(p.key);
  }
  log(`  ${Object.keys(out).length} DC projects mapped (id → key)`);
  return out;
}

// ─── Asset key enrichment ───
async function buildAssetKeyEnrichment(planFile) {
  log("Loading sibling asset maps (to compute the 'missing' set)...");
  const am = await loadAssetMaps(
    "../sync_asset_ticket_associations/logs/plan_*.json",
    { log: () => {}, cwd: path.resolve(__dirname, "..") },
  );
  log(`  sibling map: ${am.dcKeyToCloudName.size} dc keys known`);

  log("Loading field map (to identify asset fields)...");
  const fm = await buildFieldMap({ cloudClient: cloud, dcClient, log: () => {} });
  const fieldRe = buildFieldNameRegex(fm.cloudAssetFieldNames);
  if (!fieldRe) {
    log("  no asset fields → nothing to enrich");
    return { dcKeyToCloudName: {}, dcKeyToCloudObjectId: {} };
  }

  log(`Scanning plan for unresolved DC CI keys: ${planFile}`);
  const pm = new PlanManager(logsDir, () => {});
  const plan = await pm.loadPlan(planFile);
  if (!plan) { log("  load failed"); return { dcKeyToCloudName: {}, dcKeyToCloudObjectId: {} }; }

  const unresolvedKeys = new Set();
  for (const [, entry] of Object.entries(plan.filters)) {
    const jql = entry.dcOriginalJql || entry.originalJql || "";
    if (!jql) continue;
    const { masked } = maskAqlFunctionBlocks(jql);
    const matches = [];
    for (const m of masked.matchAll(fieldRe.quoted)) {
      if (!fm.cloudAssetFieldNames.has(normalizeName(m[2]))) continue;
      matches.push({ start: m.index, end: m.index + m[0].length });
    }
    if (fieldRe.bare) {
      for (const m of masked.matchAll(fieldRe.bare)) {
        if (!fm.cloudAssetFieldNames.has(normalizeName(m[1]))) continue;
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
            j++; continue;
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
        const v = masked.slice(opEnd).match(/^("[^"]*"|'[^']*'|ari:cloud:[^\s)]+|[A-Z][A-Z0-9_]*-\d+|\d+)/i);
        if (!v) continue;
        tokens = [v[0]];
      }
      for (const t of tokens) {
        const cls = classifyValueToken(t);
        // Track unresolved keyed/keyed-key forms.
        if (cls.kind === "key" || cls.kind === "keyed-key") {
          const k = cls.lookupKey;
          if (!am.dcKeyToCloudName.has(k)) unresolvedKeys.add(k);
        }
      }
    }
  }
  log(`  unresolved DC keys in plan: ${unresolvedKeys.size}`);
  if (unresolvedKeys.size === 0) {
    return { dcKeyToCloudName: {}, dcKeyToCloudObjectId: {} };
  }

  // Step 1: query DC Insight per key (paginated; one call per key is fine
  // for the small numbers we expect — <200).
  log("Resolving DC keys via Insight IQL...");
  const dcKeyToDcName = new Map();
  const dcInsightFailed = [];
  const list = Array.from(unresolvedKeys);
  for (let i = 0; i < list.length; i++) {
    const k = list[i];
    try {
      const r = await dcClient.makeRequest(
        "GET",
        `/rest/insight/1.0/iql/objects?iql=${encodeURIComponent('Key = "' + k + '"')}&resultPerPage=10`,
      );
      const entries = (r && r.objectEntries) || [];
      if (entries.length === 0) {
        dcInsightFailed.push(k + ":dc_no_match");
        continue;
      }
      const e = entries[0];
      const name = e.label || e.name || null;
      if (!name) {
        dcInsightFailed.push(k + ":dc_no_name");
        continue;
      }
      dcKeyToDcName.set(k, name);
    } catch (err) {
      dcInsightFailed.push(k + ":dc_err_" + (err.statusCode || err.message));
    }
    if ((i + 1) % 20 === 0) log(`  ${i + 1}/${list.length} DC keys queried`);
  }
  log(`  DC Insight resolved: ${dcKeyToDcName.size}/${list.length}`);
  if (dcInsightFailed.length) log(`  DC failures: ${dcInsightFailed.slice(0, 10).join(", ")}${dcInsightFailed.length > 10 ? " (...)" : ""}`);

  // Step 2: for each DC name we found, look up on Cloud Assets to learn the
  // cloud objectId. Batch via Name IN (...) for efficiency. Note: a single
  // DC name may match ≥2 cloud objects — the strict per-name rule means
  // we record the first match here so the rewriter can still flag the name
  // as ambiguous if 2+ DC keys end up resolving to the same cloud name.
  const uniqueNames = Array.from(new Set(dcKeyToDcName.values()));
  log(`  unique cloud names to resolve: ${uniqueNames.length}`);
  const nameToCloudObjectId = new Map();
  const nameNotFound = [];
  const batchSize = 25;
  for (let i = 0; i < uniqueNames.length; i += batchSize) {
    const batch = uniqueNames.slice(i, i + batchSize);
    const quoted = batch
      .map((n) => `"${CloudAssetsClient.escapeAqlValue(n)}"`)
      .join(", ");
    try {
      let startAt = 0;
      while (true) {
        const resp = await assets.makeRequest(
          "POST",
          `/object/aql?startAt=${startAt}&maxResults=50&includeAttributes=false`,
          { qlQuery: `Name IN (${quoted})` },
        );
        const objects = resp.values || [];
        for (const obj of objects) {
          const n = obj.label || obj.name;
          if (!n) continue;
          if (!nameToCloudObjectId.has(n)) {
            nameToCloudObjectId.set(n, String(obj.id));
          }
        }
        if (resp.isLast || objects.length === 0) break;
        startAt += objects.length;
      }
    } catch (err) {
      log(`  cloud batch ${i}-${i + batch.length} failed: ${err.message}`);
    }
  }
  for (const n of uniqueNames) {
    if (!nameToCloudObjectId.has(n)) nameNotFound.push(n);
  }
  log(`  cloud-matched names: ${nameToCloudObjectId.size}/${uniqueNames.length}`);
  if (nameNotFound.length) log(`  not on cloud: ${nameNotFound.slice(0, 10).join(", ")}${nameNotFound.length > 10 ? " (...)" : ""}`);

  // Assemble final enrichment maps
  const dcKeyToCloudName = {};
  const dcKeyToCloudObjectId = {};
  for (const [dcKey, dcName] of dcKeyToDcName.entries()) {
    const cloudId = nameToCloudObjectId.get(dcName);
    if (!cloudId) continue;
    dcKeyToCloudName[dcKey] = dcName;
    dcKeyToCloudObjectId[dcKey] = cloudId;
  }
  log(`  enrichment built: ${Object.keys(dcKeyToCloudName).length} DC keys → cloud`);
  return { dcKeyToCloudName, dcKeyToCloudObjectId };
}

(async function main() {
  log("============================================================");
  log("Enrich DC maps (project IDs + missing asset keys)");
  log("============================================================");

  // Resolve plan file
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

  const projectMap = await buildProjectMap();
  const enrich = await buildAssetKeyEnrichment(planFile);

  const projOut = path.join(logsDir, "dc_project_id_to_key.json");
  const enrichOut = path.join(logsDir, "dc_asset_key_enrichment.json");

  if (DRY_RUN) {
    log(`(dry-run) would write: ${projOut}, ${enrichOut}`);
    return;
  }
  fs.writeFileSync(projOut, JSON.stringify(projectMap, null, 2));
  fs.writeFileSync(enrichOut, JSON.stringify(enrich, null, 2));
  log(`\nWrote ${projOut} (${Object.keys(projectMap).length} entries)`);
  log(`Wrote ${enrichOut} (${Object.keys(enrich.dcKeyToCloudName).length} entries)`);
})().catch((err) => {
  console.error("FATAL:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
