#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const CloudJiraClient = require("../src/cloudJiraClient");
const DatacenterClient = require("../src/datacenterClient");
const FilterMapper = require("../src/filterMapper");
const PlanManager = require("../src/planManager");
const ReportWriter = require("../src/reportWriter");
const FilterProcessor = require("../src/filterProcessor");
const { resolveOrgAdminsGroup } = require("../src/permissions");
const { loadAssetMaps } = require("../src/assetMapLoader");
const { buildFieldMap } = require("../src/fieldMapBuilder");
const { buildPriorityMap } = require("../src/priorityMapBuilder");

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function hasFlag(name) {
  return args.includes(name);
}

function getArgValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const DRY_RUN = hasFlag("--dry-run");
const PLAN_ONLY = hasFlag("--plan-only");
const EXECUTE_ONLY = hasFlag("--execute-only") || hasFlag("--resume");
const RETRY_FAILED = hasFlag("--retry-failed");
const SKIP_NOT_OWNED = hasFlag("--skip-not-owned");
const VERIFY_NAME = hasFlag("--verify-name");
// Pre-GET each filter before PUT; if Cloud's current JQL differs from what
// we expect (prior rewrittenJql, or originalJql for never-PUT entries),
// skip rather than overwrite. Implies an extra GET per filter.
const AVOID_OVERWRITE = hasFlag("--avoid-overwrite");
const SAVE_DRY_RUN = hasFlag("--save-dry-run");
const HELP = hasFlag("--help");

const PLAN_FILE = getArgValue("--plan-file");
const LIMIT = parseInt(getArgValue("--limit") || "0", 10) || 0;
const CONCURRENCY = parseInt(getArgValue("--concurrency") || "5", 10) || 5;
const ID_FILE = getArgValue("--id-file");
const NAME_PREFIX = getArgValue("--name-prefix");
const DC_DUMP = getArgValue("--dc-dump");
// NOTE: --collision-resolve is accepted for plan compatibility but not yet wired in.
const COLLISION_RESOLVE = getArgValue("--collision-resolve");

// v2 flags
const NO_OWNER_SWAP = hasFlag("--no-owner-swap");
// Leave each filter owned by the running account instead of restoring the original
// owner. Needed for org-admins shares to PERSIST — Cloud drops an org-admins share
// when the filter's owner is not itself org-admins-capable, so restoring a non-admin
// owner silently reverts the share added during the run.
const NO_OWNER_RESTORE = hasFlag("--no-owner-restore");
const SWAP_ONLY_ON_403 = hasFlag("--swap-only-on-403");
const NO_SHARE_ORG_ADMINS = hasFlag("--no-share-org-admins");
const ORG_ADMINS_GROUP = getArgValue("--org-admins-group") || "org-admins";
const NO_SANITIZE = hasFlag("--no-sanitize");
const NO_UPPERCASE_OPS = hasFlag("--no-uppercase-ops");
const NO_QUOTE_IN_LISTS = hasFlag("--no-quote-in-lists");
const RENAME_FIELDS_PATH = getArgValue("--rename-fields");
const NO_ASSET_REWRITE = hasFlag("--no-asset-rewrite");
const ASSET_PLAN_GLOB =
  getArgValue("--asset-plan-glob") ||
  "../sync_asset_ticket_associations/logs/plan_*.json";
const ASSET_LIVE_FALLBACK = hasFlag("--asset-live-fallback");

// v2.1 post-mortem mitigations
const CF_MAP_PATH = getArgValue("--cf-map");
const STRIP_BROKEN_FUNCTIONS = hasFlag("--strip-broken-functions");
const BROKEN_FUNCTIONS_LIST = getArgValue("--broken-functions"); // optional CSV override
const VALIDATE_PROJECTS = hasFlag("--validate-projects");
const SKIP_MISSING_PROJECTS = hasFlag("--skip-missing-projects"); // implies --validate-projects
const STRIP_MISSING_PROJECTS = hasFlag("--strip-missing-projects"); // implies --validate-projects
// Reactive value-strip retry: equality form is destructive (changes filter
// semantics). The IN-list form runs unconditionally because dropping a
// value Cloud says doesn't exist from a list is safe. The equality form
// (`field = "X"`) requires explicit opt-in.
const STRIP_EQUALITY_MISSES = hasFlag("--strip-equality-misses");

