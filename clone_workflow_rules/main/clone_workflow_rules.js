#!/usr/bin/env node

/**
 * Clone Workflow Rules — Jira Cloud migration & JMWE fixer.
 *
 * Two-phase sequential design:
 *   --collect:  Read workflows from the instance in .env, save JSONs
 *   --apply:    Read JSONs, transform (JMWE fixes, field/ID remapping), then either
 *                 - CREATE new workflows on the instance in .env (default), or
 *                 - UPDATE existing workflows in place (--update)
 *
 * The .env contains ONE cloud instance at a time:
 *   During --collect, it's the SOURCE
 *   During --apply, it's the TARGET (= source for in-place fixes)
 *
 * See README.md for the full runbook, architecture notes, and handover state.
 *
 * Quick start:
 *   # Collect every workflow on the instance
 *   node clone_workflow_rules.js --collect --all-workflows
 *
 *   # Validate the payloads against the target (no mutation)
 *   node clone_workflow_rules.js --apply --collect-dir logs/collected_<ts> \
 *     --update --validate-only
 *
 *   # Fix in place
 *   node clone_workflow_rules.js --apply --collect-dir logs/collected_<ts> --update
 *
 *   # Or clone as _v2 duplicates on a different instance
 *   node clone_workflow_rules.js --apply --collect-dir logs/collected_<ts>
 *
 * See --help for the full option list.
 */

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const JiraCloudClient = require("../src/jiraCloudClient");
const WorkflowCollector = require("../src/workflowCollector");
const WorkflowApplier = require("../src/workflowApplier");
const CcWorkflowCollector = require("../src/ccWorkflowCollector");
const CcWorkflowApplier = require("../src/ccWorkflowApplier");

// ─────────────────────────────────────────────────
//  CLI ARGUMENT PARSING
// ─────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    mode: null,
    projectKeys: [],
    workflowNames: [],
    allWorkflows: false,
    collectDir: null,
    nameSuffix: "_v2",
    assignSchemes: false,
    publish: false,
    dryRun: false,
    // Legacy POST /rest/api/3/workflow/ was retired Feb 1, 2026.
    // useLegacyApi=false (default) routes through POST /rest/api/3/workflows/create.
    useLegacyApi: false,
    validateOnly: false,
    // --update: updates existing workflows in place via POST /rest/api/3/workflows/update
    //           instead of creating duplicates. Name suffix defaults to empty.
    updateMode: false,
    sourceUrl: null,
    exportScriptRunnerScaffold: false,
    // --cloud-to-cloud (--cc): use the new-format literal-copy path (read via
    // POST /rest/api/3/workflows, preserve rules verbatim, only translate IDs).
    cloudToCloud: false,
    // --target-url: target instance for --cc --apply. Token comes from TARGET_CLOUD_API_TOKEN
    // or falls back to CLOUD_API_TOKEN (same Atlassian account spans both sandboxes).
    targetUrl: null,
    // --force: with --cc --apply, mutate even if validation reports ERROR-level entries.
    force: false,
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
      case "--project-keys":
        options.projectKeys = (args[++i] || "").split(",").map((k) => k.trim()).filter(Boolean);
        break;
      case "--workflow-names":
        options.workflowNames = (args[++i] || "").split(",").map((n) => n.trim()).filter(Boolean);
        break;
      case "--all-workflows":
        options.allWorkflows = true;
        break;
      case "--collect-dir":
        options.collectDir = args[++i];
        break;
      case "--name-suffix":
        options.nameSuffix = args[++i] || "_v2";
        break;
      case "--assign-schemes":
        options.assignSchemes = true;
        break;
      case "--publish":
        options.publish = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--use-new-api":
        // No-op (kept for backwards compat). The new API is the default since the
        // old POST /rest/api/3/workflow/ was retired 2026-02-01.
        console.warn(
          "Note: --use-new-api is now the default and can be omitted.",
        );
        break;
      case "--use-legacy-api":
        options.useLegacyApi = true;
        break;
      case "--validate-only":
        options.validateOnly = true;
        break;
      case "--update":
        options.updateMode = true;
        // In update mode, default to no name suffix so we match the existing workflow
        // on the target by its original name. Explicit --name-suffix still wins.
        if (options.nameSuffix === "_v2") options.nameSuffix = "";
        break;
      case "--source-url":
        options.sourceUrl = args[++i];
        break;
      case "--export-scriptrunner-scaffold":
        options.exportScriptRunnerScaffold = true;
        break;
      case "--cloud-to-cloud":
      case "--cc":
        options.cloudToCloud = true;
        break;
      case "--target-url":
        options.targetUrl = args[++i];
        break;
      case "--force":
        options.force = true;
        break;
      default:
        if (args[i].startsWith("--")) {
          console.warn(`Unknown option: ${args[i]}`);
        }
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Clone Workflow Rules - Jira Cloud to Jira Cloud

USAGE:
  node clone_workflow_rules.js --collect --project-keys KEY1,KEY2 [options]
  node clone_workflow_rules.js --apply --collect-dir <path> [options]

