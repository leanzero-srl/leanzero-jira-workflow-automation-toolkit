#!/usr/bin/env node
// Rebuild rewrittenJql purely from originalJql (in-memory, no Cloud GETs).
//
// Why:
//   Previous refresh_plan.js layered passes on top of `rewrittenJql`, which
//   accumulated bugs from earlier rewriter versions (cleanupJql empty-paren
//   bug eats currentUser() → currentUser; orphan cf[N] before AND; etc.).
//   Running fresh passes on `originalJql` produces a clean, corruption-free
//   rewrite that benefits from every bug fix shipped since.
//
// What we preserve:
//   • `originalJql`            — the gold pre-PUT reference (never touched)
//   • `expectedLiveJql`        — what Cloud currently holds; used by
//                                --avoid-overwrite at execute time
//   • `originalOwner` / perms  — captured at Phase-1, still valid
//   • `refs[]`                 — DC→Cloud filter-ID resolutions; we replay
//                                them to keep `filter = NNN` rewrites intact
//                                without needing the filter mapper / DC list
//
// What we reset (when the new rewrite differs from the prior `rewrittenJql`):
//   • `rewrittenJql`           — to the fresh, clean output
//   • `status`                 — pending
//   • `jqlUpdated`, `permissionsAdded`, `ownerSwapped`, `ownerRestored`,
//     `executionPhase`, `lastStepError`, `error`, `sharePermissionPosted` — cleared
//
// Manual-edit detection: untouched. expectedLiveJql preserved. The execute
// phase with --avoid-overwrite will GET each filter and compare against
// expectedLiveJql at write time. Match → apply our fresh rewrite. Mismatch →
// skipped:externally_modified.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudJiraClient = require("../src/cloudJiraClient");
const DatacenterClient = require("../src/datacenterClient");
const PlanManager = require("../src/planManager");
const { buildFieldMap } = require("../src/fieldMapBuilder");
const { loadAssetMaps } = require("../src/assetMapLoader");
const { rewriteJql, rewriteAqlFunctionBodies } = require("../src/jqlRewriter");
const { rewriteAql } = require("../src/aqlRewriter");
const { rewriteAssetFieldRefs } = require("../src/assetFieldRewriter");
const { rewriteTrafficLightFields } = require("../src/trafficLightFieldRewriter");
const { sanitizeJql } = require("../src/jqlSanitizer");
const { cleanOrderBy } = require("../src/orderByCleaner");
const { rewriteProjectIds } = require("../src/projectIdRewriter");

const log = (...a) => console.log(...a);

// --use-dc-original: prefer entry.dcOriginalJql (populated by
// main/fetch_dc_originals.js) over entry.originalJql as the rewrite source.
// Without this flag the legacy behavior is unchanged — the rebuild reads
// originalJql (the JCMA-migrated form Cloud held at plan-build time).
const USE_DC_ORIGINAL = process.argv.includes("--use-dc-original");

// --cloud-collision-map <path>: load a Cloud-Assets-derived name → all-
// objectIds multimap (output of main/dump_cloud_name_collisions.js) and
// OVERRIDE the sibling-plan-derived cloudNameToCloudObjectIds with it.
// Required for the collision-aware rewriter to detect ambiguous names —
// the sibling plans collapse multi-objectId names to first-wins so the
// rewriter never sees the ambiguity.
function _getArg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const CLOUD_COLLISION_MAP = _getArg("--cloud-collision-map");

