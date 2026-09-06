/**
 * Project service - handles project-related operations
 */

const { logger } = require("../utils/logger");
const jiraClient = require("../api/jiraClient");

/**
 * Get project IDs from Jira instance
 * @param {string} email - User email
 * @param {string} apiToken - API token
 * @param {string} siteUrl - Site URL (e.g., yourcompany.atlassian.net)
 * @returns {Promise<Array>} List of projects
 */
async function getProjectIds(email, apiToken, siteUrl) {
  logger.info(`Fetching project IDs from ${siteUrl}`);
  logger.debug(`API endpoint: https://${siteUrl}/rest/api/3/project`);

  const url = `https://${siteUrl}/rest/api/3/project`;

  try {
    const projects = await jiraClient.get(url, email, apiToken);
    logger.info(`Successfully retrieved ${projects.length} projects`);
    logger.debug(`Projects: ${projects.map((p) => p.key || "N/A").join(", ")}`);
    return projects;
  } catch (error) {
    logger.error(`Error fetching projects from ${siteUrl}: ${error.message}`);
    logger.debug(
      `Exception details: ${error.constructor.name}: ${error.message}`,
    );
    return [];
  }
}

/**
 * Interactive version of getProjectIds with user feedback
 * @param {string} username - User email
 * @param {string} apiToken - API token
 * @param {string} siteUrl - Site URL (e.g., yourcompany.atlassian.net)
 * @returns {Promise<Array>} List of project dictionaries
 */
async function getProjectIdsInteractive(username, apiToken, siteUrl) {
  logger.info(`Fetching project IDs from ${siteUrl}...`);

  try {
    const projects = await getProjectIds(username, apiToken, siteUrl);

    // Display projects for user reference
    for (const project of projects) {
      logger.info(`  - ${project.key}: ${project.name} (ID: ${project.id})`);
    }

    return projects;
  } catch (error) {
    logger.error(`Error fetching projects: ${error.message}`);
    return [];
  }
}

/**
 * Filter automation rules based on projects
 * @param {Array} automationRules - Array of automation rules
 * @param {Array} projects - List of project dictionaries
 * @returns {Object} Object containing filteredRules and filteredActiveRules
 */
function filterAutomationRules(automationRules, projects) {
  logger.info("Filtering automation rules by projects");
  logger.debug(`Received ${projects.length} projects for filtering`);

  // FIXED: Handle automation rules as an array, not object with .rules property
  const rules = Array.isArray(automationRules) ? automationRules : [];

  // Create project mappings
  const projectKeysFilter = new Set();
  const projectIdToKeyMapping = {};

  for (const project of projects) {
    const keyLower = project.key.trim().toLowerCase();
    const idStr = String(project.id).trim();
    projectKeysFilter.add(keyLower);
    projectIdToKeyMapping[idStr] = keyLower;
  }

  logger.debug(
    `Created project mappings for ${Object.keys(projectIdToKeyMapping).length} projects`,
  );

  // Filter rules
  const filteredRules = [];
  const filteredActiveRules = [];

  for (const rule of rules) {
    // FIXED: Check ruleScopeARIs property as per OpenAPI spec
    const resources = rule.ruleScopeARIs || [];
    const projectIds = resources
      .filter((resource) => resource.includes("project/"))
      .map((resource) => resource.split("project/")[1]);

    if (projectIds.length === 0) {
      // Global rule
      filteredRules.push(rule);
      if (rule.state === "ENABLED") {
        filteredActiveRules.push(rule);
      }
    } else {
      // Project-specific rule
      const cleanedIds = projectIds.map((id) => id.trim());
      const matchingProjects = cleanedIds.filter((projId) =>
        projectKeysFilter.has(projectIdToKeyMapping[projId]),
      );

      if (matchingProjects.length > 0) {
        filteredRules.push(rule);
        if (rule.state === "ENABLED") {
          filteredActiveRules.push(rule);
        }
      }
    }
  }

  logger.info(`Filtered ${filteredRules.length} rules`);
  logger.info(`Filtered ${filteredActiveRules.length} active rules`);

  return {
    filteredRules,
    filteredActiveRules,
  };
}

module.exports = {
  getProjectIds,
  getProjectIdsInteractive,
  filterAutomationRules,
};
