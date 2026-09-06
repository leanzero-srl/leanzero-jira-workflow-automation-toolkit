#!/usr/bin/env node
// Fetch the original DC JQL for each plan entry and store it as
// `dcOriginalJql`. For filters the caller (DC_USERNAME) can't view directly
// (most owned-by-others filters), uses the admin owner-swap dance:
//   PUT /filter/{id}/owner → swap to caller
//   GET /filter/{id}       → read JQL
//   PUT /filter/{id}/owner → restore original
//
// Why we need this: the plan's `originalJql` is the JCMA-migrated form Cloud
// holds, not the DC source. JCMA can flatten same-named-but-distinct asset
// objects in IN-lists into a single value, losing information the collision-
// aware rewriter needs. The DC source is the only source of truth.
//
// Safety:
//   • Dry-run is the default. Pass --live to actually mutate DC.
//   • Per-filter state machine (dcFetchPhase) is resumable across runs.
//   • SIGINT/SIGTERM trigger an orderly restore-then-save before exit.
//   • Owner-restore failures are logged to dc_orphan_swaps_<runId>.csv so a
//     subsequent run can sweep them.
//   • Concurrency defaults to 1 to keep state-machine reasoning simple under
//     the assumption that a DC outage / rate-limit may occur mid-run.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const DatacenterClient = require("../src/datacenterClient");
const PlanManager = require("../src/planManager");

const args = process.argv.slice(2);
function hasFlag(n) { return args.includes(n); }
function getArg(n) {
  const i = args.indexOf(n);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

const HELP = hasFlag("--help");
const LIVE = hasFlag("--live");
const FORCE = hasFlag("--force");
const PLAN_FILE = getArg("--plan-file");
const ID_FILE = getArg("--id-file");
const LIMIT = parseInt(getArg("--limit") || "0", 10) || 0;
const CONCURRENCY = parseInt(getArg("--concurrency") || "1", 10) || 1;
const SAVE_EVERY = parseInt(getArg("--save-every") || "25", 10) || 25;
// --from-csv: ingest dcOriginalJql from a pre-exported CSV (e.g. a Postgres
// dump of `searchrequest` joined to `cwd_user`). Bypasses the DC REST/JSP
// path entirely. Match key is (lower(filter_name), lower(owner_display_name)).
const FROM_CSV = getArg("--from-csv");

if (HELP) {
  console.log(`
Usage: node main/fetch_dc_originals.js [options]

Reads each plan entry's DC original JQL and stores it as plan.filters[id].dcOriginalJql.
For filters the DC_USERNAME caller can't view, performs the admin owner-swap dance.

Options:
  --live              Actually mutate DC (PUT /filter/{id}/owner).
                      DEFAULT IS DRY-RUN — no DC writes.
  --plan-file <path>  Explicit plan file (otherwise: latest plan_*.json in logs/).
  --id-file <path>    Newline-separated Cloud filter IDs to restrict to.
  --force             Re-fetch even entries that already have dcOriginalJql.
  --limit <n>         Cap the number of plan entries processed.
  --concurrency <n>   Parallel workers (default 1).
  --save-every <n>    Save plan to disk every N processed entries (default 25).
  --from-csv <path>   Ingest dcOriginalJql from a pre-exported CSV instead
                      of hitting DC. The CSV must have columns:
                        dc_filter_id, filter_name, owner_user_key,
                        owner_username, owner_display_name, owner_email,
                        description, jql, favourite_count
                      Plan entries are matched by
                        (lower(filter_name), lower(owner_display_name))
                      Ambiguous and missing matches are logged to CSV.
                      NO DC connectivity required.
  --help              Show this help.

Per-entry state (dcFetchPhase):
  idle → swapping → fetching → restoring → done | failed
  Resume picks up wherever it left off. SIGINT/SIGTERM tries to restore
  ownership for any entry currently in swapping/fetching/restoring before
  exiting and saving the plan.
`);
  process.exit(0);
}

const logsDir = path.resolve(__dirname, "../logs");
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const runId = String(Date.now());
const logFile = path.join(logsDir, `fetch_dc_originals_${runId}.log`);
const orphanCsvFile = path.join(logsDir, `dc_orphan_swaps_${runId}.csv`);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  try { fs.appendFileSync(logFile, line + "\n"); } catch { /* ignore */ }
}