// v2.2: direct asset-field refs, ORDER BY clean, auto-cf-map, traffic-light.
const NO_ASSET_FIELD_REWRITE = hasFlag("--no-asset-field-rewrite");
const NO_ORDER_BY_CLEAN = hasFlag("--no-order-by-clean");
const NO_AUTO_CF_MAP = hasFlag("--no-auto-cf-map");
const AUTO_CF_MAP_CACHE = getArgValue("--auto-cf-map-cache");
const NO_TRAFFIC_LIGHT_LABEL = hasFlag("--no-traffic-light-label");

// v2.3: priority name rewrites. Auto-built from /priority on both sides
// (paired by id); a manual map file can supply overrides.
const NO_PRIORITY_REWRITE = hasFlag("--no-priority-rewrite");
const PRIORITY_MAP_PATH = getArgValue("--priority-map");
const PRIORITY_MAP_CACHE = getArgValue("--priority-map-cache");

if (HELP) {
  console.log(`
Usage: node rewrite_filter_refs.js [options]

Scans all Cloud filters, finds numeric DC-filter references inside their JQL,
and rewrites them with the corresponding Cloud filter IDs (matched by name).

Phases:
  (default)            build plan, then execute (unless --plan-only)
  --plan-only          build plan, do not execute
  --execute-only       (or --resume) load latest plan, skip build, execute
  --dry-run            preview only; no PUTs

Options:
  --plan-file <path>        Explicit master index JSON
  --limit <n>               Cap Cloud filters scanned
  --concurrency <n>         Parallel PUTs (default: 5)
  --id-file <path>          Newline-separated Cloud filter IDs to restrict to
  --name-prefix <s>         Only filters whose name starts with this
  --retry-failed            Include "failed" entries in execute phase
  --dc-dump <file>          Preload DC id->name map (JSON or CSV)
  --collision-resolve <csv> Manual dcId,cloudId overrides (TODO)
  --skip-not-owned          Skip filters not owned by current account
  --verify-name             Re-GET filter before PUT; skip if JQL changed
                            since plan capture (compares vs originalJql).
  --avoid-overwrite         Re-GET filter before PUT; compare Cloud's current
                            JQL against expectedLiveJql (what we last PUT, or
                            originalJql if never PUT). On mismatch, skip the
                            filter (status=skipped:externally_modified) to
                            avoid clobbering manual edits. Adds 1 GET/filter.
  --save-dry-run            Persist plan even during --dry-run
  --help                    Show this help

Owner-swap & permissions (v2, default ON):
  --no-owner-swap           Do not swap filter owner during execute
  --no-owner-restore        Leave each filter owned by the RUNNING account instead
                            of restoring the original owner. REQUIRED for org-admins
                            shares to persist: Cloud drops an org-admins share when
                            the filter's owner is not org-admins-capable, so
                            restoring a non-admin owner silently reverts the share.
                            Trade-off: filters end owned by the migration account.
  --swap-only-on-403        Swap only after a 403 on the first PUT attempt
  --no-share-org-admins     Do not add org-admins group to share + edit perms
  --org-admins-group <name> Override group name (default: org-admins)

JQL sanitizer (v2, default ON):
  --no-sanitize             Disable the sanitizer pass entirely
  --no-uppercase-ops        Keep operators as-is (e.g. leave "not in")
  --no-quote-in-lists       Leave unquoted IN-list tokens alone
  --rename-fields <path>    Extra field renames (CSV "from,to" or JSON map).
                            Merged with built-in Customer Request Type → Request Type.

Asset rewrites inside aqlFunction("…") (v2, default ON):
  --no-asset-rewrite        Skip asset ID rewriting in JQL
  --asset-plan-glob <p>     Glob for DC→Cloud asset map preload
                            (default: ../sync_asset_ticket_associations/logs/plan_*.json)
  --asset-live-fallback     On a DC-key miss, query Cloud Assets API by name
                            (requires CLOUD_WORKSPACE_ID in .env)

Direct Asset-field references + ORDER BY clean (v2.2, default ON):
  --no-asset-field-rewrite  Skip rewriting direct asset-field refs outside
                            aqlFunction (e.g. "Development Team" = 14032 →
                            "Development Team" = "Platform Squad").
  --no-order-by-clean       Skip stripping ORDER BY clauses on Asset fields
                            (Cloud doesn't support sorting on Asset fields).

Forge traffic-light fields (v2.2, default ON):
  --no-traffic-light-label  Skip appending .Label to value-comparison clauses
                            on Forge traffic-light fields (e.g. Internal
                            Priority). Without .Label these clauses parse on
                            Cloud but return 0 rows because the field stores
                            {shape, label} as an object.

Priority name rewrites (v2.3, default ON):
  --no-priority-rewrite     Skip the priority-value rewrite pass. By default
                            we GET /rest/api/3/priority (Cloud) and
                            /rest/api/2/priority (DC), pair by id, and rewrite
                            JQL like  priority = High  →  priority = "P1 - High"
                            when the Cloud name has changed since DC.
  --priority-map <path>     Manual DC-name → Cloud-name override. CSV
                            ("dc_name,cloud_name") or JSON ({"DC":"Cloud"}).
                            Merged on top of the auto-built map; manual wins.
  --priority-map-cache <p>  Write the merged DC→Cloud priority name map here
                            (default: logs/priority_map_cache_<runId>.json).

Auto-built DC→Cloud custom-field map (v2.2, default ON):
  --no-auto-cf-map          Skip live /field fetch from DC + Cloud. The script
                            won't auto-build a DC→Cloud customfield_N map;
                            only the manual --cf-map (if provided) is used.
  --auto-cf-map-cache <p>   Write the auto-built map to this JSON path for
                            later reuse (default: logs/field_map_cache_<runId>.json).

Post-mortem mitigations (v2.1, all OFF by default — opt in):
  --cf-map <path>           CSV (dc_id,cloud_id) or JSON {dc:cloud} map of
                            custom-field IDs. Rewrites cf[NNN] in JQL.
  --strip-broken-functions  Remove DC-only / ScriptRunner JQL functions
                            (subtask, parent, subtasksOf, hasSubtasks,
                            versionsAfterDate, issuesWhereEpicIn,
                            linkedIssuesInProject, linkedIssuesOf, epicsOf,
                            issueFunction, …) from JQL with the adjacent
                            field+operator and one AND/OR connector. ALSO
                            recognises the JQL Tricks "issueFunction <op>
                            <fn>(...)" *field-form* construct (where
                            issueFunction is the FIELD, not the function).
                            DESTRUCTIVE — changes filter semantics. Logged
                            to stripped_functions_<runId>.csv. Cross-checked
                            against the canonical Cloud JQL function reference
                            so Cloud-valid names (parentEpic, cascadeOption,
                            membersOf, currentUser, now, etc.) are NEVER
                            stripped.
  --broken-functions <csv>  Override the function list, e.g.
                            "subtask,parent" (lowercase, comma-separated).
                            Note: the issueFunction-as-field path runs
                            regardless of this override (the override is
                            about function names, not field names).
  --validate-projects       Pre-load Cloud project keys/names; record any
                            project references in JQL not found on Cloud.
  --skip-missing-projects   Implies --validate-projects. If a filter references
                            a missing project in equality form (or all entries
                            of an IN list are missing), mark it skipped:project_missing
                            instead of attempting a PUT.
  --strip-missing-projects  Implies --validate-projects. Drop missing tokens
                            from "project IN (...)" lists. If list ends up
                            empty, fall back to skipped.
  --strip-equality-misses   On a 400 saying "value 'X' does not exist for the
                            field 'Y'" where the offending clause is equality
                            form (Y = "X"), drop the WHOLE clause + one
                            adjacent AND/OR connector and retry the PUT.
                            DESTRUCTIVE — changes filter semantics. Default OFF.
                            (The non-equality IN-list form is auto-stripped
                            without this flag because dropping a value Cloud
                            says doesn't exist from a list is safe.)

Environment (.env):
  CLOUD_BASE_URL, CLOUD_API_TOKEN         Cloud (token = base64 of email:api_token)
  CLOUD_WORKSPACE_ID                      Assets workspace UUID (for --asset-live-fallback)
  DC_BASE_URL, DC_USERNAME, DC_PASSWORD   Data Center (optional; degrade gracefully)
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
const logsDir = path.resolve(__dirname, "../logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const logFile = path.join(logsDir, `rewrite_${Date.now()}.log`);

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(message);
  try {
    fs.appendFileSync(logFile, line + "\n");
  } catch {
    /* ignore log write failures */
  }
}

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------
const requiredAlways = ["CLOUD_BASE_URL", "CLOUD_API_TOKEN"];
const missing = requiredAlways.filter((k) => !process.env[k]);
if (missing.length) {
  log(`ERROR: Missing required env vars: ${missing.join(", ")}`);
  log("Copy .env.example to .env and fill in values.");
  process.exit(1);
}

// DC is only required when we need to resolve DC filter IDs we don't have preloaded.
// We defer that decision until runtime — if buildPlan needs DC and it's not configured,
// it will gracefully degrade to cloud_not_found/dc_deleted entries.

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const startTime = Date.now();
  const runId = String(startTime);

  log("============================================================");
  log("Rewrite DC Filter-ID References in Cloud Filter JQL");
  log("============================================================");
  log(`  Cloud:  ${process.env.CLOUD_BASE_URL}`);
  log(`  DC:     ${process.env.DC_BASE_URL || "(not configured)"}`);
  log(`  Mode:   ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  if (PLAN_ONLY) log("  Phase:  PLAN ONLY");
  if (EXECUTE_ONLY) log("  Phase:  EXECUTE ONLY (resume)");
  if (LIMIT > 0) log(`  Limit:  ${LIMIT}`);
  if (ID_FILE) log(`  IdFile: ${ID_FILE}`);
  if (NAME_PREFIX) log(`  NamePrefix: ${NAME_PREFIX}`);
  if (DC_DUMP) log(`  DcDump: ${DC_DUMP}`);
  if (COLLISION_RESOLVE) log(`  CollisionResolve: ${COLLISION_RESOLVE}`);
  log(`  Concurrency: ${CONCURRENCY}`);
  log("");

  // ── Clients ──
  const cloudClient = new CloudJiraClient(
    process.env.CLOUD_BASE_URL,
    process.env.CLOUD_API_TOKEN,
    log
  );

  let dcClient = null;
  if (
    process.env.DC_BASE_URL &&
    process.env.DC_USERNAME &&
    process.env.DC_PASSWORD
  ) {
    dcClient = new DatacenterClient(
      process.env.DC_BASE_URL,
      process.env.DC_USERNAME,
      process.env.DC_PASSWORD,
      log
    );
  } else if (!DC_DUMP) {
    log(
      "  WARNING: DC env vars not set and no --dc-dump provided. DC ref resolution will degrade."
    );
  }

  // ── Step 0: Connectivity ──
  log("Step 0: Testing connectivity...");
  try {
    const info = await cloudClient.testConnection();
    log(`  Cloud: OK (${info.serverTitle || info.baseUrl || "connected"})`);
  } catch (err) {
    log(`  Cloud: FAILED - ${err.message}`);
    process.exit(1);
  }

  // Always resolve current account — needed for owner-swap and optionally
  // for --skip-not-owned.
  let currentAccountId = null;
  try {
    const me = await cloudClient.getCurrentUser();
    currentAccountId = me.accountId;
    log(
      `  Cloud account: ${me.emailAddress || me.displayName} (${currentAccountId})`
    );
  } catch (err) {
    log(`  Cloud /myself failed: ${err.message}`);
    if (!NO_OWNER_SWAP && !EXECUTE_ONLY) {
      log(
        "  Cannot resolve current account; disabling owner-swap for this run."
      );
    }
  }

  if (dcClient) {
    const ok = await dcClient.testConnection();
    log(`  DC:    ${ok ? "OK" : "FAILED (continuing; DC refs will show as deleted)"}`);
  }

  // ── Shared wiring ──
  const mapper = new FilterMapper({ cloudClient, dcClient, log });
  if (DC_DUMP) {
    mapper.loadDcDump(DC_DUMP);
  }

  const planManager = new PlanManager(logsDir, log);
  const reportWriter = new ReportWriter(logsDir, runId, log);

  // Resolve org-admins group (once, before any writes) so we can fail fast
  // if it doesn't exist on this tenant.
  let orgAdminsGroup = null;
  const wantShare = !NO_SHARE_ORG_ADMINS && !DRY_RUN;
  if (wantShare) {
    try {
      orgAdminsGroup = await resolveOrgAdminsGroup(cloudClient, {
        groupName: ORG_ADMINS_GROUP,
      });
      log(
        `  Org-admins group: "${orgAdminsGroup.name}" (groupId=${orgAdminsGroup.groupId || "n/a"})`,
      );
    } catch (err) {
      log(`  ⚠  ${err.message}`);
      log("  Continuing without permission changes.");
    }
  } else if (!NO_SHARE_ORG_ADMINS && DRY_RUN) {
    // For dry-run, best-effort resolution so we can log the intent.
    try {
      orgAdminsGroup = await resolveOrgAdminsGroup(cloudClient, {
        groupName: ORG_ADMINS_GROUP,
      });
      log(
        `  Org-admins group (dry-run preview): "${orgAdminsGroup.name}" (groupId=${orgAdminsGroup.groupId || "n/a"})`,
      );
    } catch {
      /* tolerate in dry-run */
    }
  }

  // Load field renames from optional file + merge with defaults.
  const extraRenames = {};
  if (RENAME_FIELDS_PATH) {
    try {
      const contents = fs.readFileSync(RENAME_FIELDS_PATH, "utf8").trim();
      if (contents.startsWith("{")) {
        Object.assign(extraRenames, JSON.parse(contents));
      } else {
        // CSV: "from,to" header optional
        const lines = contents.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          if (/^\s*from\s*,\s*to\s*$/i.test(line)) continue;
          const [from, ...rest] = line.split(",");
          const to = rest.join(",");
          if (from && to) extraRenames[from.trim()] = to.trim();
        }
      }
      log(`  Field renames loaded: ${Object.keys(extraRenames).length} extra entries`);
    } catch (err) {
      log(`  ⚠  Could not read --rename-fields ${RENAME_FIELDS_PATH}: ${err.message}`);
    }
  }

  // Load DC→Cloud asset map from sibling plan files.
  let assetMaps = {
    dcKeyToCloudKey: new Map(),
    dcObjectIdToCloudObjectId: new Map(),
  };
  if (!NO_ASSET_REWRITE && !EXECUTE_ONLY) {
    log(`  Loading asset map from ${ASSET_PLAN_GLOB}...`);
    try {
      const loaded = await loadAssetMaps(ASSET_PLAN_GLOB, {
        log,
        cwd: path.resolve(__dirname, ".."),
      });
      assetMaps = loaded;
      log(
        `  Asset map: ${loaded.stats.dcKeysLearned} dc→cloud keys from ${loaded.stats.filesScanned} plan file(s) (${loaded.stats.issuesScanned} issues scanned, ${loaded.stats.collisions} collisions)`
      );
      if (loaded.collisions && loaded.collisions.length > 0) {
        reportWriter.writeAssetCollisions(loaded.collisions);
      }
    } catch (err) {
      log(`  ⚠  Asset map load failed: ${err.message}`);
    }
  }
  if (ASSET_LIVE_FALLBACK && !process.env.CLOUD_WORKSPACE_ID) {
    log(
      "  ⚠  --asset-live-fallback requires CLOUD_WORKSPACE_ID in .env; ignoring."
    );
  }

  // Load cf[N] DC→Cloud map. Two sources, manual file wins on conflict so
  // operators can override the auto-built pairing.
  const cfMap = {};
  let cloudAssetFieldNames = new Set();
  let cloudTrafficLightFieldNames = new Set();

  if (!NO_AUTO_CF_MAP && !EXECUTE_ONLY) {
    try {
      const fm = await buildFieldMap({ dcClient, cloudClient, log });
      // Translate the Map → plain object for sanitizer compatibility.
      for (const [dc, cloud] of fm.dcIdToCloudId.entries()) {
        if (cfMap[dc] === undefined) cfMap[dc] = cloud;
      }
      cloudAssetFieldNames = fm.cloudAssetFieldNames;
      cloudTrafficLightFieldNames = fm.cloudTrafficLightFieldNames || new Set();
      const cachePath =
        AUTO_CF_MAP_CACHE ||
        path.join(logsDir, `field_map_cache_${runId}.json`);
      try {
        const dump = {
          dcIdToCloudId: Object.fromEntries(fm.dcIdToCloudId.entries()),
          cloudAssetFieldNames: Array.from(fm.cloudAssetFieldNames),
          cloudTrafficLightFieldNames: Array.from(cloudTrafficLightFieldNames),
          collisions: fm.collisions,
          stats: fm.stats,
        };
        fs.writeFileSync(cachePath, JSON.stringify(dump, null, 2));
        log(`  Field-map cache written: ${cachePath}`);
      } catch (err) {
        log(`  ⚠  Could not write field-map cache: ${err.message}`);
      }
    } catch (err) {
      log(`  ⚠  Auto-build cf-map failed: ${err.message} — falling back to manual --cf-map only`);
    }
  }

  if (CF_MAP_PATH) {
    try {
      const contents = fs.readFileSync(CF_MAP_PATH, "utf8").trim();
      if (contents.startsWith("{")) {
        Object.assign(cfMap, JSON.parse(contents));
      } else {
        const lines = contents.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          if (/^\s*(?:dc[_ ]?id|from)\s*,/i.test(line)) continue; // header
          const parts = line.split(",");
          if (parts.length >= 2) {
            const dc = String(parts[0]).trim();
            const cloud = String(parts[1]).trim();
            if (dc && cloud) cfMap[dc] = cloud;
          }
        }
      }
      log(
        `  cf[N] map loaded: ${Object.keys(cfMap).length} DC→Cloud entries (after merging manual --cf-map ${CF_MAP_PATH})`,
      );
    } catch (err) {
      log(`  ⚠  Could not read --cf-map ${CF_MAP_PATH}: ${err.message}`);
    }
  }

  // Build the DC → Cloud priority NAME map. Auto-source: GET both
  // /priority endpoints and pair by id (JCMA keeps priority ids stable).
  // Then merge an optional --priority-map override on top — manual entries
  // win on conflict, mirroring the cf-map convention.
  const priorityNameMap = new Map();
  if (!NO_PRIORITY_REWRITE && !EXECUTE_ONLY) {
    try {
      const pm = await buildPriorityMap({ dcClient, cloudClient, log });
      for (const [k, v] of pm.dcNameToCloudName.entries()) {
        priorityNameMap.set(k, v);
      }
      const cachePath =
        PRIORITY_MAP_CACHE ||
        path.join(logsDir, `priority_map_cache_${runId}.json`);
      try {
        const dump = {
          dcNameToCloudName: Object.fromEntries(pm.dcNameToCloudName.entries()),
          dcNameToCloudNameDisplay: Object.fromEntries(
            pm.dcNameToCloudNameDisplay.entries(),
          ),
          collisions: pm.collisions,
          skipped: pm.skipped,
          stats: pm.stats,
        };
        fs.writeFileSync(cachePath, JSON.stringify(dump, null, 2));
        log(`  Priority-map cache written: ${cachePath}`);
      } catch (err) {
        log(`  ⚠  Could not write priority-map cache: ${err.message}`);
      }
    } catch (err) {
      log(`  ⚠  Auto-build priority-map failed: ${err.message} — falling back to manual --priority-map only`);
    }
  }
  if (PRIORITY_MAP_PATH) {
    try {
      // Strip a leading UTF-8 BOM if present — Excel-exported CSVs commonly
      // include one and it would otherwise break the header detection regex.
      const contents = fs
        .readFileSync(PRIORITY_MAP_PATH, "utf8")
        .replace(/^﻿/, "")
        .trim();
      const normalize = (s) =>
        String(s || "").normalize("NFC").trim().toLowerCase();
      if (contents.startsWith("{")) {
        const obj = JSON.parse(contents);
        for (const [dc, cloud] of Object.entries(obj)) {
          if (!dc || !cloud) continue;
          priorityNameMap.set(normalize(dc), String(cloud));
        }
      } else {
        const lines = contents.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          if (/^\s*(?:dc[_ ]?name|from)\s*,/i.test(line)) continue; // header
          const parts = line.split(",");
          if (parts.length >= 2) {
            const dc = String(parts[0]).trim();
            // Cloud name may legitimately contain commas — join the remainder.
            const cloud = parts.slice(1).join(",").trim();
            if (dc && cloud) priorityNameMap.set(normalize(dc), cloud);
          }
        }
      }
      log(
        `  Priority map loaded: ${priorityNameMap.size} DC→Cloud entries (after merging manual --priority-map ${PRIORITY_MAP_PATH})`,
      );
    } catch (err) {
      log(`  ⚠  Could not read --priority-map ${PRIORITY_MAP_PATH}: ${err.message}`);
    }
  }

  // Pre-load Cloud project keys/names if validation is requested.
  let knownProjectsLc = null;
  const wantValidateProjects =
    (VALIDATE_PROJECTS || SKIP_MISSING_PROJECTS || STRIP_MISSING_PROJECTS) &&
    !EXECUTE_ONLY;
  if (wantValidateProjects) {
    try {
      const projects = await cloudClient.getAllProjects();
      const { buildKnownProjectSet } = require("../src/projectValidator");
      knownProjectsLc = buildKnownProjectSet(projects);
      log(
        `  Cloud projects loaded: ${projects.length} (${knownProjectsLc.size} key/name/id tokens)`,
      );
    } catch (err) {
      log(`  ⚠  Could not load Cloud projects: ${err.message}`);
      knownProjectsLc = null;
    }
  }

  const brokenFnList = BROKEN_FUNCTIONS_LIST
    ? BROKEN_FUNCTIONS_LIST.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const processor = new FilterProcessor({
    cloudClient,
    dcClient,
    mapper,
    planManager,
    reportWriter,
    options: {
      dryRun: DRY_RUN,
      limit: LIMIT,
      concurrency: CONCURRENCY,
      retryFailed: RETRY_FAILED,
      idFile: ID_FILE,
      namePrefix: NAME_PREFIX,
      skipNotOwned: SKIP_NOT_OWNED,
      verifyName: VERIFY_NAME,
      avoidOverwrite: AVOID_OVERWRITE,
      currentAccountId,
      ownerSwap: !NO_OWNER_SWAP && !!currentAccountId,
      restoreOwner: !NO_OWNER_RESTORE,
      swapOnlyOn403: SWAP_ONLY_ON_403,
      shareOrgAdmins: !NO_SHARE_ORG_ADMINS && !!orgAdminsGroup,
      orgAdminsGroup,
      rewriteAssets: !NO_ASSET_REWRITE,
      assetMaps,
      sanitize: !NO_SANITIZE,
      sanitizerOptions: {
        fieldRenames: extraRenames,
        uppercaseOperators: !NO_UPPERCASE_OPS,
        quoteInLists: !NO_QUOTE_IN_LISTS,
        cfMap: Object.keys(cfMap).length > 0 ? cfMap : null,
      },
      stripBrokenFunctions: STRIP_BROKEN_FUNCTIONS,
      brokenFunctionList: brokenFnList,
      knownProjectsLc,
      skipMissingProjects:
        SKIP_MISSING_PROJECTS || STRIP_MISSING_PROJECTS,
      stripMissingProjects: STRIP_MISSING_PROJECTS,
      stripEqualityMisses: STRIP_EQUALITY_MISSES,
      // v2.2: asset-field rewrite + ORDER BY clean + traffic-light .Label
      assetFieldRewrite: !NO_ASSET_FIELD_REWRITE,
      orderByClean: !NO_ORDER_BY_CLEAN,
      assetFieldNames: cloudAssetFieldNames,
      trafficLightRewrite: !NO_TRAFFIC_LIGHT_LABEL,
      trafficLightFieldNames: cloudTrafficLightFieldNames,
      // v2.3: priority name rewrites
      priorityRewrite: !NO_PRIORITY_REWRITE,
      priorityNameMap,
    },
    log,
  });

  // Register for SIGINT/SIGTERM — save plan progress before exiting.
  installSignalHandlers(planManager, log);

  // ── Phase selection ──
  if (EXECUTE_ONLY) {
    log("\nPhase 2: Execute plan (skipping build)...");
    const master = planManager.loadMasterIndex(PLAN_FILE);
    if (!master) {
      log("  No plan to resume. Exiting.");
      process.exit(1);
    }
    const loaded = await planManager.loadPlan(master.planFile);
    if (!loaded) {
      log("  Could not load plan file. Exiting.");
      process.exit(1);
    }
    await processor.executePlan();
  } else {
    log("\nPhase 1: Build plan");
    await processor.buildPlan(runId);

    if (PLAN_ONLY) {
      log("\n--plan-only: stopping before execution.");
    } else {
      log("\nPhase 2: Execute plan");
      await processor.executePlan();
    }
  }

  printReport(processor, cloudClient, dcClient, planManager, startTime);

  if (DRY_RUN && !SAVE_DRY_RUN) {
    log("\n  (dry-run; plan file still written for audit)");
  }
}

