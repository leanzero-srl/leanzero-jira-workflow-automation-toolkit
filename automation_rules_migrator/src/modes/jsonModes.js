const fs = require("fs").promises;
const path = require("path");
const { logger, logEvidence } = require("../utils/logger");
const { question, confirm, waitForEnter } = require("../utils/input");
const projectService = require("../services/projectService");
const ruleService = require("../services/ruleService");
const mappingService = require("../services/mappingService");

/**
 * Generate JSON mode - Creates automation rules JSON file for selected projects
 * @param {readline.Interface} rl - Readline interface for user input
 * @param {string} username - Jira username/email
 * @param {string} apiToken - Jira API token
 * @param {string} siteUrl - Site URL (e.g., yourcompany.atlassian.net)
 * @param {string} cloudId - Cloud ID
 * @param {string} product - Product type (default: 'jira')
 */
async function generateJsonMode(
  rl,
  username,
  apiToken,
  siteUrl,
  cloudId,
  product = "jira",
) {
  logger.info("=== Generate JSON Mode ===");
  logger.info(
    "This mode will help you export automation rules to a JSON file.",
  );

  try {
    logger.info("Step 1: Fetching all projects...");
    // FIXED: Use siteUrl instead of undefined variable
    const allProjects = await projectService.getProjectIds(
      username,
      apiToken,
      siteUrl,
    );
    logger.info(`Found ${allProjects.length} total projects`);

    // Interactive project selection
    logger.info("\nStep 2: Project Selection");
    logger.info("You can either:");
    logger.info("  a) Export rules from ALL projects");
    logger.info("  b) Select specific projects");

    const choice = await question(rl, "\nEnter your choice (a/b): ");

    let selectedProjects;
    if (choice.trim().toLowerCase() === "a") {
      selectedProjects = allProjects;
      logger.info(`Selected ALL ${selectedProjects.length} projects`);
    } else {
      // Show projects and let user select
      logger.info("\nAvailable projects:");
      allProjects.forEach((proj, idx) => {
        logger.info(
          `  ${idx + 1}. ${proj.key} - ${proj.name} (ID: ${proj.id})`,
        );
      });

      const projectKeysAnswer = await question(
        rl,
        '\nEnter project keys (comma-separated, e.g., "PROJ1,PROJ2"): ',
      );
      const projectKeys = projectKeysAnswer
        .split(",")
        .map((k) => k.trim().toUpperCase());

      selectedProjects = allProjects.filter((p) =>
        projectKeys.includes(p.key.toUpperCase()),
      );
      logger.info(
        `Selected ${selectedProjects.length} projects: ${selectedProjects.map((p) => p.key).join(", ")}`,
      );
    }

    if (selectedProjects.length === 0) {
      logger.error("No projects selected. Exiting.");
      return;
    }

    logger.info("\nStep 3: Fetching automation rules...");
    // FIXED: Pass both siteUrl and cloudId
    const allRules = await ruleService.getAllRules(
      username,
      apiToken,
      siteUrl,
      cloudId,
      product,
      true,
    );
    logger.info(`Found ${allRules.length} total automation rules`);

    // Filter rules by selected projects
    logger.info("\nStep 4: Filtering rules by selected projects...");
    // FIXED: filterAutomationRules expects an array of rules
    const { filteredRules } = projectService.filterAutomationRules(
      allRules,
      selectedProjects,
    );
    logger.info(
      `Filtered to ${filteredRules.length} rules for selected projects`,
    );

    if (filteredRules.length === 0) {
      logger.warn(
        "No automation rules found for selected projects. Nothing to export.",
      );
      return;
    }

    // Show summary
    logger.info("\n=== Export Summary ===");
    logger.info(`Total rules to export: ${filteredRules.length}`);

    // Group rules by project
    const rulesByProject = {};
    for (const rule of filteredRules) {
      // FIXED: Use ruleScopeARIs instead of ruleScope.resources
      const projectKeys =
        rule.ruleScopeARIs
          ?.filter((r) => r.includes("project/"))
          ?.map((r) => r.split("project/")[1])
          ?.join(", ") || "Global";
      if (!rulesByProject[projectKeys]) {
        rulesByProject[projectKeys] = [];
      }
      rulesByProject[projectKeys].push(rule.name);
    }

    logger.info("\nRules by project:");
    for (const [projectKeys, ruleNames] of Object.entries(rulesByProject)) {
      logger.info(`  ${projectKeys}: ${ruleNames.length} rule(s)`);
    }

    // Confirm export
    const confirmExport = await confirm(
      rl,
      "\nProceed with export? (yes/no): ",
    );
    if (!confirmExport) {
      logger.info("Export cancelled by user");
      return;
    }

    // Generate filename
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .split("T")[0];
    // FIXED: Extract domain from siteUrl for filename
    const domain = siteUrl
      .replace(".atlassian.net", "")
      .replace("https://", "");
    const filename = `automation_rules_${domain}_${timestamp}.json`;
    const outputPath = path.join(process.cwd(), filename);

    // Write to file (Cloud format: {"cloud": true, "rules": [...]})
    logger.info(`\nStep 5: Writing to file: ${filename}`);
    await fs.writeFile(
      outputPath,
      JSON.stringify({ cloud: true, rules: filteredRules }, null, 2),
      "utf8",
    );

    logger.info("✓ Export completed successfully!");
    logger.info(`File saved: ${outputPath}`);
    logger.info(`Total rules exported: ${filteredRules.length}`);

    logEvidence("generate-json", {
      domain,
      cloudId,
      selectedProjects: selectedProjects.map((p) => ({ key: p.key, id: p.id })),
      totalRulesExported: filteredRules.length,
      outputFile: filename,
    });
  } catch (error) {
    logger.error(`Error in generate-json mode: ${error.message}`);
    logger.debug(error.stack);
    throw error;
  }
}

/**
 * Fix JSON mode - Fixes project and issue type IDs in automation rules JSON (Cloud-to-Cloud only)
 * @param {readline.Interface} rl - Readline interface for user input
 * @param {string} sourceUsername - Source instance username
 * @param {string} sourceApiToken - Source instance API token
 * @param {string} sourceSiteUrl - Source instance site URL
 * @param {string} targetUsername - Target instance username
 * @param {string} targetApiToken - Target instance API token
 * @param {string} targetSiteUrl - Target instance site URL
 * @param {string} targetCloudId - Target Cloud instance ID
 * @param {string} defaultAccountId - Default Cloud account ID for unmapped users (optional)
 */
