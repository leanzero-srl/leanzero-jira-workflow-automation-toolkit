/**
 * Pure transformation functions for workflow rules.
 * Ported from /jira/apps/jmwe/workflows_fixer_for_jmwe.py
 *
 * All functions are pure: input -> output, no API calls.
 */

const SYSTEM_POST_FUNCTIONS_TO_STRIP = [
  "UpdateIssueStatusFunction",
  "CreateCommentFunction",
  "IssueCreateFunction",
  "IssueReindexFunction",
  "GenerateChangeHistoryFunction",
];

const JMWE_PREFIX_CORRUPTED = [
  "com.atlassian.plugins.atlassian-connect-plugin:com.innovalog.jmwe.jira-misc-workflow-extensions__",
  "com.atlassian.plugins.atlassian-connect-plugincom.innovalog.jmwe.jira-misc-workflow-extensions__",
];

const JMWE_PREFIX_CLEAN = "com.innovalog.jmwe.jira-misc-workflow-extensions__";

const SCRIPTRUNNER_IDENTIFIER = "com.onresolve.jira.groovy.groovyrunner";

/**
 * Main entry point: transform a raw workflow for re-creation on target.
 *
 * @param {object} rawWorkflow - Raw workflow object from GET /rest/api/3/workflow/search
 * @param {object} options
 * @param {string} options.nameSuffix - Suffix to append to workflow name (default: "_v2")
 * @param {object} options.fieldRemapping - Map of oldFieldId -> newFieldId
 * @param {string} options.sourceUrl - Source instance base URL (for URL replacement)
 * @param {string} options.targetUrl - Target instance base URL
 * @returns {object} { payload, skippedScriptRunnerRules, warnings }
 */
function transformWorkflow(rawWorkflow, options = {}) {
  const {
    nameSuffix = "_v2",
    fieldRemapping = {},
    sourceUrl = "",
    targetUrl = "",
  } = options;
  // Mutable alias so we can decorate with __fields__ for the embedded-config walker.
  let idRemapping = options.idRemapping || {};

  const warnings = [];
  const skippedScriptRunnerRules = [];

  // Deep clone to avoid mutating the original
  const workflow = JSON.parse(JSON.stringify(rawWorkflow));

  // Make fieldRemapping reachable from remapEmbeddedIdsInConfig without threading
  // it through every processor call site. Local rebind; doesn't leak.
  idRemapping = Object.assign({}, idRemapping, { __fields__: fieldRemapping });

  const originalName = workflow.id ? workflow.id.name : workflow.name;
  const newName = originalName + nameSuffix;
  const description = workflow.description || "";

  // 1. Strip status read-only properties + remap status IDs to target
  const statuses = workflow.statuses || [];
  const droppedStatusIds = new Set(); // source IDs explicitly unmapped (remap -> null)
  for (const status of statuses) {
    delete status.name;
    if (status.properties) {
      delete status.properties.issueEditable;
      delete status.properties["jira.issue.editable"];
    }
    if (status.id !== undefined) {
      const remapped = applyStructuralRemap(
        String(status.id),
        idRemapping.statuses,
        warnings,
        `workflow.statuses[].id`,
      );
      if (remapped === null) droppedStatusIds.add(String(status.id));
      else status.id = remapped;
    }
  }
  // Drop statuses that were explicitly unmapped (override set them to null).
  if (droppedStatusIds.size > 0) {
    const kept = statuses.filter(
      (s) => s.id === undefined || !droppedStatusIds.has(String(s.id)),
    );
    statuses.length = 0;
    statuses.push(...kept);
  }

  // 2. Process transitions
  let transitions = workflow.transitions || [];
  const transitionsToDrop = new Set();

  for (const transition of transitions) {
    // 3. Strip transition read-only props
    delete transition.id;
    if (transition.screen) {
      delete transition.screen.name;
      if (transition.screen.id !== undefined) {
        const remapped = applyStructuralRemap(
          String(transition.screen.id),
          idRemapping.screens,
          warnings,
          `transition("${transition.name}").screen.id`,
        );
        if (remapped === null) delete transition.screen;
        else transition.screen.id = remapped;
      }
    }
    if (transition.properties) {
      delete transition.properties.issueEditable;
    }

    // Remap transition.to — a null result means the target status was dropped,
    // so the whole transition becomes invalid and must be removed.
    if (transition.to !== undefined && transition.to !== null && transition.to !== "") {
      const remapped = applyStructuralRemap(
        String(transition.to),
        idRemapping.statuses,
        warnings,
        `transition("${transition.name}").to`,
      );
      if (remapped === null) {
        warnings.push(
          `Dropping transition "${transition.name}": target status ${transition.to} unmapped on target`,
        );
        transitionsToDrop.add(transition);
        continue;
      }
      transition.to = remapped;
    }

    // Remap transition.from — drop individual from-status refs that are unmapped.
    // A globally-applied transition (no from) stays global.
    if (Array.isArray(transition.from)) {
      const remappedFrom = [];
      for (const f of transition.from) {
        if (f === undefined || f === null || f === "") continue;
        const remapped = applyStructuralRemap(
          String(f),
          idRemapping.statuses,
          warnings,
          `transition("${transition.name}").from`,
        );
        if (remapped !== null) remappedFrom.push(remapped);
      }
      if (transition.from.length > 0 && remappedFrom.length === 0) {
        warnings.push(
          `Dropping transition "${transition.name}": all source statuses unmapped on target`,
        );
        transitionsToDrop.add(transition);
        continue;
      }
      transition.from = remappedFrom;
    }

    if (!transition.rules) continue;

    // 4. conditionsTree -> conditions (rename only).
    //    nodeType ("simple"|"compound") and operator ("AND"|"OR") are preserved —
    //    the new POST /rest/api/3/workflows/create expects them for compound groups,
    //    and the legacy endpoint is retired, so stripping is no longer necessary.
    if (transition.rules.conditionsTree) {
      transition.rules.conditions = transition.rules.conditionsTree;
      delete transition.rules.conditionsTree;
    }

    // Process conditions
    if (transition.rules.conditions) {
      processConditions(
        transition.rules.conditions,
        fieldRemapping,
        idRemapping,
        sourceUrl,
        targetUrl,
        warnings,
        skippedScriptRunnerRules,
        originalName,
        transition.name || "unknown",
      );
      // If the top-level condition itself was a ScriptRunner rule, remove it
      if (transition.rules.conditions._remove) {
        delete transition.rules.conditions;
      }
    }

    // Process post-functions
    if (transition.rules.postFunctions) {
      transition.rules.postFunctions = processPostFunctions(
        transition.rules.postFunctions,
        fieldRemapping,
        idRemapping,
        sourceUrl,
        targetUrl,
        warnings,
        skippedScriptRunnerRules,
        originalName,
        transition.name || "unknown",
      );
    }

    // Process validators
    if (transition.rules.validators) {
      processValidators(
        transition.rules.validators,
        fieldRemapping,
        idRemapping,
        sourceUrl,
        targetUrl,
        warnings,
        skippedScriptRunnerRules,
        originalName,
        transition.name || "unknown",
      );
    }
  }

  // Apply any transition drops from the status-remap pass.
  if (transitionsToDrop.size > 0) {
    transitions = transitions.filter((t) => !transitionsToDrop.has(t));
  }

  const payload = {
    name: newName,
    description,
    statuses,
    transitions,
  };

  return { payload, skippedScriptRunnerRules, warnings };
}

