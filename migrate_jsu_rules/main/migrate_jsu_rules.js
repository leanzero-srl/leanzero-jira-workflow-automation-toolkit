#!/usr/bin/env node

/**
 * Migrate JSU (Jira Suite Utilities) workflow rules from Jira DC to Jira Cloud.
 *
 * Two-phase design mirroring clone_workflow_rules.js:
 *
 *   --collect  : Read workflows from DC, identify JSU rules, emit inventory
 *                and a human-reviewable conversion plan.
 *
 *   --apply    : Read collected data, convert JSU rules to native Cloud rules
 *                or JMWE equivalents, and update same-named Cloud workflows in
 *                place. --validate-only and --dry-run are supported.
 *
 * See README.md for the full runbook.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const JiraCloudClient = require("../../clone_workflow_rules/src/jiraCloudClient");
const JiraDcClient = require("../src/jiraDcClient");
const JsuCollector = require("../src/jsuCollector");
const JsuApplier = require("../src/jsuApplier");
const JsuCleaner = require("../src/jsuCleaner");
const { Logger, timestampSlug, resolveConfigEnvIndirections } = require("../src/utils");

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    mode: null,
    configPath: null,
    projectKeys: null,
    workflowNames: null,
    allWorkflows: null,
    collectDir: null,
    xmlDir: null,
    validateOnly: false,
    dryRun: false,
    force: false,
    ignoreErrors: false,
    disableJmwe: false,
    // === Fresh-start safety flags ============================================
    // --fresh-start: passed at --collect time to enforce a brand-new
    // collect dir. Refuses to overwrite an existing dir (collect or other)
    // and refuses to use an explicit --collect-dir whose contents look like
    // a prior run. Use this when migrating against a NEW source/target
    // instance pair so yesterday's artifacts can't accidentally leak in.
    freshStart: false,
    // --allow-instance-mismatch: at --apply time, override the safety check
    // that compares the collect dir's stamped instance signature against
    // the currently-configured (DC, Cloud). Use ONLY if you intentionally
    // want to apply an older collect against a different tenant — this is
    // the rope you can hang yourself with.
    allowInstanceMismatch: false,
    // --exclude-projects K1,K2: workflows backing any of these project keys
    // are skipped at --apply time. Resolved via project → workflow scheme →
    // defaultWorkflow + every issuetype mapping.
    excludeProjects: [],
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
      case "-h":
        showHelp();
        process.exit(0);
      case "--collect":
        options.mode = "collect";
        break;
      case "--apply":
        options.mode = "apply";
        break;
      case "--clean":
        options.mode = "clean";
        break;
      case "--config":
        options.configPath = args[++i];
        break;
      case "--project-keys":
        options.projectKeys = (args[++i] || "")
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
        break;
      case "--workflow-names":
        options.workflowNames = (args[++i] || "")
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean);
        break;
      case "--all-workflows":
        options.allWorkflows = true;
        break;
      case "--collect-dir":
        options.collectDir = args[++i];
        break;
      case "--xml-dir":
        options.xmlDir = args[++i];
        break;
      case "--validate-only":
        options.validateOnly = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--ignore-errors":
        options.ignoreErrors = true;
        break;
      case "--disable-jmwe":
        options.disableJmwe = true;
        break;
      case "--fresh-start":
        options.freshStart = true;
        break;
      case "--allow-instance-mismatch":
        options.allowInstanceMismatch = true;
        break;
      case "--exclude-projects":
        options.excludeProjects = (args[++i] || "")
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
        break;
      case "--remove-stale-tagged":
        // Opt-in flag for --clean: also remove rules whose
        // `parameters.tag === "migration-success"` even when the local
        // ledger / payload reconstruction / fingerprint match doesn't
        // recognise them. Useful when an EARLIER apply (pre-ledger or
        // from a different collect-dir) left behind rules that
        // would otherwise survive --clean and produce duplicates against
        // the next --apply.
        options.removeStaleTagged = true;
        break;
      case "--runas-fallback":
        // Cloud accountId to use as the runAs target for rules whose
        // `cfg.runAsUser` couldn't be resolved on Cloud (deactivated DC
        // users, missing accounts, etc.). Without this flag, those rules
        // emit `runAsType: "currentUser"` and surface in the unmapped CSV
        // with reason `unresolved-run-as-user`. With the flag, they emit
        // `runAsType: "specifiedUser"` + the supplied accountId (and stay
        // in the CSV with `run-as-fallback-used` for visibility).
        options.runasFallback = args[++i];
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(2);
    }
  }
  if (!options.mode) {
    console.error("Must specify --collect, --apply, or --clean. Use --help for usage.");
    process.exit(2);
  }
  return options;
}

function showHelp() {
  console.log(`
Migrate JSU workflow rules from Jira DC to Jira Cloud.

USAGE
  node main/migrate_jsu_rules.js --collect [options]
  node main/migrate_jsu_rules.js --apply --collect-dir <path> [options]
  node main/migrate_jsu_rules.js --clean --collect-dir <path> [options]

COLLECT OPTIONS (choose one input source)
  --xml-dir <path>         Read workflows from exported OSWorkflow XML files (RECOMMENDED for DC)
                           Jira DC REST does not expose workflow rule bodies; export each
                           workflow as XML from the admin UI into this folder.
  --project-keys K1,K2     Projects whose DC workflow schemes to resolve (REST only)
  --workflow-names W1,W2   Explicit DC workflow names (REST only)
  --all-workflows          Fetch every DC workflow (REST only)
  --config <path>          Path to config.json (default: ./config.json)
  --fresh-start            Refuse to reuse a non-empty --collect-dir.
                           Use when starting against a new (DC, Cloud) instance pair so
                           yesterday's artifacts can't leak into today's plan. Without
                           --collect-dir, behaves the same as the default (writes to a
                           fresh logs/collected_<ts>/ dir). With --collect-dir <path>,
                           errors out unless that path doesn't exist or is empty.

APPLY OPTIONS
  --collect-dir <path>     Required. The logs/collected_<ts>/ directory from --collect
  --validate-only          POST to /workflows/update/validation; never mutate
  --dry-run                Build payloads, save to disk, don't POST
  --force                  Skip hard-error checks (unmatched transitions, ambiguous)
  --ignore-errors          With --force, lets validation errors through to mutation
  --disable-jmwe           Treat JMWE-strategy rules as manual-review (skip them)
  --workflow-names W1,W2   Process only this subset from the plan
  --allow-instance-mismatch
                           Override the safety check that compares the collect-dir's
                           stamped instance signature (DC + Cloud baseUrl) to the
                           currently-configured pair. By DEFAULT, --apply REFUSES to
                           run against a different tenant pair than the one used to
                           build the collect-dir. Pass this only if you really mean it
                           — e.g. re-running an old collect against a renamed Cloud.
  --exclude-projects K1,K2 Skip every workflow that backs any of these project keys
                           (resolved via Cloud workflow scheme). Recommended on this
                           tenant: --exclude-projects BUILD,SD (manually reviewed).

CLEAN OPTIONS (remove rules WE previously pushed; clean slate for re-experiments)
  --collect-dir <path>     Required. Same collect-dir the apply ran against.
  --dry-run                Build the cleaned payload + report; never POST.
  --workflow-names W1,W2   Clean only this subset from the plan.
  --exclude-projects K1,K2 Same semantics as --apply.
  --force                  Skip pre-flight validation errors (only push the
                           cleaned envelope anyway).
  --allow-instance-mismatch
                           Same semantics as --apply.

CLEAN CONTRACT
  Removes EVERY rule on a plan-scope Cloud workflow whose parameters carry
  a 'migrationSourceId' — i.e., rules we previously pushed. Touches NOTHING
  else: JCMA-placed rules, operator-placed rules, system rules, and rules
  from other plugins (Insight, ScriptRunner, VendorThree, Exocet, Exporter) are
  guaranteed-safe.
  Enforced at runtime by the subtractive-diff guardrail: every push is
  verified to be purely "removals of migrationSourceId-tagged rules + zero
  additions / modifications". Any violation aborts that workflow's push and
  dumps the diff to 'subtractive_diff_violation_<wf>.json'.
  Outputs: clean_<TS>.json (per-workflow report) + cleaned_<TS>.csv (one row
  per rule removed). After cleaning, re-run --apply against the same
  collect-dir for a fresh slate.

FRESH-START WORKFLOW (new source/target instance pair)
  When migrating against a NEW (DC, Cloud) instance pair, do this:
    1. Update .env with new DC + Cloud credentials.
    2. Update config.json (or pass --config) with new dc.baseUrl + cloud.baseUrl.
    3. Export new XMLs into a NEW directory, e.g. workflows-2026-may/.
    4. Run:
         node main/migrate_jsu_rules.js --collect --fresh-start \\
           --xml-dir ./workflows-2026-may
       Produces a new logs/collected_<TS>/ stamped with the new instance
       signature (visible in INSTANCE.txt + metadata.json.instanceSignature).
    5. --apply against THAT collect dir; the signature check verifies the
       (DC, Cloud) currently configured matches what the collect was built
       for.
  An accidental run of --apply with stale --collect-dir now errors out with
  a clear remediation message instead of writing one tenant's converted
  rules to another.

CONFIG
  A config.json with dc/cloud/workflowSelection/jmwe/perRuleOverrides blocks.
  Values of the form "env:NAME" are resolved from process.env.
  See config.example.json.
`);
}

function loadConfig(options) {
  const defaultPath = path.resolve(__dirname, "../config.json");
  const configPath = options.configPath || (fs.existsSync(defaultPath) ? defaultPath : null);
  let config = {};
  if (configPath && fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new Error(`Failed to parse config at ${configPath}: ${err.message}`);
    }
  }
  config = resolveConfigEnvIndirections(config);

  if (options.projectKeys || options.workflowNames || options.allWorkflows) {
    config.workflowSelection = {
      ...(config.workflowSelection || {}),
      ...(options.projectKeys ? { projectKeys: options.projectKeys } : {}),
      ...(options.workflowNames ? { workflowNames: options.workflowNames } : {}),
      ...(options.allWorkflows ? { allWorkflows: true } : {}),
    };
  }
  return config;
}

function buildDcClient(config) {
  const dc = config.dc || {};
  const baseUrl = dc.baseUrl;
  if (!baseUrl) throw new Error("config.dc.baseUrl is required");
  const authType = dc.authType || "bearer";
  return new JiraDcClient(baseUrl, {
    authType,
    token: dc.token,
    username: dc.username,
    password: dc.password,
  });
}

function buildCloudClient(config) {
  const cloud = config.cloud || {};
  if (!cloud.baseUrl) throw new Error("config.cloud.baseUrl is required");
  if (!cloud.apiToken) throw new Error("config.cloud.apiToken is required (base64 of email:token)");
  return new JiraCloudClient(cloud.baseUrl, cloud.apiToken);
}

async function runCollect(options, config, log) {
  const cloud = buildCloudClient(config);

  // DC client is needed for REST-based collection AND for fetching the DC
  // field catalog (so the applier can translate DC custom field IDs to Cloud
  // IDs by name match). When using --xml-dir, the DC client is OPTIONAL: we
  // attempt to build it from config, but fall through with a warning if creds
  // are missing. The user can also point fieldMappingFile at a manually-built
  // {dcId: dcName} JSON in their config.
  let dc = null;
  if (!options.xmlDir) {
    dc = buildDcClient(config);
    const dcCheck = await dc.testConnection();
    if (!dcCheck.ok) throw new Error(`DC connection test failed: ${dcCheck.error}`);
    log.info(`DC connection OK (${dc.baseUrl})`);
  } else {
    const absXml = path.resolve(options.xmlDir);
    if (!fs.existsSync(absXml)) throw new Error(`--xml-dir does not exist: ${absXml}`);
    log.info(`Using XML source dir: ${absXml}`);
    options.xmlDir = absXml;
    try {
      dc = buildDcClient(config);
      const dcCheck = await dc.testConnection();
      if (!dcCheck.ok) {
        log.warn(`DC connection unavailable (${dcCheck.error}); proceeding without DC field catalog. ` +
          `Apply phase will treat DC field IDs as identity-mapped — verify before going live.`);
        dc = null;
      } else {
        log.info(`DC connection OK (${dc.baseUrl}) — will fetch field catalog for name-based remapping`);
      }
    } catch (e) {
      log.warn(`DC client could not be built (${e.message}); skipping DC field catalog.`);
      dc = null;
    }
  }

  const collectDirArg = options.collectDir;
  const defaultDir = path.resolve(
    __dirname,
    "..",
    "logs",
    `collected_${timestampSlug()}`,
  );
  const collectDir = collectDirArg || defaultDir;

  // === Fresh-start safety: refuse to reuse an existing populated dir ===
  // The collect dir is the "source of truth" the applier reads from. If the
  // operator passes --fresh-start, we must not silently overwrite (or worse,
  // mix into) a previous collect's artifacts — that's exactly the scenario
  // a fresh start is meant to prevent.
  if (options.freshStart && fs.existsSync(collectDir)) {
    let entries = [];
    try {
      entries = fs.readdirSync(collectDir);
    } catch {
      entries = [];
    }
    // An existing dir that's empty is fine to use as-is. Anything else is
    // a hard stop with an actionable error.
    const meaningful = entries.filter((e) => e !== ".DS_Store");
    if (meaningful.length > 0) {
      throw new Error(
        `--fresh-start: refusing to write into non-empty collect dir "${collectDir}".\n` +
        `Existing entries: ${meaningful.slice(0, 8).join(", ")}${meaningful.length > 8 ? ", ..." : ""}.\n` +
        `Either omit --collect-dir to auto-create a fresh logs/collected_<TS>/ dir, ` +
        `or pass an explicit --collect-dir pointing at a path that does not yet exist.`,
      );
    }
  }
  fs.mkdirSync(collectDir, { recursive: true });

  const logFile = path.join(collectDir, `migrate_${timestampSlug()}.log`);
  log.logFilePath = logFile;

  const collector = new JsuCollector(dc, cloud, config, {
    log,
    collectDir,
    xmlDir: options.xmlDir,
  });
  await collector.run();
}

async function runApply(options, config, log) {
  if (!options.collectDir) {
    throw new Error("--apply requires --collect-dir <path>");
  }
  if (!fs.existsSync(options.collectDir)) {
    throw new Error(`--collect-dir does not exist: ${options.collectDir}`);
  }
  const cloud = buildCloudClient(config);
  const logFile = path.join(options.collectDir, `migrate_${timestampSlug()}.log`);
  log.logFilePath = logFile;

  const applier = new JsuApplier(cloud, config, {
    log,
    collectDir: options.collectDir,
    validateOnly: options.validateOnly,
    dryRun: options.dryRun,
    force: options.force,
    ignoreErrors: options.ignoreErrors,
    disableJmwe: options.disableJmwe,
    workflowNames: options.workflowNames,
    allowInstanceMismatch: options.allowInstanceMismatch,
    excludeProjects: options.excludeProjects,
    runasFallback: options.runasFallback,
    matcherV2: options.matcherV2,
  });
  await applier.run();
}

async function runClean(options, config, log) {
  if (!options.collectDir) {
    throw new Error("--clean requires --collect-dir <path>");
  }
  if (!fs.existsSync(options.collectDir)) {
    throw new Error(`--collect-dir does not exist: ${options.collectDir}`);
  }
  const cloud = buildCloudClient(config);
  const logFile = path.join(options.collectDir, `clean_${timestampSlug()}.log`);
  log.logFilePath = logFile;

  const cleaner = new JsuCleaner(cloud, config, {
    log,
    collectDir: options.collectDir,
    dryRun: options.dryRun,
    force: options.force,
    workflowNames: options.workflowNames,
    allowInstanceMismatch: options.allowInstanceMismatch,
    excludeProjects: options.excludeProjects,
    removeStaleTagged: options.removeStaleTagged,
  });
  await cleaner.run();
}

async function main() {
  const options = parseArgs(process.argv);
  const config = loadConfig(options);

  const log = new Logger(null);
  log.info(`JSU DC→Cloud migrator — mode=${options.mode}`);

  try {
    if (options.mode === "collect") {
      await runCollect(options, config, log);
    } else if (options.mode === "apply") {
      await runApply(options, config, log);
    } else if (options.mode === "clean") {
      await runClean(options, config, log);
    }
  } catch (err) {
    log.error(err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