async function fixJsonMode(
  rl,
  sourceUsername,
  sourceApiToken,
  sourceSiteUrl,
  targetUsername,
  targetApiToken,
  targetSiteUrl,
  targetCloudId,
  defaultAccountId,
) {
  logger.info("=== Fix JSON Mode (Cloud-to-Cloud) ===");
  logger.info(
    "This mode will fix project and issue type IDs in your automation rules JSON file.",
  );

  try {
    // Get input filename
    const inputFile = await question(
      rl,
      "Enter the path to your automation rules JSON file: ",
    );
    const inputPath = path.resolve(inputFile.trim());

    // Check if file exists
    try {
      await fs.access(inputPath);
    } catch (error) {
      logger.error(`File not found: ${inputPath}`);
      return;
    }

    logger.info(`Reading file: ${inputPath}`);
    const fileContent = await fs.readFile(inputPath, "utf8");
    const rules = JSON.parse(fileContent);

    // Handle both formats: {cloud: true, rules: [...]} or just [...]
    const rulesArray = rules.rules || rules;
    const isCloudSource = rules.cloud === true;

    if (!Array.isArray(rulesArray)) {
      throw new Error("Invalid rules file format: expected array of rules");
    }

    logger.info(`Loaded ${rulesArray.length} automation rules from file`);
    logger.info(`Source type: ${isCloudSource ? "Cloud" : "Datacenter"}`);

    // Cloud-to-Cloud mode: Generate mappings via API
    logger.info(
      "\nStep 1: Generating ID mappings between source and target instances...",
    );
    logger.info("This may take a moment...");

    const mappings = await mappingService.generateMappings(
      sourceUsername,
      sourceApiToken,
      sourceSiteUrl,
      targetUsername,
      targetApiToken,
      targetSiteUrl,
    );

    logger.info("✓ Mappings generated successfully");
    logger.info(
      `  - Project mappings: ${Object.keys(mappings.projectMapping).length}`,
    );
    logger.info(
      `  - Issue type mappings: ${Object.keys(mappings.issueTypeMapping).length}`,
    );
    logger.info(
      `  - Custom field mappings: ${Object.keys(mappings.customFieldMapping).length}`,
    );
    logger.info(
      `  - Status mappings: ${Object.keys(mappings.statusMapping).length}`,
    );
    logger.info(
      `  - Resolution mappings: ${Object.keys(mappings.resolutionMapping || {}).length}`,
    );
    logger.info(
      `  - Priority mappings: ${Object.keys(mappings.priorityMapping || {}).length}`,
    );
    logger.info(
      `  - User mappings: ${Object.keys(mappings.userMapping).length}`,
    );

    // Show sample mappings
    logger.info("\nSample project mappings:");
    const projectEntries = Object.entries(mappings.projectMapping).slice(0, 3);
    for (const [sourceId, targetId] of projectEntries) {
      logger.info(`  ${sourceId} → ${targetId}`);
    }
    if (Object.keys(mappings.projectMapping).length > 3) {
      logger.info(
        `  ... and ${Object.keys(mappings.projectMapping).length - 3} more`,
      );
    }

    logger.info("\nSample issue type mappings:");
    const issueTypeEntries = Object.entries(mappings.issueTypeMapping).slice(
      0,
      3,
    );
    for (const [sourceId, targetId] of issueTypeEntries) {
      logger.info(`  ${sourceId} → ${targetId}`);
    }
    if (Object.keys(mappings.issueTypeMapping).length > 3) {
      logger.info(
        `  ... and ${Object.keys(mappings.issueTypeMapping).length - 3} more`,
      );
    }

    // Small delay to ensure all logs are flushed before readline prompt
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Confirm fixing
    const confirmFix = await confirm(
      rl,
      "\nProceed with fixing IDs in the JSON file? (yes/no): ",
    );
    if (!confirmFix) {
      logger.info("Fix cancelled by user");
      return;
    }

    // Fix the rules
    logger.info("\nStep 2: Fixing IDs in automation rules...");

    // Log default account ID if provided
    if (defaultAccountId) {
      logger.info(
        `Using default account ID for unmapped users: ${defaultAccountId}`,
      );
    } else {
      logger.warn(
        "No default account ID provided - unmapped users will keep original IDs (may cause import issues)",
      );
    }

    const fixedRules = mappingService.fixAutomationRules(
      rulesArray,
      mappings,
      targetCloudId,
      defaultAccountId,
      isCloudSource,
      isCloudSource ? false : true,  // filterUnmapped: false for cloud-to-cloud, true for DC
    );

    // Generate output filename
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .split("T")[0];

    const targetDomain = targetSiteUrl
      .replace(".atlassian.net", "")
      .replace("https://", "");

    const outputFilename = `automation_rules_fixed_${targetDomain}_${timestamp}.json`;
    const outputPath = path.join(process.cwd(), outputFilename);

    // Write fixed rules to file (Cloud-to-Cloud uses same format as DataCenter-to-Cloud)
    logger.info(`\nStep 3: Writing fixed rules to: ${outputFilename}`);
    await fs.writeFile(outputPath, JSON.stringify(fixedRules, null, 2), "utf8");

    logger.info("✓ Fix completed successfully!");
    logger.info(`Input file: ${inputPath}`);
    logger.info(`Output file: ${outputPath}`);
    logger.info(`Total rules processed: ${fixedRules.rules.length}`);

    logEvidence("fix-json", {
      inputFile: inputPath,
      outputFile: outputFilename,
      totalRules: fixedRules.rules.length,
      projectMappings: Object.keys(mappings.projectMapping).length,
      issueTypeMappings: Object.keys(mappings.issueTypeMapping).length,
      customFieldMappings: Object.keys(mappings.customFieldMapping).length,
      statusMappings: Object.keys(mappings.statusMapping).length,
      userMappings: Object.keys(mappings.userMapping).length,
      mode: "cloud-to-cloud",
      sourceSiteUrl,
      targetSiteUrl,
      targetCloudId,
    });
  } catch (error) {
    logger.error(`Error in fix-json mode: ${error.message}`);
    logger.debug(error.stack);
    throw error;
  }
}

/**
 * Import JSON mode - Complete migration workflow: export, fix, and import rules
 * @param {readline.Interface} rl - Readline interface for user input
 * @param {string} sourceUsername - Source instance username
 * @param {string} sourceApiToken - Source instance API token
 * @param {string} sourceSiteUrl - Source instance site URL
 * @param {string} sourceCloudId - Source instance cloud ID
 * @param {string} targetUsername - Target instance username
 * @param {string} targetApiToken - Target instance API token
 * @param {string} targetSiteUrl - Target instance site URL
 * @param {string} targetCloudId - Target instance cloud ID
 * @param {string} product - Product type (default: 'jira')
 */