// ─────────────────────────────────────────────────
//  CONDITION PROCESSING
// ─────────────────────────────────────────────────

function processConditions(
  condition,
  fieldRemapping,
  idRemapping,
  sourceUrl,
  targetUrl,
  warnings,
  skippedSR,
  workflowName,
  transitionName,
) {
  if (!condition) return;

  // Process this node's type if it's a leaf condition
  if (condition.type) {
    if (isScriptRunnerRule(condition.type)) {
      skippedSR.push({
        workflowName,
        transitionName,
        ruleType: "condition",
        type: condition.type,
        configuration: condition.configuration,
      });
      // Mark for removal (caller handles nested removal below)
      condition._remove = true;
    } else if (isJmweRule(condition.type)) {
      condition.type = cleanJmweType(condition.type);
      if (condition.configuration) {
        delete condition.configuration.id;
        remapEmbeddedIdsInConfig(condition.configuration, idRemapping, warnings);
        if (condition.configuration.value) {
          condition.configuration.value = remapFieldsInValue(
            condition.configuration.value,
            fieldRemapping,
            sourceUrl,
            targetUrl,
            warnings,
          );
          condition.configuration.value = remapEmbeddedIdsInValue(
            condition.configuration.value,
            idRemapping,
            warnings,
          );
        }
      }
    } else if (condition.configuration) {
      // Non-JMWE built-in conditions can still reference roles/groups by ID.
      remapEmbeddedIdsInConfig(condition.configuration, idRemapping, warnings);
    }
  }

  // Recurse into nested conditions and filter out ScriptRunner rules
  if (condition.conditions && Array.isArray(condition.conditions)) {
    for (const inner of condition.conditions) {
      processConditions(
        inner,
        fieldRemapping,
        idRemapping,
        sourceUrl,
        targetUrl,
        warnings,
        skippedSR,
        workflowName,
        transitionName,
      );
    }
    // Remove any conditions marked for removal (ScriptRunner rules)
    condition.conditions = condition.conditions.filter((c) => !c._remove);
  }
}

// ─────────────────────────────────────────────────
//  POST-FUNCTION PROCESSING
// ─────────────────────────────────────────────────