MODES:
  --collect                          Fetch workflows from instance in .env (source)
  --apply                            Create workflows on instance in .env (target)

COLLECT OPTIONS:
  --project-keys K1,K2               Projects whose workflow schemes to collect
  --workflow-names W1,W2             Additional workflow names to collect directly
  --all-workflows                    Collect EVERY workflow on the instance
                                     (paginates /rest/api/3/workflow/search)
  --collect-dir <path>               Output directory (default: logs/collected_<timestamp>)
  --export-scriptrunner-scaffold     Generate SMS extensions.yaml + Groovy stubs for ScriptRunner rules
  --cloud-to-cloud, --cc             Literal cloud->cloud copy. Reads workflows in the NEW
                                     API format (POST /rest/api/3/workflows) and writes ONE
                                     cohesive cc_bundle_<ts>.json with every rule verbatim.
                                     No old->new rule mapping; only IDs translate at apply.

APPLY OPTIONS:
  --collect-dir <path>               Directory with collected JSONs (required)
  --update                           Update EXISTING workflows in place on the target
                                     (POST /rest/api/3/workflows/update). No _v2 duplicates.
                                     Default --name-suffix becomes "" when this is set.
                                     Workflows missing on the target are skipped.
  --name-suffix <str>                Suffix for new workflow names
                                     (default: _v2 for create, "" for --update)
  --assign-schemes                   Also update workflow schemes to point to new workflows
                                     (create-mode only; a no-op with --update).
  --publish                          Publish scheme drafts after assignment (async)
  --dry-run                          Preview transformations, save payloads, don't POST
  --validate-only                    POST to /workflows/{create|update}/validation and log
                                     errors/warnings; do NOT actually mutate target
  --use-legacy-api                   Force POST /rest/api/3/workflow/ (retired 2026-02-01,
                                     likely fails). Default is the new bulk endpoint.
                                     Not compatible with --update.
  --source-url <url>                 Override source URL for URL replacement in configs

CLOUD-TO-CLOUD APPLY (--cloud-to-cloud / --cc):
  --target-url <url>                 Target instance to update in place. Token from
                                     TARGET_CLOUD_API_TOKEN, else CLOUD_API_TOKEN.
  --workflow-names W1,W2             Limit the apply to these workflows (for a first test)
  --validate-only                    POST to /workflows/update/validation only (no mutation)
  --dry-run                          Build + save update payloads only (no API calls)
  --force                            Mutate even if validation reports ERROR-level entries

GENERAL:
  --help, -h                         Show this help message

ENVIRONMENT (.env):
  CLOUD_BASE_URL                     Jira Cloud instance URL
  CLOUD_API_TOKEN                    Base64-encoded email:api_token

EXAMPLES:
  # Collect every workflow on the source instance
  node clone_workflow_rules.js --collect --all-workflows

  # Collect just a handful of projects
  node clone_workflow_rules.js --collect --project-keys PROJ1,PROJ2

  # Collect + ScriptRunner SMS scaffold
  node clone_workflow_rules.js --collect --all-workflows --export-scriptrunner-scaffold

  # In-place JMWE / field-remap fixes (update existing workflows, no duplicates):
  node clone_workflow_rules.js --apply --collect-dir ./logs/collected_<ts> --update --dry-run
  node clone_workflow_rules.js --apply --collect-dir ./logs/collected_<ts> --update --validate-only
  node clone_workflow_rules.js --apply --collect-dir ./logs/collected_<ts> --update

  # Clone to a different instance as _v2 duplicates, then cut over via schemes:
  node clone_workflow_rules.js --apply --collect-dir ./logs/collected_<ts>
  node clone_workflow_rules.js --apply --collect-dir ./logs/collected_<ts> --assign-schemes --publish

NOTES:
  - See README.md for the full runbook and handover notes.
  - The .env contains ONE instance: source for --collect, target for --apply.
    For --apply --update, source and target are typically the same.
  - Post-function ordering is not guaranteed by Jira (JRACLOUD-80800) — review
    apply_<ts>.json if order matters.
  - The new-API endpoints auto-create missing statuses from the top-level statuses[]
    block; no pre-creation needed.
  - JMWE must be installed on the target for JMWE rules to work at runtime.
  - ScriptRunner rules are stripped from the workflow payload during --apply.
    Use --export-scriptrunner-scaffold during --collect + Adaptavist SMS for deploy.
  - Legacy POST /rest/api/3/workflow/ was retired 2026-02-01. The default endpoint
    is now /rest/api/3/workflows/create. Use --use-legacy-api only if you must.