async function importJsonMode(
  rl,
  sourceUsername,
  sourceApiToken,
  sourceSiteUrl,
  sourceCloudId,
  targetUsername,
  targetApiToken,
  targetSiteUrl,
  targetCloudId,
  product = "jira",
) {
  logger.info("=== Import JSON Mode (Complete Migration) ===");
  logger.info(
    "This mode will export rules from source, fix IDs, and import to target.",
  );

  try {
    // ===== PHASE 1: EXPORT FROM SOURCE =====
    logger.info("\n" + "=".repeat(60));
    logger.info("PHASE 1: EXPORT AUTOMATION RULES FROM SOURCE");
    logger.info("=".repeat(60));

    logger.info("Step 1.1: Fetching all projects from SOURCE instance...");
    const sourceProjects = await projectService.getProjectIds(
      sourceUsername,
      sourceApiToken,
      sourceSiteUrl,
    );
    logger.info(`Found ${sourceProjects.length} projects in source instance`);

    // Interactive project selection
    logger.info("\nStep 1.2: Project Selection");
    logger.info("You can either:");
    logger.info("  a) Migrate rules from ALL projects");
    logger.info("  b) Select specific projects");

    const choice = await question(rl, "\nEnter your choice (a/b): ");

    let selectedProjects;
    if (choice.trim().toLowerCase() === "a") {
      selectedProjects = sourceProjects;
      logger.info(`Selected ALL ${selectedProjects.length} projects`);
    } else {
      // Show projects and let user select
      logger.info("\nAvailable projects in SOURCE:");
      sourceProjects.forEach((proj, idx) => {
        logger.info(
          `  ${idx + 1}. ${proj.key} - ${proj.name} (ID: ${proj.id})`,
        );
      });

      const projectKeysAnswer = await question(
        rl,
        '\nEnter project keys (comma-separated, e.g., "PROJ1,PROJ2"): ',
      );
      const projectKeys = projectKeysAnswer
        .split(",")
        .map((k) => k.trim().toUpperCase());

      selectedProjects = sourceProjects.filter((p) =>
        projectKeys.includes(p.key.toUpperCase()),
      );
      logger.info(
        `Selected ${selectedProjects.length} projects: ${selectedProjects.map((p) => p.key).join(", ")}`,
      );
    }

    if (selectedProjects.length === 0) {
      logger.error("No projects selected. Exiting.");
      return;
    }

    logger.info("\nStep 1.3: Fetching automation rules from SOURCE...");
    // FIXED: Pass both siteUrl and cloudId
    const sourceRules = await ruleService.getAllRules(
      sourceUsername,
      sourceApiToken,
      sourceSiteUrl,
      sourceCloudId,
      product,
      true,
    );
    logger.info(`Found ${sourceRules.length} total automation rules in source`);

    logger.info("\nStep 1.4: Filtering rules by selected projects...");
    // FIXED: filterAutomationRules expects array and returns object
    const { filteredRules } = projectService.filterAutomationRules(
      sourceRules,
      selectedProjects,
    );
    logger.info(
      `Filtered to ${filteredRules.length} rules for selected projects`,
    );

    if (filteredRules.length === 0) {
      logger.warn(
        "No automation rules found for selected projects. Nothing to migrate.",
      );
      return;
    }

    // Show export summary
    logger.info("\n=== Export Summary ===");
    logger.info(`Total rules to migrate: ${filteredRules.length}`);

    const rulesByProject = {};
    for (const rule of filteredRules) {
      // FIXED: Use ruleScopeARIs
      const projectKeys =
        rule.ruleScopeARIs
          ?.filter((r) => r.includes("project/"))
          ?.map((r) => r.split("project/")[1])
          ?.join(", ") || "Global";
      if (!rulesByProject[projectKeys]) {
        rulesByProject[projectKeys] = [];
      }
      rulesByProject[projectKeys].push(rule.name);
    }

    logger.info("\nRules by project:");
    for (const [projectKeys, ruleNames] of Object.entries(rulesByProject)) {
      logger.info(`  ${projectKeys}: ${ruleNames.length} rule(s)`);
    }

    await waitForEnter(
      rl,
      "\nPress Enter to continue to Phase 2 (Fixing IDs)...",
    );

    // ===== PHASE 2: FIX IDS =====
    logger.info("\n" + "=".repeat(60));
    logger.info("PHASE 2: FIX PROJECT AND ISSUE TYPE IDS");
    logger.info("=".repeat(60));

    logger.info(
      "\nStep 2.1: Generating ID mappings between source and target...",
    );
    logger.info("This may take a moment...");

    // FIXED: Pass siteUrl instead of domain
    const mappings = await mappingService.generateMappings(
      sourceUsername,
      sourceApiToken,
      sourceSiteUrl,
      targetUsername,
      targetApiToken,
      targetSiteUrl,
    );

    logger.info("✓ Mappings generated successfully");
    logger.info(
      `  - Project mappings: ${Object.keys(mappings.projectMapping).length}`,
    );
    logger.info(
      `  - Issue type mappings: ${Object.keys(mappings.issueTypeMapping).length}`,
    );

    logger.info("\nStep 2.2: Fixing IDs in automation rules...");
    // FIXED: pass cloudId, defaultAccountId, and isCloudSource=true for cloud-to-cloud
    // fixAutomationRules returns {cloud: true, rules: [...]} — destructure to get the array
    const fixedResult = mappingService.fixAutomationRules(
      filteredRules,
      mappings,
      targetCloudId,
      undefined,  // defaultAccountId
      true,       // isCloudSource=true → disable all DC-only transformations
      false,      // filterUnmapped=false → warn instead of dropping rules
    );
    const fixedRules = fixedResult.rules;
    logger.info(`✓ Fixed IDs in ${fixedRules.length} rules`);

    await waitForEnter(
      rl,
      "\nPress Enter to continue to Phase 3 (Import to Target)...",
    );

    // ===== PHASE 3: IMPORT TO TARGET =====
    logger.info("\n" + "=".repeat(60));
    logger.info("PHASE 3: IMPORT AUTOMATION RULES TO TARGET");
    logger.info("=".repeat(60));

    logger.info("\nStep 3.1: Fetching existing rules from TARGET instance...");
    // FIXED: Pass both siteUrl and cloudId
    const targetRules = await ruleService.getAllRules(
      targetUsername,
      targetApiToken,
      targetSiteUrl,
      targetCloudId,
      product,
      true,
    );
    logger.info(
      `Found ${targetRules.length} existing rules in target instance`,
    );

    // Check for duplicates by name
    logger.info("\nStep 3.2: Checking for duplicate rule names...");
    const targetRuleNames = new Set(
      targetRules.map((r) => r.name.toLowerCase()),
    );
    const duplicates = [];
    const safeToImport = [];

    for (const rule of fixedRules) {
      if (targetRuleNames.has(rule.name.toLowerCase())) {
        duplicates.push(rule.name);
      } else {
        safeToImport.push(rule);
      }
    }

    if (duplicates.length > 0) {
      logger.warn(
        `\n⚠️  Found ${duplicates.length} duplicate rule names in target:`,
      );
      duplicates.slice(0, 10).forEach((name) => logger.warn(`  - ${name}`));
      if (duplicates.length > 10) {
        logger.warn(`  ... and ${duplicates.length - 10} more`);
      }

      const skipDuplicates = await confirm(
        rl,
        "\nSkip these duplicates and import only new rules? (yes/no): ",
      );
      if (!skipDuplicates) {
        logger.info("Import cancelled by user");
        return;
      }
    }

    logger.info(`\nRules to import: ${safeToImport.length}`);

    if (safeToImport.length === 0) {
      logger.warn("No rules to import. All rules already exist in target.");
      return;
    }

    // Check for email actions
    logger.info("\nStep 3.3: Checking for email actions...");
    const rulesWithEmail = [];
    const rulesWithoutEmail = [];

    for (const rule of safeToImport) {
      if (ruleService.hasEmailAction(rule)) {
        rulesWithEmail.push(rule);
      } else {
        rulesWithoutEmail.push(rule);
      }
    }

    if (rulesWithEmail.length > 0) {
      logger.warn(
        `\n⚠️  Found ${rulesWithEmail.length} rules with email actions:`,
      );
      rulesWithEmail
        .slice(0, 10)
        .forEach((rule) => logger.warn(`  - ${rule.name}`));
      if (rulesWithEmail.length > 10) {
        logger.warn(`  ... and ${rulesWithEmail.length - 10} more`);
      }
      logger.info(
        "\nThese rules will be imported in DISABLED state for safety.",
      );
    }

    // Final confirmation
    logger.info("\n=== Import Summary ===");
    logger.info(`Total rules to import: ${safeToImport.length}`);
    logger.info(
      `  - Rules with email actions (will be disabled): ${rulesWithEmail.length}`,
    );
    logger.info(`  - Rules without email actions: ${rulesWithoutEmail.length}`);

    const confirmImport = await confirm(
      rl,
      "\nProceed with import? (yes/no): ",
    );
    if (!confirmImport) {
      logger.info("Import cancelled by user");
      return;
    }

    // Import rules
    logger.info("\nStep 3.4: Importing rules to target instance...");
    logger.info(
      "This may take several minutes depending on the number of rules...\n",
    );

    let successCount = 0;
    let failCount = 0;
    const failedRules = [];

    for (let i = 0; i < safeToImport.length; i++) {
      const rule = safeToImport[i];
      const hasEmail = ruleService.hasEmailAction(rule);

      try {
        // Prepare rule for import
        const ruleToImport = { ...rule };
        delete ruleToImport.id;
        delete ruleToImport.created;
        delete ruleToImport.updated;

        // Force disable if has email action
        if (hasEmail) {
          ruleToImport.state = "DISABLED";
        }

        // FIXED: Pass ruleToImport directly (Cloud API expects the rule object, not wrapped)
        const result = await ruleService.createRule(
          targetUsername,
          targetApiToken,
          targetSiteUrl,
          targetCloudId,
          ruleToImport,
          product,
        );

        if (result.success) {
          successCount++;
          const status = hasEmail ? "[DISABLED - EMAIL]" : "[OK]";
          logger.info(
            `  ${i + 1}/${safeToImport.length} ${status} ${rule.name}`,
          );
        } else {
          throw new Error(JSON.stringify(result.error));
        }
      } catch (error) {
        failCount++;
        failedRules.push({ name: rule.name, error: error.message });
        logger.error(
          `  ${i + 1}/${safeToImport.length} [FAILED] ${rule.name}: ${error.message}`,
        );
      }
    }

    // Final summary
    logger.info("\n" + "=".repeat(60));
    logger.info("MIGRATION COMPLETE");
    logger.info("=".repeat(60));
    logger.info(`✓ Successfully imported: ${successCount} rules`);
    if (failCount > 0) {
      logger.error(`✗ Failed to import: ${failCount} rules`);
      logger.info("\nFailed rules:");
      failedRules.forEach((r) => logger.error(`  - ${r.name}: ${r.error}`));
    }

    // Extract domain from siteUrl
    const sourceDomain = sourceSiteUrl
      .replace(".atlassian.net", "")
      .replace("https://", "");
    const targetDomain = targetSiteUrl
      .replace(".atlassian.net", "")
      .replace("https://", "");

    logEvidence("import-json", {
      sourceDomain,
      sourceCloudId,
      targetDomain,
      targetCloudId,
      selectedProjects: selectedProjects.map((p) => ({ key: p.key, id: p.id })),
      totalRulesExported: filteredRules.length,
      totalRulesImported: successCount,
      failedImports: failCount,
      rulesWithEmail: rulesWithEmail.length,
      duplicatesSkipped: duplicates.length,
    });
  } catch (error) {
    logger.error(`Error in import-json mode: ${error.message}`);
    logger.debug(error.stack);
    throw error;
  }
}