function processPostFunctions(
  postFunctions,
  fieldRemapping,
  idRemapping,
  sourceUrl,
  targetUrl,
  warnings,
  skippedSR,
  workflowName,
  transitionName,
) {
  const result = [];

  for (const pf of postFunctions) {
    // Strip system post-functions
    if (SYSTEM_POST_FUNCTIONS_TO_STRIP.some((name) => pf.type && pf.type.includes(name))) {
      continue;
    }

    // Fix FireIssueEventFunction (and remap event.id to the target instance)
    if (pf.type && pf.type.includes("FireIssueEventFunction")) {
      if (pf.configuration && pf.configuration.event) {
        delete pf.configuration.event.name;
        if (pf.configuration.event.id !== undefined) {
          const remapped = applyStructuralRemap(
            String(pf.configuration.event.id),
            idRemapping.events,
            warnings,
            `FireIssueEventFunction.event.id in "${transitionName}"`,
          );
          if (remapped === null) {
            // Event unmapped — drop this post-function (no safe default).
            warnings.push(
              `Dropping FireIssueEventFunction in "${transitionName}": event ${pf.configuration.event.id} unmapped on target`,
            );
            continue;
          }
          pf.configuration.event.id = remapped;
        }
      }
      result.push(pf);
      continue;
    }

    // ScriptRunner rules - skip and record
    if (pf.type && isScriptRunnerRule(pf.type)) {
      skippedSR.push({
        workflowName,
        transitionName,
        ruleType: "postFunction",
        type: pf.type,
        configuration: pf.configuration,
      });
      continue;
    }

    // JMWE rules - clean and remap
    if (pf.type && isJmweRule(pf.type)) {
      pf.type = cleanJmweType(pf.type);
      if (pf.configuration) {
        delete pf.configuration.id;

        // Unwrap remoteWorkflowPostFunctionConfiguration
        if (pf.configuration.value) {
          try {
            const valJSON = JSON.parse(pf.configuration.value);
            if (valJSON.remoteWorkflowPostFunctionConfiguration) {
              pf.configuration.value = valJSON.remoteWorkflowPostFunctionConfiguration;
            } else {
              delete valJSON.remoteWorkflowPostFunctionUUID;
              pf.configuration.value = JSON.stringify(valJSON);
            }
          } catch {
            // value is not JSON, leave as-is
          }

          pf.configuration.value = remapFieldsInValue(
            pf.configuration.value,
            fieldRemapping,
            sourceUrl,
            targetUrl,
            warnings,
          );
          pf.configuration.value = remapEmbeddedIdsInValue(
            pf.configuration.value,
            idRemapping,
            warnings,
          );
        }
        remapEmbeddedIdsInConfig(pf.configuration, idRemapping, warnings);
      }
    } else if (pf.configuration) {
      remapEmbeddedIdsInConfig(pf.configuration, idRemapping, warnings);
    }

    result.push(pf);
  }

  return result;
}

// ─────────────────────────────────────────────────
//  VALIDATOR PROCESSING
// ─────────────────────────────────────────────────

function processValidators(
  validators,
  fieldRemapping,
  idRemapping,
  sourceUrl,
  targetUrl,
  warnings,
  skippedSR,
  workflowName,
  transitionName,
) {
  // Build a new array, filtering out ScriptRunner rules
  const result = [];

  for (const validator of validators) {
    // FieldRequiredValidator: rename fields -> fieldIds
    if (validator.type && validator.type.includes("FieldRequiredValidator")) {
      if (validator.configuration && validator.configuration.fields) {
        validator.configuration.fieldIds = validator.configuration.fields;
        delete validator.configuration.fields;
      }
    }

    // ScriptRunner rules - skip and record (do NOT include in output)
    if (validator.type && isScriptRunnerRule(validator.type)) {
      skippedSR.push({
        workflowName,
        transitionName,
        ruleType: "validator",
        type: validator.type,
        configuration: validator.configuration,
      });
      continue;
    }

    // JMWE rules - clean and remap
    if (validator.type && isJmweRule(validator.type)) {
      validator.type = cleanJmweType(validator.type);
      if (validator.configuration) {
        delete validator.configuration.id;
        delete validator.configuration.fieldIds; // JMWE auto-generates these

        if (validator.configuration.value) {
          validator.configuration.value = remapFieldsInValue(
            validator.configuration.value,
            fieldRemapping,
            sourceUrl,
            targetUrl,
            warnings,
          );
          validator.configuration.value = remapEmbeddedIdsInValue(
            validator.configuration.value,
            idRemapping,
            warnings,
          );
        }
        remapEmbeddedIdsInConfig(validator.configuration, idRemapping, warnings);
      }
    } else if (validator.configuration) {
      remapEmbeddedIdsInConfig(validator.configuration, idRemapping, warnings);
    }

    result.push(validator);
  }

  // Replace array contents in-place
  validators.length = 0;
  validators.push(...result);
}

// ─────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────

function stripNodeTypeRecursive(node) {
  if (!node || typeof node !== "object") return;
  delete node.nodeType;
  if (node.conditions && Array.isArray(node.conditions)) {
    for (const child of node.conditions) {
      stripNodeTypeRecursive(child);
    }
  }
}