function findLatestPlan() {
  const dir = path.resolve(__dirname, "../logs");
  return fs.readdirSync(dir)
    .filter((f) => /^plan_\d+\.json$/.test(f) && !/prerefresh|preorphan|prerebuild/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((e) => path.join(dir, e.f))[0];
}

(async () => {
  // First true positional arg → plan file path. We must skip values that
  // are arguments to known flags (e.g. `--cloud-collision-map ./foo.json`
  // — the second token is the flag's value, not a positional).
  const FLAGS_WITH_VALUE = new Set(["--cloud-collision-map", "--plan-file"]);
  const argv = process.argv.slice(2);
  let positional = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (FLAGS_WITH_VALUE.has(a)) i++; // skip the value
      continue;
    }
    positional = a;
    break;
  }
  const planFile = positional ? path.resolve(positional) : findLatestPlan();
  if (!planFile || !fs.existsSync(planFile)) {
    console.error("no plan file");
    process.exit(1);
  }
  log(`Rebuilding rewrittenJql from originalJql in plan: ${planFile}`);

  // Resolve Cloud + (optional) DC for the field map. Needed for asset / TL /
  // customfield_N remap. Pure in-memory after this — no per-filter GETs.
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
    try {
      const ok = await dcClient.testConnection();
      if (!ok) { log("  ⚠  DC test failed; continuing without DC"); dcClient = null; }
    } catch { dcClient = null; }
  }

  log("Loading field map...");
  const fm = await buildFieldMap({ cloudClient: cloud, dcClient, log });
  log("Loading asset maps from sibling plans...");
  const am = await loadAssetMaps(
    "../sync_asset_ticket_associations/logs/plan_*.json",
    { log, cwd: path.resolve(__dirname, "..") },
  );
  // workspaceId is required for ARI emission in the collision-aware pass.
  // When absent, the rewriter silently falls back to name-only behavior.
  const workspaceId = process.env.CLOUD_WORKSPACE_ID || null;
  if (am.cloudNameToCloudObjectIds && workspaceId) {
    log(
      `  Collision-aware pass enabled: ${am.stats.cloudNameCollisions || 0} cloud name(s) with ≥2 objectIds (workspace ${workspaceId})`,
    );
  } else if (am.cloudNameToCloudObjectIds && !workspaceId) {
    log(
      "  ⚠  CLOUD_WORKSPACE_ID missing — collision-aware ARI emission disabled. Set it in .env to enable.",
    );
  }

  // OVERRIDE the sibling-plan multimap with the Cloud-Assets-derived one
  // when --cloud-collision-map is supplied. Cloud Assets is the truth;
  // the sibling per-issue plans collapse to first-wins.
  if (CLOUD_COLLISION_MAP) {
    const mapAbs = require("path").isAbsolute(CLOUD_COLLISION_MAP)
      ? CLOUD_COLLISION_MAP
      : require("path").resolve(process.cwd(), CLOUD_COLLISION_MAP);
    log(`  Loading Cloud-Assets name multimap: ${mapAbs}`);
    const parsed = JSON.parse(fs.readFileSync(mapAbs, "utf8"));
    const nameToIds = parsed.nameToObjectIds || {};
    const overridden = new Map();
    let entries = 0;
    let collisions = 0;
    for (const [lcName, ids] of Object.entries(nameToIds)) {
      const arr = Array.isArray(ids) ? ids.map(String) : [];
      if (arr.length === 0) continue;
      overridden.set(lcName, arr);
      entries++;
      if (arr.length >= 2) collisions++;
    }
    am.cloudNameToCloudObjectIds = overridden;
    // NOTE: we intentionally do NOT mutate cloudObjectIdToCloudName here.
    // That map is used to resolve ARI/numeric tokens back to a display name.
    // The multimap JSON stores names lowercased; populating the reverse map
    // with lowercased values would silently downcase emit-time display
    // names. Existing sibling-plan entries (which preserve case) are kept.
    log(`  Cloud-Assets multimap loaded: ${entries} names, ${collisions} ambiguous (≥2 objectIds)`);
  }

  // Asset-key enrichment: when sibling-plan maps don't have a DC CI key
  // (because no migrated issue ever referenced it), the rewriter falls
  // back to passing the bare CI through. The enrichment file
  // logs/dc_asset_key_enrichment.json (built by main/enrich_dc_maps.js)
  // closes that gap with DC-Insight-derived (key → cloudName, cloudObjectId)
  // pairs. Merged here so subsequent passes see the keys as resolvable.
  const enrichPath = require("path").resolve(__dirname, "../logs/dc_asset_key_enrichment.json");
  if (fs.existsSync(enrichPath)) {
    try {
      const e = JSON.parse(fs.readFileSync(enrichPath, "utf8"));
      let n = 0;
      for (const [k, name] of Object.entries(e.dcKeyToCloudName || {})) {
        if (!am.dcKeyToCloudName.has(k)) { am.dcKeyToCloudName.set(k, name); n++; }
      }
      for (const [k, id] of Object.entries(e.dcKeyToCloudObjectId || {})) {
        if (!am.dcKeyToCloudObjectId.has(k)) am.dcKeyToCloudObjectId.set(k, id);
      }
      log(`  Asset-key enrichment: merged ${n} new DC keys (from ${enrichPath})`);
    } catch (err) {
      log(`  ⚠  Could not read asset-key enrichment: ${err.message}`);
    }
  }

  // Type-aware override: the typed map (built by main/enrich_typed_asset_map.js)
  // re-resolves each DC asset key from primary sources, constrained by object
  // TYPE. When type-matching narrows to a single Cloud objectId, we OVERRIDE
  // the sibling-map binding (which was name-only and frequently wrong when
  // DC had multiple objects sharing a name across types). For DC keys with
  // multiple type-compatible Cloud candidates (within-type ambiguity), we
  // store a multi-id list so the rewriter can emit all candidates as ARIs.
  am.dcKeyToCloudObjectIdsMulti = new Map();   // dcKey → string[] (≥2 ids)
  const typedPath = require("path").resolve(__dirname, "../logs/dc_typed_asset_map.json");
  if (fs.existsSync(typedPath)) {
    try {
      const typed = JSON.parse(fs.readFileSync(typedPath, "utf8"));
      const tk = typed.keys || {};
      let overridden = 0, multiCount = 0, kept = 0;
      for (const [dcKey, info] of Object.entries(tk)) {
        if (!info.cloudCandidates || info.cloudCandidates.length === 0) {
          kept++;
          continue;
        }
        if (info.name) am.dcKeyToCloudName.set(dcKey, info.name);
        if (info.cloudCandidates.length === 1) {
          const cid = info.cloudCandidates[0].cloudObjectId;
          const priorId = am.dcKeyToCloudObjectId.get(dcKey);
          if (priorId !== cid) overridden++;
          am.dcKeyToCloudObjectId.set(dcKey, cid);
        } else {
          // Multi-candidate within type. Record all so the rewriter can
          // emit all ARIs when the per-filter rule fires.
          am.dcKeyToCloudObjectIdsMulti.set(
            dcKey,
            info.cloudCandidates.map((c) => c.cloudObjectId),
          );
          // For single-id consumers (e.g. dcKeyToCloudObjectId), pick the
          // first as a sane default. The multi list takes precedence in
          // the rewriter when present.
          am.dcKeyToCloudObjectId.set(dcKey, info.cloudCandidates[0].cloudObjectId);
          multiCount++;
        }
      }
      log(
        `  Type-aware map loaded: ${Object.keys(tk).length} DC keys total; ` +
        `${overridden} overrode sibling bindings; ${multiCount} ambiguous within type; ${kept} kept (no candidates).`,
      );
    } catch (err) {
      log(`  ⚠  Could not read typed asset map: ${err.message}`);
    }
  }

  // DC project-ID → key map (built by main/enrich_dc_maps.js). Drives the
  // projectIdRewriter pass — `project = "<dc_id>"` becomes `project = "<key>"`.
  let projectIdToKey = null;
  const projMapPath = require("path").resolve(__dirname, "../logs/dc_project_id_to_key.json");
  if (fs.existsSync(projMapPath)) {
    try {
      projectIdToKey = JSON.parse(fs.readFileSync(projMapPath, "utf8"));
      log(`  DC project map loaded: ${Object.keys(projectIdToKey).length} entries`);
    } catch (err) {
      log(`  ⚠  Could not read DC project map: ${err.message}`);
    }
  }

  // Reconstruct full rewrite pipeline (Phase 1 logic) for one entry.
  // Pass 1 (filter-ID rewrite) uses the entry's own `refs[]` so we don't
  // need the live filter mapper.
  function reapplyPasses(originalJql, refs) {
    let s = originalJql;
    // Pass 1: filter ID rewrite using cached refs[]
    const dcToCloudFilterMap = new Map();
    for (const r of refs || []) {
      if (r && r.kind === "filter" && r.resolution === "ok" && r.dcId && r.cloudId) {
        dcToCloudFilterMap.set(String(r.dcId), String(r.cloudId));
      }
    }
    if (dcToCloudFilterMap.size > 0) {
      s = rewriteJql(s, dcToCloudFilterMap).rewritten;
    }
    // Pass 2: aqlFunction body rewrite
    s = rewriteAqlFunctionBodies(s, (b) => rewriteAql(b, am)).rewritten;
    // Pass 2b: direct asset-field rewrite (+ collision-aware ARI emission
    // when cloudNameToCloudObjectIds + workspaceId are available).
    const aR = rewriteAssetFieldRefs(s, {
      assetFieldNames: fm.cloudAssetFieldNames,
      dcKeyToCloudName: am.dcKeyToCloudName,
      dcObjectIdToCloudName: am.dcObjectIdToCloudName,
      cloudObjectIdToCloudName: am.cloudObjectIdToCloudName,
      cloudKeyToCloudName: am.cloudKeyToCloudName,
      dcKeyToCloudObjectId: am.dcKeyToCloudObjectId,
      dcKeyToCloudObjectIdsMulti: am.dcKeyToCloudObjectIdsMulti,
      dcObjectIdToCloudObjectId: am.dcObjectIdToCloudObjectId,
      cloudKeyToCloudObjectId: am.cloudKeyToCloudObjectId,
      cloudNameToCloudObjectIds: am.cloudNameToCloudObjectIds,
      workspaceId,
    });
    s = aR.rewritten;
    // Pass 2c: traffic-light .Label + value strip
    const tR = rewriteTrafficLightFields(s, {
      trafficLightFieldNames: fm.cloudTrafficLightFieldNames,
    });
    s = tR.rewritten;
    // Pass 3: sanitize (operator casing + IN-list quoting + cf[N]/customfield_N remap)
    const sR = sanitizeJql(s, {
      cfMap: Object.fromEntries(fm.dcIdToCloudId.entries()),
    });
    s = sR.sanitized;
    // Pass 3b: ORDER BY clean for asset fields
    const oR = cleanOrderBy(s, { assetFieldNames: fm.cloudAssetFieldNames });
    s = oR.rewritten;
    // Pass 4: DC numeric project ID → key. Only runs when the project map
    // is loaded (built by main/enrich_dc_maps.js).
    let projectIdReps = [], projectIdUnresolved = [];
    if (projectIdToKey) {
      const pR = rewriteProjectIds(s, projectIdToKey);
      s = pR.rewritten;
      projectIdReps = pR.replacements || [];
      projectIdUnresolved = pR.unresolved || [];
    }
    return {
      final: s,
      assetFieldReplacements: aR.replacements,
      assetFieldUnresolved: aR.unresolved,
      ariCollisions: aR.ariCollisions || [],
      trafficLightChanges: tR.replacements,
      orderByStripped: oR.stripped,
      sanitizerChanges: sR.changes,
      projectIdReplacements: projectIdReps,
      projectIdUnresolved,
    };
  }

  const pm = new PlanManager(path.resolve(__dirname, "../logs"), () => {});
  const plan = await pm.loadPlan(planFile);
  if (!plan) { console.error("load failed"); process.exit(1); }

  const backup = planFile.replace(/\.json$/, ".prerebuild.json");
  fs.copyFileSync(planFile, backup);
  log(`Backup saved: ${backup}`);

  const stats = {
    total: 0,
    rebuilt: 0,
    nowNoChange: 0,
    untouched: 0,
    flipFromCompleted: 0,
    flipFromFailed: 0,
    flipFromSkipped: 0,
    flipFromNoChange: 0,
    flipFromPending: 0,
    ariCollisionsClauses: 0,
    ariCollisionsFilters: 0,
    usedDcOriginal: 0,
    usedOriginal: 0,
    dcOriginalDiffersFromOriginal: 0,
  };

  if (USE_DC_ORIGINAL) {
    log("  --use-dc-original: preferring entry.dcOriginalJql as rewrite source where populated");
  }

  for (const [, e] of Object.entries(plan.filters)) {
    stats.total++;
    // Pick the source JQL. Without --use-dc-original or when dcOriginalJql is
    // empty/missing, fall back to originalJql (legacy behavior).
    const dcOrig = e.dcOriginalJql;
    const useDc = USE_DC_ORIGINAL && typeof dcOrig === "string" && dcOrig.length > 0;
    const orig = useDc ? dcOrig : (e.originalJql || "");
    if (useDc) {
      stats.usedDcOriginal++;
      if (dcOrig !== (e.originalJql || "")) {
        stats.dcOriginalDiffersFromOriginal++;
      }
    } else if (orig) {
      stats.usedOriginal++;
    }
    if (!orig) { stats.untouched++; continue; }

    const r = reapplyPasses(orig, e.refs || []);
    const fresh = r.final;
    const prior = e.rewrittenJql || "";

    // If the fresh rewrite is byte-identical to what's already stored, leave
    // the entry exactly as it is. Nothing to gain by touching status.
    if (fresh === prior) {
      stats.untouched++;
      continue;
    }

    // The fresh rewrite differs from the prior stored value. Replace it and
    // reset execution state so the next execute-only will retry with the
    // fresh JQL.
    //
    // expectedLiveJql is the manual-edit anchor used by --avoid-overwrite.
    // Set it explicitly here from prior state — DON'T preserve a stale or
    // empty value from prior refreshes, that causes false-positive
    // externally_modified skips at execute time:
    //
    //   • status==="completed" AND jqlUpdated===true  → we previously PUT
    //     this filter; Cloud holds prior rewrittenJql (the PRE-rebuild
    //     value `prior`). expectedLiveJql = prior.
    //   • Otherwise                                    → we never PUT this
    //     filter; Cloud still holds originalJql. expectedLiveJql = original.
    const priorStatus = e.status || "pending";
    if (priorStatus === "completed") stats.flipFromCompleted++;
    else if (priorStatus === "failed") stats.flipFromFailed++;
    else if (priorStatus === "skipped") stats.flipFromSkipped++;
    else if (priorStatus === "no_change") stats.flipFromNoChange++;
    else stats.flipFromPending++;

    // expectedLiveJql semantics: this is the manual-edit anchor used by
    // --avoid-overwrite. It records what Cloud holds RIGHT NOW from our
    // perspective. Preserve it across rebuilds — if it was set by a prior
    // backfill or by a successful PUT from a previous run, that's the most
    // accurate value we have. Only set it if it's missing/empty.
    if (!e.expectedLiveJql || String(e.expectedLiveJql).trim().length === 0) {
      const priorPut = priorStatus === "completed" && e.jqlUpdated === true;
      e.expectedLiveJql = priorPut ? prior : orig;
    }

    e.rewrittenJql = fresh;
    if (fresh === orig) {
      // Fresh pipeline says nothing to rewrite — mark no_change.
      e.status = "no_change";
      stats.nowNoChange++;
    } else {
      e.status = "pending";
    }
    e.jqlUpdated = false;
    e.permissionsAdded = false;
    e.ownerSwapped = false;
    e.ownerRestored = false;
    e.executionPhase = "idle";
    e.lastStepError = null;
    e.error = null;
    e.updatedAt = null;
    e.sharePermissionPosted = false;
    e.sharePermissionPostError = null;
    e.sharePermissionPostSkippedReason = null;
    // Replace per-pass change records with the fresh ones (audit trail).
    e.assetFieldReplacements = r.assetFieldReplacements;
    e.assetFieldUnresolved = r.assetFieldUnresolved;
    e.ariCollisions = r.ariCollisions;
    e.trafficLightChanges = r.trafficLightChanges;
    e.orderByStripped = r.orderByStripped;
    e.sanitizerChanges = r.sanitizerChanges;
    e.projectIdReplacements = r.projectIdReplacements;
    e.projectIdUnresolved = r.projectIdUnresolved;
    if (r.ariCollisions && r.ariCollisions.length > 0) {
      stats.ariCollisionsClauses += r.ariCollisions.length;
      stats.ariCollisionsFilters++;
    }
    if (r.projectIdReplacements && r.projectIdReplacements.length > 0) {
      stats.projectIdRewrites = (stats.projectIdRewrites || 0) + r.projectIdReplacements.length;
      stats.filtersWithProjectIdRewrites = (stats.filtersWithProjectIdRewrites || 0) + 1;
    }
    stats.rebuilt++;
  }

  pm.savePlan();
  log("\nPlan saved (streaming format).\n");
  log("=== rebuild summary ===");
  log(`  total entries:                 ${stats.total}`);
  log(`  rebuilt (rewrittenJql changed): ${stats.rebuilt}`);
  log(`    flipped from completed:      ${stats.flipFromCompleted}`);
  log(`    flipped from failed:         ${stats.flipFromFailed}`);
  log(`    flipped from skipped:        ${stats.flipFromSkipped}`);
  log(`    flipped from no_change:      ${stats.flipFromNoChange}`);
  log(`    flipped from pending:        ${stats.flipFromPending}`);
  log(`  now marked no_change:          ${stats.nowNoChange}`);
  log(`  untouched (rewrite identical): ${stats.untouched}`);
  log(`  ARI-collision rewrites:        ${stats.ariCollisionsClauses} clause(s) across ${stats.ariCollisionsFilters} filter(s)`);
  log(`  Project-ID rewrites:           ${stats.projectIdRewrites || 0} clause(s) across ${stats.filtersWithProjectIdRewrites || 0} filter(s)`);
  log(`  source: used dcOriginalJql:    ${stats.usedDcOriginal} (${stats.dcOriginalDiffersFromOriginal} differ from originalJql)`);
  log(`  source: used originalJql:      ${stats.usedOriginal}`);

  const masterGuess = planFile.replace(/\/plan_/, "/master_");
  log("\nNext step (apply with manual-edit protection):");
  log(`  node main/rewrite_filter_refs.js --execute-only --plan-file ${masterGuess} --avoid-overwrite`);
})().catch((err) => {
  console.error("rebuild failed:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
