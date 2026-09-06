/**
 * Consolidation Modes - Interactive migration with status checking
 */

const { logger } = require("../utils/logger");
const { question, confirm, waitForEnter } = require("../utils/input");
const ruleService = require("../services/ruleService");

/**
 * Validate rule state
 * @param {string} state - Rule state
 * @param {string} ruleName - Rule name for logging
 * @param {string} source - Source identifier (for logging)
 * @returns {string} Validated state
 */
function validateState(state, ruleName, source = "") {
  if (!["ENABLED", "DISABLED", "UNKNOWN"].includes(state)) {
    logger.warn(
      `Unexpected state '${state}' for rule '${ruleName}'${source ? " in " + source : ""}, treating as UNKNOWN`,
    );
    return "UNKNOWN";
  }
  return state;
}

/**
 * Consolidation dual source mode: Compare target with 2 source instances
 * and set enable/disable status based on consensus from both sources
 *
 * ⚠️ IMPORTANT: This mode relies on rule names being unique and consistent across all instances.
 */
async function consolidationDualSourceMode(
  rl,
  source1Username,
  source1ApiToken,
  source1SiteUrl,
  source1CloudId,
  source2Username,
  source2ApiToken,
  source2SiteUrl,
  source2CloudId,
  targetUsername,
  targetApiToken,
  targetSiteUrl,
  targetCloudId,
  product = "jira",
) {
  logger.info("=== CONSOLIDATION DUAL SOURCE MODE ===");
  logger.info(
    "This mode will compare target instance with 2 source instances and set rule states accordingly.",
  );

  // Step 1: Get rules from all instances
  logger.info("\n[STEP 1] Fetching automation rules from all instances...");

  await waitForEnter(
    rl,
    "Press Enter to fetch rules from first source instance...",
  );
  // FIXED: Pass both siteUrl and cloudId
  const source1Rules = await ruleService.getAllRules(
    source1Username,
    source1ApiToken,
    source1SiteUrl,
    source1CloudId,
    product,
  );
  logger.info(`✓ Found ${source1Rules.length} rules in first source instance`);

  await waitForEnter(
    rl,
    "Press Enter to fetch rules from second source instance...",
  );
  const source2Rules = await ruleService.getAllRules(
    source2Username,
    source2ApiToken,
    source2SiteUrl,
    source2CloudId,
    product,
  );
  logger.info(`✓ Found ${source2Rules.length} rules in second source instance`);

  await waitForEnter(rl, "Press Enter to fetch rules from target instance...");
  const targetRules = await ruleService.getAllRules(
    targetUsername,
    targetApiToken,
    targetSiteUrl,
    targetCloudId,
    product,
  );
  logger.info(`✓ Found ${targetRules.length} rules in target instance`);

  // Step 2: Create rule lookup dictionaries
  logger.info("\n[STEP 2] Creating rule lookup dictionaries...");

  const source1RulesByName = {};
  const source2RulesByName = {};
  const targetRulesByName = {};

  source1Rules.forEach((rule) => {
    source1RulesByName[rule.name || ""] = rule;
  });
  source2Rules.forEach((rule) => {
    source2RulesByName[rule.name || ""] = rule;
  });
  targetRules.forEach((rule) => {
    targetRulesByName[rule.name || ""] = rule;
  });

  // Step 3: Analyze and determine required changes
  logger.info(
    "\n[STEP 3] Analyzing rule states and determining required changes...",
  );

  const rulesToEnable = [];
  const rulesToDisable = [];
  const rulesNoChange = [];

  // Get all unique rule names across all instances
  const allRuleNames = new Set([
    ...Object.keys(source1RulesByName),
    ...Object.keys(source2RulesByName),
    ...Object.keys(targetRulesByName),
  ]);

  for (const ruleName of allRuleNames) {
    if (!ruleName.trim()) continue;

    const source1Rule = source1RulesByName[ruleName];
    const source2Rule = source2RulesByName[ruleName];
    const targetRule = targetRulesByName[ruleName];

    const sourceStates = [];
    if (source1Rule) sourceStates.push(source1Rule.state || "UNKNOWN");
    if (source2Rule) sourceStates.push(source2Rule.state || "UNKNOWN");

    if (sourceStates.length === 0) continue;

    let desiredState;

    if (source1Rule && source2Rule) {
      let source1State = validateState(
        source1Rule.state || "UNKNOWN",
        ruleName,
        "source1",
      );
      let source2State = validateState(
        source2Rule.state || "UNKNOWN",
        ruleName,
        "source2",
      );

      if (source1State === source2State) {
        desiredState = source1State;
      } else {
        desiredState = targetRule ? targetRule.state || "UNKNOWN" : "DISABLED";
        logger.warn(
          `Rule '${ruleName}' has conflicting states in sources (Source1: ${source1State}, Source2: ${source2State}). Keeping current state: ${desiredState}`,
        );
      }
    } else {
      const sourceRule = source1Rule || source2Rule;
      desiredState = validateState(sourceRule.state || "UNKNOWN", ruleName);
    }

    if (!targetRule) {
      logger.warn(
        `Rule '${ruleName}' exists in sources but not in target instance. Skipping.`,
      );
      continue;
    }

    const currentState = targetRule.state || "UNKNOWN";
    const uuid = targetRule.uuid || targetRule.id;

    if (desiredState === "ENABLED" && currentState !== "ENABLED") {
      if (ruleService.hasEmailAction(targetRule)) {
        logger.info(
          `⚠️  Skipping rule '${ruleName}' - contains email action, keeping disabled for safety`,
        );
        continue;
      }

      rulesToEnable.push({
        name: ruleName,
        uuid: uuid,
        current: currentState,
        desired: desiredState,
      });
    } else if (desiredState === "DISABLED" && currentState !== "DISABLED") {
      rulesToDisable.push({
        name: ruleName,
        uuid: uuid,
        current: currentState,
        desired: desiredState,
      });
    } else {
      rulesNoChange.push({ name: ruleName, state: currentState });
    }
  }

  // Step 4: Show summary and get confirmation
  logger.info("\n[STEP 4] Summary of changes required:");
  logger.info(`Rules to enable: ${rulesToEnable.length}`);
  for (const rule of rulesToEnable) {
    logger.info(
      `  - ${rule.name} (currently: ${rule.current} → ${rule.desired})`,
    );
  }

  logger.info(`Rules to disable: ${rulesToDisable.length}`);
  for (const rule of rulesToDisable) {
    logger.info(
      `  - ${rule.name} (currently: ${rule.current} → ${rule.desired})`,
    );
  }

  logger.info(`Rules no change: ${rulesNoChange.length}`);

  // Step 5: Execute changes if confirmed
  if (rulesToEnable.length > 0 || rulesToDisable.length > 0) {
    const changeChoice = await confirm(
      rl,
      `\nApply ${rulesToEnable.length + rulesToDisable.length} changes? (y/n): `,
    );

    if (changeChoice) {
      if (rulesToEnable.length > 0) {
        logger.info("\nEnabling rules...");
        let successCount = 0;
        for (const rule of rulesToEnable) {
          // FIXED: Pass both siteUrl and cloudId
          if (
            rule.uuid &&
            (await ruleService.enableRule(
              targetUsername,
              targetApiToken,
              targetSiteUrl,
              targetCloudId,
              rule.uuid,
              product,
            ))
          ) {
            successCount++;
            logger.info(`✓ Enabled ${rule.name}`);
          }
        }
        logger.info(
          `✅ Successfully enabled ${successCount}/${rulesToEnable.length} rules`,
        );
      }

      if (rulesToDisable.length > 0) {
        logger.info("\nDisabling rules...");
        let successCount = 0;
        for (const rule of rulesToDisable) {
          // FIXED: Pass both siteUrl and cloudId
          if (
            rule.uuid &&
            (await ruleService.disableRule(
              targetUsername,
              targetApiToken,
              targetSiteUrl,
              targetCloudId,
              rule.uuid,
              product,
            ))
          ) {
            successCount++;
            logger.info(`✓ Disabled ${rule.name}`);
          }
        }
        logger.info(
          `✅ Successfully disabled ${successCount}/${rulesToDisable.length} rules`,
        );
      }

      logger.info("✅ Dual-source consolidation completed successfully");
    } else {
      logger.info("Operation cancelled by user.");
    }
  } else {
    logger.info(
      "✅ No changes needed - target instance is already in sync with sources",
    );
  }
}

