/**
 * Blanket Mode - Enable all disabled automations in target instance
 */

const { logger } = require("../utils/logger");
const { question, confirm } = require("../utils/input");
const ruleService = require("../services/ruleService");

/**
 * Blanket mode: Enable all disabled automations in target instance
 * @param {Object} rl - Readline interface
 * @param {string} username - User email
 * @param {string} apiToken - API token
 * @param {string} siteUrl - Site URL (e.g., yourcompany.atlassian.net)
 * @param {string} cloudId - Cloud ID
 * @param {string} product - Product name (default: jira)
 */
async function blanketMode(
  rl,
  username,
  apiToken,
  siteUrl,
  cloudId,
  product = "jira",
) {
  logger.info("=== BLANKET MODE ===");
  logger.info(
    "This mode will enable all disabled automations in the target instance.",
  );
  logger.info("⚠️  All operations will be logged for evidence");

  // FIXED: Pass both siteUrl and cloudId
  const rules = await ruleService.getAllRules(
    username,
    apiToken,
    siteUrl,
    cloudId,
    product,
  );

  if (!rules || rules.length === 0) {
    logger.error("No rules found");
    return;
  }

  // Show rule statistics
  const enabledCount = rules.filter((r) => r.state === "ENABLED").length;
  const disabledCount = rules.filter((r) => r.state === "DISABLED").length;
  logger.info(
    `Rules: ${rules.length} total (${enabledCount} enabled, ${disabledCount} disabled)`,
  );

  // Filter for disabled rules and apply safety checks
  const disabledRules = [];
  let skippedEmailRules = 0;

  logger.info(
    "\n[STEP 2] Filtering disabled rules and applying safety checks...",
  );
  for (const rule of rules) {
    if (rule.state === "DISABLED") {
      // Safety check: Skip rules with email actions to prevent accidental spam
      if (ruleService.hasEmailAction(rule)) {
        const ruleName = rule.name || "Unknown";
        logger.info(
          `⚠️  Skipping rule '${ruleName}' - contains email action, keeping disabled for safety`,
        );
        skippedEmailRules++;
        continue;
      }
      disabledRules.push(rule);
    }
  }

  if (disabledRules.length === 0) {
    logger.info("✅ All rules are already enabled or contain email actions!");
    if (skippedEmailRules > 0) {
      logger.info(
        `   (${skippedEmailRules} rules with email actions were skipped for safety)`,
      );
    }
    return;
  }

  logger.info(`Found ${disabledRules.length} disabled rules safe to enable`);
  if (skippedEmailRules > 0) {
    logger.info(
      `Skipped ${skippedEmailRules} rules with email actions for safety`,
    );
  }

  // Show rules to be enabled for confirmation
  logger.info("\nRules that will be enabled:");
  for (const rule of disabledRules) {
    const ruleName = rule.name || "Unknown";
    const ruleId = rule.uuid || rule.id;
    logger.info(
      `  - ${ruleName} (ID: ${ruleId ? ruleId.substring(0, 8) + "..." : "N/A"})`,
    );
  }

  // User confirmation before enabling
  const enableChoice = await confirm(
    rl,
    `\nEnable all ${disabledRules.length} disabled rules? (y/n): `,
  );

  if (!enableChoice) {
    logger.info("Operation cancelled by user. No rules were enabled.");
    return;
  }

  // Enable all disabled rules
  logger.info("\nEnabling disabled rules...");
  let successCount = 0;
  for (const rule of disabledRules) {
    const uuid = rule.uuid || rule.id;
    // FIXED: Pass both siteUrl and cloudId
    if (
      uuid &&
      (await ruleService.enableRule(
        username,
        apiToken,
        siteUrl,
        cloudId,
        uuid,
        product,
      ))
    ) {
      successCount++;
    }
  }

  logger.info(
    `✅ Successfully enabled ${successCount}/${disabledRules.length} rules`,
  );
}

module.exports = blanketMode;