function appendOrphan(row) {
  const exists = fs.existsSync(orphanCsvFile);
  if (!exists) {
    fs.writeFileSync(orphanCsvFile, "cloudId,name,originalOwnerKey,error\n");
  }
  fs.appendFileSync(orphanCsvFile, row + "\n");
}

function csvCell(s) {
  if (s == null) return "";
  const str = String(s).replace(/"/g, '""');
  return /[",\n]/.test(str) ? `"${str}"` : str;
}

// DC env is only required when we're hitting the DC REST/JSP path. The
// --from-csv mode operates entirely on a local CSV plus the plan file.
const requiredEnv = FROM_CSV ? [] : ["CLOUD_BASE_URL", "DC_BASE_URL", "DC_USERNAME", "DC_PASSWORD"];
const missing = requiredEnv.filter((k) => !process.env[k]);
if (missing.length) {
  log(`ERROR: Missing required env vars: ${missing.join(", ")}`);
  process.exit(1);
}

// Streaming-ish CSV parser. Handles quoted fields with embedded quotes,
// commas, and newlines. Returns Array<Array<string>>.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cell += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
      else if (c !== "\r") cell += c;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Normalize an owner displayName for cross-tenant matching. DC sometimes
// suffixes deactivated/migrated users with a tag like " [X]" or
// " [Assignee/Reporter]"; Cloud's displayName has no such suffix. Strip it
// before lowercasing so the match key works either side.
function normalizeOwnerDisplay(s) {
  if (s == null) return "";
  return String(s)
    .replace(/\s*\[[^\]]+\]\s*$/, "")  // drop trailing [X] / [tag] markers
    .trim()
    .toLowerCase();
}

// Ingest dcOriginalJql values from a CSV exported from the DC database.
// Returns stats. Mutates `plan.filters[id]` in place — caller saves.
function ingestFromCsv(plan, csvPath) {
  log(`Reading DC CSV: ${csvPath}`);
  const csvText = fs.readFileSync(csvPath, "utf8");
  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    throw new Error(`CSV has no data rows (${rows.length} total lines)`);
  }
  const header = rows[0].map((h) => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const required = ["dc_filter_id", "filter_name", "owner_display_name", "jql"];
  for (const r of required) {
    if (idx[r] === undefined) {
      throw new Error(`CSV missing required column: ${r}. Header was: ${header.join(", ")}`);
    }
  }
  log(`  parsed ${rows.length - 1} DC rows, ${header.length} columns`);

  // Build index keyed by (lower(name), normalize(displayName)). Owner names
  // are normalized to strip DC's deactivated/migrated user tags like " [X]"
  // before lowercasing — Cloud doesn't carry those tags.
  const byNameOwner = new Map();
  for (const r of rows.slice(1)) {
    if (r.length < 2) continue;
    const name = (r[idx.filter_name] || "").trim().toLowerCase();
    const owner = normalizeOwnerDisplay(r[idx.owner_display_name] || "");
    if (!name) continue;
    const k = name + "|" + owner;
    if (!byNameOwner.has(k)) byNameOwner.set(k, []);
    byNameOwner.get(k).push(r);
  }
  log(`  unique (name, owner) keys: ${byNameOwner.size}`);

  const stats = {
    plan: 0,
    matched: 0,
    matchedAmbiguous: 0,
    notFound: 0,
    skippedAlready: 0,
  };

  const ambigCsv = path.join(logsDir, `dc_csv_ambiguous_${runId}.csv`);
  const missingCsv = path.join(logsDir, `dc_csv_missing_${runId}.csv`);
  fs.writeFileSync(ambigCsv, "cloudId,name,ownerDisplayName,dcRowCount,dcIds\n");
  fs.writeFileSync(missingCsv, "cloudId,name,ownerDisplayName,planStatus\n");

  for (const [cloudId, entry] of Object.entries(plan.filters)) {
    stats.plan++;
    if (entry.dcOriginalJql && !FORCE) {
      stats.skippedAlready++;
      continue;
    }
    const name = (entry.name || "").trim().toLowerCase();
    const owner = normalizeOwnerDisplay(
      entry.originalOwner && entry.originalOwner.displayName
        ? entry.originalOwner.displayName
        : "",
    );
    const k = name + "|" + owner;
    const dcRows = byNameOwner.get(k);
    if (!dcRows || dcRows.length === 0) {
      stats.notFound++;
      entry.dcFetchReason = "csv_no_match";
      fs.appendFileSync(missingCsv, csvRow([cloudId, entry.name, entry.originalOwner && entry.originalOwner.displayName, entry.status]));
      continue;
    }
    if (dcRows.length > 1) {
      stats.matchedAmbiguous++;
      entry.dcFetchReason = "csv_ambiguous";
      const dcIds = dcRows.map((r) => r[idx.dc_filter_id]).join("|");
      fs.appendFileSync(ambigCsv, csvRow([cloudId, entry.name, entry.originalOwner && entry.originalOwner.displayName, dcRows.length, dcIds]));
      continue;
    }
    const r = dcRows[0];
    entry.dcOriginalJql = r[idx.jql] || "";
    entry.dcSourceFilterId = r[idx.dc_filter_id];
    entry.dcFetchReason = "csv_match";
    entry.dcFetchPhase = "done";
    entry.lastDcFetchError = null;
    stats.matched++;
  }
  return { stats, ambigCsv, missingCsv };
}

function csvRow(values) {
  return values.map(csvCell).join(",") + "\n";
}

const dcSelfName = process.env.DC_USERNAME; // the caller's DC username — we swap ownership to ourselves to read

// Skip DC client construction in --from-csv mode (no DC connectivity needed).
const dc = FROM_CSV
  ? null
  : new DatacenterClient(
      process.env.DC_BASE_URL,
      process.env.DC_USERNAME,
      process.env.DC_PASSWORD,
      log,
    );

// Resolve a DC user from the Cloud-side displayName. Returns the DC user
// object ({name, key, displayName}) or null. Caches results by displayName.
const userCache = new Map();
async function resolveDcUserByDisplayName(displayName) {
  if (!displayName) return null;
  if (userCache.has(displayName)) return userCache.get(displayName);
  try {
    const list = await dc.makeRequest(
      "GET",
      `/rest/api/2/user/search?username=${encodeURIComponent(displayName)}&maxResults=20`,
    );
    // Prefer an exact displayName match; if there's only one result, accept it.
    const exact = (list || []).find((u) => u.displayName === displayName);
    const u = exact || (list && list.length === 1 ? list[0] : null);
    userCache.set(displayName, u || null);
    return u || null;
  } catch (err) {
    log(`  user search failed for "${displayName}": ${err.statusCode || ""} ${err.message}`);
    userCache.set(displayName, null);
    return null;
  }
}

// Swap filter ownership on DC. On Jira 10.3.6 the REST endpoint
// `PUT /rest/api/2/filter/{id}/owner` returns 404 even for admins, so we use
// the admin JSP form `POST /secure/admin/filters/ChangeSharedFilterOwner.jspa`
// — the same path the admin UI uses.
//
// Flow:
//   1. GET /secure/admin/filters/ChangeSharedFilterOwner!default.jspa?filterId=<id>
//      → extract `atl_token` (CSRF) from the form HTML.
//   2. POST /secure/admin/filters/ChangeSharedFilterOwner.jspa with
//      form-encoded body { owner, filterId, atl_token, ChangeOwner }.
//   3. Success → 302 redirect back to the listing (or 200 if WebSudo'd
//      through inline).
//   4. Failure → either WebSudo intercept (302 to /authenticate.action)
//      or HTML page with error message embedded.
async function setFilterOwner(cloudId, newOwnerName) {
  // Step 1: GET form, extract CSRF token.
  const formPage = await dc.makeFormRequest(
    "GET",
    `/secure/admin/filters/ChangeSharedFilterOwner!default.jspa?filterId=${encodeURIComponent(cloudId)}`,
    null,
  );
  if (formPage.statusCode === 302) {
    const loc = formPage.headers.location || "";
    if (/authenticate/i.test(loc)) {
      const err = new Error(`websudo_required: redirected to ${loc}`);
      err.statusCode = 401;
      throw err;
    }
    const err = new Error(`form_redirect: ${formPage.statusCode} to ${loc}`);
    err.statusCode = formPage.statusCode;
    throw err;
  }
  if (formPage.statusCode !== 200) {
    const err = new Error(`form_get_failed: status ${formPage.statusCode}`);
    err.statusCode = formPage.statusCode;
    throw err;
  }
  const tokenMatch = formPage.body.match(
    /name="atl_token"[^>]+value="([^"]+)"/,
  );
  if (!tokenMatch) {
    const err = new Error(`atl_token_not_found_on_form_page (length=${formPage.body.length})`);
    err.statusCode = 0;
    throw err;
  }
  const atlToken = tokenMatch[1];

  // Step 2: POST form to change owner.
  const post = await dc.makeFormRequest(
    "POST",
    `/secure/admin/filters/ChangeSharedFilterOwner.jspa`,
    {
      owner: newOwnerName,
      filterId: String(cloudId),
      atl_token: atlToken,
      ChangeOwner: "Change owner",
    },
  );
  // Success on this JSP is typically a 302 redirect to ViewSharedFilters.jspa.
  // 200 with an inline error page is the "failed validation" case (e.g.
  // unknown owner, or "owner already same"). Inspect body for known error
  // banners.
  if (post.statusCode === 302) {
    const loc = post.headers.location || "";
    if (/authenticate/i.test(loc)) {
      const err = new Error(`websudo_required_on_submit: ${loc}`);
      err.statusCode = 401;
      throw err;
    }
    // Anything else (most commonly /secure/admin/filters/ViewSharedFilters.jspa)
    // is treated as success.
    return;
  }
  if (post.statusCode === 200) {
    // The JSP may render the form again with an error banner. Look for
    // "errMsg" / "aui-message-error" / explicit error text.
    const errMatch =
      post.body.match(/class="error[^"]*"[^>]*>([^<]+)</i) ||
      post.body.match(/<div[^>]*aui-message-error[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) ||
      post.body.match(/errMsg[^>]*>([^<]+)</i);
    const errText = errMatch ? errMatch[1].trim() : "unknown_jsp_error";
    const err = new Error(`jsp_form_failed: ${errText}`);
    err.statusCode = 200;
    err.responseBody = post.body.slice(0, 500);
    throw err;
  }
  const err = new Error(`jsp_post_unexpected_status: ${post.statusCode}`);
  err.statusCode = post.statusCode;
  throw err;
}

