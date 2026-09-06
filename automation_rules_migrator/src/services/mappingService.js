/**
 * Mapping service - handles ID mapping generation and rule fixing
 */

const fs = require("fs").promises;
const crypto = require("crypto");
const { logger } = require("../utils/logger");
const jiraClient = require("../api/jiraClient");
const projectService = require("./projectService");

/**
 * Generate mappings between source and target instances
 * @param {string} sourceEmail - Source instance email
 * @param {string} sourceApiToken - Source instance API token
 * @param {string} sourceSiteUrl - Source instance site URL (e.g., yourcompany.atlassian.net)
 * @param {string} targetEmail - Target instance email
 * @param {string} targetApiToken - Target instance API token
 * @param {string} targetSiteUrl - Target instance site URL (e.g., yourcompany.atlassian.net)
 * @returns {Promise<Object>} Dictionary containing all mappings
 */
async function generateMappings(
  sourceEmail,
  sourceApiToken,
  sourceSiteUrl,
  targetEmail,
  targetApiToken,
  targetSiteUrl,
) {
  logger.info("Generating mappings between source and target instances");
  logger.debug(`Source site: ${sourceSiteUrl}, Target site: ${targetSiteUrl}`);

  // Get issue types from both instances
  logger.debug("Fetching issue types from source...");
  const sourceIssueTypes = await jiraClient.getPaginatedData(
    sourceEmail,
    sourceApiToken,
    sourceSiteUrl,
    "/issuetype",
  );

  logger.debug("Fetching issue types from target...");
  const targetIssueTypes = await jiraClient.getPaginatedData(
    targetEmail,
    targetApiToken,
    targetSiteUrl,
    "/issuetype",
  );

  // Create issue type mapping
  const issueTypeMapping = {};
  for (const sourceIt of sourceIssueTypes) {
    for (const targetIt of targetIssueTypes) {
      if (sourceIt.name === targetIt.name) {
        issueTypeMapping[sourceIt.id] = targetIt.id;
        logger.debug(
          `Mapped issue type: ${sourceIt.name} (${sourceIt.id} → ${targetIt.id})`,
        );
        break;
      }
    }
  }

  logger.info(
    `Issue type mapping created: ${Object.keys(issueTypeMapping).length} mappings`,
  );

  // Get projects from both instances
  logger.debug("Fetching projects from source...");
  const sourceProjects = await projectService.getProjectIds(
    sourceEmail,
    sourceApiToken,
    sourceSiteUrl,
  );

  logger.debug("Fetching projects from target...");
  const targetProjects = await projectService.getProjectIds(
    targetEmail,
    targetApiToken,
    targetSiteUrl,
  );

  // Create project mapping
  const projectMapping = {};
  for (const sourceProj of sourceProjects) {
    for (const targetProj of targetProjects) {
      if (sourceProj.key === targetProj.key) {
        projectMapping[sourceProj.id] = targetProj.id;
        logger.debug(
          `Mapped project: ${sourceProj.key} (${sourceProj.id} → ${targetProj.id})`,
        );
        break;
      }
    }
  }

  logger.info(
    `Project mapping created: ${Object.keys(projectMapping).length} mappings`,
  );

  // EXTENDED: Get custom fields from both instances.
  // IMPORTANT: use /field/search (paginated), NOT /field. Plain /field is
  // INCOMPLETE on many Cloud tenants — it silently omits custom fields that are
  // not on a screen/context (verified on a sandbox tenant: /field returned
  // 227 custom fields, /field/search returned 315). Those missing fields then
  // never get a source→target mapping, so automation rules that reference them
  // (e.g. in smart values) get falsely flagged "Unmapped custom field" even
  // though the field exists on both sides. /field/search returns the full set.
  logger.debug("Fetching custom fields from source...");
  const sourceCustomFields = await jiraClient.getPaginatedData(
    sourceEmail,
    sourceApiToken,
    sourceSiteUrl,
    "/field/search",
    { type: "custom", expand: "key" },
  );

  logger.debug("Fetching custom fields from target...");
  const targetCustomFields = await jiraClient.getPaginatedData(
    targetEmail,
    targetApiToken,
    targetSiteUrl,
    "/field/search",
    { type: "custom", expand: "key" },
  );

  // Create custom field mapping (ID → ID) and name mapping (ID → NAME)
  const customFieldMapping = {};
  const customFieldNameMapping = {};
  const sourceCustomFieldsFiltered = sourceCustomFields.filter((f) =>
    f.id.startsWith("customfield_"),
  );
  const targetCustomFieldsFiltered = targetCustomFields.filter((f) =>
    f.id.startsWith("customfield_"),
  );

  // Pass 1: exact name match (takes priority).
  for (const sourceCf of sourceCustomFieldsFiltered) {
    const t = targetCustomFieldsFiltered.find((tc) => tc.name === sourceCf.name);
    if (t) {
      customFieldMapping[sourceCf.id] = t.id;
      customFieldNameMapping[t.id] = t.name; // Store name for field object transformation
      logger.debug(`Mapped custom field: ${sourceCf.name} (${sourceCf.id} → ${t.id})`);
    }
  }
  // Pass 2: suffix-tolerant fallback for still-unmapped source fields. JCMA leaves
  // a trailing " (migrated)" on some field names; the same field exists clean on the
  // other side (e.g. source "Category (migrated)" → target "Category"). Only runs
  // when an exact match wasn't found, so it never overrides a real exact match.
  const stripMigrated = (n) => String(n || "").replace(/\s*\(migrated\)\s*$/i, "").trim();
  for (const sourceCf of sourceCustomFieldsFiltered) {
    if (customFieldMapping[sourceCf.id] !== undefined) continue;
    const sBase = stripMigrated(sourceCf.name);
    if (!sBase) continue;
    // Prefer the CLEAN-named target over a "(migrated)" one with the same base.
    const cands = targetCustomFieldsFiltered.filter((tc) => stripMigrated(tc.name) === sBase);
    const t = cands.find((tc) => tc.name === sBase) || cands[0];
    if (t) {
      customFieldMapping[sourceCf.id] = t.id;
      customFieldNameMapping[t.id] = t.name;
      logger.debug(
        `Mapped custom field (suffix-tolerant): ${sourceCf.name} (${sourceCf.id} → ${t.id} "${t.name}")`,
      );
    }
  }

  logger.info(
    `Custom field mapping created: ${Object.keys(customFieldMapping).length} mappings`,
  );

  // EXTENDED: Get statuses from both instances
  logger.debug("Fetching statuses from source...");
  const sourceStatuses = await jiraClient.getPaginatedData(
    sourceEmail,
    sourceApiToken,
    sourceSiteUrl,
    "/status",
  );

  logger.debug("Fetching statuses from target...");
  const targetStatuses = await jiraClient.getPaginatedData(
    targetEmail,
    targetApiToken,
    targetSiteUrl,
    "/status",
  );

  // Create status mapping - map by name (Cloud uses names more than IDs)
  const statusMapping = {};
  for (const sourceStat of sourceStatuses) {
    for (const targetStat of targetStatuses) {
      if (sourceStat.name === targetStat.name) {
        // Map ID to NAME (most Cloud workflows use names)
        statusMapping[sourceStat.id] = targetStat.name;
        logger.debug(
          `Mapped status: ${sourceStat.name} (${sourceStat.id} → ${targetStat.name})`,
        );
        break;
      }
    }
  }

  logger.info(
    `Status mapping created: ${Object.keys(statusMapping).length} mappings`,
  );

  // EXTENDED: Get resolutions from both instances
  logger.debug("Fetching resolutions from source...");
  const sourceResolutions = await jiraClient.getPaginatedData(
    sourceEmail,
    sourceApiToken,
    sourceSiteUrl,
    "/resolution",
  );

  logger.debug("Fetching resolutions from target...");
  const targetResolutions = await jiraClient.getPaginatedData(
    targetEmail,
    targetApiToken,
    targetSiteUrl,
    "/resolution",
  );

  // Create resolution mapping
  const resolutionMapping = {};
  for (const sourceRes of sourceResolutions) {
    for (const targetRes of targetResolutions) {
      if (sourceRes.name === targetRes.name) {
        resolutionMapping[sourceRes.id] = targetRes.id;
        logger.debug(
          `Mapped resolution: ${sourceRes.name} (${sourceRes.id} → ${targetRes.id})`,
        );
        break;
      }
    }
  }

  logger.info(
    `Resolution mapping created: ${Object.keys(resolutionMapping).length} mappings`,
  );

  // EXTENDED: Get priorities from both instances
  logger.debug("Fetching priorities from source...");
  const sourcePriorities = await jiraClient.getPaginatedData(
    sourceEmail,
    sourceApiToken,
    sourceSiteUrl,
    "/priority",
  );

  logger.debug("Fetching priorities from target...");
  const targetPriorities = await jiraClient.getPaginatedData(
    targetEmail,
    targetApiToken,
    targetSiteUrl,
    "/priority",
  );

  // Create priority mapping — BY NAME (priority ids are not stable across sites).
  // Beware target renames: on a sandbox tenant the source "High" (10001)
  // exists on target as "High" but under a DIFFERENT id (2), while target id
  // 10001 is "High (migrated)". Exact-name match handles that correctly. We add
  // a second pass that ignores a trailing "(migrated)"/"(default)" suffix on
  // either side (common JCMA / default-scheme artifacts), and WARN on any source
  // priority left unmapped so the operator can verify (an unmapped priority means
  // a rule that sets it would keep the SOURCE id = a different priority on target).
  const priorityMapping = {};
  const normPri = (n) =>
    String(n || "").trim().toLowerCase().replace(/\s*\((migrated|default)\)\s*$/i, "");
  for (const sourcePri of sourcePriorities) {
    // Pass 1: exact name. Pass 2: suffix-tolerant, but PREFER the CLEAN-named target
    // over a "(migrated)"/"(default)" one — otherwise source "High (default)" would
    // wrongly bind to target "High (migrated)" instead of the real "High".
    let t = targetPriorities.find((tp) => tp.name === sourcePri.name);
    if (!t) {
      const base = normPri(sourcePri.name);
      const cands = targetPriorities.filter((tp) => normPri(tp.name) === base);
      t = cands.find((tp) => tp.name.trim().toLowerCase() === base) || cands[0];
    }
    if (t) {
      priorityMapping[sourcePri.id] = t.id;
      logger.debug(
        `Mapped priority: ${sourcePri.name} (${sourcePri.id} → ${t.id} "${t.name}")`,
      );
    }
  }
  const unmappedPri = sourcePriorities.filter((p) => priorityMapping[p.id] === undefined);
  if (unmappedPri.length) {
    logger.warn(
      `Priority: ${unmappedPri.length} source priorit(ies) have NO target match and will pass through unchanged (verify!): ${unmappedPri.map((p) => `${p.name}(${p.id})`).join(", ")}`,
    );
  }

  logger.info(
    `Priority mapping created: ${Object.keys(priorityMapping).length} mappings`,
  );

  // EXTENDED: Get users from both instances (for common system accounts)
  // Note: Full user mapping would require user migration data, so we map common system users
  logger.debug("Fetching users from source...");
  let sourceUsers = [];
  try {
    // FIXED: Pass query="*" to fetch all active users (was missing before → returned empty)
    sourceUsers = await jiraClient.getPaginatedData(
      sourceEmail,
      sourceApiToken,
      sourceSiteUrl,
      "/users/search",
      { query: "*" },
    );
  } catch (error) {
    logger.warn(
      `Could not fetch source users (may require additional permissions): ${error.message}`,
    );
  }

  logger.debug("Fetching users from target...");
  let targetUsers = [];
  try {
    // FIXED: Pass query="*" to fetch all active users
    targetUsers = await jiraClient.getPaginatedData(
      targetEmail,
      targetApiToken,
      targetSiteUrl,
      "/users/search",
      { query: "*" },
    );
  } catch (error) {
    logger.warn(
      `Could not fetch target users (may require additional permissions): ${error.message}`,
    );
  }

  // Create user mapping (accountId → accountId, or username → accountId for DC→Cloud compatibility)
  const userMapping = {};
  for (const sourceUser of sourceUsers) {
    for (const targetUser of targetUsers) {
      // Match by email (most reliable) or displayName
      if (
        (sourceUser.emailAddress &&
          sourceUser.emailAddress === targetUser.emailAddress) ||
        (sourceUser.displayName &&
          sourceUser.displayName === targetUser.displayName)
      ) {
        const sourceKey = sourceUser.accountId || sourceUser.name; // DC uses 'name', Cloud uses 'accountId'
        const targetKey = targetUser.accountId;
        userMapping[sourceKey] = targetKey;
        logger.debug(
          `Mapped user: ${sourceUser.displayName} (${sourceKey} → ${targetKey})`,
        );
        break;
      }
    }
  }

  logger.info(
    `User mapping created: ${Object.keys(userMapping).length} mappings`,
  );

  // Return all mappings as an object
  logger.info("\n=== MAPPING GENERATION COMPLETE ===");
  logger.info(`Total mappings created:`);
  logger.info(`  - Projects: ${Object.keys(projectMapping).length}`);
  logger.info(`  - Issue Types: ${Object.keys(issueTypeMapping).length}`);
  logger.info(`  - Custom Fields: ${Object.keys(customFieldMapping).length}`);
  logger.info(`  - Statuses: ${Object.keys(statusMapping).length}`);
  logger.info(`  - Resolutions: ${Object.keys(resolutionMapping).length}`);
  logger.info(`  - Priorities: ${Object.keys(priorityMapping).length}`);
  logger.info(`  - Users: ${Object.keys(userMapping).length}`);

  return {
    issueTypeMapping,
    projectMapping,
    customFieldMapping,
    customFieldNameMapping, // CRITICAL: For fieldId→field transformation
    statusMapping,
    userMapping,
    resolutionMapping,
    priorityMapping,
    sourceIssueTypes,
    targetIssueTypes,
    sourceProjects,
    targetProjects,
  };
}

/**
 * Fix automation rules by updating IDs based on mappings
 * @param {Array} automationRules - Array of automation rules
 * @param {Object} mappings - Dictionary containing all mappings from generateMappings
 * @param {string} cloudId - Cloud instance ID for ARI generation
 * @param {string} defaultAccountId - Default Cloud account ID for unmapped users (optional)
 * @param {boolean} isCloudSource - True if source is Cloud, false if Datacenter (optional, defaults to false)
 * @param {boolean} filterUnmapped - If true, skip rules with unmapped IDs (optional, defaults to false for cloud-to-cloud)
 * @returns {Array} Fixed automation rules (array, not wrapped in object)
 */
