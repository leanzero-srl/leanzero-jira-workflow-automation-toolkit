/**
 * Reference Scanner: extract all instance-bound IDs referenced by a workflow JSON.
 *
 * Two tiers:
 *   structural  — guaranteed locations in the v3 workflow schema. Safe to auto-remap.
 *   embedded    — IDs found inside opaque JMWE/Connect configuration.value blobs.
 *                 Reported as candidates for the operator's curation file; we do NOT
 *                 auto-remap these because bare numeric IDs can't be disambiguated
 *                 without per-rule knowledge (a "10001" might be a status, a priority,
 *                 a role, or an arbitrary option ID).
 */

const STRUCTURAL_BUCKETS = [
  "statuses",
  "screens",
  "events",
];

// Key names that appear inside JMWE config "value" JSON and strongly imply an
// entity type. Used as hints for the embedded-ID report.
const EMBEDDED_KEY_HINTS = {
  statusId: "statuses",
  statusIds: "statuses",
  status: "statuses",              // object form { id, name }
  previousStatus: "statuses",      // PreviousStatusCondition — object form
  parentStatuses: "statuses",      // ParentStatusValidator — array of objects
  toStatusId: "statuses",
  fromStatusId: "statuses",
  issueTypeId: "issueTypes",
  issueTypeIds: "issueTypes",
  issueType: "issueTypes",         // object form
  issuetype: "issueTypes",         // JMWE CreateIssueFunction uses lowercase scalar
  selectedIssueTypeId: "issueTypes", // JMWE LinkedIssueStatusValidator
  priorityId: "priorities",
  priorityIds: "priorities",
  priority: "priorities",          // object form
  resolutionId: "resolutions",
  resolutionIds: "resolutions",
  resolution: "resolutions",       // object form
  linkTypeId: "linkTypes",
  issueLinkTypeId: "linkTypes",
  issueLinkType: "linkTypes",      // object form
  linkType: "linkTypes",           // object form
  selectedLinkTypeId: "linkTypes", // JMWE linked-issue rules
  securityLevelId: "securityLevels",
  securityLevel: "securityLevels",
  issueSecurityLevel: "securityLevels", // SetIssueSecurityFromRoleFunction — object form
  projectRoleId: "projectRoles",
  roleId: "projectRoles",
  projectRole: "projectRoles",  // object form { id, name }
  projectRoles: "projectRoles", // array-of-objects form (seen in InAnyProjectRoleCondition)
  role: "projectRoles",         // object form
  roles: "projectRoles",        // array-of-objects form
  groupId: "groups",
  groupIds: "groups",
  groupName: "groups",
  groupNames: "groups",
  group: "groups",              // object form
  groups: "groups",             // UserInAnyGroupCondition — array of group name strings
  accountId: "users",
  screenId: "screens",
  screen: "screens",            // object form
  eventId: "events",
  event: "events",              // object form
};

/**
 * Scan a raw workflow object and return every referenced ID bucketed by category.
 *
 * @param {object} workflow - Raw workflow JSON from /rest/api/3/workflow/search
 * @returns {object} {
 *   structural: { statuses: Set, screens: Set, events: Set },
 *   embedded:   { issueTypes: Set, priorities: Set, resolutions: Set, linkTypes: Set,
 *                 securityLevels: Set, projectRoles: Set, groups: Set, users: Set,
 *                 screens: Set, events: Set, statuses: Set },
 * }
 */
function scanWorkflow(workflow) {
  const structural = {
    statuses: new Set(),
    screens: new Set(),
    events: new Set(),
  };
  const embedded = {
    statuses: new Set(),
    issueTypes: new Set(),
    priorities: new Set(),
    resolutions: new Set(),
    linkTypes: new Set(),
    securityLevels: new Set(),
    projectRoles: new Set(),
    groups: new Set(),
    users: new Set(),
    screens: new Set(),
    events: new Set(),
  };

  // ── Structural: workflow-level statuses ──
  for (const s of workflow.statuses || []) {
    const id = s.id || s.statusId;
    if (id) structural.statuses.add(String(id));
  }

  // ── Structural: per-transition ──
  for (const t of workflow.transitions || []) {
    if (t.to !== undefined && t.to !== null && t.to !== "") {
      structural.statuses.add(String(t.to));
    }
    if (Array.isArray(t.from)) {
      for (const f of t.from) {
        if (f !== undefined && f !== null && f !== "") {
          structural.statuses.add(String(f));
        }
      }
    }
    if (t.screen && t.screen.id) {
      structural.screens.add(String(t.screen.id));
    }
    if (!t.rules) continue;

    // FireIssueEventFunction stashes the event under configuration.event.id
    for (const pf of t.rules.postFunctions || []) {
      if (
        pf.type &&
        pf.type.includes("FireIssueEventFunction") &&
        pf.configuration &&
        pf.configuration.event &&
        pf.configuration.event.id !== undefined
      ) {
        structural.events.add(String(pf.configuration.event.id));
      }
    }

    // ── Embedded: walk every rule's configuration for hint keys ──
    const walk = (cfg) => {
      if (!cfg) return;
      // JMWE stores its real payload as a JSON string in configuration.value
      if (cfg.value && typeof cfg.value === "string") {
        try {
          const parsed = JSON.parse(cfg.value);
          walkObject(parsed, embedded);
        } catch {
          // not JSON — skip
        }
      }
      // Non-value keys (e.g. projectRole, event) on configuration itself
      walkObject(cfg, embedded);
    };

    for (const pf of t.rules.postFunctions || []) walk(pf.configuration);
    for (const v of t.rules.validators || []) walk(v.configuration);
    walkConditions(t.rules.conditionsTree || t.rules.conditions, walk);
  }

  return { structural, embedded };
}