// One-filter state machine. Returns a result object describing what we did.
async function fetchOne(cloudId, entry) {
  // Already have it (and not forcing): skip.
  if (entry.dcOriginalJql && !FORCE) {
    // Defensive: if a prior crash left ownership in our hands, restore now
    // even though dcOriginalJql is already set.
    if (
      entry.dcOriginalOwnerKey &&
      entry.dcFetchPhase &&
      entry.dcFetchPhase !== "done"
    ) {
      if (!LIVE) {
        return { skipped: true, reason: "already_present_dry_run_orphan" };
      }
      try {
        await setFilterOwner(cloudId, entry.dcOriginalOwnerKey);
        entry.dcFetchPhase = "done";
        delete entry.dcOriginalOwnerKey;
        return { skipped: true, reason: "already_present_restored_orphan" };
      } catch (err) {
        return {
          ok: false,
          error: `orphan_restore_failed: ${err.statusCode || ""} ${err.message}`,
          orphan: true,
        };
      }
    }
    return { skipped: true, reason: "already_present" };
  }

  // 0) RESUME GUARD: if a prior run swapped ownership to us but didn't
  //    restore (crash mid-flight), the direct GET below would succeed
  //    silently and we'd lose track of the original owner. Restore FIRST
  //    so the rest of the dance is well-defined.
  if (
    entry.dcOriginalOwnerKey &&
    entry.dcFetchPhase &&
    entry.dcFetchPhase !== "done"
  ) {
    if (!LIVE) {
      return {
        ok: false,
        error: `orphaned_swap_seen_dry_run (phase=${entry.dcFetchPhase}, would_restore_to=${entry.dcOriginalOwnerKey})`,
      };
    }
    try {
      await setFilterOwner(cloudId, entry.dcOriginalOwnerKey);
      // Restored — clear the tracking so we can re-do the cycle fresh.
      delete entry.dcOriginalOwnerKey;
      entry.dcFetchPhase = "idle";
    } catch (err) {
      appendOrphan(
        `${csvCell(cloudId)},${csvCell(entry.name)},${csvCell(entry.dcOriginalOwnerKey)},${csvCell("pre-fetch resume restore: " + err.message)}`,
      );
      return {
        ok: false,
        error: `resume_restore_failed: ${err.statusCode || ""} ${err.message}`,
        orphan: true,
      };
    }
  }

  // 1) Direct GET. If 200, done. If 404, mark as not-found. If 400
  //    (permission denied), proceed to the swap dance.
  try {
    const f = await dc.getFilter(cloudId);
    if (f === null) {
      // 404 from getFilter is normalized to null
      return { ok: true, dcOriginalJql: null, dcFetchReason: "dc_not_found" };
    }
    return { ok: true, dcOriginalJql: f.jql || "", dcFetchReason: "direct_read" };
  } catch (err) {
    if (err.statusCode !== 400) {
      // 401/403/5xx → fail this entry, leave state to retry next run
      return { ok: false, error: `direct_get_failed: ${err.statusCode || ""} ${err.message}` };
    }
    // 400 → permission denied. Continue with swap dance.
  }

  // 2) Resolve the DC user we need to restore ownership to. Use Cloud-side
  //    originalOwner.displayName.
  const ownerDisplay = (entry.originalOwner && entry.originalOwner.displayName) || null;
  if (!ownerDisplay) {
    return { ok: false, error: "no_original_owner_in_plan" };
  }
  const dcOwner = await resolveDcUserByDisplayName(ownerDisplay);
  if (!dcOwner || !dcOwner.name) {
    return { ok: false, error: `dc_owner_resolve_failed: ${ownerDisplay}` };
  }

  // 3) Owner-swap → GET → restore. Track phase on the entry so a crash
  //    halfway through is recoverable.
  if (!LIVE) {
    return {
      ok: true,
      dryRun: true,
      wouldSwapFrom: dcOwner.name,
      dcOriginalJql: null,
      dcFetchReason: "would_swap_dance",
    };
  }

  entry.dcFetchPhase = "swapping";
  entry.dcOriginalOwnerKey = dcOwner.name;
  try {
    await setFilterOwner(cloudId, dcSelfName);
  } catch (err) {
    return {
      ok: false,
      error: `owner_swap_to_self_failed: ${err.statusCode || ""} ${err.message}`,
    };
  }

  entry.dcFetchPhase = "fetching";
  let jql = null;
  let fetchErr = null;
  try {
    const f = await dc.getFilter(cloudId);
    if (f === null) {
      // 404 after swap is bizarre but possible (filter deleted between calls).
      jql = null;
    } else {
      jql = f.jql || "";
    }
  } catch (err) {
    fetchErr = `read_after_swap_failed: ${err.statusCode || ""} ${err.message}`;
  }

  entry.dcFetchPhase = "restoring";
  try {
    await setFilterOwner(cloudId, dcOwner.name);
  } catch (err) {
    // Critical: we own this filter now and couldn't give it back. Log to
    // orphan CSV so the operator can sweep.
    appendOrphan(
      `${csvCell(cloudId)},${csvCell(entry.name)},${csvCell(dcOwner.name)},${csvCell(err.message)}`,
    );
    entry.dcFetchPhase = "failed";
    entry.lastDcFetchError = `owner_restore_failed: ${err.statusCode || ""} ${err.message}`;
    return {
      ok: false,
      error: entry.lastDcFetchError,
      orphan: true,
    };
  }

  if (fetchErr) {
    return { ok: false, error: fetchErr };
  }
  return { ok: true, dcOriginalJql: jql, dcFetchReason: "swap_dance" };
}