/**
 * Data Center to Cloud mode - Auto-populate Cloud IDs and fix automation rules
 * @param {readline.Interface} rl - Readline interface for user input
 * @param {string} mappingFilePath - Path to datacenter_cloud_mapping.json
 * @param {string} cloudUsername - Cloud instance username/email
 * @param {string} cloudApiToken - Cloud instance API token
 * @param {string} cloudSiteUrl - Cloud instance site URL (e.g., yourcompany.atlassian.net)
 * @param {string} cloudId - Cloud instance Cloud ID
 * @param {string} defaultAccountId - Default Cloud account ID for unmapped users (optional)
 */
async function datacenterToCloudMode(
  rl,
  mappingFilePath,
  cloudUsername,
  cloudApiToken,
  cloudSiteUrl,
  cloudId,
  defaultAccountId,
) {
  logger.info("=== Data Center to Cloud Migration Mode ===");
  logger.info(
    "This mode will auto-populate Cloud IDs and fix your automation rules.",
  );

  try {
    // ===== PHASE 1: LOAD MAPPING FILE =====
    logger.info("\n" + "=".repeat(60));
    logger.info("PHASE 1: LOAD DATA CENTER MAPPING FILE");
    logger.info("=".repeat(60));

    const mappingPath = path.resolve(mappingFilePath);
    logger.info(`\nStep 1.1: Reading mapping file: ${mappingPath}`);

    // Check if file exists
    try {
      await fs.access(mappingPath);
    } catch (error) {
      logger.error(`Mapping file not found: ${mappingPath}`);
      logger.error(
        "Please ensure the datacenter_cloud_mapping.json file exists.",
      );
      return;
    }

    const mappingContent = await fs.readFile(mappingPath, "utf8");
    const mappingData = JSON.parse(mappingContent);

    // Validate structure
    if (!mappingData.projects || !mappingData.issue_types) {
      logger.error(
        "Invalid mapping file format: missing projects or issue_types",
      );
      return;
    }

    logger.info("✓ Mapping file loaded successfully");
    logger.info(`  - Projects: ${mappingData.projects.length}`);
    logger.info(`  - Issue Types: ${mappingData.issue_types.length}`);
    if (mappingData.custom_fields) {
      logger.info(`  - Custom Fields: ${mappingData.custom_fields.length}`);
    }
    if (mappingData.statuses) {
      logger.info(`  - Statuses: ${mappingData.statuses.length}`);
    }
    if (mappingData.users) {
      logger.info(`  - Users: ${mappingData.users.length}`);
    }

    await waitForEnter(
      rl,
      "\nPress Enter to continue to Phase 2 (Auto-populate Cloud IDs)...",
    );

    // ===== PHASE 2: AUTO-POPULATE CLOUD IDs =====
    logger.info("\n" + "=".repeat(60));
    logger.info("PHASE 2: AUTO-POPULATE CLOUD IDs");
    logger.info("=".repeat(60));

    const jiraClient = require("../api/jiraClient");

    // Auto-populate Project IDs
    logger.info("\nStep 2.1: Auto-populating Project IDs...");
    logger.info("Fetching all projects from Cloud instance...");
    const cloudProjects = await jiraClient.getPaginatedData(
      cloudUsername,
      cloudApiToken,
      cloudSiteUrl,
      "/project/search",
    );
    logger.info(`Found ${cloudProjects.length} projects in Cloud`);

    // Initialize counters at function scope
    let projectsMapped = 0;
    let projectsNotFound = 0;
    let issueTypesMapped = 0;
    let issueTypesNotFound = 0;
    let customFieldsMapped = 0;
    let customFieldsNotFound = 0;
    let statusesMapped = 0;
    let statusesNotFound = 0;
    let usersMapped = 0;
    let usersNotFound = 0;
    let resolutionsMapped = 0;
    let resolutionsNotFound = 0;
    let prioritiesMapped = 0;
    let prioritiesNotFound = 0;

    for (const dcProject of mappingData.projects) {
      if (dcProject.cloud_id) {
        // Already populated
        continue;
      }

      // Match by project key
      const cloudProject = cloudProjects.find((cp) => cp.key === dcProject.key);
      if (cloudProject) {
        dcProject.cloud_id = cloudProject.id;
        projectsMapped++;
        logger.debug(
          `Mapped project: ${dcProject.key} → ${cloudProject.id} (${cloudProject.name})`,
        );
      } else {
        projectsNotFound++;
        logger.warn(`Project not found in Cloud: ${dcProject.key}`);
      }
    }
    logger.info(
      `✓ Projects: ${projectsMapped} mapped, ${projectsNotFound} not found`,
    );

    // Auto-populate Issue Type IDs
    logger.info("\nStep 2.2: Auto-populating Issue Type IDs...");
    logger.info("Fetching all issue types from Cloud instance...");
    const cloudIssueTypes = await jiraClient.getPaginatedData(
      cloudUsername,
      cloudApiToken,
      cloudSiteUrl,
      "/issuetype",
    );
    logger.info(`Found ${cloudIssueTypes.length} issue types in Cloud`);
    for (const dcIssueType of mappingData.issue_types) {
      if (dcIssueType.cloud_id) {
        // Already populated
        continue;
      }

      // Match by name
      const cloudIssueType = cloudIssueTypes.find(
        (cit) => cit.name === dcIssueType.name,
      );
      if (cloudIssueType) {
        dcIssueType.cloud_id = cloudIssueType.id;
        issueTypesMapped++;
        logger.debug(
          `Mapped issue type: ${dcIssueType.name} → ${cloudIssueType.id}`,
        );
      } else {
        issueTypesNotFound++;
        logger.warn(`Issue type not found in Cloud: ${dcIssueType.name}`);
      }
    }
    logger.info(
      `✓ Issue Types: ${issueTypesMapped} mapped, ${issueTypesNotFound} not found`,
    );

    // Auto-populate Custom Field IDs
    if (mappingData.custom_fields) {
      logger.info("\nStep 2.3: Auto-populating Custom Field IDs...");
      logger.info("Fetching all custom fields from Cloud instance...");
      const cloudFields = await jiraClient.getPaginatedData(
        cloudUsername,
        cloudApiToken,
        cloudSiteUrl,
        "/field",
      );
      const cloudCustomFields = cloudFields.filter((f) =>
        f.id.startsWith("customfield_"),
      );
      logger.info(`Found ${cloudCustomFields.length} custom fields in Cloud`);

      for (const dcCustomField of mappingData.custom_fields) {
        if (dcCustomField.cloud_id) {
          // Already populated
          continue;
        }

        // Try 1: Match by name and field_type (most precise)
        let cloudCustomField = cloudCustomFields.find(
          (ccf) =>
            ccf.name === dcCustomField.name &&
            (dcCustomField.field_type === ccf.schema?.custom ||
              dcCustomField.field_type === ccf.type),
        );

        // Try 2: Match by field_type only (for Service Desk fields that may have different names)
        if (
          !cloudCustomField &&
          dcCustomField.field_type &&
          dcCustomField.field_type.includes("servicedesk")
        ) {
          cloudCustomField = cloudCustomFields.find(
            (ccf) =>
              dcCustomField.field_type === ccf.schema?.custom ||
              dcCustomField.field_type === ccf.type,
          );
          if (cloudCustomField) {
            logger.debug(
              `Matched Service Desk field by type: "${dcCustomField.name}" (DC) → "${cloudCustomField.name}" (Cloud)`,
            );
          }
        }

        // Try 3: Match by name only as fallback
        if (!cloudCustomField) {
          cloudCustomField = cloudCustomFields.find(
            (ccf) => ccf.name === dcCustomField.name,
          );
        }

        if (cloudCustomField) {
          dcCustomField.cloud_id = cloudCustomField.id;
          dcCustomField.cloud_name = cloudCustomField.name; // Store Cloud field name for transformation
          customFieldsMapped++;
          logger.debug(
            `Mapped custom field: ${dcCustomField.name} → ${cloudCustomField.id} (Cloud name: ${cloudCustomField.name})`,
          );
        } else {
          customFieldsNotFound++;
          logger.warn(`Custom field not found in Cloud: ${dcCustomField.name}`);
        }
      }
      logger.info(
        `✓ Custom Fields: ${customFieldsMapped} mapped, ${customFieldsNotFound} not found`,
      );
    }

    // Auto-populate Status IDs
    if (mappingData.statuses) {
      logger.info("\nStep 2.4: Auto-populating Status IDs...");
      logger.info("Fetching all statuses from Cloud instance...");
      const cloudStatuses = await jiraClient.getPaginatedData(
        cloudUsername,
        cloudApiToken,
        cloudSiteUrl,
        "/status",
      );
      logger.info(`Found ${cloudStatuses.length} statuses in Cloud`);

      for (const dcStatus of mappingData.statuses) {
        if (dcStatus.cloud_id) {
          // Already populated
          continue;
        }

        // Match by name and category (more precise)
        const cloudStatus = cloudStatuses.find(
          (cs) =>
            cs.name === dcStatus.name &&
            cs.statusCategory?.key?.toLowerCase() ===
              dcStatus.category?.toLowerCase(),
        );
        if (cloudStatus) {
          dcStatus.cloud_id = cloudStatus.id;
          statusesMapped++;
          logger.debug(`Mapped status: ${dcStatus.name} → ${cloudStatus.id}`);
        } else {
          // Try matching by name only as fallback
          const cloudStatusByName = cloudStatuses.find(
            (cs) => cs.name === dcStatus.name,
          );
          if (cloudStatusByName) {
            dcStatus.cloud_id = cloudStatusByName.id;
            statusesMapped++;
            logger.debug(
              `Mapped status (by name only): ${dcStatus.name} → ${cloudStatusByName.id}`,
            );
          } else {
            statusesNotFound++;
            logger.warn(`Status not found in Cloud: ${dcStatus.name}`);
          }
        }
      }
      logger.info(
        `✓ Statuses: ${statusesMapped} mapped, ${statusesNotFound} not found`,
      );
    }

    // Auto-populate User Account IDs
    if (mappingData.users) {
      logger.info("\nStep 2.5: Auto-populating User Account IDs...");
      logger.info(
        "Note: User mapping requires fetching users. This may take a moment...",
      );

      try {
        // Fetch all users from Cloud
        const cloudUsers = await jiraClient.getPaginatedData(
          cloudUsername,
          cloudApiToken,
          cloudSiteUrl,
          "/users/search",
        );
        logger.info(`Found ${cloudUsers.length} users in Cloud`);

        for (const dcUser of mappingData.users) {
          if (dcUser.cloud_account_id) {
            // Already populated
            continue;
          }

          // Match by email (most reliable)
          let cloudUser = null;
          if (dcUser.email) {
            cloudUser = cloudUsers.find(
              (cu) => cu.emailAddress === dcUser.email,
            );
          }

          // Fallback: match by display name if email not found
          if (!cloudUser && dcUser.display_name) {
            cloudUser = cloudUsers.find(
              (cu) => cu.displayName === dcUser.display_name,
            );
          }

          if (cloudUser) {
            dcUser.cloud_account_id = cloudUser.accountId;
            usersMapped++;
            logger.debug(
              `Mapped user: ${dcUser.display_name} (${dcUser.email}) → ${cloudUser.accountId}`,
            );
          } else {
            usersNotFound++;
            logger.warn(
              `User not found in Cloud: ${dcUser.display_name} (${dcUser.email})`,
            );
          }
        }
        logger.info(
          `✓ Users: ${usersMapped} mapped, ${usersNotFound} not found`,
        );
      } catch (error) {
        logger.warn(
          `Could not fetch Cloud users (may require additional permissions): ${error.message}`,
        );
        logger.warn(
          "User mapping skipped. You may need to populate these manually.",
        );
      }
    }

    // Auto-populate Resolutions (if present)
    if (mappingData.resolutions) {
      logger.info("\nStep 2.6: Auto-populating Resolution IDs...");
      logger.info("Fetching all resolutions from Cloud instance...");
      const cloudResolutions = await jiraClient.getPaginatedData(
        cloudUsername,
        cloudApiToken,
        cloudSiteUrl,
        "/resolution",
      );
      logger.info(`Found ${cloudResolutions.length} resolutions in Cloud`);

      for (const dcResolution of mappingData.resolutions) {
        if (dcResolution.cloud_id) {
          continue;
        }

        const cloudResolution = cloudResolutions.find(
          (cr) => cr.name === dcResolution.name,
        );
        if (cloudResolution) {
          dcResolution.cloud_id = cloudResolution.id;
          resolutionsMapped++;
          logger.debug(
            `Mapped resolution: ${dcResolution.name} → ${cloudResolution.id}`,
          );
        } else {
          resolutionsNotFound++;
          logger.warn(`Resolution not found in Cloud: ${dcResolution.name}`);
        }
      }
      logger.info(
        `✓ Resolutions: ${resolutionsMapped} mapped, ${resolutionsNotFound} not found`,
      );
    }

    // Auto-populate Priorities (if present)
    if (mappingData.priorities) {
      logger.info("\nStep 2.7: Auto-populating Priority IDs...");
      logger.info("Fetching all priorities from Cloud instance...");
      const cloudPriorities = await jiraClient.getPaginatedData(
        cloudUsername,
        cloudApiToken,
        cloudSiteUrl,
        "/priority",
      );
      logger.info(`Found ${cloudPriorities.length} priorities in Cloud`);

      for (const dcPriority of mappingData.priorities) {
        if (dcPriority.cloud_id) {
          continue;
        }

        const cloudPriority = cloudPriorities.find(
          (cp) => cp.name === dcPriority.name,
        );
        if (cloudPriority) {
          dcPriority.cloud_id = cloudPriority.id;
          prioritiesMapped++;
          logger.debug(
            `Mapped priority: ${dcPriority.name} → ${cloudPriority.id}`,
          );
        } else {
          prioritiesNotFound++;
          logger.warn(`Priority not found in Cloud: ${dcPriority.name}`);
        }
      }
      logger.info(
        `✓ Priorities: ${prioritiesMapped} mapped, ${prioritiesNotFound} not found`,
      );
    }

    // Save updated mapping file
    logger.info("\nStep 2.8: Saving updated mapping file...");
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .split("T")[0];
    const updatedMappingFilename = `datacenter_cloud_mapping_populated_${timestamp}.json`;
    const updatedMappingPath = path.join(process.cwd(), updatedMappingFilename);

    await fs.writeFile(
      updatedMappingPath,
      JSON.stringify(mappingData, null, 2),
      "utf8",
    );
    logger.info(`✓ Updated mapping file saved: ${updatedMappingFilename}`);

    logger.info("\n=== Auto-Population Summary ===");
    logger.info(
      `Projects: ${projectsMapped} mapped, ${projectsNotFound} not found`,
    );
    logger.info(
      `Issue Types: ${issueTypesMapped} mapped, ${issueTypesNotFound} not found`,
    );
    if (mappingData.custom_fields) {
      logger.info(
        `Custom Fields: ${customFieldsMapped} mapped, ${customFieldsNotFound} not found`,
      );
    }
    if (mappingData.statuses) {
      logger.info(
        `Statuses: ${statusesMapped} mapped, ${statusesNotFound} not found`,
      );
    }
    if (mappingData.users) {
      logger.info(`Users: ${usersMapped} mapped, ${usersNotFound} not found`);
    }
    if (mappingData.resolutions) {
      logger.info(
        `Resolutions: ${resolutionsMapped} mapped, ${resolutionsNotFound} not found`,
      );
    }
    if (mappingData.priorities) {
      logger.info(
        `Priorities: ${prioritiesMapped} mapped, ${prioritiesNotFound} not found`,
      );
    }

    const totalNotFound =
      projectsNotFound +
      issueTypesNotFound +
      customFieldsNotFound +
      statusesNotFound +
      usersNotFound +
      resolutionsNotFound +
      prioritiesNotFound;

    if (totalNotFound > 0) {
      logger.warn(
        `\n⚠️  WARNING: ${totalNotFound} entities could not be mapped automatically.`,
      );
      logger.warn(
        "Please review the updated mapping file and manually populate missing Cloud IDs if needed.",
      );
    }

    await waitForEnter(
      rl,
      "\nPress Enter to continue to Phase 3 (Fix Automation Rules)...",
    );

    // ===== PHASE 3: FIX AUTOMATION RULES =====
    logger.info("\n" + "=".repeat(60));
    logger.info("PHASE 3: FIX AUTOMATION RULES");
    logger.info("=".repeat(60));

    // Get automation.json file
    const automationFile = await question(
      rl,
      "\nEnter the path to your automation.json file: ",
    );
    const automationPath = path.resolve(automationFile.trim());

    // Check if file exists
    try {
      await fs.access(automationPath);
    } catch (error) {
      logger.error(`Automation file not found: ${automationPath}`);
      return;
    }

    logger.info(`Reading automation file: ${automationPath}`);
    const automationContent = await fs.readFile(automationPath, "utf8");
    const automationRules = JSON.parse(automationContent);

    // Handle both array format and {rules: [...]} format
    const rulesArray = Array.isArray(automationRules)
      ? automationRules
      : automationRules.rules && Array.isArray(automationRules.rules)
        ? automationRules.rules
        : [];
    logger.info(`Loaded ${rulesArray.length} automation rules from file`);

    // Count enabled vs disabled rules
    const enabledRules = rulesArray.filter((r) => r.state === "ENABLED").length;
    const disabledRules = rulesArray.filter(
      (r) => r.state === "DISABLED",
    ).length;
    logger.info(`  - Enabled: ${enabledRules}`);
    logger.info(`  - Disabled: ${disabledRules}`);

    // Load mappings from the updated file
    logger.info("\nStep 3.1: Loading updated mappings...");
    const mappings =
      await mappingService.loadMappingsFromFile(updatedMappingPath);
    logger.info("✓ Mappings loaded successfully");

    // Confirm fixing
    const confirmFix = await confirm(
      rl,
      "\nProceed with fixing IDs in automation rules? (yes/no): ",
    );
    if (!confirmFix) {
      logger.info("Fix cancelled by user");
      logger.info(`Updated mapping file saved at: ${updatedMappingPath}`);
      return;
    }

    // Fix the rules
    logger.info("\nStep 3.2: Fixing IDs in automation rules...");

    // Log default account ID if provided
    if (defaultAccountId) {
      logger.info(
        `Using default account ID for unmapped users: ${defaultAccountId}`,
      );
    } else {
      logger.warn(
        "No default account ID provided - unmapped users will keep original IDs (may cause import issues)",
      );
    }

    const fixedRules = mappingService.fixAutomationRules(
      rulesArray,
      mappings,
      cloudId,
      defaultAccountId,
      false,  // isCloudSource=false → DC-to-Cloud transformations
      true,   // filterUnmapped=true → skip rules with unmapped IDs (safer for DC)
    );

    // Generate output filename
    const outputFilename = `automation_rules_fixed_cloud_${timestamp}.json`;
    const outputPath = path.join(process.cwd(), outputFilename);

    // Write fixed rules to file (Cloud import expects {"cloud": true, "rules": [...]} format)
    logger.info(`\nStep 3.3: Writing fixed rules to: ${outputFilename}`);
    // fixedRules is already in correct format: {cloud: true, rules: [...]}
    await fs.writeFile(outputPath, JSON.stringify(fixedRules, null, 2), "utf8");

    // Recalculate enabled/disabled counts from FILTERED rules (not original input)
    const filteredEnabledRules = fixedRules.rules.filter(
      (r) => r.state === "ENABLED",
    ).length;
    const filteredDisabledRules = fixedRules.rules.filter(
      (r) => r.state === "DISABLED",
    ).length;

    logger.info("\n" + "=".repeat(60));
    logger.info("PHASE 3 COMPLETE - RULES FIXED");
    logger.info("=".repeat(60));
    logger.info(`✓ Fixed automation rules saved: ${outputFilename}`);
    logger.info(`✓ Total rules after filtering: ${fixedRules.rules.length}`);
    logger.info(`  - Enabled: ${filteredEnabledRules}`);
    logger.info(`  - Disabled: ${filteredDisabledRules}`);
    logger.info(`\nOriginal Data Center rules: ${rulesArray.length}`);
    logger.info(`  - Enabled: ${enabledRules}`);
    logger.info(`  - Disabled: ${disabledRules}`);

    // ===== PHASE 4: SYNC RULE STATES IN CLOUD =====
    logger.info("\n" + "=".repeat(60));
    logger.info("PHASE 4: SYNC RULE STATES IN CLOUD");
    logger.info("=".repeat(60));

    logger.info(
      "\n⚠️  IMPORTANT: The Cloud import will import all rules as DISABLED.",
    );
    logger.info(
      "After importing, this script will automatically enable/disable rules to match Data Center.",
    );
    logger.info("\nPlease follow these steps:");
    logger.info(`1. Open your Cloud Jira: https://${cloudSiteUrl}`);
    logger.info("2. Go to: Settings → System → Automation Rules");
    logger.info("3. Click 'Import' button");
    logger.info(`4. Upload the file: ${outputFilename}`);
    logger.info("5. Wait for the import to complete");

    const importConfirm = await confirm(
      rl,
      "\nHave you completed the import in Cloud? (yes/no): ",
    );

    // Initialize state sync counters
    let stateSyncEnabledCount = 0;
    let stateSyncDisabledCount = 0;
    let stateSyncSkippedCount = 0;
    let stateSyncFailedCount = 0;
    let stateSyncPerformed = false;

    if (!importConfirm) {
      logger.info(
        "\nPhase 4 skipped. You can manually enable/disable rules later.",
      );
      logger.info(
        "Or re-run this mode and skip directly to Phase 4 when prompted.",
      );
    } else {
      stateSyncPerformed = true;
      // Get all rules from Cloud after import
      logger.info("\nStep 4.1: Fetching imported rules from Cloud...");
      const ruleService = require("../services/ruleService");
      const cloudRules = await ruleService.getAllRules(
        cloudUsername,
        cloudApiToken,
        cloudSiteUrl,
        cloudId,
        "jira",
        true, // include disabled
      );
      logger.info(`Found ${cloudRules.length} rules in Cloud`);

      // Build a map of rule name → desired state from fixedRules
      // WARNING: This uses rule names which might not be unique!
      const desiredStateMap = new Map();
      const desiredRuleNames = new Set();
      for (const rule of fixedRules.rules) {
        desiredStateMap.set(rule.name, rule.state);
        desiredRuleNames.add(rule.name);
      }

      // Build set of Cloud rule names for comparison
      const cloudRuleNames = new Set(cloudRules.map((r) => r.name));

      // Check for rules that might be missing from Cloud
      const missingFromCloud = Array.from(desiredRuleNames).filter(
        (name) => !cloudRuleNames.has(name),
      );
      if (missingFromCloud.length > 0) {
        logger.warn(
          `\n⚠️  WARNING: ${missingFromCloud.length} rules from Data Center not found in Cloud after import!`,
        );
        logger.warn("This could mean the import failed for these rules:");
        missingFromCloud.slice(0, 10).forEach((name) => {
          logger.warn(`  - ${name}`);
        });
        if (missingFromCloud.length > 10) {
          logger.warn(`  ... and ${missingFromCloud.length - 10} more`);
        }
      }

      // Sync states
      logger.info("\nStep 4.2: Syncing rule states...");
      logger.info("This may take several minutes for large rule sets...");

      for (const cloudRule of cloudRules) {
        const desiredState = desiredStateMap.get(cloudRule.name);

        if (!desiredState) {
          // Rule exists in Cloud but not in our import (probably pre-existing)
          stateSyncSkippedCount++;
          logger.debug(`Skipped rule (not in import): ${cloudRule.name}`);
          continue;
        }

        // Check if state needs to be changed
        if (cloudRule.state === desiredState) {
          stateSyncSkippedCount++;
          logger.debug(
            `Rule already in correct state: ${cloudRule.name} (${desiredState})`,
          );
          continue;
        }

        // Change state
        if (desiredState === "ENABLED") {
          const success = await ruleService.enableRule(
            cloudUsername,
            cloudApiToken,
            cloudSiteUrl,
            cloudId,
            cloudRule.uuid,
            "jira",
          );
          if (success) {
            stateSyncEnabledCount++;
          } else {
            stateSyncFailedCount++;
            logger.warn(`Failed to enable rule: ${cloudRule.name}`);
          }
        } else if (desiredState === "DISABLED") {
          const success = await ruleService.disableRule(
            cloudUsername,
            cloudApiToken,
            cloudSiteUrl,
            cloudId,
            cloudRule.uuid,
            "jira",
          );
          if (success) {
            stateSyncDisabledCount++;
          } else {
            stateSyncFailedCount++;
            logger.warn(`Failed to disable rule: ${cloudRule.name}`);
          }
        }
      }

      logger.info("\n" + "=".repeat(60));
      logger.info("RULE STATE SYNC COMPLETE");
      logger.info("=".repeat(60));
      logger.info(`✓ Enabled: ${stateSyncEnabledCount} rules`);
      logger.info(`✓ Disabled: ${stateSyncDisabledCount} rules`);
      logger.info(
        `  Skipped (already correct): ${stateSyncSkippedCount} rules`,
      );
      if (stateSyncFailedCount > 0) {
        logger.warn(`  ⚠️  Failed: ${stateSyncFailedCount} rules`);
      }
      if (missingFromCloud.length > 0) {
        logger.warn(
          `  ⚠️  Missing from Cloud: ${missingFromCloud.length} rules (import may have failed)`,
        );
      }

      // Validation check - use FILTERED rule counts (what we actually exported)
      const totalExpected = filteredEnabledRules + filteredDisabledRules;
      const totalInCloud = cloudRules.length;
      if (totalInCloud < totalExpected) {
        logger.warn(
          `\n⚠️  WARNING: Expected ${totalExpected} rules in Cloud, but found ${totalInCloud}`,
        );
        logger.warn(
          `${totalExpected - totalInCloud} rules are missing - the import may have failed!`,
        );
      }
    }

    // Final summary
    logger.info("\n" + "=".repeat(60));
    logger.info("DATA CENTER TO CLOUD MIGRATION COMPLETE");
    logger.info("=".repeat(60));
    logger.info(`✓ Updated mapping file: ${updatedMappingFilename}`);
    logger.info(`✓ Fixed automation rules: ${outputFilename}`);
    logger.info(`✓ Total rules processed: ${fixedRules.rules.length}`);
    logger.info("\nNext steps:");
    logger.info("1. Review the updated mapping file for any missing Cloud IDs");
    logger.info(
      "2. Test the automation rules in Cloud to ensure they work correctly",
    );
    logger.info(
      "3. Verify that enabled/disabled states match your Data Center instance",
    );

    logEvidence("datacenter-to-cloud", {
      cloudSiteUrl,
      cloudId,
      inputMappingFile: mappingFilePath,
      outputMappingFile: updatedMappingFilename,
      inputAutomationFile: automationPath,
      outputAutomationFile: outputFilename,
      totalRulesProcessed: fixedRules.rules.length,
      enabledRulesInDataCenter: enabledRules,
      disabledRulesInDataCenter: disabledRules,
      stateSyncPerformed,
      stateSyncEnabledCount,
      stateSyncDisabledCount,
      stateSyncSkippedCount,
      stateSyncFailedCount,
      projectsMapped,
      projectsNotFound,
      issueTypesMapped,
      issueTypesNotFound,
      customFieldsMapped,
      customFieldsNotFound,
      statusesMapped,
      statusesNotFound,
      usersMapped,
      usersNotFound,
      resolutionsMapped,
      resolutionsNotFound,
      prioritiesMapped,
      prioritiesNotFound,
      totalNotFound,
    });
  } catch (error) {
    logger.error(`Error in datacenter-to-cloud mode: ${error.message}`);
    logger.debug(error.stack);
    throw error;
  }
}

