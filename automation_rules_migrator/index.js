#!/usr/bin/env node

/**
 * Jira Automation Migrator
 * Main entry point for the CLI application
 */

const { program } = require("commander");
const { logger } = require("./src/utils/logger");
const readline = require("readline");
const blanketMode = require("./src/modes/blanketMode");
const consolidationModes = require("./src/modes/consolidationModes");
const jsonModes = require("./src/modes/jsonModes");

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Set up the main program
program
  .name("automation-migrator")
  .description(
    "Jira Cloud Automation Migrator - Migrate automation rules between Jira instances",
  )
  .version("1.0.0");

// Blanket mode command
program
  .command("blanket")
  .description("Enable all disabled automation rules in a Jira instance")
  .requiredOption("--username <email>", "Jira instance username/email")
  .requiredOption("--token <token>", "Jira instance API token")
  .requiredOption(
    "--site-url <url>",
    "Jira instance site URL (e.g., yourcompany.atlassian.net)",
  )
  .requiredOption("--cloud-id <id>", "Jira Cloud ID")
  .action(blanketMode.execute);

// Consolidation dual source command
program
  .command("consolidation-dual-source")
  .description(
    "Consolidate automation rules: compare target with 2 source instances",
  )
  .requiredOption("--source1-username <email>", "Source 1 username/email")
  .requiredOption("--source1-token <token>", "Source 1 API token")
  .requiredOption("--source1-site-url <url>", "Source 1 site URL")
  .requiredOption("--source1-cloud-id <id>", "Source 1 Cloud ID")
  .requiredOption("--source2-username <email>", "Source 2 username/email")
  .requiredOption("--source2-token <token>", "Source 2 API token")
  .requiredOption("--source2-site-url <url>", "Source 2 site URL")
  .requiredOption("--source2-cloud-id <id>", "Source 2 Cloud ID")
  .requiredOption("--target-username <email>", "Target username/email")
  .requiredOption("--target-token <token>", "Target API token")
  .requiredOption("--target-site-url <url>", "Target site URL")
  .requiredOption("--target-cloud-id <id>", "Target Cloud ID")
  .action(consolidationModes.consolidationDualSourceMode);

// Consolidation sandbox command
program
  .command("consolidation-sandbox")
  .description(
    "Consolidate automation rules: migrate from sandbox to production",
  )
  .requiredOption("--source-username <email>", "Source username/email")
  .requiredOption("--source-token <token>", "Source API token")
  .requiredOption("--source-site-url <url>", "Source site URL")
  .requiredOption("--source-cloud-id <id>", "Source Cloud ID")
  .requiredOption("--target-username <email>", "Target username/email")
  .requiredOption("--target-token <token>", "Target API token")
  .requiredOption("--target-site-url <url>", "Target site URL")
  .requiredOption("--target-cloud-id <id>", "Target Cloud ID")
  .action(consolidationModes.consolidationSandboxMode);

// Consolidation prod command
program
  .command("consolidation-prod")
  .description("Consolidate automation rules: migrate from source to target")
  .requiredOption("--source-username <email>", "Source username/email")
  .requiredOption("--source-token <token>", "Source API token")
  .requiredOption("--source-site-url <url>", "Source site URL")
  .requiredOption("--source-cloud-id <id>", "Source Cloud ID")
  .requiredOption("--target-username <email>", "Target username/email")
  .requiredOption("--target-token <token>", "Target API token")
  .requiredOption("--target-site-url <url>", "Target site URL")
  .requiredOption("--target-cloud-id <id>", "Target Cloud ID")
  .action(consolidationModes.consolidationProdMode);

// Generate JSON command
program
  .command("generate-json")
  .description("Export automation rules to a JSON file")
  .requiredOption("--username <email>", "Jira instance username/email")
  .requiredOption("--token <token>", "Jira instance API token")
  .requiredOption("--site-url <url>", "Jira instance site URL")
  .requiredOption("--cloud-id <id>", "Jira Cloud ID")
  .action((options) => {
    jsonModes.generateJsonMode(
      rl,
      options.username,
      options.token,
      options.siteUrl,
      options.cloudId,
    );
  });