function isJmweRule(type) {
  return type && type.includes("innovalog");
}

function isScriptRunnerRule(type) {
  return type && type.includes(SCRIPTRUNNER_IDENTIFIER);
}

function cleanJmweType(type) {
  let cleaned = type;
  for (const prefix of JMWE_PREFIX_CORRUPTED) {
    cleaned = cleaned.replace(prefix, JMWE_PREFIX_CLEAN);
  }
  return cleaned;
}

/**
 * Find all customfield_NNNNN references in a value string, remap them,
 * and replace source URLs with target URLs.
 */
function remapFieldsInValue(value, fieldRemapping, sourceUrl, targetUrl, warnings) {
  if (!value || typeof value !== "string") return value;

  // Find all customfield references (variable length IDs)
  const cfPattern = /customfield_\d+/g;
  const matches = [...new Set(value.match(cfPattern) || [])];

  let result = value;

  for (const cfId of matches) {
    const mappedId = fieldRemapping[cfId];
    if (mappedId) {
      result = result.split(cfId).join(mappedId);
    } else if (fieldRemapping[cfId] === null) {
      // Field explicitly unmapped - remove from comma-separated lists
      warnings.push(`Field ${cfId} not found on target, removing from config`);
      result = result.replace(new RegExp("," + cfId + ",", "g"), ",");
      result = result.replace(new RegExp("," + cfId + "(?=[^_\\d]|$)", "g"), "");
      result = result.replace(new RegExp(cfId + ",", "g"), "");
    }
    // If not in remapping at all, leave as-is (may be a target-side field)
  }

  // URL replacement
  if (sourceUrl && targetUrl && sourceUrl !== targetUrl) {
    result = result.split(sourceUrl).join(targetUrl);
  }

  return result;
}

// ─────────────────────────────────────────────────
//  ID REMAPPING HELPERS
// ─────────────────────────────────────────────────

/**
 * Apply a structural ID remap at a known location.
 * Semantics:
 *   bucket[sourceId] === undefined  -> pass-through (no mapping known; emit warning)
 *   bucket[sourceId] === null       -> drop (returns null)
 *   bucket[sourceId] === "12345"    -> translate to that target ID
 *
 * @returns {string|null} target ID, or null if dropped.
 */
function applyStructuralRemap(sourceId, bucket, warnings, locationLabel) {
  if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, sourceId)) {
    // Unknown — leave as-is but warn so operator sees the gap.
    if (bucket) {
      warnings.push(
        `No remap entry for ID ${sourceId} at ${locationLabel} — passing through (may be invalid on target)`,
      );
    }
    return sourceId;
  }
  const mapped = bucket[sourceId];
  if (mapped === null) return null;
  return String(mapped);
}

/**
 * Keys inside configuration objects whose values represent entity IDs.
 * Values can be scalar (id), CSV string (ids), or an object with an `id` field.
 * Mirror of EMBEDDED_KEY_HINTS in referenceScanner, kept in sync manually.
 */
const CONFIG_KEY_BUCKETS = {
  statusId: "statuses",
  statusIds: "statuses",
  status: "statuses",
  previousStatus: "statuses",
  parentStatuses: "statuses",
  toStatusId: "statuses",
  fromStatusId: "statuses",
  issueTypeId: "issueTypes",
  issueTypeIds: "issueTypes",
  issueType: "issueTypes",
  issuetype: "issueTypes",
  selectedIssueTypeId: "issueTypes",
  priorityId: "priorities",
  priorityIds: "priorities",
  priority: "priorities",
  resolutionId: "resolutions",
  resolutionIds: "resolutions",
  resolution: "resolutions",
  linkTypeId: "linkTypes",
  issueLinkTypeId: "linkTypes",
  issueLinkType: "linkTypes",
  linkType: "linkTypes",
  selectedLinkTypeId: "linkTypes",
  securityLevelId: "securityLevels",
  securityLevel: "securityLevels",
  issueSecurityLevel: "securityLevels",
  projectRoleId: "projectRoles",
  roleId: "projectRoles",
  projectRole: "projectRoles",
  projectRoles: "projectRoles", // e.g. InAnyProjectRoleCondition: {"projectRoles":[{"id":"..."}]}
  role: "projectRoles",
  roles: "projectRoles",
  groupId: "groups",
  groupIds: "groups",
  group: "groups",
  groups: "groups", // UserInAnyGroupCondition — array of group name strings
  screenId: "screens",
  screen: "screens",
  eventId: "events",
  event: "events",
};

/**
 * Walk a configuration object and rewrite any scalar/array/object identifiers
 * that sit under a known key name. Only explicit overrides or resolved auto-mappings
 * take effect — unknown keys and unknown IDs are left alone.
 *
 * Also applies a customfield_NNNNN regex rewrite to every string value encountered —
 * this catches field references in places like DateFieldValidator.date1/date2 that
 * live directly on the configuration (not inside a JMWE `value` blob).
 */