function fixAutomationRules(
  automationRules,
  mappings,
  cloudId,
  defaultAccountId,
  isCloudSource = false,
  filterUnmapped = false,
) {
  logger.info("Fixing automation rules with mappings");
  logger.info(
    `Source type: ${isCloudSource ? "Cloud-to-Cloud" : "Datacenter-to-Cloud"}`,
  );

  // FIXED: Handle automationRules as array
  const rules = Array.isArray(automationRules) ? automationRules : [];

  // Validate cloudId for ARI generation
  if (!cloudId) {
    logger.warn(
      "No cloudId provided - ruleScope and ruleHome will not be created properly",
    );
  }

  // Log default account ID info
  if (defaultAccountId) {
    logger.info(`Default account ID for unmapped users: ${defaultAccountId}`);
  } else {
    logger.warn(
      "No default account ID provided - unmapped users may cause import failures",
    );
  }

  // Extract mappings
  const issueTypeMapping = mappings.issueTypeMapping || {};
  const projectMapping = mappings.projectMapping || {};
  const customFieldMapping = mappings.customFieldMapping || {};
  const customFieldNameMapping = mappings.customFieldNameMapping || {}; // CRITICAL: For field object transformation
  const customFieldTypeMapping = mappings.customFieldTypeMapping || {}; // CRITICAL: For COPY sourceField fieldType
  const statusMapping = mappings.statusMapping || {};
  const userMapping = mappings.userMapping || {};
  const resolutionMapping = mappings.resolutionMapping || {};
  const priorityMapping = mappings.priorityMapping || {};

  // Log available mappings
  logger.debug(
    `Available mappings: projects=${Object.keys(projectMapping).length}, issueTypes=${Object.keys(issueTypeMapping).length}, customFields=${Object.keys(customFieldMapping).length}, customFieldNames=${Object.keys(customFieldNameMapping).length}, statuses=${Object.keys(statusMapping).length}, users=${Object.keys(userMapping).length}, resolutions=${Object.keys(resolutionMapping).length}, priorities=${Object.keys(priorityMapping).length}`,
  );

  // Track unmapped IDs for summary report
  const unmappedIds = {
    projects: new Set(),
    issueTypes: new Set(),
    customFields: new Set(),
    statuses: new Set(),
    users: new Set(),
    resolutions: new Set(),
    priorities: new Set(),
  };

  /**
   * Recursively traverse and fix IDs in rule components
   * @param {*} component - Component to fix
   * @param {string} path - Current path in object tree (for debugging)
   * @param {function} trackUnmapped - Function to track unmapped IDs
   */
  function recursivelyFixIds(component, path = "root", trackUnmapped = null) {
    // Fallback to global tracking if no per-rule tracking provided
    if (!trackUnmapped) {
      trackUnmapped = (category, id) => unmappedIds[category].add(id);
    }
    if (Array.isArray(component)) {
      for (let i = 0; i < component.length; i++) {
        recursivelyFixIds(component[i], `${path}[${i}]`, trackUnmapped);
      }
    } else if (typeof component === "object" && component !== null) {
      // Fix project IDs in projects array
      if ("projectId" in component && typeof component.projectId === "string") {
        const projectId = component.projectId;
        if (projectId in projectMapping) {
          const newProjectId = projectMapping[projectId];
          logger.debug(
            `Replaced projectId ${projectId} → ${newProjectId} at ${path}`,
          );
          component.projectId = newProjectId;
        } else {
          trackUnmapped("projects", projectId);
          logger.warn(
            `No mapping found for projectId: ${projectId} at ${path}`,
          );
        }
      }

      // Fix issue type IDs - they appear nested as {"type":"ID","value":"123"}
      // This handles both conditions (compareValue) and actions (value)
      if (
        typeof component.value === "object" &&
        component.value !== null &&
        component.value.type === "ID" &&
        typeof component.value.value === "string"
      ) {
        // Check if parent context is issuetype-related
        const parentIsIssueType =
          component.fieldType === "issuetype" ||
          component.selectedFieldType === "issuetype";

        if (parentIsIssueType) {
          const issueTypeId = component.value.value;
          if (issueTypeId in issueTypeMapping) {
            const newId = issueTypeMapping[issueTypeId];
            logger.debug(
              `Replaced issue type ID ${issueTypeId} → ${newId} at ${path}`,
            );
            component.value.value = newId;
          } else {
            trackUnmapped("issueTypes", issueTypeId);
            logger.warn(
              `No mapping found for issue type ID: ${issueTypeId} at ${path}`,
            );
          }
        }
      }

      // Also handle compareValue for conditions (single issue type)
      if (
        "compareValue" in component &&
        typeof component.compareValue === "object" &&
        component.compareValue !== null &&
        component.compareValue.type === "ID" &&
        typeof component.compareValue.value === "string" &&
        component.selectedFieldType === "issuetype" &&
        !component.compareValue.multiValue
      ) {
        const issueTypeId = component.compareValue.value;
        if (issueTypeId in issueTypeMapping) {
          const newId = issueTypeMapping[issueTypeId];
          logger.debug(
            `Replaced issue type ID in compareValue ${issueTypeId} → ${newId} at ${path}`,
          );
          component.compareValue.value = newId;
        } else {
          trackUnmapped("issueTypes", issueTypeId);
          logger.warn(
            `No mapping found for issue type ID in compareValue: ${issueTypeId} at ${path}`,
          );
        }
      }

      // Fix issue type IDs - they appear as JSON-encoded arrays in compareValue
      // Pattern: {"selectedFieldType":"issuetype","compareValue":{"type":"ID","value":"[\"10018\",\"10000\"]","multiValue":true}}
      if (
        component.selectedFieldType === "issuetype" &&
        component.compareValue &&
        component.compareValue.type === "ID" &&
        typeof component.compareValue.value === "string" &&
        component.compareValue.multiValue === true
      ) {
        try {
          const issueTypeIds = JSON.parse(component.compareValue.value);
          if (Array.isArray(issueTypeIds)) {
            const mappedIds = [];
            const unmappedIssueTypeIds = [];

            for (const issueTypeId of issueTypeIds) {
              if (issueTypeId in issueTypeMapping) {
                mappedIds.push(issueTypeMapping[issueTypeId]);
                logger.debug(
                  `Replaced issue type ID ${issueTypeId} → ${issueTypeMapping[issueTypeId]} at ${path}`,
                );
              } else {
                mappedIds.push(issueTypeId); // Keep original if no mapping
                unmappedIssueTypeIds.push(issueTypeId);
                trackUnmapped("issueTypes", issueTypeId);
              }
            }

            if (unmappedIssueTypeIds.length > 0) {
              logger.warn(
                `No mapping found for issue type IDs: ${unmappedIssueTypeIds.join(", ")} at ${path}`,
              );
            }

            component.compareValue.value = JSON.stringify(mappedIds);
          }
        } catch (e) {
          logger.warn(
            `Failed to parse issue type IDs at ${path}: ${component.compareValue.value}`,
          );
        }
      }

      // Fix project IDs in action operations - nested as {"type":"ID","value":"123"}
      if (
        typeof component.value === "object" &&
        component.value !== null &&
        component.value.type === "ID" &&
        typeof component.value.value === "string" &&
        component.fieldType === "project"
      ) {
        const projectId = component.value.value;
        if (projectId in projectMapping) {
          const newId = projectMapping[projectId];
          logger.debug(
            `Replaced project ID in action ${projectId} → ${newId} at ${path}`,
          );
          component.value.value = newId;
        } else {
          trackUnmapped("projects", projectId);
          logger.warn(
            `No mapping found for project ID in action: ${projectId} at ${path}`,
          );
        }
      }

      // Also handle project in compareValue for conditions
      if (
        "compareValue" in component &&
        typeof component.compareValue === "object" &&
        component.compareValue !== null &&
        component.compareValue.type === "ID" &&
        typeof component.compareValue.value === "string" &&
        component.selectedFieldType === "project"
      ) {
        const projectId = component.compareValue.value;
        if (projectId in projectMapping) {
          const newId = projectMapping[projectId];
          logger.debug(
            `Replaced project ID in compareValue ${projectId} → ${newId} at ${path}`,
          );
          component.compareValue.value = newId;
        } else {
          trackUnmapped("projects", projectId);
          logger.warn(
            `No mapping found for project ID in compareValue: ${projectId} at ${path}`,
          );
        }
      }

      // Fix status IDs in toStatus/fromStatus (type: "ID", value: "123")
      // Note: Must check context to distinguish status IDs from user IDs
      // Cloud can use either type="ID" (25%) or type="NAME" (75%), so we handle both
      if (
        (component.type === "ID" || component.type === "status") &&
        "value" in component &&
        typeof component.value === "string" &&
        !component.value.startsWith("{{") && // Skip smart values
        !component.value.includes("@") && // Skip email-like user IDs
        /^\d+$/.test(component.value) // Status IDs are numeric
      ) {
        const statusId = component.value;
        if (statusId in statusMapping) {
          const newValue = statusMapping[statusId];
          logger.debug(
            `Replaced status ID ${statusId} → ${newValue} at ${path}`,
          );
          component.value = newValue;

          // CRITICAL FIX: If mapped value is non-numeric (a name), change type to "NAME"
          // Cloud uses type="NAME" for 75% of status references
          if (!/^\d+$/.test(newValue)) {
            component.type = "NAME";
            logger.debug(
              `Changed status type from ID to NAME for ${statusId} → ${newValue} at ${path}`,
            );
          }
        } else {
          // Check if this might be a status ID based on path context
          if (
            path.includes("toStatus") ||
            path.includes("fromStatus") ||
            path.includes("destinationStatus")
          ) {
            trackUnmapped("statuses", statusId);
            logger.warn(
              `No mapping found for status ID: ${statusId} at ${path}`,
            );
          }
        }
      }

      // CRITICAL FIX: Transform DC fieldId string → Cloud field object
      // DC uses: "fieldId": "customfield_24902" or "assignee"
      // Cloud uses: "field": {"type":"NAME", "value":"Request participants"} or {"type":"ID", "value":"assignee"}
      // ONLY apply for Datacenter-to-Cloud, NOT Cloud-to-Cloud
      if (
        !isCloudSource &&
        "fieldId" in component &&
        typeof component.fieldId === "string"
      ) {
        const fieldId = component.fieldId;
        const originalFieldId = fieldId; // Save original DC ID for name lookup

        // First update custom field IDs if mapped
        if (fieldId.startsWith("customfield_")) {
          if (fieldId in customFieldMapping) {
            const newFieldId = customFieldMapping[fieldId];
            logger.debug(
              `Replaced fieldId ${fieldId} → ${newFieldId} at ${path}`,
            );
            component.fieldId = newFieldId;
          } else {
            trackUnmapped("customFields", fieldId);
            logger.warn(
              `No mapping found for custom field: ${fieldId} at ${path}`,
            );
          }

          // Transform to field object with NAME (Cloud requires this!)
          // CRITICAL: Use ORIGINAL DC fieldId for name lookup, not the updated Cloud ID!
          if (originalFieldId in customFieldNameMapping) {
            const fieldName = customFieldNameMapping[originalFieldId];
            component.field = {
              type: "NAME",
              value: fieldName,
            };
            delete component.fieldId;
            logger.debug(
              `Transformed fieldId to field object: ${originalFieldId} → {type:"NAME", value:"${fieldName}"} at ${path}`,
            );
          } else {
            // No name mapping - use ID instead (Cloud requires field object, not fieldId)
            component.field = {
              type: "ID",
              value: component.fieldId, // Use the mapped Cloud ID
            };
            delete component.fieldId;
            logger.warn(
              `No field name mapping found for ${originalFieldId}, using ID in field object at ${path}`,
            );
          }
        } else {
          // System field (assignee, reporter, components, etc.)
          // Cloud uses: field: {type:"ID", value:"assignee"}
          component.field = {
            type: "ID",
            value: fieldId,
          };
          delete component.fieldId;
          logger.debug(
            `Transformed system fieldId to field object: ${fieldId} → {type:"ID", value:"${fieldId}"} at ${path}`,
          );
        }
      }

      // Transform selectedField for custom fields (conditions use this)
      // DC: {"selectedField":{"type":"ID","value":"customfield_24903"},"selectedFieldType":"com.atlassian.servicedesk:vp-origin"}
      // Cloud: {"selectedField":{"type":"NAME","value":"Request Type"},"selectedFieldType":"com.atlassian.servicedesk:vp-origin"}
      // ONLY apply for Datacenter-to-Cloud, NOT Cloud-to-Cloud
      if (
        !isCloudSource &&
        component.selectedField &&
        typeof component.selectedField === "object"
      ) {
        const selectedField = component.selectedField;
        if (
          selectedField.type === "ID" &&
          typeof selectedField.value === "string" &&
          selectedField.value.startsWith("customfield_")
        ) {
          const fieldId = selectedField.value;
          // Look up field name using original DC field ID
          if (fieldId in customFieldNameMapping) {
            const fieldName = customFieldNameMapping[fieldId];
            component.selectedField = {
              type: "NAME",
              value: fieldName,
            };
            logger.debug(
              `Transformed selectedField: ${fieldId} → {type:"NAME", value:"${fieldName}"} at ${path}`,
            );
          } else {
            // Still update the ID if mapped, even without name
            if (fieldId in customFieldMapping) {
              const newFieldId = customFieldMapping[fieldId];
              component.selectedField.value = newFieldId;
              logger.debug(
                `Updated selectedField ID: ${fieldId} → ${newFieldId} at ${path}`,
              );
            } else {
              trackUnmapped("customFields", fieldId);
              logger.warn(
                `No mapping found for selectedField: ${fieldId} at ${path}`,
              );
            }
          }
        }
      }

      // Fix custom field IDs in value property when type is "ID" (conditions)
      if (
        "value" in component &&
        typeof component.value === "string" &&
        component.value.startsWith("customfield_")
      ) {
        const oldFieldId = component.value;
        if (oldFieldId in customFieldMapping) {
          const newFieldId = customFieldMapping[oldFieldId];
          logger.debug(
            `Replaced custom field value ${oldFieldId} → ${newFieldId} at ${path}`,
          );
          component.value = newFieldId;
        } else {
          trackUnmapped("customFields", oldFieldId);
          logger.warn(
            `No mapping found for custom field value: ${oldFieldId} at ${path}`,
          );
        }
      }

      // CRITICAL FIX: Transform custom field IDs inside advancedFields JSON strings
      // advancedFields is a JSON-encoded string like: "{\n  \"fields\": {\n    \"customfield_12345\": \"value\"\n  }\n}"
      // This is the MOST COMMON CAUSE of NullPointerException errors during Cloud import!
      if (
        "advancedFields" in component &&
        typeof component.advancedFields === "string" &&
        component.advancedFields.trim().startsWith("{")
      ) {
        try {
          const advFieldsObj = JSON.parse(component.advancedFields);
          if (advFieldsObj.fields && typeof advFieldsObj.fields === "object") {
            let hasChanges = false;
            const newFields = {};

            for (const [fieldKey, fieldValue] of Object.entries(
              advFieldsObj.fields,
            )) {
              // Check if this is a DC custom field ID
              if (fieldKey.startsWith("customfield_")) {
                // CRITICAL: Remove fields with null values to prevent NullPointerException
                if (fieldValue === null) {
                  logger.debug(
                    `Removed null custom field from advancedFields: ${fieldKey} at ${path}`,
                  );
                  hasChanges = true;
                  continue; // Skip this field - don't add to newFields
                }

                // Map the field ID if mapping exists
                if (fieldKey in customFieldMapping) {
                  const newFieldKey = customFieldMapping[fieldKey];
                  newFields[newFieldKey] = fieldValue;
                  hasChanges = true;
                  logger.debug(
                    `Mapped custom field in advancedFields: ${fieldKey} → ${newFieldKey} at ${path}`,
                  );
                } else {
                  // Keep unmapped non-null fields (may cause issues, warn user)
                  newFields[fieldKey] = fieldValue;
                  trackUnmapped("customFields", fieldKey);
                  logger.warn(
                    `Unmapped custom field in advancedFields: ${fieldKey} at ${path}`,
                  );
                }
              } else {
                // Keep system fields as-is
                newFields[fieldKey] = fieldValue;
              }
            }

            if (hasChanges) {
              // If no fields left, set advancedFields to null (Cloud standard)
              if (Object.keys(newFields).length === 0) {
                component.advancedFields = null;
                logger.debug(
                  `Set advancedFields to null (no fields remaining) at ${path}`,
                );
              } else {
                advFieldsObj.fields = newFields;
                component.advancedFields = JSON.stringify(advFieldsObj);
                logger.debug(`Updated advancedFields JSON string at ${path}`);
              }
            }
          }
        } catch (e) {
          logger.warn(
            `Failed to parse advancedFields JSON at ${path}: ${e.message}`,
          );
          // Set to null if parse fails - safer than keeping unparseable JSON
          component.advancedFields = null;
          logger.debug(
            `Set advancedFields to null due to parse error at ${path}`,
          );
        }
      }

      // CRITICAL: Replace custom field IDs in smart values ({{customfield_XXXXX}})
      // These appear in strings throughout the automation (summaries, descriptions, emails, etc.)
      // Pattern: {{customfield_24804}} or {{customfield_24804.displayName}}
      // Pattern: {{issue.customfield_24804}} or {{trigger.customfield_24804}} or {{parent.customfield_24804}}
      // FIXED: Now handles nested smart values and multiple field references in one expression
      // Check all string properties in the current component
      for (const key in component) {
        if (
          component.hasOwnProperty(key) &&
          typeof component[key] === "string"
        ) {
          const stringValue = component[key];
          // FIXED v2: Match field ID pattern WITHOUT requiring closing }}, allowing nested/multiple replacements
          // Matches: customfield_12345 (with optional prefix like "issue." before it)
          // This will catch ALL occurrences even in nested expressions like {{if(issue.customfield_123 + issue.customfield_456)}}
          const smartValuePattern = /(\w+\.)?customfield_(\d+)/g;

          if (smartValuePattern.test(stringValue)) {
            let updatedString = stringValue;
            let hasChanges = false;

            // Reset regex lastIndex for reuse
            smartValuePattern.lastIndex = 0;

            updatedString = updatedString.replace(
              smartValuePattern,
              (match, prefix, dcFieldNum) => {
                const dcFieldId = `customfield_${dcFieldNum}`;

                if (dcFieldId in customFieldMapping) {
                  const cloudFieldId = customFieldMapping[dcFieldId];
                  hasChanges = true;
                  const prefixStr = prefix || "";
                  const replacement = `${prefixStr}${cloudFieldId}`;
                  logger.debug(
                    `Replaced smart value field: ${match} → ${replacement} at ${path}.${key}`,
                  );
                  return replacement;
                } else {
                  trackUnmapped("customFields", dcFieldId);
                  logger.warn(
                    `Unmapped custom field in smart value: ${dcFieldId} at ${path}.${key}`,
                  );
                  return match; // Keep original if no mapping
                }
              },
            );

            if (hasChanges) {
              component[key] = updatedString;
              logger.debug(`Updated smart values in ${path}.${key}`);
            }
          }
        }
      }

      // Fix resolution IDs - they appear as JSON-encoded arrays in compareValue
      // Pattern: {"selectedFieldType":"resolution","compareValue":{"type":"ID","value":"[\"6\",\"1\",\"10000\"]","multiValue":true}}
      if (
        component.selectedFieldType === "resolution" &&
        component.compareValue &&
        component.compareValue.type === "ID" &&
        typeof component.compareValue.value === "string" &&
        component.compareValue.multiValue === true
      ) {
        try {
          const resolutionIds = JSON.parse(component.compareValue.value);
          if (Array.isArray(resolutionIds)) {
            const mappedIds = [];
            const unmappedResolutionIds = [];

            for (const resId of resolutionIds) {
              if (resId in resolutionMapping) {
                mappedIds.push(resolutionMapping[resId]);
                logger.debug(
                  `Replaced resolution ID ${resId} → ${resolutionMapping[resId]} at ${path}`,
                );
              } else {
                mappedIds.push(resId); // Keep original if no mapping
                unmappedResolutionIds.push(resId);
                trackUnmapped("resolutions", resId);
              }
            }

            if (unmappedResolutionIds.length > 0) {
              logger.warn(
                `No mapping found for resolution IDs: ${unmappedResolutionIds.join(", ")} at ${path}`,
              );
            }

            component.compareValue.value = JSON.stringify(mappedIds);
          }
        } catch (e) {
          logger.warn(
            `Failed to parse resolution IDs at ${path}: ${component.compareValue.value}`,
          );
        }
      }

      // Fix priority IDs - similar pattern to resolution
      // Pattern: {"selectedFieldType":"priority","compareValue":{"type":"ID","value":"[\"1\",\"2\"]","multiValue":true}}
      if (
        component.selectedFieldType === "priority" &&
        component.compareValue &&
        component.compareValue.type === "ID" &&
        typeof component.compareValue.value === "string" &&
        component.compareValue.multiValue === true
      ) {
        try {
          const priorityIds = JSON.parse(component.compareValue.value);
          if (Array.isArray(priorityIds)) {
            const mappedIds = [];
            const unmappedPriorityIds = [];

            for (const priId of priorityIds) {
              if (priId in priorityMapping) {
                mappedIds.push(priorityMapping[priId]);
                logger.debug(
                  `Replaced priority ID ${priId} → ${priorityMapping[priId]} at ${path}`,
                );
              } else {
                mappedIds.push(priId); // Keep original if no mapping
                unmappedPriorityIds.push(priId);
                trackUnmapped("priorities", priId);
              }
            }

            if (unmappedPriorityIds.length > 0) {
              logger.warn(
                `No mapping found for priority IDs: ${unmappedPriorityIds.join(", ")} at ${path}`,
              );
            }

            component.compareValue.value = JSON.stringify(mappedIds);
          }
        } catch (e) {
          logger.warn(
            `Failed to parse priority IDs at ${path}: ${component.compareValue.value}`,
          );
        }
      }

      // Fix single-value resolution IDs
      // Pattern: {"selectedFieldType":"resolution","compareValue":{"type":"ID","value":"10600","multiValue":false}}
      if (
        component.selectedFieldType === "resolution" &&
        component.compareValue &&
        component.compareValue.type === "ID" &&
        typeof component.compareValue.value === "string" &&
        component.compareValue.multiValue === false &&
        !component.compareValue.value.startsWith("{") && // Not a JSON object
        !component.compareValue.value.startsWith("[") // Not a JSON array
      ) {
        const resolutionId = component.compareValue.value;
        if (resolutionId in resolutionMapping) {
          const newId = resolutionMapping[resolutionId];
          logger.debug(
            `Replaced single resolution ID ${resolutionId} → ${newId} at ${path}`,
          );
          component.compareValue.value = newId;
        } else {
          trackUnmapped("resolutions", resolutionId);
          logger.warn(
            `No mapping found for single resolution ID: ${resolutionId} at ${path}`,
          );
        }
      }

      // Fix single-value priority IDs
      // Pattern: {"selectedFieldType":"priority","compareValue":{"type":"ID","value":"1","multiValue":false}}
      if (
        component.selectedFieldType === "priority" &&
        component.compareValue &&
        component.compareValue.type === "ID" &&
        typeof component.compareValue.value === "string" &&
        component.compareValue.multiValue === false &&
        !component.compareValue.value.startsWith("{") && // Not a JSON object
        !component.compareValue.value.startsWith("[") // Not a JSON array
      ) {
        const priorityId = component.compareValue.value;
        if (priorityId in priorityMapping) {
          const newId = priorityMapping[priorityId];
          logger.debug(
            `Replaced single priority ID ${priorityId} → ${newId} at ${path}`,
          );
          component.compareValue.value = newId;
        } else {
          trackUnmapped("priorities", priorityId);
          logger.warn(
            `No mapping found for single priority ID: ${priorityId} at ${path}`,
          );
        }
      }

      // Fix user IDs (authorAccountId, actorAccountId, assignee values)
      if (
        "authorAccountId" in component &&
        typeof component.authorAccountId === "string"
      ) {
        const userId = component.authorAccountId;
        if (userId in userMapping) {
          const newUserId = userMapping[userId];
          logger.debug(
            `Replaced authorAccountId ${userId} → ${newUserId} at ${path}`,
          );
          component.authorAccountId = newUserId;
        } else if (!userId.startsWith("{{")) {
          // Ignore smart values
          // Use default account ID if provided
          if (defaultAccountId) {
            logger.warn(
              `No mapping found for authorAccountId: ${userId} at ${path}, using default: ${defaultAccountId}`,
            );
            component.authorAccountId = defaultAccountId;
          } else {
            trackUnmapped("users", userId);
            logger.warn(
              `No mapping found for authorAccountId: ${userId} at ${path}`,
            );
          }
        }
      }

      if (
        "actorAccountId" in component &&
        typeof component.actorAccountId === "string"
      ) {
        const userId = component.actorAccountId;
        if (userId in userMapping) {
          const newUserId = userMapping[userId];
          logger.debug(
            `Replaced actorAccountId ${userId} → ${newUserId} at ${path}`,
          );
          component.actorAccountId = newUserId;
        } else if (!userId.startsWith("{{")) {
          // Ignore smart values
          // Use default account ID if provided
          if (defaultAccountId) {
            logger.warn(
              `No mapping found for actorAccountId: ${userId} at ${path}, using default: ${defaultAccountId}`,
            );
            component.actorAccountId = defaultAccountId;
          } else {
            trackUnmapped("users", userId);
            logger.warn(
              `No mapping found for actorAccountId: ${userId} at ${path}`,
            );
          }
        }
      }

      // Fix user values in assignee/watcher fields (type: "ID", value: "username")
      // Only process if NOT already handled as status ID (status IDs are numeric, user IDs are alphanumeric)
      if (
        component.type === "ID" &&
        "value" in component &&
        typeof component.value === "string" &&
        !component.value.startsWith("{{") && // Skip smart values
        !/^\d+$/.test(component.value) // Skip numeric values (those are status IDs)
      ) {
        const userId = component.value;
        if (userId in userMapping) {
          const newUserId = userMapping[userId];
          logger.debug(
            `Replaced user value ${userId} → ${newUserId} at ${path}`,
          );
          component.value = newUserId;
        } else {
          // Only warn about unmapped users in contexts where we expect user IDs
          if (
            path.includes("watchers") ||
            path.includes("assignee") ||
            path.includes("value.value")
          ) {
            // Use default account ID if provided
            if (defaultAccountId) {
              logger.warn(
                `No mapping found for user ID: ${userId} at ${path}, using default: ${defaultAccountId}`,
              );
              component.value = defaultAccountId;
            } else {
              trackUnmapped("users", userId);
              logger.warn(`No mapping found for user ID: ${userId} at ${path}`);
            }
          }
        }
      }

      // CRITICAL FIX: Fix user IDs in compareValue (for reporter/assignee conditions)
      // Pattern: {"selectedFieldType":"reporter","compareValue":{"type":"ID","value":"JIRAUSER10000"}}
      if (
        component.compareValue &&
        typeof component.compareValue === "object" &&
        component.compareValue.type === "ID" &&
        typeof component.compareValue.value === "string" &&
        !component.compareValue.value.startsWith("{{") && // Skip smart values
        (component.selectedFieldType === "reporter" ||
          component.selectedFieldType === "assignee" ||
          component.selectedFieldType === "creator" ||
          component.selectedFieldType === "user") &&
        component.compareValue.value.startsWith("JIRAUSER") // Unmapped DC user
      ) {
        const userId = component.compareValue.value;
        if (userId in userMapping) {
          const newUserId = userMapping[userId];
          logger.debug(
            `Replaced user ID in compareValue ${userId} → ${newUserId} at ${path}`,
          );
          component.compareValue.value = newUserId;
        } else {
          // Use default account ID if provided
          if (defaultAccountId) {
            logger.warn(
              `No mapping found for user ID in compareValue: ${userId} at ${path}, using default: ${defaultAccountId}`,
            );
            component.compareValue.value = defaultAccountId;
          } else {
            trackUnmapped("users", userId);
            logger.warn(
              `No mapping found for user ID in compareValue: ${userId} at ${path}`,
            );
          }
        }
      }

      // CRITICAL FIX: Fix user IDs in SET operation value arrays (multi-user picker fields)
      // Pattern: {"type":"SET","value":[{"type":"ID","value":"JIRAUSER10000"}],"field":{"type":"NAME","value":"Approvers"}}
      if (
        component.type === "SET" &&
        Array.isArray(component.value) &&
        (component.fieldType?.includes("userpicker") ||
          component.fieldType?.includes("user") ||
          component.field?.value?.toLowerCase().includes("approver") ||
          component.field?.value?.toLowerCase().includes("visible"))
      ) {
        for (let i = 0; i < component.value.length; i++) {
          const item = component.value[i];
          if (
            typeof item === "object" &&
            item !== null &&
            item.type === "ID" &&
            typeof item.value === "string" &&
            !item.value.startsWith("{{") && // Skip smart values
            item.value.startsWith("JIRAUSER") // Unmapped DC user
          ) {
            const userId = item.value;
            if (userId in userMapping) {
              const newUserId = userMapping[userId];
              logger.debug(
                `Replaced user ID in SET array[${i}] ${userId} → ${newUserId} at ${path}`,
              );
              item.value = newUserId;
            } else {
              // Use default account ID if provided
              if (defaultAccountId) {
                logger.warn(
                  `No mapping found for user ID in SET array[${i}]: ${userId} at ${path}, using default: ${defaultAccountId}`,
                );
                item.value = defaultAccountId;
              } else {
                trackUnmapped("users", userId);
                logger.warn(
                  `No mapping found for user ID in SET array[${i}]: ${userId} at ${path}`,
                );
              }
            }
          }
        }
      }

      // Transform COPY operation format (DC → Cloud)
      // DC: {"type":"COPY","value":{"type":"ADD","value":"current","additional":"customfield_29102"}}
      // Cloud: {"type":"COPY","value":{"copyOptions":["ADD"],"sourceIssue":"current","sourceField":{...}}}
      // ONLY apply for Datacenter-to-Cloud, NOT Cloud-to-Cloud
      if (
        !isCloudSource &&
        component.type === "COPY" &&
        component.value &&
        typeof component.value === "object"
      ) {
        const val = component.value;

        // Check if it's DC format (has "additional" field)
        if (val.additional && typeof val.additional === "string") {
          const fieldId = val.additional;

          // Transform to Cloud format
          const newValue = {
            copyOptions: val.type ? [val.type] : [],
            sourceIssue: val.value || "current",
          };

          // Handle custom fields
          if (fieldId.startsWith("customfield_")) {
            if (fieldId in customFieldNameMapping) {
              const fieldName = customFieldNameMapping[fieldId];
              const sourceFieldType =
                customFieldTypeMapping[fieldId] ||
                component.fieldType ||
                "unknown";
              newValue.sourceField = {
                type: "NAME",
                value: fieldName,
                fieldType: sourceFieldType,
              };
              logger.debug(
                `Transformed COPY additional to sourceField: ${fieldId} → {type:"NAME", value:"${fieldName}", fieldType:"${sourceFieldType}"} at ${path}`,
              );
            } else {
              const mappedFieldId =
                fieldId in customFieldMapping
                  ? customFieldMapping[fieldId]
                  : fieldId;
              const sourceFieldType =
                customFieldTypeMapping[fieldId] ||
                component.fieldType ||
                "unknown";
              newValue.sourceField = {
                type: "ID",
                value: mappedFieldId,
                fieldType: sourceFieldType,
              };
              logger.warn(
                `No field name found for COPY additional: ${fieldId}, using ID at ${path}`,
              );
            }
          } else {
            // System field - use ID type
            newValue.sourceField = {
              type: "ID",
              value: fieldId,
              fieldType: component.fieldType || fieldId,
            };
            logger.debug(
              `Transformed COPY system field: ${fieldId} at ${path}`,
            );
          }

          component.value = newValue;
        } else if (
          val.sourceField &&
          val.sourceField.value &&
          typeof val.sourceField.value === "string" &&
          val.sourceField.value.startsWith("customfield_")
        ) {
          // Already in Cloud format but sourceField.value has DC field ID - transform it
          const dcFieldId = val.sourceField.value;
          if (customFieldMapping[dcFieldId]) {
            val.sourceField.value = customFieldMapping[dcFieldId];
            logger.debug(
              `Transformed COPY sourceField.value: ${dcFieldId} → ${customFieldMapping[dcFieldId]} at ${path}`,
            );
          }
        }
      }

      // CRITICAL FIX: Transform DC 'additional' field for REFERENCE and COPY types
      // DC SET operations have: "value": {"type":"REFERENCE","value":"CURRENT","additional":1445}
      // or "value": [{"type":"REFERENCE","additional":"USE_REPORTER_EMAIL"}]
      // or "value": {"type":"COPY","value":"trigger","additional":"description"}
      // Cloud expects: "value": {"type":"REFERENCE","value":"CURRENT"}
      // or "value": [{"type":"REFERENCE","value":"USE_REPORTER_EMAIL"}]
      // or "value": {"type":"COPY","value":{"copyOptions":[],"sourceIssue":"trigger","sourceField":{...}}}
      // ONLY apply for Datacenter-to-Cloud, NOT Cloud-to-Cloud
      if (!isCloudSource && component.type === "SET" && component.value) {
        // Handle object value
        if (
          typeof component.value === "object" &&
          !Array.isArray(component.value) &&
          "additional" in component.value
        ) {
          // Transform COPY type with additional
          if (
            component.value.type === "COPY" &&
            typeof component.value.value === "string"
          ) {
            const sourceIssue = component.value.value;
            const sourceFieldId = component.value.additional;
            const fieldType = component.fieldType || "unknown";

            // Create Cloud format for COPY
            const newValue = {
              copyOptions: [],
              sourceIssue: sourceIssue,
              sourceField: {
                type: "ID",
                value: sourceFieldId,
                fieldType: fieldType,
              },
            };

            // Map custom field if needed
            if (sourceFieldId.startsWith("customfield_")) {
              const mappedFieldId =
                customFieldMapping[sourceFieldId] || sourceFieldId;
              const fieldName = customFieldNameMapping[sourceFieldId];
              if (fieldName) {
                newValue.sourceField = {
                  type: "NAME",
                  value: fieldName,
                  fieldType: customFieldTypeMapping[sourceFieldId] || fieldType,
                };
              } else {
                newValue.sourceField.value = mappedFieldId;
                newValue.sourceField.fieldType =
                  customFieldTypeMapping[sourceFieldId] || fieldType;
              }
            }

            component.value = newValue;
            logger.debug(
              `Transformed COPY with additional to Cloud format: ${sourceIssue}/${sourceFieldId} at ${path}`,
            );
          }
          // If REFERENCE type with additional but no value, move additional to value
          else if (
            component.value.type === "REFERENCE" &&
            !("value" in component.value)
          ) {
            component.value.value = component.value.additional;
            logger.debug(
              `Transformed REFERENCE additional to value: ${component.value.additional} at ${path}`,
            );
            delete component.value.additional;
          }
          // For other types, just delete additional
          else if ("additional" in component.value) {
            delete component.value.additional;
            logger.debug(
              `Removed DC-specific 'additional' field from SET operation value at ${path}`,
            );
          }
        }
        // Handle array value
        if (Array.isArray(component.value)) {
          for (const item of component.value) {
            if (typeof item === "object" && "additional" in item) {
              // Transform COPY type with additional
              if (item.type === "COPY" && typeof item.value === "string") {
                const sourceIssue = item.value;
                const sourceFieldId = item.additional;
                const fieldType = component.fieldType || "unknown";

                // Create Cloud format
                const newValue = {
                  copyOptions: [],
                  sourceIssue: sourceIssue,
                  sourceField: {
                    type: "ID",
                    value: sourceFieldId,
                    fieldType: fieldType,
                  },
                };

                // Map custom field if needed
                if (sourceFieldId.startsWith("customfield_")) {
                  const mappedFieldId =
                    customFieldMapping[sourceFieldId] || sourceFieldId;
                  const fieldName = customFieldNameMapping[sourceFieldId];
                  if (fieldName) {
                    newValue.sourceField = {
                      type: "NAME",
                      value: fieldName,
                      fieldType:
                        customFieldTypeMapping[sourceFieldId] || fieldType,
                    };
                  } else {
                    newValue.sourceField.value = mappedFieldId;
                    newValue.sourceField.fieldType =
                      customFieldTypeMapping[sourceFieldId] || fieldType;
                  }
                }

                // Replace the item's value with the new structure
                item.value = newValue;
                delete item.additional;
                logger.debug(
                  `Transformed COPY array item with additional to Cloud format at ${path}`,
                );
              }
              // If REFERENCE type with additional but no value, move additional to value
              else if (item.type === "REFERENCE" && !("value" in item)) {
                item.value = item.additional;
                delete item.additional;
                logger.debug(
                  `Transformed REFERENCE additional to value: ${item.value} at ${path}`,
                );
              }
              // For other types, just delete additional
              else {
                delete item.additional;
                logger.debug(
                  `Removed DC-specific 'additional' field from SET operation array value at ${path}`,
                );
              }
            }
          }
        }

        // Handle COPY type WITHOUT additional field (means copy from same field)
        // DC: {"type":"COPY","value":"trigger"} means copy from trigger issue's same field
        // Cloud: {"type":"COPY","value":{"copyOptions":[],"sourceIssue":"trigger","sourceField":{same field}}}
        // NOTE: Email to/cc/bcc and destinationStatus fields keep the simple format

        // Handle object value (not in email/to/cc/bcc/destinationStatus fields)
        if (
          typeof component.value === "object" &&
          !Array.isArray(component.value) &&
          component.value.type === "COPY" &&
          typeof component.value.value === "string" &&
          !("copyOptions" in component.value) &&
          !path.includes(".to") &&
          !path.includes(".cc") &&
          !path.includes(".bcc") &&
          !path.includes(".destinationStatus")
        ) {
          const sourceIssue = component.value.value;

          // Get target field info from parent component
          let targetFieldId = component.field?.value || component.fieldId;
          let targetFieldType = component.field?.type || "ID";
          let fieldType = component.fieldType || "unknown";

          // Create source field (same as target field)
          const sourceField = {
            type: targetFieldType,
            value: targetFieldId,
            fieldType: fieldType,
          };

          // Create Cloud format
          component.value = {
            copyOptions: [],
            sourceIssue: sourceIssue,
            sourceField: sourceField,
          };

          logger.debug(
            `Transformed COPY without additional to Cloud format: ${sourceIssue} → same field (${targetFieldId}) at ${path}`,
          );
        }

        // Handle array values with COPY objects (not in email to/cc/bcc/destinationStatus)
        if (
          Array.isArray(component.value) &&
          !path.includes(".to") &&
          !path.includes(".cc") &&
          !path.includes(".bcc") &&
          !path.includes(".destinationStatus")
        ) {
          for (let i = 0; i < component.value.length; i++) {
            const item = component.value[i];
            if (
              typeof item === "object" &&
              item.type === "COPY" &&
              typeof item.value === "string" &&
              !("copyOptions" in item)
            ) {
              const sourceIssue = item.value;

              // Get target field info from parent component
              let targetFieldId = component.field?.value || component.fieldId;
              let targetFieldType = component.field?.type || "ID";
              let fieldType = component.fieldType || "unknown";

              // Create source field (same as target field)
              const sourceField = {
                type: targetFieldType,
                value: targetFieldId,
                fieldType: fieldType,
              };

              // Create Cloud format
              component.value[i] = {
                type: "COPY",
                value: {
                  copyOptions: [],
                  sourceIssue: sourceIssue,
                  sourceField: sourceField,
                },
              };

              logger.debug(
                `Transformed COPY array item without additional to Cloud format: ${sourceIssue} → same field (${targetFieldId}) at ${path}`,
              );
            }
          }
        }
      }

      // Fix webhookUrl format: Data Center uses {"key": "url"}, Cloud expects just "url"
      // ONLY apply for Datacenter-to-Cloud, NOT Cloud-to-Cloud
      if (
        !isCloudSource &&
        component.webhookUrl &&
        typeof component.webhookUrl === "object" &&
        component.webhookUrl.key
      ) {
        logger.debug(`Converting webhookUrl from object to string at ${path}`);
        component.webhookUrl = component.webhookUrl.key;
      }

      // Fix webhook headers format: Data Center uses {"keyOrValue": "val", "secret": false}, Cloud expects just "val"
      // ONLY apply for Datacenter-to-Cloud, NOT Cloud-to-Cloud
      if (
        !isCloudSource &&
        component.headers &&
        Array.isArray(component.headers)
      ) {
        component.headers.forEach((header, idx) => {
          if (
            header.value &&
            typeof header.value === "object" &&
            "keyOrValue" in header.value
          ) {
            logger.debug(
              `Converting header[${idx}].value from object to string at ${path}`,
            );
            header.value = header.value.keyOrValue;
          }
        });
      }

      // CRITICAL FIX: Add value field to container blocks
      // Container blocks (jira.condition.container.block) must have a value field in Cloud
      if (
        component.type === "jira.condition.container.block" &&
        !("value" in component)
      ) {
        component.value = {};
        logger.debug(`Added empty value object to container block at ${path}`);
      }

      // CRITICAL FIX: Fix selectedFieldType with string "null" value
      // Some fields have selectedFieldType: "null" (string) which is invalid
      if (
        component.type === "jira.issue.condition" &&
        component.value &&
        component.value.selectedFieldType === "null"
      ) {
        // Determine correct field type based on selectedField
        const fieldId = component.value.selectedField?.value;
        if (fieldId === "status") {
          component.value.selectedFieldType = "status";
        } else if (fieldId === "assignee") {
          component.value.selectedFieldType = "assignee";
        } else if (fieldId === "reporter") {
          component.value.selectedFieldType = "reporter";
        } else if (fieldId === "priority") {
          component.value.selectedFieldType = "priority";
        } else if (fieldId === "issuetype") {
          component.value.selectedFieldType = "issuetype";
        } else if (fieldId === "resolution") {
          component.value.selectedFieldType = "resolution";
        } else if (fieldId === "components") {
          component.value.selectedFieldType = "components";
        } else if (fieldId === "labels") {
          component.value.selectedFieldType = "labels";
        } else {
          // Default to string type for unknown fields
          component.value.selectedFieldType =
            "com.atlassian.jira.plugin.system.customfieldtypes:textfield";
        }
        logger.debug(
          `Fixed selectedFieldType from "null" to "${component.value.selectedFieldType}" for field ${fieldId} at ${path}`,
        );
      }

      // CRITICAL FIX: Handle EMPTY and NOT_EMPTY comparisons
      // For EMPTY and NOT_EMPTY comparisons, compareValue must be null (not undefined)
      if (
        component.type === "jira.issue.condition" &&
        component.value &&
        (component.value.comparison === "EMPTY" ||
          component.value.comparison === "NOT_EMPTY") &&
        !("compareValue" in component.value)
      ) {
        component.value.compareValue = null;
        logger.debug(
          `Added compareValue: null for ${component.value.comparison} comparison at ${path}`,
        );
      }

      // CRITICAL FIX: Add required Cloud fields to compareValue objects
      // Cloud requires modifier and source fields in all compareValue objects
      if (
        "compareValue" in component &&
        component.compareValue !== null &&
        typeof component.compareValue === "object"
      ) {
        if (!("modifier" in component.compareValue)) {
          component.compareValue.modifier = null;
        }
        if (!("source" in component.compareValue)) {
          component.compareValue.source = null;
        }
        if (!("multiValue" in component.compareValue)) {
          component.compareValue.multiValue = false;
        }
      }

      // CRITICAL FIX: Add required Cloud fields to components
      // These fields are required by Cloud for all components (triggers/actions/conditions)
      if (component.component) {
        if (!("parentId" in component)) {
          component.parentId = null;
        }
        if (!("conditionParentId" in component)) {
          component.conditionParentId = null;
        }
        if (!("connectionId" in component)) {
          component.connectionId = null;
        }

        // CRITICAL FIX: Update schemaVersion for jira.issue.edit and jira.issue.create actions
        if (
          component.type === "jira.issue.edit" &&
          component.schemaVersion !== 12
        ) {
          component.schemaVersion = 12;
          logger.debug(
            `Updated schemaVersion to 12 for jira.issue.edit at ${path}`,
          );
        }

        if (
          component.type === "jira.issue.create" &&
          component.schemaVersion !== 12
        ) {
          component.schemaVersion = 12;
          logger.debug(
            `Updated schemaVersion to 12 for jira.issue.create at ${path}`,
          );
        }

        // CRITICAL FIX: Add/remove fields for jira.issue.edit value
        if (component.type === "jira.issue.edit" && component.value) {
          if (!("advancedFields" in component.value)) {
            component.value.advancedFields = null;
          }
          // CRITICAL: Remove DC-specific useLegacyRendering field (Cloud doesn't use it)
          if ("useLegacyRendering" in component.value) {
            delete component.value.useLegacyRendering;
            logger.debug(
              `Removed useLegacyRendering from jira.issue.edit at ${path}`,
            );
          }
        }
      }

      // CRITICAL FIX: Fix user IDs in operations arrays (jira.issue.edit/create actions)
      // Pattern: {"type":"jira.issue.edit","value":{"operations":[{"type":"SET","value":[{"type":"ID","value":"JIRAUSER10000"}]}]}}
      if (
        (component.type === "jira.issue.edit" ||
          component.type === "jira.issue.create") &&
        component.value &&
        component.value.operations &&
        Array.isArray(component.value.operations)
      ) {
        for (const operation of component.value.operations) {
          // Handle array values (multi-user picker)
          if (
            operation.type === "SET" &&
            Array.isArray(operation.value) &&
            (operation.fieldType?.includes("userpicker") ||
              operation.fieldType?.includes("user") ||
              operation.field?.value?.toLowerCase().includes("approver") ||
              operation.field?.value?.toLowerCase().includes("visible") ||
              operation.field?.value?.toLowerCase().includes("watcher"))
          ) {
            for (let i = 0; i < operation.value.length; i++) {
              const item = operation.value[i];
              if (
                typeof item === "object" &&
                item !== null &&
                item.type === "ID" &&
                typeof item.value === "string" &&
                !item.value.startsWith("{{") && // Skip smart values
                item.value.startsWith("JIRAUSER") // Unmapped DC user
              ) {
                const userId = item.value;
                if (userId in userMapping) {
                  const newUserId = userMapping[userId];
                  logger.debug(
                    `Replaced user ID in operations[].value[${i}] ${userId} → ${newUserId} at ${path}`,
                  );
                  item.value = newUserId;
                } else {
                  // Use default account ID if provided
                  if (defaultAccountId) {
                    logger.warn(
                      `No mapping found for user ID in operations[].value[${i}]: ${userId} at ${path}, using default: ${defaultAccountId}`,
                    );
                    item.value = defaultAccountId;
                  } else {
                    trackUnmapped("users", userId);
                    logger.warn(
                      `No mapping found for user ID in operations[].value[${i}]: ${userId} at ${path}`,
                    );
                  }
                }
              }
            }
          }
          // Handle single value (single user picker)
          else if (
            operation.type === "SET" &&
            typeof operation.value === "object" &&
            operation.value !== null &&
            !Array.isArray(operation.value) &&
            operation.value.type === "ID" &&
            typeof operation.value.value === "string" &&
            !operation.value.value.startsWith("{{") &&
            operation.value.value.startsWith("JIRAUSER") &&
            (operation.fieldType?.includes("userpicker") ||
              operation.fieldType?.includes("user") ||
              operation.fieldType === "assignee" ||
              operation.fieldType === "reporter")
          ) {
            const userId = operation.value.value;
            if (userId in userMapping) {
              const newUserId = userMapping[userId];
              logger.debug(
                `Replaced user ID in operations[].value ${userId} → ${newUserId} at ${path}`,
              );
              operation.value.value = newUserId;
            } else {
              // Use default account ID if provided
              if (defaultAccountId) {
                logger.warn(
                  `No mapping found for user ID in operations[].value: ${userId} at ${path}, using default: ${defaultAccountId}`,
                );
                operation.value.value = defaultAccountId;
              } else {
                trackUnmapped("users", userId);
                logger.warn(
                  `No mapping found for user ID in operations[].value: ${userId} at ${path}`,
                );
              }
            }
          }
        }
      }

      // CRITICAL FIX: Fix user IDs in jira.issue.assign userList arrays
      // Pattern: {"type":"jira.issue.assign","value":{"userList":[{"type":"ID","value":"JIRAUSER10000"}]}}
      if (
        component.type === "jira.issue.assign" &&
        component.value &&
        component.value.userList &&
        Array.isArray(component.value.userList)
      ) {
        for (let i = 0; i < component.value.userList.length; i++) {
          const item = component.value.userList[i];
          if (
            typeof item === "object" &&
            item !== null &&
            item.type === "ID" &&
            typeof item.value === "string" &&
            !item.value.startsWith("{{") && // Skip smart values
            item.value.startsWith("JIRAUSER") // Unmapped DC user
          ) {
            const userId = item.value;
            if (userId in userMapping) {
              const newUserId = userMapping[userId];
              logger.debug(
                `Replaced user ID in assign userList[${i}] ${userId} → ${newUserId} at ${path}`,
              );
              item.value = newUserId;
            } else {
              // Use default account ID if provided
              if (defaultAccountId) {
                logger.warn(
                  `No mapping found for user ID in assign userList[${i}]: ${userId} at ${path}, using default: ${defaultAccountId}`,
                );
                item.value = defaultAccountId;
              } else {
                trackUnmapped("users", userId);
                logger.warn(
                  `No mapping found for user ID in assign userList[${i}]: ${userId} at ${path}`,
                );
              }
            }
          }
        }

        // Also check assignee field
        if (
          component.value.assignee &&
          typeof component.value.assignee === "object" &&
          component.value.assignee.type === "ID" &&
          typeof component.value.assignee.value === "string" &&
          !component.value.assignee.value.startsWith("{{") &&
          component.value.assignee.value.startsWith("JIRAUSER")
        ) {
          const userId = component.value.assignee.value;
          if (userId in userMapping) {
            const newUserId = userMapping[userId];
            logger.debug(
              `Replaced user ID in assign assignee ${userId} → ${newUserId} at ${path}`,
            );
            component.value.assignee.value = newUserId;
          } else {
            // Use default account ID if provided
            if (defaultAccountId) {
              logger.warn(
                `No mapping found for user ID in assign assignee: ${userId} at ${path}, using default: ${defaultAccountId}`,
              );
              component.value.assignee.value = defaultAccountId;
            } else {
              trackUnmapped("users", userId);
              logger.warn(
                `No mapping found for user ID in assign assignee: ${userId} at ${path}`,
              );
            }
          }
        }
      }

      // CRITICAL FIX: Transform DC transition component to Cloud format
      // DC: {"type":"jira.issue.transition","value":{"transitionMode":"transition","transition":{"id":"1061","workflowName":"..."},"ignoreConditions":false}}
      // Cloud: {"type":"jira.issue.transition","value":{"destinationStatus":{"type":"NAME","value":"Approved"}}}
      // ONLY apply for Datacenter-to-Cloud, NOT Cloud-to-Cloud
      if (
        !isCloudSource &&
        component.type === "jira.issue.transition" &&
        component.value &&
        typeof component.value === "object"
      ) {
        // Remove DC-specific fields
        if ("transitionMode" in component.value) {
          delete component.value.transitionMode;
          logger.debug(
            `Removed DC-specific 'transitionMode' from transition at ${path}`,
          );
        }
        if ("ignoreConditions" in component.value) {
          delete component.value.ignoreConditions;
          logger.debug(
            `Removed DC-specific 'ignoreConditions' from transition at ${path}`,
          );
        }
        if ("useLegacyRendering" in component.value) {
          delete component.value.useLegacyRendering;
          logger.debug(
            `Removed DC-specific 'useLegacyRendering' from transition at ${path}`,
          );
        }

        // Handle transition object (DC format)
        if (
          component.value.transition &&
          typeof component.value.transition === "object"
        ) {
          const transitionId = component.value.transition.id;
          const workflowName = component.value.transition.workflowName;

          // Check if we already have destinationStatus mapped in statusMapping
          // The transition ID might correspond to a status ID
          if (transitionId && transitionId in statusMapping) {
            component.value.destinationStatus = {
              type: "NAME",
              value: statusMapping[transitionId],
            };
            logger.info(
              `Added destinationStatus from statusMapping for transition ${transitionId} → "${statusMapping[transitionId]}" at ${path}`,
            );
          } else {
            // We can't automatically determine the destination status without workflow data
            // Log this for manual resolution and leave transition info as a comment
            logger.warn(
              `⚠️  MANUAL ACTION REQUIRED: Transition component at ${path} needs destinationStatus configured. Original DC transition: id=${transitionId}, workflow="${workflowName}"`,
            );

            // Add destinationStatus as null - this will need manual fixing in Jira UI
            if (!component.value.destinationStatus) {
              component.value.destinationStatus = {
                type: "NAME",
                value: "", // Empty - must be manually configured in Jira
              };
              logger.warn(
                `Added empty destinationStatus for transition ${transitionId} at ${path} - MUST BE MANUALLY CONFIGURED IN JIRA UI AFTER IMPORT`,
              );
            }
          }

          // Remove the DC transition object
          delete component.value.transition;
          logger.debug(`Removed DC transition object at ${path}`);
        }

        // Ensure advancedFields exists for Cloud compatibility
        if (!("advancedFields" in component.value)) {
          component.value.advancedFields = null;
        }
      }

      // CRITICAL FIX: Add missing value field to SET operations
      // DC can have SET without value, but Cloud requires it
      if (
        component.type === "SET" &&
        component.field &&
        !("value" in component)
      ) {
        let emptyValue = ""; // Default to empty string
        if (component.fieldType) {
          if (
            component.fieldType.includes("multi") ||
            component.fieldType.includes("checkbox")
          ) {
            emptyValue = [];
          } else if (
            component.fieldType.includes("userpicker") ||
            component.fieldType.includes("grouppicker") ||
            component.fieldType.includes("number")
          ) {
            emptyValue = null;
          }
        }
        component.value = emptyValue;
        logger.info(
          `FIXED: Added missing value to SET for field: ${component.field?.value || component.fieldId} with value: ${JSON.stringify(emptyValue)} at ${path}`,
        );
      }

      // Recurse through all nested structures
      for (const key in component) {
        if (component.hasOwnProperty(key)) {
          recursivelyFixIds(component[key], `${path}.${key}`, trackUnmapped);
        }
      }
    }
  }

  // List of component types that don't exist in Cloud
  const incompatibleComponentTypes = [
    "com.onresolve.jira.groovy.groovyrunner:lookup-object-bean", // ScriptRunner
    "com.onresolve.jira.groovy.GroovyFunctionPlugin", // ScriptRunner
    "com.onresolve.jira.groovy", // Any ScriptRunner component
    "com.xiplink.jira.git.jira_git_plugin", // Git Integration plugin triggers
  ];

  /**
   * Remove incompatible components from rule recursively
   */
  function removeIncompatibleComponents(components) {
    if (!Array.isArray(components)) return components;

    return components.filter((component) => {
      // Check if this component type is incompatible
      if (
        component.type &&
        incompatibleComponentTypes.some((incompatible) =>
          component.type.includes(incompatible),
        )
      ) {
        logger.warn(`Removing incompatible component type: ${component.type}`);
        return false;
      }

      // Recursively clean children
      if (component.children && Array.isArray(component.children)) {
        component.children = removeIncompatibleComponents(component.children);
      }

      return true;
    });
  }

  // Fix rules
  const fixedRules = [];
  const skippedRules = [];

  // ============================================================================
  // FILTER TOGGLE: Controlled by filterUnmapped parameter
  // ============================================================================
  // When true: Rules with ANY unmapped custom fields, statuses, users, etc. are filtered out
  // When false: All rules are kept, unmapped IDs are just logged as warnings
  // Default: false for cloud-to-cloud (preserve all rules), true for DC-to-cloud (safer)
  const FILTER_RULES_WITH_UNMAPPED_IDS = filterUnmapped;
  // ============================================================================

  for (const rule of rules) {
    // Track unmapped IDs for this specific rule
    const ruleUnmappedIds = {
      projects: new Set(),
      issueTypes: new Set(),
      customFields: new Set(),
      statuses: new Set(),
      users: new Set(),
      resolutions: new Set(),
      priorities: new Set(),
    };

    // Helper to track unmapped IDs both globally and per-rule
    const trackUnmapped = (category, id) => {
      unmappedIds[category].add(id);
      ruleUnmappedIds[category].add(id);
    };

    // Check if trigger is incompatible (Git plugin, etc.)
    if (rule.trigger && rule.trigger.type) {
      const isIncompatibleTrigger = incompatibleComponentTypes.some(
        (incompatible) => rule.trigger.type.includes(incompatible),
      );

      if (isIncompatibleTrigger) {
        logger.warn(
          `Skipping rule "${rule.name}" - trigger type "${rule.trigger.type}" is incompatible with Cloud`,
        );
        skippedRules.push({
          name: rule.name,
          reason: `Incompatible trigger: ${rule.trigger.type}`,
        });
        continue;
      }
    }

    // Remove incompatible components (e.g., ScriptRunner)
    if (rule.components && Array.isArray(rule.components)) {
      const originalCount = rule.components.length;
      rule.components = removeIncompatibleComponents(rule.components);

      if (rule.components.length === 0 && originalCount > 0) {
        logger.warn(
          `Skipping rule "${rule.name}" - all components are incompatible with Cloud`,
        );
        skippedRules.push({
          name: rule.name,
          reason: "All components incompatible",
        });
        continue;
      } else if (rule.components.length < originalCount) {
        logger.info(
          `Rule "${rule.name}" - removed ${originalCount - rule.components.length} incompatible component(s)`,
        );
      }
    }

    // FIXED: Fix project IDs in ruleScopeARIs (correct property name from OpenAPI spec)
    if (rule.ruleScopeARIs && Array.isArray(rule.ruleScopeARIs)) {
      const newResources = [];
      for (const resource of rule.ruleScopeARIs) {
        if (resource.includes("project/")) {
          const projectId = resource.split("project/")[1];
          if (projectId in projectMapping) {
            // Replace both cloud ID AND project ID in ARI
            if (cloudId) {
              newResources.push(
                `ari:cloud:jira:${cloudId}:project/${projectMapping[projectId]}`,
              );
            } else {
              newResources.push(
                `ari:cloud:jira::project/${projectMapping[projectId]}`,
              );
            }
          } else {
            // CRITICAL: Even if project is unmapped, still replace cloud ID
            if (
              cloudId &&
              resource.match(/ari:cloud:jira:[a-f0-9-]+:project/)
            ) {
              const newResource = resource.replace(
                /ari:cloud:jira:[a-f0-9-]+:/,
                `ari:cloud:jira:${cloudId}:`,
              );
              newResources.push(newResource);
            } else {
              newResources.push(resource);
            }
          }
        } else {
          newResources.push(resource);
        }
      }
      rule.ruleScopeARIs = newResources;
    }

    // CRITICAL FIX: Fix project IDs and cloud IDs in existing ruleScope.resources
    if (
      rule.ruleScope &&
      rule.ruleScope.resources &&
      Array.isArray(rule.ruleScope.resources)
    ) {
      const newResources = [];
      for (const resource of rule.ruleScope.resources) {
        if (resource.includes("project/")) {
          const match = resource.match(/project\/(\d+)/);
          if (match) {
            const projectId = match[1];
            if (projectId in projectMapping) {
              // Replace both cloud ID AND project ID in ARI
              if (cloudId) {
                newResources.push(
                  `ari:cloud:jira:${cloudId}:project/${projectMapping[projectId]}`,
                );
              } else {
                newResources.push(
                  `ari:cloud:jira::project/${projectMapping[projectId]}`,
                );
              }
            } else {
              // CRITICAL: Even if project is unmapped, still replace cloud ID
              if (
                cloudId &&
                resource.match(/ari:cloud:jira:[a-f0-9-]+:project/)
              ) {
                const newResource = resource.replace(
                  /ari:cloud:jira:[a-f0-9-]+:/,
                  `ari:cloud:jira:${cloudId}:`,
                );
                newResources.push(newResource);
              } else {
                newResources.push(resource);
              }
            }
          } else {
            newResources.push(resource);
          }
        } else if (resource.includes("site/")) {
          // Fix global site ARIs
          if (
            cloudId &&
            resource.match(/ari:cloud:jira[^:]*:[a-f0-9-]+:site/)
          ) {
            const newResource = resource.replace(
              /ari:cloud:jira([^:]*):([a-f0-9-]+):site/,
              `ari:cloud:jira$1:${cloudId}:site`,
            );
            newResources.push(newResource);
          } else {
            newResources.push(resource);
          }
        } else {
          newResources.push(resource);
        }
      }
      rule.ruleScope.resources = newResources;
    }

    // CRITICAL FIX: Fix cloud IDs in existing ruleHome locationARIs
    if (rule.ruleHome && cloudId) {
      // Fix ruleLifecycleHome locationARI
      if (rule.ruleHome.ruleLifecycleHome?.locationARI) {
        const ari = rule.ruleHome.ruleLifecycleHome.locationARI;
        if (ari.match(/ari:cloud:jira[^:]*:[a-f0-9-]+:/)) {
          // Replace cloud ID in project ARIs
          if (ari.includes("project/")) {
            const match = ari.match(/project\/(\d+)/);
            if (match) {
              const projectId = match[1];
              const mappedProjectId = projectMapping[projectId] || projectId;
              rule.ruleHome.ruleLifecycleHome.locationARI = `ari:cloud:jira:${cloudId}:project/${mappedProjectId}`;
            }
          } else if (ari.includes("site/")) {
            // Replace cloud ID in site ARIs
            rule.ruleHome.ruleLifecycleHome.locationARI = ari.replace(
              /ari:cloud:jira([^:]*):([a-f0-9-]+):site/,
              `ari:cloud:jira$1:${cloudId}:site`,
            );
          }
        }
      }

      // Fix ruleBillingHome locationARI
      if (rule.ruleHome.ruleBillingHome?.locationARI) {
        const ari = rule.ruleHome.ruleBillingHome.locationARI;
        if (ari.match(/ari:cloud:jira[^:]*:[a-f0-9-]+:/)) {
          // Replace cloud ID in project ARIs
          if (ari.includes("project/")) {
            const match = ari.match(/project\/(\d+)/);
            if (match) {
              const projectId = match[1];
              const mappedProjectId = projectMapping[projectId] || projectId;
              rule.ruleHome.ruleBillingHome.locationARI = `ari:cloud:jira-software:${cloudId}:project/${mappedProjectId}`;
            }
          } else if (ari.includes("site/")) {
            // Replace cloud ID in site ARIs
            rule.ruleHome.ruleBillingHome.locationARI = ari.replace(
              /ari:cloud:jira([^:]*):([a-f0-9-]+):site/,
              `ari:cloud:jira$1:${cloudId}:site`,
            );
          }
        }
      }
    }

    // CRITICAL FIX: Fix project IDs in trigger eventFilters (Cloud uses these for scoping)
    // Cloud pattern: "eventFilters": ["ari:cloud:jira:00000009-0000-4000-8000-000000000009:project/10346"]
    if (
      rule.trigger &&
      rule.trigger.value &&
      rule.trigger.value.eventFilters &&
      Array.isArray(rule.trigger.value.eventFilters)
    ) {
      const newEventFilters = [];
      for (const filter of rule.trigger.value.eventFilters) {
        if (typeof filter === "string" && filter.includes("project/")) {
          // Extract project ID from ARI
          const match = filter.match(/project\/(\d+)/);
          if (match) {
            const projectId = match[1];
            if (projectId in projectMapping) {
              // Replace both cloud ID AND project ID in ARI
              let newFilter = filter.replace(
                /project\/\d+/,
                `project/${projectMapping[projectId]}`,
              );
              // Replace cloud ID with target cloud ID
              if (cloudId) {
                newFilter = newFilter.replace(
                  /ari:cloud:jira:[a-f0-9-]+:/,
                  `ari:cloud:jira:${cloudId}:`,
                );
              }
              newEventFilters.push(newFilter);
              logger.debug(
                `Replaced project ID in eventFilter: ${filter} → ${newFilter}`,
              );
            } else {
              // CRITICAL: Even if project is unmapped, still replace cloud ID
              let newFilter = filter;
              if (cloudId) {
                newFilter = filter.replace(
                  /ari:cloud:jira:[a-f0-9-]+:/,
                  `ari:cloud:jira:${cloudId}:`,
                );
              }
              newEventFilters.push(newFilter);
              trackUnmapped("projects", projectId);
              logger.warn(
                `No mapping found for project ID in eventFilter: ${projectId}`,
              );
            }
          } else {
            newEventFilters.push(filter);
          }
        } else {
          newEventFilters.push(filter);
        }
      }
      rule.trigger.value.eventFilters = newEventFilters;
    }

    // Fix rule-level user IDs (authorAccountId, actorAccountId)
    if (rule.authorAccountId && typeof rule.authorAccountId === "string") {
      const userId = rule.authorAccountId;
      if (userId in userMapping) {
        const newUserId = userMapping[userId];
        logger.debug(`Replaced rule.authorAccountId ${userId} → ${newUserId}`);
        rule.authorAccountId = newUserId;
      } else {
        // Use default account ID if provided
        if (defaultAccountId) {
          logger.warn(
            `No mapping found for rule.authorAccountId: ${userId}, using default: ${defaultAccountId}`,
          );
          rule.authorAccountId = defaultAccountId;
        } else {
          trackUnmapped("users", userId);
          logger.warn(`No mapping found for authorAccountId: ${userId}`);
        }
      }
    }

    if (rule.actorAccountId && typeof rule.actorAccountId === "string") {
      const userId = rule.actorAccountId;
      let mappedUserId;

      if (userId in userMapping) {
        mappedUserId = userMapping[userId];
        logger.debug(
          `Replaced rule.actorAccountId ${userId} → ${mappedUserId}`,
        );
      } else {
        // Use default account ID if provided, otherwise keep original
        if (defaultAccountId) {
          mappedUserId = defaultAccountId;
          logger.warn(
            `No mapping found for rule.actorAccountId: ${userId}, using default: ${defaultAccountId}`,
          );
        } else {
          mappedUserId = userId;
          trackUnmapped("users", userId);
          logger.warn(
            `No mapping found for actorAccountId: ${userId}, keeping original (may cause import issues)`,
          );
        }
      }

      // Transform actorAccountId to actor object (Cloud format)
      rule.actor = {
        type: "ACCOUNT_ID",
        value: mappedUserId,
      };
      delete rule.actorAccountId;
      logger.debug(`Transformed actorAccountId to actor object`);
    }

    // Transform projects array to ruleScope and ruleHome (Cloud format)
    if (
      rule.projects &&
      Array.isArray(rule.projects) &&
      rule.projects.length > 0
    ) {
      const resources = [];
      let projectTypeKey = "software"; // Default

      for (const proj of rule.projects) {
        if (proj.projectId) {
          const mappedProjectId =
            proj.projectId in projectMapping
              ? projectMapping[proj.projectId]
              : proj.projectId;
          if (cloudId) {
            resources.push(
              `ari:cloud:jira:${cloudId}:project/${mappedProjectId}`,
            );
          }
          if (proj.projectTypeKey) {
            projectTypeKey = proj.projectTypeKey;
          }
        }
      }

      // CRITICAL: Validate that all project IDs in resources have valid mappings
      // Before creating ruleScope, check if any project references unmapped DC IDs
      let hasInvalidProject = false;
      let invalidProjectId = null;
      if (resources.length > 0) {
        const validCloudProjectIds = new Set(
          Object.values(projectMapping).filter((id) => id),
        );
        const validDcProjectIds = new Set(Object.keys(projectMapping));

        for (const resource of resources) {
          if (resource.includes("project/")) {
            const projectId = resource.split("project/").pop();
            const isValidCloudId = validCloudProjectIds.has(projectId);
            const isDcIdWithMapping = validDcProjectIds.has(projectId);

            if (!isValidCloudId && !isDcIdWithMapping) {
              // This project doesn't exist in Cloud (unmapped DC ID)
              logger.warn(
                `[VALIDATION] Rule "${rule.name}" references non-existent Cloud project: ${projectId}`,
              );
              trackUnmapped("projects", projectId);
              hasInvalidProject = true;
              invalidProjectId = projectId;
              break; // Stop checking this rule's projects
            }
          }
        }
      }

      // Skip this rule if it has invalid projects
      if (hasInvalidProject) {
        logger.warn(
          `[VALIDATION] Skipping rule "${rule.name}" - project ${invalidProjectId} not available in Cloud`,
        );
        skippedRules.push({
          name: rule.name || "Unnamed rule",
          reason: `Project ${invalidProjectId} not available in Cloud`,
        });
        continue; // Skip to next rule in main loop
      }

      if (resources.length > 0 && cloudId) {
        // Create ruleScope
        rule.ruleScope = {
          resources: resources,
        };

        // Create ruleHome
        const productType =
          projectTypeKey === "service_desk"
            ? "jira-servicedesk"
            : "jira-software";
        rule.ruleHome = {
          ruleLifecycleHome: {
            locationARI: resources[0], // Use first project
          },
          ruleBillingHome: {
            locationARI: `ari:cloud:${productType}:${cloudId}:site/${cloudId}`,
          },
        };

        // CRITICAL: Add eventFilters to trigger for issue event triggers
        // Cloud requires eventFilters for project-scoped rules with issue event triggers
        if (rule.trigger && rule.trigger.value && rule.trigger.type) {
          const triggerType = rule.trigger.type;
          // Issue event triggers need eventFilters
          if (
            triggerType.includes("jira.issue.event.trigger") ||
            triggerType.includes("jira.issue.field.changed")
          ) {
            if (!rule.trigger.value.eventFilters) {
              rule.trigger.value.eventFilters = resources;
              logger.debug(`Added eventFilters to trigger: ${triggerType}`);
            }
          }
        }

        logger.debug(
          `Created ruleScope with ${resources.length} resource(s) and ruleHome`,
        );
      }

      // Empty projects array (Cloud uses ruleScope instead)
      rule.projects = [];
    } else if (
      rule.projects &&
      Array.isArray(rule.projects) &&
      rule.projects.length === 0 &&
      !rule.ruleScope &&
      cloudId
    ) {
      // Global rule (no projects AND no existing ruleScope) - create global ruleScope and ruleHome
      rule.ruleScope = {
        resources: [`ari:cloud:jira:${cloudId}:site/${cloudId}`],
      };
      rule.ruleHome = {
        ruleLifecycleHome: {
          locationARI: `ari:cloud:jira-software:${cloudId}:site/${cloudId}`,
        },
        ruleBillingHome: {
          locationARI: `ari:cloud:jira-software:${cloudId}:site/${cloudId}`,
        },
      };
      logger.debug(
        `Created global ruleScope and ruleHome for rule without projects`,
      );
    }

    // CRITICAL: Ensure ALL project-scoped rules with issue event triggers have eventFilters
    // This handles rules that already had ruleScope but no eventFilters
    if (
      rule.ruleScope &&
      rule.ruleScope.resources &&
      rule.ruleScope.resources.length > 0 &&
      rule.ruleScope.resources[0].includes("project/") &&
      rule.trigger &&
      rule.trigger.type
    ) {
      const triggerType = rule.trigger.type;
      // Issue event triggers need eventFilters
      if (
        triggerType.includes("jira.issue.event.trigger") ||
        triggerType.includes("jira.issue.field.changed")
      ) {
        // Create trigger.value if it doesn't exist
        if (!rule.trigger.value) {
          rule.trigger.value = {};

          // Add required fields based on trigger type
          if (triggerType.includes(":commented")) {
            rule.trigger.value.eventKey = "jira:issue_updated";
            rule.trigger.value.issueEvent = "issue_commented";
            // REMOVED: Don't add eventTypes - analysis shows it's rarely present in working Cloud exports
            // rule.trigger.value.eventTypes = [];
          } else if (triggerType.includes(":created")) {
            rule.trigger.value.eventKey = "jira:issue_created";
            rule.trigger.value.issueEvent = "issue_created";
          } else if (triggerType.includes(":updated")) {
            rule.trigger.value.eventKey = "jira:issue_updated";
            rule.trigger.value.issueEvent = "issue_updated";
          } else if (triggerType.includes(":assigned")) {
            rule.trigger.value.eventKey = "jira:issue_updated";
            rule.trigger.value.issueEvent = "issue_assigned";
          } else if (triggerType.includes(":transitioned")) {
            rule.trigger.value.eventKey = "jira:issue_updated";
            rule.trigger.value.issueEvent = "issue_generic";
          }

          logger.debug(`Created trigger.value for ${triggerType}`);
        }

        // Add eventFilters if missing
        if (!rule.trigger.value.eventFilters) {
          rule.trigger.value.eventFilters = rule.ruleScope.resources;
          logger.debug(
            `Added missing eventFilters from ruleScope for trigger: ${triggerType}`,
          );
        }
      }
    }

    // Add changeType to field.changed triggers (Cloud requires this)
    if (
      rule.trigger &&
      rule.trigger.value &&
      rule.trigger.type === "jira.issue.field.changed" &&
      !rule.trigger.value.changeType
    ) {
      rule.trigger.value.changeType = "ANY_CHANGE";
      logger.debug(`Added changeType to field.changed trigger`);
    }

    // REMOVED: Don't add eventTypes to :commented triggers
    // Analysis shows that most Cloud triggers don't have eventTypes field
    // Only 3 out of 221 rules in the working export have it
    // if (
    //   rule.trigger &&
    //   rule.trigger.value &&
    //   rule.trigger.type === "jira.issue.event.trigger:commented" &&
    //   !("eventTypes" in rule.trigger.value)
    // ) {
    //   rule.trigger.value.eventTypes = [];
    //   logger.debug(`Added eventTypes to commented trigger`);
    // }

    // CRITICAL FIX: Remove numeric labels - Cloud doesn't support them
    // Labels should be strings or empty array, not numbers
    if (rule.labels && Array.isArray(rule.labels)) {
      const hasNumericLabels = rule.labels.some(
        (label) => typeof label === "number",
      );
      if (hasNumericLabels) {
        logger.debug(
          `Removing numeric labels from rule "${rule.name}": ${JSON.stringify(rule.labels)}`,
        );
        rule.labels = []; // Clear numeric labels as they're not valid in Cloud
      }
    }

    // CRITICAL FIX: Replace null id, created, updated with fake values
    // These cause NullPointerException in Cloud import
    if (rule.id === null) {
      // Generate a simple random ID
      rule.id = 9000000 + Math.floor(Math.random() * 1000000); // Random ID between 9000000-9999999
      logger.debug(
        `Replaced null id with fake value ${rule.id} for rule "${rule.name}"`,
      );
    }
    if (rule.created === null) {
      // Use today's timestamp
      rule.created = Date.now();
      logger.debug(
        `Replaced null created with today's timestamp for rule "${rule.name}"`,
      );
    }
    if (rule.updated === null) {
      // Also use today's timestamp
      rule.updated = Date.now();
      logger.debug(
        `Replaced null updated with today's timestamp for rule "${rule.name}"`,
      );
    }
    if (rule.currentVersionId === null) {
      delete rule.currentVersionId; // This one we can safely remove
    }
    if (rule.description === null) {
      rule.description = "Migrated"; // Add migrated text
      logger.debug(
        `Replaced null description with empty string for rule "${rule.name}"`,
      );
    }

    // CRITICAL FIX: Add required Cloud fields to ALL triggers
    if (rule.trigger) {
      if (!("parentId" in rule.trigger)) {
        rule.trigger.parentId = null;
      }
      if (!("conditionParentId" in rule.trigger)) {
        rule.trigger.conditionParentId = null;
      }
      if (!("connectionId" in rule.trigger)) {
        rule.trigger.connectionId = null;
      }
    }

    // Add required fields to manual triggers (Cloud requires these)
    if (
      rule.trigger &&
      rule.trigger.value &&
      rule.trigger.type === "jira.manual.trigger.issue"
    ) {
      if (!("inputFromUsers" in rule.trigger.value)) {
        rule.trigger.value.inputFromUsers = false;
      }
      if (!("inputPrompts" in rule.trigger.value)) {
        rule.trigger.value.inputPrompts = [];
      }
      if (!("issueFilter" in rule.trigger.value)) {
        rule.trigger.value.issueFilter = null;
      }
      if (!("jQLFilter" in rule.trigger.value)) {
        rule.trigger.value.jQLFilter = null;
      }
      logger.debug(`Added required fields to manual trigger`);
    }

    // Remove DC-specific 'synchronous' field from ALL triggers (Cloud doesn't use it)
    // ONLY apply for Datacenter-to-Cloud, NOT Cloud-to-Cloud
    if (
      !isCloudSource &&
      rule.trigger &&
      rule.trigger.value &&
      "synchronous" in rule.trigger.value
    ) {
      delete rule.trigger.value.synchronous;
      logger.debug(`Removed DC-specific 'synchronous' field from trigger`);
    }

    // Remove DC-specific 'processIssuesInBulk' field from scheduled triggers (Cloud doesn't use it)
    // ONLY apply for Datacenter-to-Cloud, NOT Cloud-to-Cloud
    if (
      !isCloudSource &&
      rule.trigger &&
      rule.trigger.value &&
      rule.trigger.type === "jira.jql.scheduled" &&
      "processIssuesInBulk" in rule.trigger.value
    ) {
      delete rule.trigger.value.processIssuesInBulk;
      logger.debug(
        `Removed DC-specific 'processIssuesInBulk' field from scheduled trigger`,
      );
    }

    // Transform DC field IDs in SLA trigger customFieldId
    if (
      rule.trigger &&
      rule.trigger.value &&
      rule.trigger.type === "jira.sla.threshold.trigger" &&
      rule.trigger.value.customFieldId
    ) {
      const dcFieldId = rule.trigger.value.customFieldId;
      if (
        dcFieldId.startsWith("customfield_") &&
        customFieldMapping[dcFieldId]
      ) {
        rule.trigger.value.customFieldId = customFieldMapping[dcFieldId];
        logger.debug(
          `Transformed SLA trigger customFieldId: ${dcFieldId} → ${customFieldMapping[dcFieldId]}`,
        );
      }
    }

    // Transform DC field IDs in field.changed trigger fields array
    if (
      rule.trigger &&
      rule.trigger.value &&
      rule.trigger.type === "jira.issue.field.changed" &&
      rule.trigger.value.fields
    ) {
      for (const field of rule.trigger.value.fields) {
        if (
          field.value &&
          field.value.startsWith("customfield_") &&
          customFieldMapping[field.value]
        ) {
          const oldValue = field.value;
          field.value = customFieldMapping[oldValue];
          logger.debug(
            `Transformed field.changed trigger field: ${oldValue} → ${field.value}`,
          );
        }
      }
    }

    // Transform DC field IDs in email action recipients (to, cc, bcc)
    if (rule.components) {
      for (const comp of rule.components) {
        if (comp.type === "jira.issue.outgoing.email" && comp.value) {
          for (const recipientType of ["to", "cc", "bcc"]) {
            const recipients = comp.value[recipientType];
            if (Array.isArray(recipients)) {
              for (const recipient of recipients) {
                if (
                  recipient.type === "COPY" &&
                  recipient.value &&
                  recipient.value.startsWith("customfield_")
                ) {
                  const dcFieldId = recipient.value;
                  if (customFieldMapping[dcFieldId]) {
                    recipient.value = customFieldMapping[dcFieldId];
                    logger.debug(
                      `Transformed email recipient field: ${dcFieldId} → ${recipient.value}`,
                    );
                  }
                }
              }
            }
          }
        }
      }
    }

    // Remove DC-specific 'processIssuesInBulk' from ALL component values (not just triggers)
    // DC uses this in jira.issue.related and other components, Cloud doesn't have it
    if (rule.components) {
      for (const comp of rule.components) {
        if (
          comp.value &&
          typeof comp.value === "object" &&
          "processIssuesInBulk" in comp.value
        ) {
          delete comp.value.processIssuesInBulk;
          logger.debug(
            `Removed DC-specific 'processIssuesInBulk' field from component ${comp.type}`,
          );
        }
      }
    }

    // CRITICAL FIX: Add missing value field to SET operations
    // DC can have SET operations without value field, but Cloud requires it
    const addMissingSetValues = (obj) => {
      if (!obj || typeof obj !== "object") return;

      if (Array.isArray(obj)) {
        for (const item of obj) {
          addMissingSetValues(item);
        }
      } else {
        // Check this object first
        if (obj.type === "SET" && obj.field && !("value" in obj)) {
          obj.value = null;
          logger.info(
            `FIXED: Added missing value field to SET operation for field: ${obj.field.value || obj.fieldId}`,
          );
        }

        // Then recurse into children
        for (const key in obj) {
          if (obj.hasOwnProperty(key) && key !== "value") {
            addMissingSetValues(obj[key]);
          }
        }
      }
    };

    // CRITICAL: Fix IDs in trigger (toStatus, fromStatus, custom fields, etc.)
    if (rule.trigger) {
      recursivelyFixIds(rule.trigger, "trigger", trackUnmapped);
    }

    // Fix issue type IDs in components (this transforms fieldId → field)
    if (rule.components) {
      recursivelyFixIds(rule.components, "root", trackUnmapped);
    }

    // NOW add missing values AFTER field transformation
    addMissingSetValues(rule.components);
    addMissingSetValues(rule.trigger);

    // CRITICAL FIX: Add required Cloud fields that are missing from DC export
    // These fields are required by Cloud import (based on working export analysis)
    if (!("billingType" in rule)) {
      rule.billingType = "NORMAL";
    }
    if (!("collaborators" in rule)) {
      rule.collaborators = [];
    }
    if (!("currentVersionId" in rule)) {
      rule.currentVersionId = null;
    }
    if (!("description" in rule) || rule.description === null) {
      rule.description = "Migrated from Data Center";
    }
    if (!("writeAccessType" in rule)) {
      rule.writeAccessType = "UNRESTRICTED";
    }
    if (!("idUuid" in rule)) {
      // Generate UUID for idUuid
      rule.idUuid = crypto.randomUUID();
    }
    if (!("partitionId" in rule)) {
      // partitionId must also be a UUID
      rule.partitionId = crypto.randomUUID();
    }

    // CRITICAL: Remove DC-specific useLegacyRendering from ALL components
    // This field doesn't exist in Cloud and causes import failures
    // Found in jira.issue.create (59 rules), jira.issue.edit, and potentially other component types
    if (rule.components) {
      for (const comp of rule.components) {
        // Remove from ANY component type that has it
        if (
          comp.value &&
          typeof comp.value === "object" &&
          "useLegacyRendering" in comp.value
        ) {
          delete comp.value.useLegacyRendering;
          logger.debug(
            `Removed useLegacyRendering from ${comp.type} component in rule: ${rule.name}`,
          );
        }

        // Recursive function to fix operations in nested components
        const fixComponentOperations = (component) => {
          // FIX: Handle operations with mismatched type and value structure
          // Cloud expects different structures for COPY operations
          // This applies to both jira.issue.create AND jira.issue.edit
          if (
            (component.type === "jira.issue.create" ||
              component.type === "jira.issue.edit") &&
            component.value?.operations
          ) {
            for (const op of component.value.operations) {
              // Fix empty string values (replace with null for Cloud)
              if (op.value === "") {
                op.value = null;
                logger.debug(
                  `Fixed empty string value to null for field ${op.field?.value || op.fieldId} in rule: ${rule.name}`,
                );
              }

              // Fix operations that have Data Center COPY structure
              // ONLY apply this transformation for Datacenter-to-Cloud, NOT Cloud-to-Cloud
              if (!isCloudSource && op.value && typeof op.value === "object") {
                // Check if this has DC COPY structure with sourceIssue/sourceField
                if (op.value.sourceIssue && op.value.sourceField) {
                  // For description field with COPY type, use special structure
                  if (op.fieldType === "description" && op.type === "COPY") {
                    op.value = {
                      type: "COPY",
                      value: op.value.sourceIssue,
                      additional: op.value.sourceField.value || "description",
                    };
                    // Remove field property for description COPY
                    delete op.field;
                    logger.debug(
                      `Fixed description COPY operation structure in rule: ${rule.name}`,
                    );
                  }
                  // For other fields, keep as SET but transform value to Cloud format
                  else {
                    // Transform to Cloud format: SET with nested COPY value
                    const sourceField =
                      op.value.sourceField.value || op.field?.value || op.field;
                    op.type = "SET";
                    op.value = {
                      type: "COPY",
                      value: op.value.sourceIssue,
                    };
                    // REMOVED: Don't add fieldId - Cloud uses field object, not fieldId
                    // The field object should already be created by the earlier transformation
                    logger.debug(
                      `Fixed ${sourceField} operation to SET with COPY value in rule: ${rule.name}`,
                    );
                  }
                }
              }
            }
          }

          // Recursively process children
          if (component.children && Array.isArray(component.children)) {
            for (const child of component.children) {
              fixComponentOperations(child);
            }
          }
        };

        // Apply the fix recursively to the component and all its children
        fixComponentOperations(comp);
      }
    }

    // REMOVED: Do NOT set metadata fields to null - causes NullPointerException
    // Cloud does NOT regenerate them, it throws an error!
    // rule.id = null;
    // rule.created = null;
    // rule.updated = null;

    logger.debug(`Added required Cloud fields to rule: ${rule.name}`);

    // Check if this rule has any unmapped project IDs
    let hasUnmappedProject = false;

    // Check trigger eventFilters for unmapped projects
    if (rule.trigger?.value?.eventFilters) {
      for (const filter of rule.trigger.value.eventFilters) {
        if (filter.includes("project/")) {
          // Extract project ID from ARI
          const match = filter.match(/project\/(\d+)/);
          if (match) {
            const projectId = match[1];
            // Check if this project ID is in the unmapped set
            if (unmappedIds.projects.has(projectId)) {
              hasUnmappedProject = true;
              logger.warn(
                `Rule "${rule.name}" has unmapped project in trigger: ${projectId}`,
              );
              break;
            }
          }
        }
      }
    }

    // Check ruleScope for unmapped projects
    if (rule.ruleScope?.resources) {
      for (const resource of rule.ruleScope.resources) {
        if (resource.includes("project/")) {
          // Extract project ID from ARI
          const match = resource.match(/project\/(\d+)/);
          if (match) {
            const projectId = match[1];
            // Check if this project ID is in the unmapped set
            if (unmappedIds.projects.has(projectId)) {
              hasUnmappedProject = true;
              logger.warn(
                `Rule "${rule.name}" has unmapped project in ruleScope: ${projectId}`,
              );
              break;
            }
          }
        }
      }
    }

    // Check components for unmapped project IDs
    const checkComponentForUnmappedProjects = (component) => {
      // Check projectId field (this is the direct projectId on components like jira.issue.create)
      if (component.projectId && typeof component.projectId === "string") {
        // Check if this projectId was in the unmappedIds set (more reliable than checking if numeric)
        // Or if it's still numeric (wasn't mapped to a cloud project ID)
        if (
          unmappedIds.projects.has(component.projectId) ||
          /^\d+$/.test(component.projectId)
        ) {
          hasUnmappedProject = true;
          logger.warn(
            `Rule "${rule.name}" has unmapped projectId in component: ${component.projectId}`,
          );
          return true;
        }
      }

      // Check value.value for project fieldType
      if (
        component.fieldType === "project" &&
        component.value?.value &&
        typeof component.value.value === "string" &&
        (unmappedIds.projects.has(component.value.value) ||
          /^\d+$/.test(component.value.value))
      ) {
        hasUnmappedProject = true;
        logger.warn(
          `Rule "${rule.name}" has unmapped project in operation: ${component.value.value}`,
        );
        return true;
      }

      // Check compareValue for project conditions
      if (
        component.selectedFieldType === "project" &&
        component.compareValue?.value &&
        typeof component.compareValue.value === "string" &&
        (unmappedIds.projects.has(component.compareValue.value) ||
          /^\d+$/.test(component.compareValue.value))
      ) {
        hasUnmappedProject = true;
        logger.warn(
          `Rule "${rule.name}" has unmapped project in condition: ${component.compareValue.value}`,
        );
        return true;
      }

      // Check operations in jira.issue.create/edit
      if (component.value?.operations) {
        for (const op of component.value.operations) {
          if (
            op.fieldType === "project" &&
            op.value?.value &&
            typeof op.value.value === "string" &&
            (unmappedIds.projects.has(op.value.value) ||
              /^\d+$/.test(op.value.value))
          ) {
            hasUnmappedProject = true;
            logger.warn(
              `Rule "${rule.name}" has unmapped project in operation: ${op.value.value}`,
            );
            return true;
          }
        }
      }

      // Check children recursively
      if (component.children && Array.isArray(component.children)) {
        for (const child of component.children) {
          if (checkComponentForUnmappedProjects(child)) {
            return true;
          }
        }
      }

      return false;
    };

    // Check all components
    if (rule.components) {
      for (const comp of rule.components) {
        if (checkComponentForUnmappedProjects(comp)) {
          break;
        }
      }
    }

    // Skip rule if it has unmapped projects
    if (hasUnmappedProject) {
      skippedRules.push({
        name: rule.name,
        reason: "Contains unmapped project ID(s)",
      });
      logger.warn(
        `Skipping rule "${rule.name}" - contains unmapped project ID(s)`,
      );
    } else {
      // ============================================================================
      // FILTER CHECK: Skip rules with unmapped IDs that would cause failures
      // NOTE: We do NOT skip rules with unmapped users - they use the default account ID
      // ============================================================================
      if (FILTER_RULES_WITH_UNMAPPED_IDS) {
        // Only count unmapped items that don't have fallbacks
        const totalUnmapped =
          ruleUnmappedIds.customFields.size +
          ruleUnmappedIds.statuses.size +
          // ruleUnmappedIds.users.size +  // REMOVED: Don't count unmapped users (use default)
          ruleUnmappedIds.issueTypes.size +
          ruleUnmappedIds.resolutions.size +
          ruleUnmappedIds.priorities.size;

        if (totalUnmapped > 0) {
          const unmappedDetails = [];
          if (ruleUnmappedIds.customFields.size > 0)
            unmappedDetails.push(
              `${ruleUnmappedIds.customFields.size} custom fields`,
            );
          if (ruleUnmappedIds.statuses.size > 0)
            unmappedDetails.push(`${ruleUnmappedIds.statuses.size} statuses`);
          // Don't add users to unmapped details - they use default account ID
          // if (ruleUnmappedIds.users.size > 0)
          //   unmappedDetails.push(`${ruleUnmappedIds.users.size} users`);
          if (ruleUnmappedIds.issueTypes.size > 0)
            unmappedDetails.push(
              `${ruleUnmappedIds.issueTypes.size} issue types`,
            );
          if (ruleUnmappedIds.resolutions.size > 0)
            unmappedDetails.push(
              `${ruleUnmappedIds.resolutions.size} resolutions`,
            );
          if (ruleUnmappedIds.priorities.size > 0)
            unmappedDetails.push(
              `${ruleUnmappedIds.priorities.size} priorities`,
            );

          skippedRules.push({
            name: rule.name,
            reason: `Contains unmapped: ${unmappedDetails.join(", ")}`,
          });
          logger.warn(
            `[FILTER] Skipping rule "${rule.name}" - contains unmapped: ${unmappedDetails.join(", ")}`,
          );
          continue; // Skip to next rule
        }
      }
      // ============================================================================

      // Add fixed rule to list only if all projects are mapped
      fixedRules.push(rule);
    }
  }

  logger.info(`Fixed ${fixedRules.length} rules`);

  if (skippedRules.length > 0) {
    logger.warn(
      `\n⚠️  SKIPPED ${skippedRules.length} RULES (incompatible with Cloud):`,
    );
    skippedRules.forEach((rule) => {
      logger.warn(`  - "${rule.name}" (${rule.reason})`);
    });
  }

  // Print summary report
  const totalUnmapped =
    unmappedIds.projects.size +
    unmappedIds.issueTypes.size +
    unmappedIds.customFields.size +
    unmappedIds.statuses.size +
    unmappedIds.users.size +
    unmappedIds.resolutions.size +
    unmappedIds.priorities.size;

  logger.info("\n========================================");
  logger.info("ID REPLACEMENT SUMMARY");
  logger.info("========================================");
  logger.info(`Total rules processed: ${fixedRules.length}`);
  logger.info(`\nMappings available:`);
  logger.info(`  - Projects: ${Object.keys(projectMapping).length}`);
  logger.info(`  - Issue Types: ${Object.keys(issueTypeMapping).length}`);
  logger.info(`  - Custom Fields: ${Object.keys(customFieldMapping).length}`);
  logger.info(`  - Statuses: ${Object.keys(statusMapping).length}`);
  logger.info(`  - Users: ${Object.keys(userMapping).length}`);
  logger.info(`  - Resolutions: ${Object.keys(resolutionMapping).length}`);
  logger.info(`  - Priorities: ${Object.keys(priorityMapping).length}`);

  if (totalUnmapped > 0) {
    logger.warn(`\n⚠️  UNMAPPED IDs FOUND: ${totalUnmapped} total`);
    if (unmappedIds.projects.size > 0) {
      logger.warn(
        `  - Projects (${unmappedIds.projects.size}): ${Array.from(unmappedIds.projects).join(", ")}`,
      );
    }
    if (unmappedIds.issueTypes.size > 0) {
      logger.warn(
        `  - Issue Types (${unmappedIds.issueTypes.size}): ${Array.from(unmappedIds.issueTypes).join(", ")}`,
      );
    }
    if (unmappedIds.customFields.size > 0) {
      logger.warn(
        `  - Custom Fields (${unmappedIds.customFields.size}): ${Array.from(unmappedIds.customFields).join(", ")}`,
      );
    }
    if (unmappedIds.statuses.size > 0) {
      logger.warn(
        `  - Statuses (${unmappedIds.statuses.size}): ${Array.from(unmappedIds.statuses).join(", ")}`,
      );
    }
    if (unmappedIds.users.size > 0) {
      logger.warn(
        `  - Users (${unmappedIds.users.size}): ${Array.from(unmappedIds.users).join(", ")}`,
      );
    }
    if (unmappedIds.resolutions.size > 0) {
      logger.warn(
        `  - Resolutions (${unmappedIds.resolutions.size}): ${Array.from(unmappedIds.resolutions).join(", ")}`,
      );
    }
    if (unmappedIds.priorities.size > 0) {
      logger.warn(
        `  - Priorities (${unmappedIds.priorities.size}): ${Array.from(unmappedIds.priorities).join(", ")}`,
      );
    }
    logger.warn(
      `\n⚠️  WARNING: Output contains unmapped IDs that may cause import failures!`,
    );
    logger.warn(
      `   These IDs exist in the source instance but not in the target instance.`,
    );
    logger.warn(
      `   You may need to create these entities in the target or update the mappings.`,
    );
  } else {
    logger.info(`\n✅ SUCCESS: All IDs were successfully mapped!`);
  }
  logger.info("========================================\n");

  // FIXED: Return array directly, not wrapped in object
  // Cloud format requires wrapping rules in an object with "cloud": true
  return {
    cloud: true,
    rules: fixedRules,
  };
}

