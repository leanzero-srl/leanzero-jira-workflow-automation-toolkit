/**
 * Rule service - handles automation rule CRUD operations
 */

const { logger } = require("../utils/logger");
const jiraClient = require("../api/jiraClient");

/**
 * Filter rules by state, optionally excluding disabled rules
 * @param {Array} rules - List of rules to filter
 * @param {boolean} includeDisabled - Whether to include disabled rules (default: true)
 * @returns {Array} Filtered list of rules
 */
function filterRulesByState(rules, includeDisabled = true) {
  if (includeDisabled) {
    return rules;
  }
  return rules.filter((rule) => rule.state === "ENABLED");
}

/**
 * Check if an automation rule contains email actions
 * @param {Object} rule - Automation rule dictionary
 * @returns {boolean} True if rule contains email actions, false otherwise
 */
function hasEmailAction(rule) {
  try {
    // Check if rule has components
    if (!rule.components) {
      return false;
    }

    // Recursively check all components for email actions
    function checkComponents(components) {
      for (const component of components) {
        if (typeof component === "object" && component !== null) {
          // Check if this is an email action component
          if (
            component.component === "ACTION" &&
            component.type === "jira.issue.outgoing.email"
          ) {
            return true;
          }
          // Recursively check children
          if (component.children) {
            if (checkComponents(component.children)) {
              return true;
            }
          }
        }
      }
      return false;
    }

    return checkComponents(rule.components);
  } catch (error) {
    logger.warn(`Error checking for email actions in rule: ${error.message}`);
    return false;
  }
}

/**
 * Fetch all automation rule summaries from the instance, handling pagination
 * @param {string} username - User email
 * @param {string} apiToken - API token
 * @param {string} siteUrl - Jira site URL (e.g., yourdomain.atlassian.net)
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} product - Product type (jira or confluence)
 * @param {boolean} verbose - Verbose output
 * @returns {Promise<Array>} All automation rules
 */
async function getAllRules(
  username,
  apiToken,
  siteUrl,
  cloudId,
  product = "jira",
  verbose = false,
) {
  // FIXED: Correct URL structure according to OpenAPI spec
  const baseUrl = `https://${siteUrl}/gateway/api/automation/public/${product}/${cloudId}`;
  const allRules = [];
  let cursor = null;
  let pageCount = 0;

  logger.debug(`Fetching automation rules from site: ${siteUrl}`);
  logger.debug(`API base URL: ${baseUrl}`);

  while (true) {
    pageCount++;
    const url = `${baseUrl}/rest/v1/rule/summary`;
    const params = { limit: 100 };
    if (cursor) {
      params.cursor = cursor;
    }

    const cursorDisplay =
      cursor && cursor.length > 20 ? cursor.substring(0, 20) + "..." : cursor;
    logger.debug(`Fetching page ${pageCount} (cursor: ${cursorDisplay})`);

    try {
      const data = await jiraClient.get(url, username, apiToken, params);

      logger.debug(`Page ${pageCount} fetch successful`);
      let rulesPage = [];

      // Handle response structure from OpenAPI spec
      if (data && data.data) {
        rulesPage = data.data;
      } else if (Array.isArray(data)) {
        rulesPage = data;
      }

      if (rulesPage.length > 0) {
        allRules.push(...rulesPage);
        logger.debug(
          `Added ${rulesPage.length} rules from page ${pageCount}. Total so far: ${allRules.length}`,
        );

        // Handle pagination using links from response
        if (data && data.links && data.links.next) {
          // Extract cursor from next link query params
          const nextLink = data.links.next;
          const match = nextLink.match(/cursor=([^&]+)/);
          if (match) {
            cursor = decodeURIComponent(match[1]);
          } else {
            cursor = null;
          }
        } else {
          cursor = null;
        }

        // Check if we have more data based on returned page size
        if (rulesPage.length < 100) {
          cursor = null;
        }
      } else {
        break;
      }
    } catch (error) {
      if (verbose) {
        logger.error(`Request error: ${error.message}`);
      }
      break;
    }

    if (pageCount > 100) {
      break;
    }

    if (!cursor) {
      break;
    }
  }

  logger.info(
    `✓ Fetched ${allRules.length} total rules across ${pageCount} pages`,
  );
  return allRules;
}