let shuttingDown = false;
let pm; // populated in main

async function emergencyRestore(entry) {
  if (!entry || !entry.dcOriginalOwnerKey) return;
  if (
    entry.dcFetchPhase !== "swapping" &&
    entry.dcFetchPhase !== "fetching" &&
    entry.dcFetchPhase !== "restoring"
  ) return;
  try {
    await setFilterOwner(/* cloudId is the entry's own key */ entry.__cloudId, entry.dcOriginalOwnerKey);
    log(`  restored ownership of ${entry.__cloudId} → ${entry.dcOriginalOwnerKey}`);
  } catch (err) {
    log(`  EMERGENCY restore FAILED for ${entry.__cloudId}: ${err.message}`);
    appendOrphan(
      `${csvCell(entry.__cloudId)},${csvCell(entry.name)},${csvCell(entry.dcOriginalOwnerKey)},${csvCell("emergency: " + err.message)}`,
    );
  }
}

function installSigHandlers() {
  const handler = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\nReceived ${sig}, attempting emergency restore + save before exit...`);
    if (pm && pm.plan) {
      for (const [cid, e] of Object.entries(pm.plan.filters)) {
        e.__cloudId = cid;
        await emergencyRestore(e);
        delete e.__cloudId;
      }
      try { pm.savePlan(); } catch { /* ignore */ }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

(async function main() {
  log("============================================================");
  log("Fetch DC originals" + (LIVE ? "  (LIVE)" : "  (DRY RUN)"));
  log("============================================================");
  log(`  DC:      ${process.env.DC_BASE_URL}`);
  log(`  Caller:  ${dcSelfName}`);
  log(`  Plan:    ${PLAN_FILE || "(latest in logs/)"}`);
  log(`  Live:    ${LIVE}`);
  log(`  Force:   ${FORCE}`);
  if (ID_FILE) log(`  IdFile:  ${ID_FILE}`);
  if (LIMIT > 0) log(`  Limit:   ${LIMIT}`);
  log(`  Concur:  ${CONCURRENCY}`);
  log("");

  pm = new PlanManager(logsDir, log);
  // Find latest plan if --plan-file not given. PlanManager has loadPlan
  // taking a planFile; we replicate the "find latest" logic from
  // rebuild_plan_from_original.js.
  let planFile = PLAN_FILE;
  if (!planFile) {
    planFile = fs.readdirSync(logsDir)
      .filter((f) => /^plan_\d+\.json$/.test(f) && !/prerefresh|preorphan|prerebuild|prebackfill/.test(f))
      .map((f) => ({ f, m: fs.statSync(path.join(logsDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .map((e) => path.join(logsDir, e.f))[0];
  } else {
    planFile = path.resolve(planFile);
  }
  if (!planFile || !fs.existsSync(planFile)) {
    log("No plan file found.");
    process.exit(1);
  }
  log(`Loading plan: ${planFile}`);
  const plan = await pm.loadPlan(planFile);
  if (!plan) {
    log("Failed to load plan.");
    process.exit(1);
  }

  // Backup before mutating anything (DC OR plan state).
  // We back up for --from-csv too because it mutates plan.filters[id].dcOriginalJql.
  const backup = planFile.replace(/\.json$/, `.prefetchdc_${runId}.json`);
  fs.copyFileSync(planFile, backup);
  log(`Backup saved: ${backup}`);

  // ─── CSV-mode short-circuit ───
  if (FROM_CSV) {
    log(`--from-csv mode: ingesting from ${FROM_CSV}`);
    const csvAbs = path.isAbsolute(FROM_CSV) ? FROM_CSV : path.resolve(process.cwd(), FROM_CSV);
    if (!fs.existsSync(csvAbs)) {
      log(`ERROR: CSV not found at ${csvAbs}`);
      process.exit(1);
    }
    const { stats, ambigCsv, missingCsv } = ingestFromCsv(plan, csvAbs);
    try { pm.savePlan(); } catch (err) { log(`  save error: ${err.message}`); }
    log("\n=== --from-csv summary ===");
    log(`  plan entries scanned     : ${stats.plan}`);
    log(`  matched 1:1 on (name,owner): ${stats.matched}`);
    log(`  ambiguous (multi-row)    : ${stats.matchedAmbiguous}  (see ${ambigCsv})`);
    log(`  no match in DC CSV       : ${stats.notFound}  (see ${missingCsv})`);
    log(`  already had dcOriginalJql: ${stats.skippedAlready}`);
    log(`  log                      : ${logFile}`);
    return;
  }

  installSigHandlers();

  // Build the work queue.
  let entries = Object.entries(plan.filters);
  if (ID_FILE) {
    const allowed = new Set(
      fs.readFileSync(ID_FILE, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    );
    entries = entries.filter(([cid]) => allowed.has(cid));
  }
  if (LIMIT > 0) entries = entries.slice(0, LIMIT);

  // Quick connectivity check.
  log("Testing DC connectivity...");
  try {
    const ok = await dc.testConnection();
    log(`  DC: ${ok ? "OK" : "FAILED"}`);
    if (!ok) process.exit(1);
  } catch (err) {
    log(`  DC test failed: ${err.message}`);
    process.exit(1);
  }
  // Verify the caller is actually present on DC.
  const me = await dc.makeRequest("GET", `/rest/api/2/user?username=${encodeURIComponent(dcSelfName)}`);
  log(`  Caller resolved: ${me.name} (${me.displayName})`);

  const stats = {
    total: entries.length,
    skippedAlready: 0,
    directReads: 0,
    swapReads: 0,
    notFound: 0,
    wouldSwap: 0,
    failed: 0,
    orphans: 0,
  };

  let processed = 0;
  for (const [cloudId, entry] of entries) {
    if (shuttingDown) break;
    processed++;
    const before = entry.dcOriginalJql;
    const result = await fetchOne(cloudId, entry);
    if (result.skipped) {
      stats.skippedAlready++;
    } else if (result.ok) {
      if (result.dryRun) {
        stats.wouldSwap++;
        log(`  [${cloudId}] WOULD swap (orig owner: ${result.wouldSwapFrom}) — name="${entry.name || ""}"`);
      } else {
        if (result.dcFetchReason === "direct_read") stats.directReads++;
        else if (result.dcFetchReason === "swap_dance") stats.swapReads++;
        else if (result.dcFetchReason === "dc_not_found") stats.notFound++;
        entry.dcOriginalJql = result.dcOriginalJql;
        entry.dcFetchReason = result.dcFetchReason;
        entry.dcFetchPhase = "done";
        entry.lastDcFetchError = null;
        // Clear the tracking field after a successful cycle.
        delete entry.dcOriginalOwnerKey;
      }
    } else {
      stats.failed++;
      if (result.orphan) stats.orphans++;
      entry.dcFetchPhase = entry.dcFetchPhase || "failed";
      entry.lastDcFetchError = result.error;
      log(`  [${cloudId}] FAIL ${result.error}`);
    }

    if (processed % SAVE_EVERY === 0) {
      try { pm.savePlan(); } catch (err) { log(`  save error: ${err.message}`); }
      log(`  progress ${processed}/${entries.length} (direct=${stats.directReads} swap=${stats.swapReads} would=${stats.wouldSwap} 404=${stats.notFound} fail=${stats.failed} orphan=${stats.orphans})`);
    }

    // Belt and braces: if we just changed dcOriginalJql, mark the entry
    // touched so PlanManager flushes it.
    if (before !== entry.dcOriginalJql) {
      // PlanManager's `updateFilterEntry` does an in-place merge; we already
      // mutated `entry` directly which is the same object PlanManager holds.
      // Nothing more to do.
    }
  }

  try { pm.savePlan(); } catch (err) { log(`  final save error: ${err.message}`); }

  log("\n=== summary ===");
  log(`  total considered  : ${stats.total}`);
  log(`  already had it    : ${stats.skippedAlready}`);
  log(`  direct reads      : ${stats.directReads}`);
  log(`  swap-dance reads  : ${stats.swapReads}`);
  log(`  dc not found      : ${stats.notFound}`);
  if (!LIVE) log(`  would swap (DRY)  : ${stats.wouldSwap}`);
  log(`  failed            : ${stats.failed}`);
  log(`  orphans           : ${stats.orphans} (see ${orphanCsvFile})`);
  log(`  log               : ${logFile}`);
})().catch((err) => {
  log(`FATAL: ${err.message}\n${err.stack || ""}`);
  process.exit(1);
});