/**
 * Sync States mode - Independently sync enable/disable states from JSON file to Cloud
 * @param {readline.Interface} rl - Readline interface for user input
 * @param {string} rulesFilePath - Path to the automation rules JSON file
 * @param {string} cloudUsername - Cloud username/email
 * @param {string} cloudApiToken - Cloud API token
 * @param {string} cloudSiteUrl - Cloud site URL
 * @param {string} cloudId - Cloud ID
 */
async function syncStatesMode(
  rl,
  rulesFilePath,
  cloudUsername,
  cloudApiToken,
  cloudSiteUrl,
  cloudId,
) {
  try {
    logger.info("=== Sync Rule States Mode ===");
    logger.info(
      "This mode will sync enable/disable states from your JSON file to Cloud.",
    );

    // Step 1: Load the rules file
    logger.info("\nStep 1: Loading automation rules file...");
    logger.info(`Reading: ${rulesFilePath}`);
    const rulesData = await fs.readFile(rulesFilePath, "utf8");
    const rulesJson = JSON.parse(rulesData);

    // Handle both formats: {cloud: true, rules: [...]} or just [...]
    const rulesArray = rulesJson.rules || rulesJson;

    if (!Array.isArray(rulesArray)) {
      throw new Error("Invalid rules file format: expected array of rules");
    }

    logger.info(`✓ Loaded ${rulesArray.length} rules from file`);

    const enabledInFile = rulesArray.filter(
      (r) => r.state === "ENABLED",
    ).length;
    const disabledInFile = rulesArray.filter(
      (r) => r.state === "DISABLED",
    ).length;
    logger.info(`  - Enabled: ${enabledInFile}`);
    logger.info(`  - Disabled: ${disabledInFile}`);

    // Step 2: Get all rules from Cloud
    logger.info("\nStep 2: Fetching rules from Cloud...");
    const cloudRules = await ruleService.getAllRules(
      cloudUsername,
      cloudApiToken,
      cloudSiteUrl,
      cloudId,
      "jira",
      true, // include disabled
    );
    logger.info(`✓ Found ${cloudRules.length} rules in Cloud`);

    // Step 3: Build mapping and compare
    logger.info("\nStep 3: Building rule state mapping...");
    const desiredStateMap = new Map();
    const desiredRuleNames = new Set();

    for (const rule of rulesArray) {
      desiredStateMap.set(rule.name, rule.state);
      desiredRuleNames.add(rule.name);
    }

    // Build set of Cloud rule names for comparison
    const cloudRuleNames = new Set(cloudRules.map((r) => r.name));

    // Check for rules that might be missing from Cloud
    const missingFromCloud = Array.from(desiredRuleNames).filter(
      (name) => !cloudRuleNames.has(name),
    );

    if (missingFromCloud.length > 0) {
      logger.warn(
        `\n⚠️  WARNING: ${missingFromCloud.length} rules from file not found in Cloud!`,
      );
      logger.warn("These rules may not have been imported yet:");
      missingFromCloud.slice(0, 10).forEach((name) => {
        logger.warn(`  - ${name}`);
      });
      if (missingFromCloud.length > 10) {
        logger.warn(`  ... and ${missingFromCloud.length - 10} more`);
      }

      const continueAnyway = await confirm(
        rl,
        "\nContinue with state sync for existing rules? (yes/no): ",
      );

      if (!continueAnyway) {
        logger.info("State sync cancelled.");
        return;
      }
    }

    // Step 4: Sync states
    logger.info("\nStep 4: Syncing rule states...");
    logger.info("This may take several minutes for large rule sets...");

    let stateSyncEnabledCount = 0;
    let stateSyncDisabledCount = 0;
    let stateSyncSkippedCount = 0;
    let stateSyncFailedCount = 0;
    const failedRules = [];

    for (const cloudRule of cloudRules) {
      const desiredState = desiredStateMap.get(cloudRule.name);

      if (!desiredState) {
        // Rule exists in Cloud but not in our file (probably pre-existing)
        stateSyncSkippedCount++;
        logger.debug(`Skipped rule (not in file): ${cloudRule.name}`);
        continue;
      }

      // Check if state needs to be changed
      if (cloudRule.state === desiredState) {
        stateSyncSkippedCount++;
        logger.debug(
          `Rule already in correct state: ${cloudRule.name} (${desiredState})`,
        );
        continue;
      }

      // Change state
      logger.info(
        `Updating ${cloudRule.name}: ${cloudRule.state} → ${desiredState}`,
      );

      if (desiredState === "ENABLED") {
        const success = await ruleService.enableRule(
          cloudUsername,
          cloudApiToken,
          cloudSiteUrl,
          cloudId,
          cloudRule.uuid,
          "jira",
        );
        if (success) {
          stateSyncEnabledCount++;
        } else {
          stateSyncFailedCount++;
          failedRules.push({ name: cloudRule.name, action: "enable" });
          logger.warn(`Failed to enable rule: ${cloudRule.name}`);
        }
      } else if (desiredState === "DISABLED") {
        const success = await ruleService.disableRule(
          cloudUsername,
          cloudApiToken,
          cloudSiteUrl,
          cloudId,
          cloudRule.uuid,
          "jira",
        );
        if (success) {
          stateSyncDisabledCount++;
        } else {
          stateSyncFailedCount++;
          failedRules.push({ name: cloudRule.name, action: "disable" });
          logger.warn(`Failed to disable rule: ${cloudRule.name}`);
        }
      }
    }

    // Final summary
    logger.info("\n" + "=".repeat(60));
    logger.info("RULE STATE SYNC COMPLETE");
    logger.info("=".repeat(60));
    logger.info(`✓ Enabled: ${stateSyncEnabledCount} rules`);
    logger.info(`✓ Disabled: ${stateSyncDisabledCount} rules`);
    logger.info(`  Skipped (already correct): ${stateSyncSkippedCount} rules`);

    if (stateSyncFailedCount > 0) {
      logger.warn(`  ⚠️  Failed: ${stateSyncFailedCount} rules`);
    }

    if (missingFromCloud.length > 0) {
      logger.warn(
        `  ⚠️  Missing from Cloud: ${missingFromCloud.length} rules (not imported yet)`,
      );
    }

    // Display failed rules list
    if (failedRules.length > 0) {
      logger.info("\n" + "=".repeat(60));
      logger.info("FAILED RULES - MANUAL ACTION REQUIRED");
      logger.info("=".repeat(60));
      logger.info(
        `\nThe following ${failedRules.length} rule(s) failed to ${failedRules[0].action}:`,
      );
      logger.info(
        "Please manually review and enable/disable these rules in Jira Cloud UI:\n",
      );

      failedRules.forEach((rule, index) => {
        logger.info(`  ${index + 1}. ${rule.name}`);
      });

      logger.info("\n" + "=".repeat(60));
    }

    logger.info("\n✓ State synchronization complete!");

    logEvidence("sync-states", {
      rulesFile: rulesFilePath,
      cloudSiteUrl,
      cloudId,
      totalRulesInFile: rulesArray.length,
      enabledInFile,
      disabledInFile,
      totalRulesInCloud: cloudRules.length,
      stateSyncEnabledCount,
      stateSyncDisabledCount,
      stateSyncSkippedCount,
      stateSyncFailedCount,
      missingFromCloud: missingFromCloud.length,
    });
  } catch (error) {
    logger.error(`Error in sync-states mode: ${error.message}`);
    logger.debug(error.stack);
    throw error;
  }
}

module.exports = {
  generateJsonMode,
  fixJsonMode,
  importJsonMode,
  datacenterToCloudMode,
  syncStatesMode,
};