/**
 * Enable a single automation rule by its UUID
 * @param {string} username - User email
 * @param {string} apiToken - API token
 * @param {string} siteUrl - Jira site URL (e.g., yourdomain.atlassian.net)
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} ruleUuid - Rule UUID
 * @param {string} product - Product type (jira or confluence)
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
async function enableRule(
  username,
  apiToken,
  siteUrl,
  cloudId,
  ruleUuid,
  product = "jira",
) {
  // FIXED: Correct URL structure according to OpenAPI spec
  const baseUrl = `https://${siteUrl}/gateway/api/automation/public/${product}/${cloudId}`;
  const url = `${baseUrl}/rest/v1/rule/${ruleUuid}/state`;
  const payload = { value: "ENABLED" };

  logger.debug(`Attempting to enable rule ${ruleUuid} at ${url}`);

  try {
    const result = await jiraClient.put(url, username, apiToken, payload);
    if (result.status === 200) {
      logger.info(`✓ Successfully enabled rule with UUID ${ruleUuid}`);
      logger.debug(`Response: ${JSON.stringify(result.data)}`);
      return true;
    } else {
      logger.error(
        `✗ Failed to enable rule with UUID ${ruleUuid}. Status code: ${result.status}, Response: ${JSON.stringify(result.data)}`,
      );
      return false;
    }
  } catch (error) {
    logger.error(`✗ Error enabling rule ${ruleUuid}: ${error.message}`);
    logger.debug(
      `Exception details: ${error.constructor.name}: ${error.message}`,
    );
    return false;
  }
}

/**
 * Disable a single automation rule by its UUID
 * @param {string} username - User email
 * @param {string} apiToken - API token
 * @param {string} siteUrl - Jira site URL (e.g., yourdomain.atlassian.net)
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} ruleUuid - Rule UUID
 * @param {string} product - Product type (jira or confluence)
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
async function disableRule(
  username,
  apiToken,
  siteUrl,
  cloudId,
  ruleUuid,
  product = "jira",
) {
  // FIXED: Correct URL structure according to OpenAPI spec
  const baseUrl = `https://${siteUrl}/gateway/api/automation/public/${product}/${cloudId}`;
  const url = `${baseUrl}/rest/v1/rule/${ruleUuid}/state`;
  const payload = { value: "DISABLED" };

  logger.debug(`Attempting to disable rule ${ruleUuid} at ${url}`);

  try {
    const result = await jiraClient.put(url, username, apiToken, payload);
    if (result.status === 200) {
      logger.info(`✓ Successfully disabled rule with UUID ${ruleUuid}`);
      logger.debug(`Response: ${JSON.stringify(result.data)}`);
      return true;
    } else {
      logger.error(
        `✗ Failed to disable rule with UUID ${ruleUuid}. Status code: ${result.status}, Response: ${JSON.stringify(result.data)}`,
      );
      return false;
    }
  } catch (error) {
    logger.error(`✗ Error disabling rule ${ruleUuid}: ${error.message}`);
    logger.debug(
      `Exception details: ${error.constructor.name}: ${error.message}`,
    );
    return false;
  }
}

/**
 * Create a new automation rule
 * @param {string} username - User email
 * @param {string} apiToken - API token
 * @param {string} siteUrl - Jira site URL (e.g., yourdomain.atlassian.net)
 * @param {string} cloudId - Jira Cloud ID
 * @param {Object} rule - Rule configuration
 * @param {string} product - Product type (jira or confluence)
 * @returns {Promise<Object>} Creation result
 */
async function createRule(
  username,
  apiToken,
  siteUrl,
  cloudId,
  rule,
  product = "jira",
) {
  // FIXED: Correct URL structure according to OpenAPI spec
  const baseUrl = `https://${siteUrl}/gateway/api/automation/public/${product}/${cloudId}`;
  const url = `${baseUrl}/rest/v1/rule`;

  logger.debug(`Attempting to create rule at ${url}`);

  try {
    const result = await jiraClient.post(url, username, apiToken, rule);
    if (result.status === 201) {
      logger.info(`✓ Successfully created rule`);
      logger.debug(`Response: ${JSON.stringify(result.data)}`);
      return { success: true, data: result.data };
    } else {
      logger.error(
        `✗ Failed to create rule. Status code: ${result.status}, Response: ${JSON.stringify(result.data)}`,
      );
      return { success: false, error: result.data };
    }
  } catch (error) {
    logger.error(`✗ Error creating rule: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Update an existing automation rule IN PLACE (PUT /rule/{uuid}).
 * Body is the wrapped { rule: <CreateRulePayload>, connections: [] } shape (same
 * as createRule). Used by the reconcile-target mode to correct field references
 * without creating a new rule. Returns { success, data|error }.
 */
async function updateRule(
  username,
  apiToken,
  siteUrl,
  cloudId,
  ruleUuid,
  rule,
  product = "jira",
) {
  const baseUrl = `https://${siteUrl}/gateway/api/automation/public/${product}/${cloudId}`;
  const url = `${baseUrl}/rest/v1/rule/${ruleUuid}`;
  try {
    const result = await jiraClient.put(url, username, apiToken, rule);
    if (result.status >= 200 && result.status < 300) {
      logger.info(`✓ Updated rule ${ruleUuid}`);
      return { success: true, data: result.data };
    }
    logger.error(
      `✗ Failed to update rule ${ruleUuid}. Status ${result.status}: ${JSON.stringify(result.data)}`,
    );
    return { success: false, error: result.data, status: result.status };
  } catch (error) {
    logger.error(`✗ Error updating rule ${ruleUuid}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Get detailed rule configuration by UUID
 * @param {string} username - User email
 * @param {string} apiToken - API token
 * @param {string} siteUrl - Jira site URL (e.g., yourdomain.atlassian.net)
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} ruleUuid - Rule UUID
 * @param {string} product - Product type (jira or confluence)
 * @returns {Promise<Object>} Rule configuration
 */
async function getRuleByUuid(
  username,
  apiToken,
  siteUrl,
  cloudId,
  ruleUuid,
  product = "jira",
) {
  // FIXED: Correct URL structure according to OpenAPI spec
  const baseUrl = `https://${siteUrl}/gateway/api/automation/public/${product}/${cloudId}`;
  const url = `${baseUrl}/rest/v1/rule/${ruleUuid}`;

  logger.debug(`Fetching rule ${ruleUuid} from ${url}`);

  try {
    const result = await jiraClient.get(url, username, apiToken);
    logger.debug(`Successfully fetched rule ${ruleUuid}`);
    return result;
  } catch (error) {
    logger.error(`✗ Error fetching rule ${ruleUuid}: ${error.message}`);
    throw error;
  }
}

module.exports = {
  filterRulesByState,
  hasEmailAction,
  getAllRules,
  enableRule,
  disableRule,
  createRule,
  updateRule,
  getRuleByUuid,
};