function walkConditions(node, walk) {
  if (!node) return;
  if (node.configuration) walk(node.configuration);
  if (Array.isArray(node.conditions)) {
    for (const c of node.conditions) walkConditions(c, walk);
  }
}

function walkObject(obj, embedded, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 25) return;
  if (Array.isArray(obj)) {
    for (const item of obj) walkObject(item, embedded, depth + 1);
    return;
  }
  for (const [key, val] of Object.entries(obj)) {
    const bucket = EMBEDDED_KEY_HINTS[key];
    if (bucket) {
      collectValues(val, embedded[bucket]);
    }
    if (val && typeof val === "object") {
      walkObject(val, embedded, depth + 1);
    } else if (typeof val === "string") {
      // JMWE sometimes double-encodes JSON; recurse one level if it parses
      const trimmed = val.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          walkObject(JSON.parse(trimmed), embedded, depth + 1);
        } catch {
          // not JSON
        }
      }
    }
  }
}

function collectValues(val, targetSet) {
  if (val === undefined || val === null || val === "") return;
  if (Array.isArray(val)) {
    for (const item of val) collectValues(item, targetSet);
    return;
  }
  if (typeof val === "object") {
    // e.g. projectRole: { id: "10001", name: "Developers" }
    if (val.id !== undefined) targetSet.add(String(val.id));
    return;
  }
  // string or number — comma-split just in case (JMWE commonly uses CSV)
  const s = String(val);
  if (s.includes(",")) {
    for (const part of s.split(",")) {
      const trimmed = part.trim();
      if (trimmed) targetSet.add(trimmed);
    }
  } else {
    targetSet.add(s);
  }
}

function setsToArrays(bucketedSets) {
  const out = {};
  for (const [k, v] of Object.entries(bucketedSets)) {
    out[k] = [...v];
  }
  return out;
}

/**
 * Scan many workflows and merge their reference buckets.
 *
 * @param {Array<object>} workflows
 * @returns {{ structural: object, embedded: object }} — each bucket is a sorted array
 */
function scanMany(workflows) {
  const merged = {
    structural: { statuses: new Set(), screens: new Set(), events: new Set() },
    embedded: {
      statuses: new Set(),
      issueTypes: new Set(),
      priorities: new Set(),
      resolutions: new Set(),
      linkTypes: new Set(),
      securityLevels: new Set(),
      projectRoles: new Set(),
      groups: new Set(),
      users: new Set(),
      screens: new Set(),
      events: new Set(),
    },
  };

  for (const wf of workflows) {
    const { structural, embedded } = scanWorkflow(wf);
    for (const bucket of Object.keys(structural)) {
      for (const id of structural[bucket]) merged.structural[bucket].add(id);
    }
    for (const bucket of Object.keys(embedded)) {
      for (const id of embedded[bucket]) merged.embedded[bucket].add(id);
    }
  }

  // Stabilise ordering so diffs on id_mapping.json are readable.
  const sortSets = (buckets) => {
    const out = {};
    for (const [k, v] of Object.entries(buckets)) {
      out[k] = [...v].sort();
    }
    return out;
  };

  return {
    structural: sortSets(merged.structural),
    embedded: sortSets(merged.embedded),
  };
}

module.exports = {
  scanWorkflow,
  scanMany,
  STRUCTURAL_BUCKETS,
  EMBEDDED_KEY_HINTS,
  // exported for tests
  setsToArrays,
};