function printReport(processor, cloudClient, dcClient, planManager, startTime) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const pStats = processor.getStats();
  const cStats = cloudClient.getStats();
  const dcStats = dcClient ? dcClient.getStats() : { requestCount: 0, errorCount: 0 };

  log("\n============================================================");
  log("FINAL REPORT");
  log("============================================================");
  if (DRY_RUN) log("\n  *** DRY RUN - No changes were made ***");

  log("\n  Filters:");
  log(`    Total scanned:       ${pStats.totalCloudFilters}`);
  log(`    With filter-refs:    ${pStats.filtersWithRefs}`);
  log(`    Without refs:        ${pStats.filtersNoRefs}`);

  log("\n  References:");
  log(`    Total:               ${pStats.refsTotal}`);
  log(`    Resolved OK:         ${pStats.refsResolvedOk}`);
  log(`    DC deleted:          ${pStats.refsDcDeleted}`);
  log(`    Cloud not found:     ${pStats.refsCloudNotFound}`);
  log(`    Cloud collision:     ${pStats.refsCollision}`);

  log("\n  Rewrites:");
  log(
    `    ${DRY_RUN ? "Would update" : "Updated"}:        ${pStats.filtersUpdated}`
  );
  log(`    Failed:              ${pStats.filtersFailed}`);
  log(`    Asset rewrites (aqlFunction):   ${pStats.aqlRewrites}`);
  log(`    Asset-field rewrites (direct):  ${pStats.assetFieldRewrites || 0}  (${pStats.filtersWithAssetFieldRewrites || 0} filter(s))`);
  log(`    Traffic-light .Label appended:  ${pStats.trafficLightLabelAppended || 0}  (${pStats.filtersWithTrafficLightLabel || 0} filter(s))`);
  log(`    Priority name rewrites:         ${pStats.priorityRewrites || 0}  (${pStats.filtersWithPriorityRewrites || 0} filter(s))`);
  log(`    Sanitizer edits:     ${pStats.sanitizerHits}`);
  log(`    ORDER BY stripped (asset fields): ${pStats.orderByStrippedTotal || 0}  (${pStats.filtersWithOrderByStripped || 0} filter(s))`);

  log(`    Skipped (externally modified, --avoid-overwrite): ${pStats.skippedExternallyModified || 0}`);

  log("\n  Owner-swap / Permissions:");
  log(`    Owner swap failures:   ${pStats.ownerSwapFailures}`);
  log(`    Owner restore failures:${pStats.ownerRestoreFailures}`);
  log(`    Share-permission POST added (verified persisted): ${pStats.sharePermissionsAdded || 0}`);
  log(`    Share-permission POST failures: ${pStats.sharePermissionAddFailures || 0}`);
  if ((pStats.sharePermissionAddFailures || 0) > 0) {
    log(
      `      ⚠  org-admins shares that don't persist are almost always because the filter's`,
    );
    log(
      `         (restored) owner is not org-admins-capable — Cloud reverts the share. Re-run`,
    );
    log(
      `         with --no-owner-restore to leave filters owned by this admin account so the`,
    );
    log(
      `         share sticks, or ensure the running account can share with any group already`,
    );
    log(
      `         on the filter (e.g. it was just added to a group → wait for membership to propagate).`,
    );
  }
  log(`    Permissions failures:  ${pStats.permissionsFailures}`);
  log(`    Share entries dropped: ${pStats.shareEntriesDropped}`);
  log(`    Denied-group retries:  ${pStats.deniedGroupRetries} (${pStats.deniedGroupRetrySuccesses} succeeded)`);
  if (pStats.ownerRestoreFailures > 0) {
    log(
      `    ⚠  ${pStats.ownerRestoreFailures} filter(s) still owned by the migration user — see orphaned_owner_swaps_*.csv`
    );
  }

  log("\n  Post-mortem mitigations:");
  log(`    cf[N] remaps:                ${pStats.cfRemaps}`);
  log(`    Filters with broken fns:     ${pStats.filtersWithBrokenFunctions} (${pStats.brokenFunctionsStripped} calls stripped)`);
  log(`    Filters w/ missing projects: ${pStats.filtersWithMissingProjects}`);
  log(`    Missing project tokens stripped from IN: ${pStats.missingProjectTokensStripped}`);
  log(`    Filters skipped (project missing):       ${pStats.filtersSkippedMissingProject}`);
  log(`    Reactive value-strip retries: ${pStats.valueStripRetries || 0} (${pStats.valueStripRetrySuccesses || 0} succeeded, ${pStats.valueStripDroppedTotal || 0} values dropped from IN-lists, ${pStats.valueStripEqualityStripped || 0} equality clauses dropped, ${pStats.valueStripEqualityBlocked || 0} blocked by equality form)`);

  log("\n  API Statistics:");
  log(
    `    Cloud: ${cStats.requestCount} req (${cStats.errorCount} err, ${cStats.rateLimitCount} rate-lim)`
  );
  log(`    DC:    ${dcStats.requestCount} req (${dcStats.errorCount} err)`);

  const summary = planManager.getPlanSummary();
  if (summary) {
    log("\n  Plan file:");
    if (summary.masterFile) log(`    Master: ${summary.masterFile}`);
    if (summary.planFile) log(`    Plan:   ${summary.planFile}`);
  }

  log(`\n  Log file:      ${logFile}`);
  log(`  Elapsed time:  ${elapsed}s`);
  log("============================================================\n");
}

// ---------------------------------------------------------------------------
// Signal handling — persist plan before exit
// ---------------------------------------------------------------------------
let shuttingDown = false;
function installSignalHandlers(planManager, log) {
  const handle = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\nReceived ${signal}, saving plan and shutting down...`);
    try {
      planManager.savePlan();
      planManager.saveMasterIndex();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
main().catch((err) => {
  log(`\nFATAL ERROR: ${err.message}`);
  log(err.stack);
  process.exit(1);
});