/**
 * Load mappings from a datacenter_cloud_mapping.json file
 * @param {string} mappingFilePath - Path to the mapping file
 * @returns {Promise<Object>} Dictionary containing all mappings in the same format as generateMappings
 */
async function loadMappingsFromFile(mappingFilePath) {
  logger.info(`Loading mappings from file: ${mappingFilePath}`);

  try {
    const fileContent = await fs.readFile(mappingFilePath, "utf8");
    const mappingData = JSON.parse(fileContent);

    // Validate structure
    if (!mappingData.projects || !mappingData.issue_types) {
      throw new Error(
        "Invalid mapping file format: missing projects or issue_types",
      );
    }

    // Convert to internal mapping format
    const issueTypeMapping = {};
    const projectMapping = {};
    const customFieldMapping = {};
    const statusMapping = {};
    const userMapping = {};

    // Project mappings
    let projectCount = 0;
    for (const project of mappingData.projects) {
      if (project.cloud_id && project.datacenter_id) {
        projectMapping[project.datacenter_id] = project.cloud_id;
        projectCount++;
        logger.debug(
          `Loaded project mapping: ${project.key} (${project.datacenter_id} → ${project.cloud_id})`,
        );
      }
    }

    // Issue type mappings
    let issueTypeCount = 0;
    for (const issueType of mappingData.issue_types) {
      if (issueType.cloud_id && issueType.datacenter_id) {
        issueTypeMapping[issueType.datacenter_id] = issueType.cloud_id;
        issueTypeCount++;
        logger.debug(
          `Loaded issue type mapping: ${issueType.name} (${issueType.datacenter_id} → ${issueType.cloud_id})`,
        );
      }
    }

    // Custom field mappings (if present)
    // CRITICAL: Store ID mapping, name mapping, AND type mapping for fieldId→field transformation
    const customFieldNameMapping = {}; // DC ID → Cloud field name
    const customFieldTypeMapping = {}; // DC ID → field type
    if (mappingData.custom_fields) {
      let customFieldCount = 0;
      for (const customField of mappingData.custom_fields) {
        if (customField.cloud_id && customField.datacenter_id) {
          customFieldMapping[customField.datacenter_id] = customField.cloud_id;
          // Store name mapping for field object transformation (DC→Cloud requires NAME, not ID)
          // CRITICAL: Use cloud_name if available (Cloud field name), otherwise fall back to DC name
          const fieldName = customField.cloud_name || customField.name;
          if (fieldName) {
            customFieldNameMapping[customField.datacenter_id] = fieldName;
          }
          // Store field type for COPY sourceField transformation
          if (customField.field_type) {
            customFieldTypeMapping[customField.datacenter_id] =
              customField.field_type;
          }
          customFieldCount++;
          logger.debug(
            `Loaded custom field mapping: ${customField.name} (${customField.datacenter_id} → ${customField.cloud_id}, Cloud name: ${fieldName})`,
          );
        }
      }
      logger.info(`Loaded ${customFieldCount} custom field mappings`);
    }

    // Status mappings (if present)
    // CRITICAL: Map to status NAME, not cloud_id - Cloud automations use type="NAME"
    if (mappingData.statuses) {
      let statusCount = 0;
      for (const status of mappingData.statuses) {
        if (status.name && status.datacenter_id) {
          statusMapping[status.datacenter_id] = status.name;
          statusCount++;
          logger.debug(
            `Loaded status mapping: ${status.name} (${status.datacenter_id} → "${status.name}")`,
          );
        }
      }
      logger.info(`Loaded ${statusCount} status mappings`);
    }

    // User mappings (if present)
    if (mappingData.users) {
      let userCount = 0;
      for (const user of mappingData.users) {
        if (user.cloud_account_id && user.datacenter_username) {
          userMapping[user.datacenter_username] = user.cloud_account_id;
          userCount++;
          logger.debug(
            `Loaded user mapping: ${user.display_name} (${user.datacenter_username} → ${user.cloud_account_id})`,
          );
        }
      }
      logger.info(`Loaded ${userCount} user mappings`);
    }

    // Resolution mappings (if present)
    const resolutionMapping = {};
    if (mappingData.resolutions) {
      let resolutionCount = 0;
      for (const resolution of mappingData.resolutions) {
        if (resolution.cloud_id && resolution.datacenter_id) {
          resolutionMapping[resolution.datacenter_id] = resolution.cloud_id;
          resolutionCount++;
          logger.debug(
            `Loaded resolution mapping: ${resolution.name} (${resolution.datacenter_id} → ${resolution.cloud_id})`,
          );
        }
      }
      logger.info(`Loaded ${resolutionCount} resolution mappings`);
    }

    // Priority mappings (if present)
    const priorityMapping = {};
    if (mappingData.priorities) {
      let priorityCount = 0;
      for (const priority of mappingData.priorities) {
        if (priority.cloud_id && priority.datacenter_id) {
          priorityMapping[priority.datacenter_id] = priority.cloud_id;
          priorityCount++;
          logger.debug(
            `Loaded priority mapping: ${priority.name} (${priority.datacenter_id} → ${priority.cloud_id})`,
          );
        }
      }
      logger.info(`Loaded ${priorityCount} priority mappings`);
    }

    logger.info(`Successfully loaded mappings from file:`);
    logger.info(`  - Projects: ${projectCount}`);
    logger.info(`  - Issue Types: ${issueTypeCount}`);

    return {
      issueTypeMapping,
      projectMapping,
      customFieldMapping,
      customFieldNameMapping, // CRITICAL: For fieldId→field transformation
      customFieldTypeMapping, // CRITICAL: For COPY sourceField fieldType
      statusMapping,
      userMapping,
      resolutionMapping,
      priorityMapping,
    };
  } catch (error) {
    logger.error(`Failed to load mapping file: ${error.message}`);
    throw error;
  }
}

module.exports = {
  generateMappings,
  fixAutomationRules,
  loadMappingsFromFile,
};