function remapEmbeddedIdsInConfig(config, idRemapping, warnings, depth = 0, fieldRemapping = null) {
  if (!config || typeof config !== "object" || depth > 25) return;
  // Back-compat: most callers pass only (config, idRemapping, warnings). We accept
  // an optional fieldRemapping on the tail so customfield rewrites happen in-tree too.
  fieldRemapping = fieldRemapping || idRemapping.__fields__ || null;

  if (Array.isArray(config)) {
    for (const item of config) {
      remapEmbeddedIdsInConfig(item, idRemapping, warnings, depth + 1, fieldRemapping);
    }
    return;
  }
  for (const [key, val] of Object.entries(config)) {
    const bucketName = CONFIG_KEY_BUCKETS[key];
    const bucket = bucketName ? idRemapping[bucketName] : null;
    if (bucket) {
      config[key] = remapIdValue(val, bucket);
    } else if (fieldRemapping && typeof val === "string" && val.includes("customfield_")) {
      // Key not a known entity-ID slot, but the string value references a customfield.
      // Rewrite in-place so configs like {date1: "customfield_10673"} get translated.
      config[key] = remapFieldsInValue(val, fieldRemapping, "", "", warnings || []);
    }
    if (val && typeof val === "object") {
      remapEmbeddedIdsInConfig(val, idRemapping, warnings, depth + 1, fieldRemapping);
    }
  }
}

function remapIdValue(val, bucket) {
  if (val === undefined || val === null) return val;
  if (Array.isArray(val)) {
    return val
      .map((item) => remapIdValue(item, bucket))
      .filter((item) => item !== null && item !== "");
  }
  if (typeof val === "object") {
    // e.g. { id: "10001", name: "..." } — rewrite id, leave everything else.
    if (val.id !== undefined) {
      const mapped = remapScalarId(String(val.id), bucket);
      if (mapped === null) return null;
      val.id = mapped;
    }
    return val;
  }
  // scalar: string or number. Handle CSV.
  const s = String(val);
  if (s.includes(",")) {
    const parts = s
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => remapScalarId(p, bucket))
      .filter((p) => p !== null && p !== "");
    return parts.join(",");
  }
  const mapped = remapScalarId(s, bucket);
  return mapped === null ? "" : mapped;
}

function remapScalarId(sourceId, bucket) {
  if (!Object.prototype.hasOwnProperty.call(bucket, sourceId)) return sourceId;
  const mapped = bucket[sourceId];
  if (mapped === null) return null;
  return String(mapped);
}

/**
 * Apply embedded-ID remapping inside a JSON-string configuration.value.
 * Parses, walks via remapEmbeddedIdsInConfig, and re-serializes. Non-JSON strings
 * are returned untouched.
 */