`);
}

// ─────────────────────────────────────────────────
//  MAIN ORCHESTRATOR
// ─────────────────────────────────────────────────

class CloneWorkflowRules {
  constructor(options) {
    this.options = options;

    this.validateConfig();

    // Logging
    this.logDir = path.join(__dirname, "../logs");
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.logFile = path.join(this.logDir, `clone_${Date.now()}.log`);
    fs.writeFileSync(
      this.logFile,
      `Clone Workflow Rules Log\nStarted: ${new Date().toISOString()}\nMode: ${options.mode}\n${"=".repeat(80)}\n\n`,
    );

    this.log = this.log.bind(this);

    // Client
    this.client = new JiraCloudClient(
      process.env.CLOUD_BASE_URL,
      process.env.CLOUD_API_TOKEN,
    );
  }

  validateConfig() {
    const required = ["CLOUD_BASE_URL", "CLOUD_API_TOKEN"];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}\nCopy .env.example to .env and fill in the values.`,
      );
    }

    if (!this.options.mode) {
      throw new Error("Please specify --collect or --apply mode. Use --help for usage.");
    }

    if (this.options.mode === "collect") {
      if (
        this.options.projectKeys.length === 0 &&
        this.options.workflowNames.length === 0 &&
        !this.options.allWorkflows
      ) {
        throw new Error(
          "Collect mode requires --project-keys, --workflow-names, or --all-workflows",
        );
      }
    }

    if (this.options.mode === "apply") {
      if (!this.options.collectDir) {
        throw new Error("Apply mode requires --collect-dir <path>");
      }
      if (!fs.existsSync(this.options.collectDir)) {
        throw new Error(`Collect directory not found: ${this.options.collectDir}`);
      }
    }
  }

  log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    console.log(message);
    fs.appendFileSync(this.logFile, line + "\n");
  }

  async run() {
    // Test connection
    this.log("Testing connection to Jira Cloud...");
    const serverInfo = await this.client.testConnection();
    if (!serverInfo) {
      throw new Error("Cannot connect to Jira Cloud. Check CLOUD_BASE_URL and CLOUD_API_TOKEN.");
    }
    this.log(`Connected to: ${serverInfo.baseUrl} (${serverInfo.version})`);

    if (this.options.mode === "collect") {
      return this.runCollect();
    } else if (this.options.mode === "apply") {
      return this.runApply();
    }
  }

  async runCollect() {
    // Auto-generate collect dir if not specified
    const collectDir =
      this.options.collectDir ||
      path.join(this.logDir, `collected_${Date.now()}`);

    // Cloud-to-cloud literal-copy path: read in NEW format, write one cohesive bundle.
    if (this.options.cloudToCloud) {
      const ccCollector = new CcWorkflowCollector(this.client, {
        log: this.log,
        collectDir,
        projectKeys: this.options.projectKeys,
        workflowNames: this.options.workflowNames,
        allWorkflows: this.options.allWorkflows,
      });
      return ccCollector.run();
    }

    const collector = new WorkflowCollector(this.client, {
      log: this.log,
      collectDir,
      projectKeys: this.options.projectKeys,
      workflowNames: this.options.workflowNames,
      allWorkflows: this.options.allWorkflows,
      exportScriptRunnerScaffold: this.options.exportScriptRunnerScaffold,
    });

    return collector.run();
  }

  async runApply() {
    // Cloud-to-cloud update-in-place: read source bundle, write to a TARGET instance.
    if (this.options.cloudToCloud) {
      const targetUrl =
        this.options.targetUrl ||
        process.env.TARGET_CLOUD_BASE_URL ||
        process.env.CLOUD_BASE_URL;
      const targetToken =
        process.env.TARGET_CLOUD_API_TOKEN || process.env.CLOUD_API_TOKEN;
      const targetClient = new JiraCloudClient(targetUrl, targetToken);

      this.log(`Testing connection to TARGET ${targetUrl}...`);
      const info = await targetClient.testConnection();
      if (!info) {
        throw new Error(`Cannot connect to target ${targetUrl}. Set --target-url and TARGET_CLOUD_API_TOKEN (or CLOUD_API_TOKEN).`);
      }
      this.log(`Connected to target: ${info.baseUrl} (${info.version})`);

      const ccApplier = new CcWorkflowApplier(targetClient, {
        log: this.log,
        collectDir: this.options.collectDir,
        dryRun: this.options.dryRun,
        validateOnly: this.options.validateOnly,
        force: this.options.force,
        workflowNames: this.options.workflowNames,
      });
      return ccApplier.run();
    }

    const applier = new WorkflowApplier(this.client, {
      log: this.log,
      collectDir: this.options.collectDir,
      nameSuffix: this.options.nameSuffix,
      assignSchemes: this.options.assignSchemes,
      publish: this.options.publish,
      dryRun: this.options.dryRun,
      useLegacyApi: this.options.useLegacyApi,
      validateOnly: this.options.validateOnly,
      updateMode: this.options.updateMode,
      sourceUrl: this.options.sourceUrl,
    });

    return applier.run();
  }
}

// ─────────────────────────────────────────────────
//  ENTRY POINT
// ─────────────────────────────────────────────────

async function main() {
  const options = parseArgs();

  let runner;
  try {
    runner = new CloneWorkflowRules(options);
  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    process.exit(1);
  }

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    runner.log("\nShutting down gracefully...");
    runner.log(`Log file: ${runner.logFile}`);
    process.exit(1);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await runner.run();
    runner.log(`\nLog file: ${runner.logFile}`);
  } catch (err) {
    runner.log(`\nFATAL ERROR: ${err.message}`);
    runner.log(`Log file: ${runner.logFile}`);
    process.exit(1);
  }
}

main();