// Fix JSON command
program
  .command("fix-json")
  .description(
    "Fix project and issue type IDs in automation rules JSON file (Cloud-to-Cloud only)",
  )
  .requiredOption("--source-username <email>", "Source Cloud username/email")
  .requiredOption("--source-token <token>", "Source Cloud API token")
  .requiredOption("--source-site-url <url>", "Source Cloud site URL")
  .requiredOption("--target-username <email>", "Target Cloud username/email")
  .requiredOption("--target-token <token>", "Target Cloud API token")
  .requiredOption("--target-site-url <url>", "Target Cloud site URL")
  .requiredOption("--target-cloud-id <id>", "Target Cloud instance ID")
  .option(
    "--default-account-id <id>",
    "Default Cloud account ID for unmapped users (optional)",
  )
  .action((options) => {
    jsonModes.fixJsonMode(
      rl,
      options.sourceUsername,
      options.sourceToken,
      options.sourceSiteUrl,
      options.targetUsername,
      options.targetToken,
      options.targetSiteUrl,
      options.targetCloudId,
      options.defaultAccountId,
    );
  });

// Data Center to Cloud command
program
  .command("datacenter-to-cloud")
  .description(
    "Data Center to Cloud migration: auto-populate Cloud IDs and fix automation rules",
  )
  .requiredOption(
    "--mapping-file <path>",
    "Path to datacenter_cloud_mapping.json file",
  )
  .requiredOption("--cloud-username <email>", "Cloud instance username/email")
  .requiredOption("--cloud-token <token>", "Cloud instance API token")
  .requiredOption(
    "--cloud-site-url <url>",
    "Cloud instance site URL (e.g., yourcompany.atlassian.net)",
  )
  .requiredOption("--cloud-id <id>", "Cloud instance Cloud ID")
  .option(
    "--default-account-id <id>",
    "Default Cloud account ID for unmapped users (optional, recommended)",
  )
  .action((options) => {
    jsonModes.datacenterToCloudMode(
      rl,
      options.mappingFile,
      options.cloudUsername,
      options.cloudToken,
      options.cloudSiteUrl,
      options.cloudId,
      options.defaultAccountId,
    );
  });

// Import JSON command
program
  .command("import-json")
  .description(
    "Complete migration: export from source, fix IDs, import to target",
  )
  .requiredOption("--source-username <email>", "Source username/email")
  .requiredOption("--source-token <token>", "Source API token")
  .requiredOption("--source-site-url <url>", "Source site URL")
  .requiredOption("--source-cloud-id <id>", "Source Cloud ID")
  .requiredOption("--target-username <email>", "Target username/email")
  .requiredOption("--target-token <token>", "Target API token")
  .requiredOption("--target-site-url <url>", "Target site URL")
  .requiredOption("--target-cloud-id <id>", "Target Cloud ID")
  .action(jsonModes.importJsonMode);

// Sync States command
program
  .command("sync-states")
  .description(
    "Sync enable/disable states from JSON file to Cloud (independent of migration)",
  )
  .requiredOption("--rules-file <path>", "Path to automation rules JSON file")
  .requiredOption("--cloud-username <email>", "Cloud instance username/email")
  .requiredOption("--cloud-token <token>", "Cloud instance API token")
  .requiredOption(
    "--cloud-site-url <url>",
    "Cloud instance site URL (e.g., yourcompany.atlassian.net)",
  )
  .requiredOption("--cloud-id <id>", "Cloud instance Cloud ID")
  .action((options) => {
    jsonModes.syncStatesMode(
      rl,
      options.rulesFile,
      options.cloudUsername,
      options.cloudToken,
      options.cloudSiteUrl,
      options.cloudId,
    );
  });

// Parse command-line arguments
program.parse(process.argv);

// Show help if no command is provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