/**
 * Consolidation sandbox mode: Interactive sandbox-to-production migration
 *
 * ⚠️ IMPORTANT: This mode relies on rule names being unique and consistent across all instances.
 */
async function consolidationSandboxMode(
  rl,
  sourceUsername,
  sourceApiToken,
  sourceSiteUrl,
  sourceCloudId,
  targetUsername,
  targetApiToken,
  targetSiteUrl,
  targetCloudId,
  targetSandboxUsername,
  targetSandboxApiToken,
  targetSandboxSiteUrl,
  targetSandboxCloudId,
  product = "jira",
) {
  logger.info("=== CONSOLIDATION SANDBOX MODE ===");
  logger.info(
    "This mode will help you migrate automations from sandbox to production",
  );
  logger.info(
    "with interactive steps and status checking from target sandbox.",
  );

  logger.info(
    "\n[STEP 1] Fetching initial automation rules from all instances...",
  );

  await waitForEnter(
    rl,
    "Press Enter to fetch rules from source (sandbox) instance...",
  );
  // FIXED: Pass both siteUrl and cloudId
  const sourceRules = await ruleService.getAllRules(
    sourceUsername,
    sourceApiToken,
    sourceSiteUrl,
    sourceCloudId,
    product,
  );
  logger.info(
    `✓ Found ${sourceRules.length} rules in source (sandbox) instance`,
  );

  await waitForEnter(
    rl,
    "Press Enter to fetch rules from target (production) instance...",
  );
  const targetRules = await ruleService.getAllRules(
    targetUsername,
    targetApiToken,
    targetSiteUrl,
    targetCloudId,
    product,
  );
  logger.info(
    `✓ Found ${targetRules.length} rules in target (production) instance`,
  );

  await waitForEnter(
    rl,
    "Press Enter to fetch rules from target sandbox instance...",
  );
  const targetSandboxRules = await ruleService.getAllRules(
    targetSandboxUsername,
    targetSandboxApiToken,
    targetSandboxSiteUrl,
    targetSandboxCloudId,
    product,
  );
  logger.info(
    `✓ Found ${targetSandboxRules.length} rules in target sandbox instance`,
  );

  logger.info("\n[STEP 2] Analyzing current automation states...");

  const sourceRuleNames = new Set(
    sourceRules.map((r, i) => r.name || `rule_${i}`),
  );
  const targetRuleNames = new Set(
    targetRules.map((r, i) => r.name || `rule_${i}`),
  );
  const targetSandboxRuleNames = new Set(
    targetSandboxRules.map((r, i) => r.name || `rule_${i}`),
  );

  const newRules = new Set(
    [...sourceRuleNames].filter((x) => !targetRuleNames.has(x)),
  );
  const existingRules = new Set(
    [...sourceRuleNames].filter((x) => targetRuleNames.has(x)),
  );

  logger.info(`New rules to potentially enable: ${newRules.size}`);
  logger.info(`Existing rules in both instances: ${existingRules.size}`);

  logger.info("\n[STEP 3] Import automations into target instance");
  logger.info(
    "Please import your automations into the target (production) instance now.",
  );
  logger.info(
    "You can use the Jira web interface or any other method you prefer.",
  );

  const continueImport = await confirm(
    rl,
    "\nHave you completed importing the automations? (y/n): ",
  );
  if (!continueImport) {
    logger.info("Operation cancelled by user.");
    return;
  }

  logger.info("\n[STEP 4] Re-fetching target instance rules after import...");
  const targetRulesAfter = await ruleService.getAllRules(
    targetUsername,
    targetApiToken,
    targetSiteUrl,
    targetCloudId,
    product,
  );
  logger.info(
    `✓ Found ${targetRulesAfter.length} rules in target after import`,
  );

  logger.info("\n[STEP 5] Determining which rules should be enabled...");

  const targetRulesAfterNames = new Set(
    targetRulesAfter.map((r, i) => r.name || `rule_${i}`),
  );
  const actuallyNewRules = new Set(
    [...targetRulesAfterNames].filter((x) => !targetRuleNames.has(x)),
  );

  const targetDisabledRules = targetRulesAfter.filter(
    (r) => r.state === "DISABLED",
  );

  const rulesToEnable = [];
  for (const rule of targetDisabledRules) {
    const ruleName = rule.name || "Unknown";
    validateState(rule.state || "UNKNOWN", ruleName);

    if (ruleService.hasEmailAction(rule)) {
      logger.info(
        `⚠️  Skipping rule '${ruleName}' - contains email action, keeping disabled`,
      );
      continue;
    }

    if (actuallyNewRules.has(ruleName)) {
      rulesToEnable.push(rule);
    } else if (targetSandboxRuleNames.has(ruleName)) {
      const sandboxRule = targetSandboxRules.find((r) => r.name === ruleName);
      if (sandboxRule) {
        const sandboxState = validateState(
          sandboxRule.state || "UNKNOWN",
          ruleName,
          "sandbox",
        );
        if (sandboxState === "ENABLED") {
          rulesToEnable.push(rule);
        }
      }
    }
  }

  if (rulesToEnable.length === 0) {
    logger.info("No rules need to be enabled.");
    return;
  }

  logger.info(`Found ${rulesToEnable.length} rules that should be enabled:`);
  for (const rule of rulesToEnable) {
    const ruleName = rule.name || "Unknown";
    const ruleState = rule.state || "Unknown";
    logger.info(`  - ${ruleName} (current state: ${ruleState})`);
  }

  const enableChoice = await confirm(
    rl,
    `\nEnable ${rulesToEnable.length} rules? (y/n): `,
  );
  if (enableChoice) {
    let successCount = 0;
    for (const rule of rulesToEnable) {
      const uuid = rule.uuid || rule.id;
      // FIXED: Pass both siteUrl and cloudId
      if (
        uuid &&
        (await ruleService.enableRule(
          targetUsername,
          targetApiToken,
          targetSiteUrl,
          targetCloudId,
          uuid,
          product,
        ))
      ) {
        successCount++;
      }
    }

    logger.info(
      `✅ Successfully enabled ${successCount}/${rulesToEnable.length} rules`,
    );
  } else {
    logger.info("Operation cancelled by user.");
  }
}