function remapEmbeddedIdsInValue(value, idRemapping, warnings) {
  if (!value || typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return value;
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  remapEmbeddedIdsInConfig(parsed, idRemapping, warnings);
  return JSON.stringify(parsed);
}

/**
 * Extract all unique customfield IDs from a workflow JSON.
 */
function extractCustomFieldIds(workflow) {
  const jsonStr = JSON.stringify(workflow);
  const cfPattern = /customfield_\d+/g;
  return [...new Set(jsonStr.match(cfPattern) || [])];
}

/**
 * Detect all ScriptRunner rules in a workflow.
 */
function detectScriptRunnerRules(workflow) {
  const rules = [];
  const transitions = workflow.transitions || [];

  for (const transition of transitions) {
    if (!transition.rules) continue;

    // Check conditions
    findScriptRunnerInConditions(
      transition.rules.conditionsTree || transition.rules.conditions,
      workflow.id ? workflow.id.name : workflow.name || "unknown",
      transition.name || "unknown",
      "condition",
      rules,
    );

    // Check post-functions
    if (transition.rules.postFunctions) {
      for (const pf of transition.rules.postFunctions) {
        if (pf.type && isScriptRunnerRule(pf.type)) {
          rules.push({
            workflowName: workflow.id ? workflow.id.name : workflow.name || "unknown",
            transitionName: transition.name || "unknown",
            ruleType: "postFunction",
            type: pf.type,
            configuration: pf.configuration,
          });
        }
      }
    }

    // Check validators
    if (transition.rules.validators) {
      for (const v of transition.rules.validators) {
        if (v.type && isScriptRunnerRule(v.type)) {
          rules.push({
            workflowName: workflow.id ? workflow.id.name : workflow.name || "unknown",
            transitionName: transition.name || "unknown",
            ruleType: "validator",
            type: v.type,
            configuration: v.configuration,
          });
        }
      }
    }
  }

  return rules;
}

function findScriptRunnerInConditions(condition, workflowName, transitionName, ruleType, results) {
  if (!condition) return;
  if (condition.type && isScriptRunnerRule(condition.type)) {
    results.push({
      workflowName,
      transitionName,
      ruleType,
      type: condition.type,
      configuration: condition.configuration,
    });
  }
  if (condition.conditions && Array.isArray(condition.conditions)) {
    for (const inner of condition.conditions) {
      findScriptRunnerInConditions(inner, workflowName, transitionName, ruleType, results);
    }
  }
}

/**
 * Check if a workflow has any JMWE rules.
 */
function hasJmweRules(workflow) {
  return JSON.stringify(workflow).includes("innovalog");
}

/**
 * Check if a workflow has any ScriptRunner rules.
 */
function hasScriptRunnerRules(workflow) {
  return JSON.stringify(workflow).includes(SCRIPTRUNNER_IDENTIFIER);
}

/**
 * Build a bulk create payload for the new POST /rest/api/3/workflows/create API.
 * This converts the old-format workflow into the new format.
 *
 * IMPORTANT: `transformedPayload` is the output of transformWorkflow(). If the
 * caller passed a non-empty `idRemapping.statuses`, the status IDs embedded in
 * the payload are ALREADY the target IDs. The optional `options.statusRemapping`
 * is a belt-and-suspenders safety net — we use it to translate any ID that still
 * looks like a source ID before hitting `statusMap` (which is keyed by target ID).
 *
 * @param {object} transformedPayload - Output from transformWorkflow().payload
 * @param {object} statusMap - target side: { targetStatusId: { id, name, statusCategory } }
 * @param {object} [options]
 * @param {object} [options.statusRemapping] - { sourceId: targetId | null }
 * @returns {object} Bulk create request body
 */
function buildBulkCreatePayload(transformedPayload, statusMap, options = {}) {
  const statusRemapping = options.statusRemapping || {};

  const uuidv4 = () =>
    "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });

  // Translate any ID through the remap first, then look up in target statusMap.
  const toTargetStatusId = (rawId) => {
    if (rawId === undefined || rawId === null || rawId === "") return null;
    const s = String(rawId);
    if (Object.prototype.hasOwnProperty.call(statusRemapping, s)) {
      const mapped = statusRemapping[s];
      if (mapped === null) return null;
      return String(mapped);
    }
    return s;
  };

  // Build status reference map: TARGET statusId -> UUID.
  const statusRefMap = new Map();
  const topLevelStatuses = [];

  for (const status of transformedPayload.statuses) {
    const rawId = status.id || status.statusId;
    const targetId = toTargetStatusId(rawId);
    if (!targetId) {
      // Explicit drop via override — skip this status entirely.
      continue;
    }
    const statusInfo = statusMap[targetId];
    if (!statusInfo) {
      throw new Error(
        `Status ID ${targetId} (source ${rawId}) not found on target. Ensure all ` +
        `statuses exist on the target instance or add an override in id_overrides.json.`,
      );
    }
    if (statusRefMap.has(targetId)) continue; // dedup if source had collisions
    const ref = uuidv4();
    statusRefMap.set(targetId, ref);

    topLevelStatuses.push({
      name: statusInfo.name,
      statusCategory: statusInfo.statusCategory,
      statusReference: ref,
    });
  }

  // Convert transitions
  const convertedTransitions = [];
  for (const t of transformedPayload.transitions) {
    const toTarget = toTargetStatusId(t.to);
    if (!toTarget || !statusRefMap.has(toTarget)) {
      // target status was dropped or never existed — skip transition
      continue;
    }
    const converted = {
      name: t.name,
      description: t.description || "",
      type: guessTransitionType(t),
      toStatusReference: statusRefMap.get(toTarget),
      triggers: [],
      validators: [],
      actions: [],
      properties: t.properties || {},
    };

    // Convert rules — the new API expects:
    //   conditionsTree: walked as-is, preserving nodeType/operator at each node
    //                   and converting only leaf rules into {ruleKey, parameters}.
    //   validators:     flat array of {ruleKey, parameters}.
    //   actions:        flat array (new-API naming for post-functions).
    if (t.rules) {
      if (t.rules.conditions) {
        converted.conditions = convertConditionsTree(t.rules.conditions);
      }
      if (t.rules.validators) {
        converted.validators = t.rules.validators.map(convertRuleToNewFormat);
      }
      if (t.rules.postFunctions) {
        converted.actions = t.rules.postFunctions.map(convertRuleToNewFormat);
      }
    }

    // Build links for directed transitions
    if (t.from && Array.isArray(t.from)) {
      const links = [];
      for (const fromStatus of t.from) {
        const fromTarget = toTargetStatusId(fromStatus);
        if (!fromTarget || !statusRefMap.has(fromTarget)) continue;
        links.push({
          fromStatusReference: statusRefMap.get(fromTarget),
          fromPort: 0,
          toPort: 1,
        });
      }
      if (links.length > 0) converted.links = links;
    }

    convertedTransitions.push(converted);
  }

  // Build workflow statuses (references only)
  const workflowStatuses = [];
  for (const s of transformedPayload.statuses) {
    const targetId = toTargetStatusId(s.id || s.statusId);
    if (!targetId || !statusRefMap.has(targetId)) continue;
    workflowStatuses.push({
      statusReference: statusRefMap.get(targetId),
      properties: s.properties || {},
    });
  }

  return {
    scope: { type: "GLOBAL" },
    statuses: topLevelStatuses,
    workflows: [
      {
        name: transformedPayload.name,
        description: transformedPayload.description,
        statuses: workflowStatuses,
        transitions: convertedTransitions,
      },
    ],
  };
}

/**
 * Build a bulk UPDATE payload for POST /rest/api/3/workflows/update.
 *
 * The update API is keyed by workflow UUID + version (optimistic concurrency) rather
 * than by name. It has the same status/transition body shape as create, but:
 *   - no top-level `scope` (scope is fixed at create time)
 *   - per-workflow: `id` + `version: {id, versionNumber}` required; `name` absent
 *   - may accept `defaultStatusMappings` / `statusMappings` for status removals
 *     (the caller is expected to supply those via options.statusMappings if needed)
 *
 * @param {object} transformedPayload - Output from transformWorkflow().payload
 * @param {object} targetWorkflowInfo - { id, version: {id, versionNumber} } from
 *                                       POST /rest/api/3/workflows name lookup
 * @param {object} statusMap - target side statuses (see buildBulkCreatePayload)
 * @param {object} [options]
 * @param {object} [options.statusRemapping] - source -> target status ID map
 * @param {Array}  [options.defaultStatusMappings] - passed through verbatim
 * @param {Array}  [options.statusMappings] - passed through verbatim
 */
function buildBulkUpdatePayload(transformedPayload, targetWorkflowInfo, statusMap, options = {}) {
  if (!targetWorkflowInfo || !targetWorkflowInfo.id || !targetWorkflowInfo.version) {
    throw new Error(
      "buildBulkUpdatePayload requires targetWorkflowInfo with {id, version} from " +
      "POST /rest/api/3/workflows name lookup",
    );
  }

  // Reuse the create builder so all the status-ref / transition-conversion logic
  // stays single-source-of-truth, then rewrite the outer envelope into update shape.
  const createPayload = buildBulkCreatePayload(transformedPayload, statusMap, options);
  const inner = createPayload.workflows[0];
  // Drop `name` — update identifies the workflow by id, not name.
  const { name, ...withoutName } = inner;

  const updateWorkflow = {
    id: targetWorkflowInfo.id,
    version: targetWorkflowInfo.version,
    ...withoutName,
  };
  if (options.defaultStatusMappings) {
    updateWorkflow.defaultStatusMappings = options.defaultStatusMappings;
  }
  if (options.statusMappings) {
    updateWorkflow.statusMappings = options.statusMappings;
  }

  return {
    statuses: createPayload.statuses,
    workflows: [updateWorkflow],
  };
}

function guessTransitionType(transition) {
  if (transition.type) return transition.type.toUpperCase();
  // Heuristic: initial transition typically has no 'from'
  if (!transition.from || (Array.isArray(transition.from) && transition.from.length === 0)) {
    if (transition.name && transition.name.toLowerCase() === "create") return "INITIAL";
    return "GLOBAL";
  }
  return "DIRECTED";
}

/**
 * Mapping from old-API short rule type names to the new bulk-create API's ruleKey +
 * parameter shape. Entries below are limited to names I've either seen in Atlassian's
 * official docs examples (developer.atlassian.com/cloud/jira/platform/rest/v3
 * api-group-workflows) or that are trivial 1:1 renames.
 *
 * When the new API uses a `ruleType` discriminator (e.g. system:validate-field-value
 * branches into fieldRequired / fieldChanged / fieldHasSingleValue / dateFieldComparison),
 * we emit it as a parameter rather than adding a dedicated ruleKey per branch.
 *
 * For entries we don't have a verified mapping for, we leave a `null` value and fall
 * through to the pass-through `system:<type>` heuristic. The --validate-only path is
 * the iteration mechanism for completing/correcting this table: watch the validation
 * response for unrecognised ruleKey errors and extend the map.
 */
const SYSTEM_RULE_KEY_MAP = {
  // Verified in docs:
  PermissionValidator: { ruleKey: "system:check-permission-validator" },
  ValueFieldCondition: { ruleKey: "system:check-field-value" },

  // Derived from docs (ruleType discriminator pattern):
  FieldRequiredValidator: {
    ruleKey: "system:validate-field-value",
    paramsMapper: (cfg) => ({
      ruleType: "fieldRequired",
      fieldIds: Array.isArray(cfg.fields)
        ? cfg.fields.join(",")
        : Array.isArray(cfg.fieldIds)
          ? cfg.fieldIds.join(",")
          : String(cfg.fields || cfg.fieldIds || ""),
      errorMessage: String(cfg.errorMessage || ""),
      ignoreContext: String(cfg.ignoreContext || false),
    }),
  },
  FieldChangedValidator: {
    ruleKey: "system:validate-field-value",
    paramsMapper: (cfg) => ({
      ruleType: "fieldChanged",
      fieldId: String(cfg.fieldId || ""),
      errorMessage: String(cfg.errorMessage || ""),
      exemptedGroups: Array.isArray(cfg.exemptedGroups) ? cfg.exemptedGroups.join(",") : "",
    }),
  },

  // Pass-through (no verified mapping yet — tuned via --validate-only):
  PermissionCondition: null,
  InAnyProjectRoleCondition: null,
  AlwaysFalseCondition: null,
  UpdateIssueFieldFunction: null,
  ClearFieldValuePostFunction: null,
  FireIssueEventFunction: null,
};

function convertRuleToNewFormat(rule) {
  if (!rule || !rule.type) return rule;

  let ruleKey;
  let paramsMapper = null;

  // Forge apps: type starts with "ari:cloud:" or "ari:". Per current docs the new API
  // accepts the ARI as the ruleKey with a `forge:` prefix (unverified — flag via
  // --validate-only). Kept as a single branch so the heuristic is easy to correct.
  if (rule.type.startsWith("ari:")) {
    ruleKey = `forge:${rule.type}`;
  } else if (rule.type.startsWith("forge:") || rule.type.startsWith("connect:") || rule.type.startsWith("system:")) {
    // Already namespaced — pass through.
    ruleKey = rule.type;
  } else if (rule.type.includes("__")) {
    // Connect app modules: "appKey__moduleKey"
    ruleKey = `connect:${rule.type}`;
  } else if (Object.prototype.hasOwnProperty.call(SYSTEM_RULE_KEY_MAP, rule.type)) {
    // Known OOTB system rule.
    const entry = SYSTEM_RULE_KEY_MAP[rule.type];
    if (entry) {
      ruleKey = entry.ruleKey;
      paramsMapper = entry.paramsMapper || null;
    } else {
      // Explicit null = known unmapped; fall through to pass-through.
      ruleKey = `system:${rule.type}`;
    }
  } else {
    // Unknown — best guess.
    ruleKey = `system:${rule.type}`;
  }

  const converted = { ruleKey };
  if (rule.configuration) {
    const params = paramsMapper ? paramsMapper(rule.configuration) : coerceParams(rule.configuration);
    converted.parameters = {};
    for (const [k, v] of Object.entries(params)) {
      converted.parameters[k] = typeof v === "string" ? v : String(v);
    }
  }

  return converted;
}

function coerceParams(config) {
  // New API expects parameters as a flat string map. Coerce non-strings.
  const out = {};
  for (const [key, val] of Object.entries(config)) {
    out[key] =
      typeof val === "string" ? val :
      typeof val === "boolean" ? String(val) :
      typeof val === "number" ? String(val) :
      JSON.stringify(val);
  }
  return out;
}

/**
 * Convert a (possibly compound) conditions tree from the internal representation
 * to the new-API format.
 *
 * Internal (post-transform) shape mirrors what GET returns:
 *   Simple leaf:    { nodeType: "simple", type: "...", configuration: {...} }
 *   Compound group: { nodeType: "compound", operator: "AND"|"OR", conditions: [ ...children ] }
 *
 * New-API shape (per developer.atlassian.com/cloud/jira/platform/rest/v3 workflows/create):
 *   Simple leaf:    { ruleKey, parameters: { ... } }
 *   Compound group: { nodeType: "compound", operator: "AND"|"OR", conditions: [ ...children ] }
 *
 * nodeType / operator are preserved verbatim for compound nodes; leaves are replaced
 * with the {ruleKey, parameters} pair produced by convertRuleToNewFormat.
 */
function convertConditionsTree(node) {
  if (!node || typeof node !== "object") return node;

  // Compound group: recurse into children.
  if (node.nodeType === "compound" || Array.isArray(node.conditions)) {
    return {
      nodeType: node.nodeType || "compound",
      operator: node.operator || "AND",
      conditions: (node.conditions || []).map(convertConditionsTree),
    };
  }

  // Leaf: treat as a single rule.
  return convertRuleToNewFormat(node);
}

module.exports = {
  transformWorkflow,
  extractCustomFieldIds,
  detectScriptRunnerRules,
  hasJmweRules,
  hasScriptRunnerRules,
  buildBulkCreatePayload,
  buildBulkUpdatePayload,
  // Exported for testing
  stripNodeTypeRecursive,
  cleanJmweType,
  remapFieldsInValue,
  applyStructuralRemap,
  remapEmbeddedIdsInConfig,
  remapEmbeddedIdsInValue,
  convertConditionsTree,
  convertRuleToNewFormat,
  CONFIG_KEY_BUCKETS,
  isJmweRule,
  isScriptRunnerRule,
};