/**
 * Consolidation production mode: Interactive source-to-target migration
 *
 * ⚠️ IMPORTANT: This mode relies on rule names being unique and consistent across all instances.
 */
async function consolidationProdMode(
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
  logger.info("=== CONSOLIDATION PRODUCTION MODE ===");
  logger.info(
    "This mode will help you migrate automations from source to production",
  );
  logger.info("with interactive steps and status checking.");

  logger.info(
    "\n[STEP 1] Fetching initial automation rules from both instances...",
  );

  await waitForEnter(rl, "Press Enter to fetch rules from source instance...");
  // FIXED: Pass both siteUrl and cloudId
  const sourceRules = await ruleService.getAllRules(
    sourceUsername,
    sourceApiToken,
    sourceSiteUrl,
    sourceCloudId,
    product,
  );
  logger.info(`✓ Found ${sourceRules.length} rules in source instance`);

  await waitForEnter(
    rl,
    "Press Enter to fetch rules from target (production) instance...",
  );
  const targetRules = await ruleService.getAllRules(
    targetUsername,
    targetApiToken,
    targetSiteUrl,
    targetCloudId,
    product,
  );
  logger.info(
    `✓ Found ${targetRules.length} rules in target (production) instance`,
  );

  logger.info("\n[STEP 2] Analyzing current automation states...");

  const sourceRuleNames = new Set(
    sourceRules.map((r, i) => r.name || `rule_${i}`),
  );
  const targetRuleNames = new Set(
    targetRules.map((r, i) => r.name || `rule_${i}`),
  );

  const newRules = new Set(
    [...sourceRuleNames].filter((x) => !targetRuleNames.has(x)),
  );
  const existingRules = new Set(
    [...sourceRuleNames].filter((x) => targetRuleNames.has(x)),
  );

  logger.info(`New rules to potentially enable: ${newRules.size}`);
  logger.info(`Existing rules in both instances: ${existingRules.size}`);

  logger.info("\n[STEP 3] Import automations into target instance");
  logger.info(
    "Please import your automations into the target (production) instance now.",
  );
  logger.info(
    "You can use the Jira web interface or any other method you prefer.",
  );

  const continueImport = await confirm(
    rl,
    "\nHave you completed importing the automations? (y/n): ",
  );
  if (!continueImport) {
    logger.info("Operation cancelled by user.");
    return;
  }

  logger.info("\n[STEP 4] Re-fetching target instance rules after import...");
  const targetRulesAfter = await ruleService.getAllRules(
    targetUsername,
    targetApiToken,
    targetSiteUrl,
    targetCloudId,
    product,
  );
  logger.info(
    `✓ Found ${targetRulesAfter.length} rules in target after import`,
  );

  logger.info("\n[STEP 5] Determining which rules should be enabled...");

  const targetRulesAfterNames = new Set(
    targetRulesAfter.map((r, i) => r.name || `rule_${i}`),
  );
  const actuallyNewRules = new Set(
    [...targetRulesAfterNames].filter((x) => !targetRuleNames.has(x)),
  );

  const targetDisabledRules = targetRulesAfter.filter(
    (r) => r.state === "DISABLED",
  );
  const newDisabledRules = [];

  for (const rule of targetDisabledRules) {
    const ruleName = rule.name || "Unknown";
    validateState(rule.state || "UNKNOWN", ruleName);

    if (actuallyNewRules.has(ruleName)) {
      if (ruleService.hasEmailAction(rule)) {
        logger.info(
          `⚠️  Skipping rule '${ruleName}' - contains email action, keeping disabled`,
        );
        continue;
      }
      newDisabledRules.push(rule);
    }
  }

  if (newDisabledRules.length === 0) {
    logger.info("No new disabled rules found that need to be enabled.");
    return;
  }

  logger.info(`Found ${newDisabledRules.length} new disabled rules:`);
  for (const rule of newDisabledRules) {
    const ruleName = rule.name || "Unknown";
    logger.info(`  - ${ruleName}`);
  }

  const enableChoice = await confirm(
    rl,
    `\nEnable ${newDisabledRules.length} new disabled rules? (y/n): `,
  );
  if (enableChoice) {
    let successCount = 0;
    for (const rule of newDisabledRules) {
      const uuid = rule.uuid || rule.id;
      // FIXED: Pass both siteUrl and cloudId
      if (
        uuid &&
        (await ruleService.enableRule(
          targetUsername,
          targetApiToken,
          targetSiteUrl,
          targetCloudId,
          uuid,
          product,
        ))
      ) {
        successCount++;
      }
    }

    logger.info(
      `✅ Successfully enabled ${successCount}/${newDisabledRules.length} new rules`,
    );
  } else {
    logger.info("Operation cancelled by user.");
  }
}

module.exports = {
  consolidationDualSourceMode,
  consolidationSandboxMode,
  consolidationProdMode,
};
