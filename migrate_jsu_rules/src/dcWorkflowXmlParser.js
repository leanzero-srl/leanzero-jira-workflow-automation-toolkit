const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

/**
 * Parses OSWorkflow XML (the format downloaded from the Jira DC admin UI via
 * Workflows → <workflow> → "View" → Text/XML tab, or from the "Export" button)
 * into the shape jsuInventory expects — i.e. whatever `GET /rest/api/3/workflow/search`
 * would return on Cloud:
 *
 *   { name, description, transitions: [{
 *       id, name, to, from,
 *       rules: {
 *         conditionsTree?: {nodeType:"compound"|"simple", operator, conditions|type+configuration},
 *         validators: [{type, configuration}],
 *         postFunctions: [{type, configuration}]
 *       }
 *   }] }
 *
 * Key OSWorkflow → unified-shape translations:
 *   <action id=5 name="X">                          → transition { id: 5, name: "X" }
 *   <restrict-to><conditions type="AND">...</conditions></restrict-to>
 *                                                   → transition.rules.conditionsTree
 *   <conditions type="AND"|"OR"><condition/>...</conditions>
 *                                                   → { nodeType: "compound", operator: "AND", conditions: [...] }
 *   <condition type="class"><arg name="full.module.key">TYPE</arg>...</condition>
 *                                                   → { type: TYPE, configuration: {...other args} }
 *   <validators>/<post-functions>                   → flat arrays
 *   <common-actions><action/></common-actions>      → template inherited by <common-action id=X/>
 *   <initial-actions><action/></initial-actions>    → the CREATE transition
 *
 * OSWorkflow step IDs are internal (sequential) — we enrich each step with its
 * Jira status id from `<meta name="jira.status.id">`, then each transition's
 * unconditional-result `step` → we look up that step's jira.status.id for `to`.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: false,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  // Preserve element order within parents when it matters (e.g. post-functions
  // are ordered, conditions are ordered for AND/OR semantics to be deterministic)
  isArray: (tagName) => {
    // Tags that can legitimately appear multiple times as siblings.
    // Singleton containers like <validators>, <post-functions>, <restrict-to>,
    // <results> are NOT listed — they wrap their children. The children (like
    // <validator>, <function>, <condition>) ARE listed here so fast-xml-parser
    // always returns an array even when there's only one child.
    return [
      "step",
      "action",
      "common-action",
      "validator",
      "function",
      "condition",
      "conditions",
      "arg",
      "meta",
      "unconditional-result",
      "conditional-result",
    ].includes(tagName);
  },
});

function parseWorkflowXml(xmlText, { workflowName = null } = {}) {
  const doc = parser.parse(xmlText);
  const wf = doc.workflow || doc["os:workflow"] || null;
  if (!wf) throw new Error("XML root <workflow> not found");

  const stepMap = buildStepMap(wf);
  const commonActions = indexCommonActions(wf);

  const transitions = [];

  // Initial actions (the CREATE transition) — no fromStep, targetStep from unconditional-result
  for (const act of arrify(wf["initial-actions"] && wf["initial-actions"].action)) {
    transitions.push(normalizeAction(act, { fromStepId: null, commonActions, stepMap }));
  }

  // Step actions
  for (const step of arrify(wf.steps && wf.steps.step)) {
    const stepId = Number(step["@_id"]);
    const actions = arrify(step.actions && step.actions.action);
    for (const act of actions) {
      transitions.push(normalizeAction(act, { fromStepId: stepId, commonActions, stepMap }));
    }
    // <common-action id="5"/> references a common action template
    const refs = arrify(step.actions && step.actions["common-action"]);
    for (const ref of refs) {
      const refId = Number(ref["@_id"]);
      const template = commonActions[refId];
      if (!template) continue;
      transitions.push(
        normalizeAction(template, { fromStepId: stepId, commonActions, stepMap, inheritedId: refId }),
      );
    }
  }

  // Global actions — apply from any step
  for (const act of arrify(wf["global-actions"] && wf["global-actions"].action)) {
    transitions.push(normalizeAction(act, { fromStepId: null, commonActions, stepMap, isGlobal: true }));
  }

  // Fill in workflow name:
  //   1. explicit override,
  //   2. <meta name="jira.workflow.description.xmlworkflowname"> (rare)
  //   3. filename (passed in by caller),
  //   4. fallback "<unnamed>"
  const metaName = lookupMeta(wf.meta, "jira.workflow.description.xmlworkflowname");
  const name = workflowName || metaName || "<unnamed>";

  return {
    name,
    description: lookupMeta(wf.meta, "jira.workflow.description.description") || "",
    transitions,
    _source: "dcWorkflowXml",
    _stepMap: stepMap,
  };
}

function buildStepMap(wf) {
  const map = {};
  for (const step of arrify(wf.steps && wf.steps.step)) {
    const stepId = Number(step["@_id"]);
    const statusId = lookupMeta(step.meta, "jira.status.id");
    map[stepId] = {
      stepId,
      statusId: statusId || null,
      name: step["@_name"] || "",
    };
  }
  return map;
}

function indexCommonActions(wf) {
  const out = {};
  for (const act of arrify(wf["common-actions"] && wf["common-actions"].action)) {
    const id = Number(act["@_id"]);
    out[id] = act;
  }
  return out;
}

function normalizeAction(act, { fromStepId, stepMap, inheritedId, isGlobal }) {
  const id = inheritedId != null ? inheritedId : Number(act["@_id"]);
  const name = act["@_name"] || "";

  // Resolve target step → status via unconditional-result
  let toStatusId = null;
  const results = act.results || {};
  const uncond = arrify(results["unconditional-result"])[0];
  if (uncond) {
    const targetStep = Number(uncond["@_step"]);
    if (stepMap[targetStep]) toStatusId = stepMap[targetStep].statusId;
  }

  const fromStatusId = fromStepId && stepMap[fromStepId] ? stepMap[fromStepId].statusId : null;

  // Post-functions can appear either at the action level OR inside
  // <results>/<unconditional-result>/<post-functions> (most common on Jira DC).
  // Collect from both locations.
  const postFunctions = [];
  postFunctions.push(...parsePostFunctions(act["post-functions"]));
  for (const resultNode of arrify(uncond)) {
    postFunctions.push(...parsePostFunctions(resultNode && resultNode["post-functions"]));
  }
  for (const cr of arrify(results["conditional-result"])) {
    postFunctions.push(...parsePostFunctions(cr && cr["post-functions"]));
  }

  const rules = {
    conditionsTree: parseConditionsTree(act["restrict-to"]),
    validators: parseValidators(act.validators),
    postFunctions,
  };

  return {
    id,
    name,
    from: fromStatusId ? [fromStatusId] : isGlobal ? [] : [],
    to: toStatusId || null,
    type: isGlobal ? "GLOBAL" : fromStepId == null ? "INITIAL" : "DIRECTED",
    rules,
  };
}

function parseConditionsTree(restrictTo) {
  if (!restrictTo) return null;
  const cond = restrictTo.conditions || restrictTo.condition;
  if (!cond) return null;
  // If wrapped with conditions element: may be array (since isArray includes it) or object
  const rootNode = Array.isArray(cond) ? cond[0] : cond;
  return normalizeConditionNode(rootNode);
}

function normalizeConditionNode(node) {
  if (!node) return null;

  // Compound conditions wrapper
  if (node.conditions || node.condition || node["@_type"]) {
    const operator = (node["@_type"] || "AND").toUpperCase();
    const children = [];
    for (const child of arrify(node.condition)) {
      children.push(normalizeLeafCondition(child));
    }
    for (const child of arrify(node.conditions)) {
      children.push(normalizeConditionNode(child));
    }
    const filtered = children.filter(Boolean);
    if (filtered.length === 1) return filtered[0]; // unwrap single-child compound
    return { nodeType: "compound", operator, conditions: filtered };
  }

  // Leaf condition directly as a node (rare)
  return normalizeLeafCondition(node);
}

function normalizeLeafCondition(node) {
  if (!node) return null;
  const { type, configuration } = extractArgs(node);
  if (!type) return null;
  return { nodeType: "simple", type, configuration };
}

function parseValidators(validators) {
  if (!validators) return [];
  return arrify(validators.validator).map(extractRule).filter((r) => r && r.type);
}

function parsePostFunctions(postFunctions) {
  if (!postFunctions) return [];
  // Some workflows may have multiple <post-functions> siblings (rare); flatten.
  const batches = arrify(postFunctions);
  const out = [];
  for (const batch of batches) {
    for (const fn of arrify(batch.function)) {
      const r = extractRule(fn);
      if (r && r.type) out.push(r);
    }
  }
  return out;
}

function extractRule(node) {
  const { type, configuration } = extractArgs(node);
  return { type, configuration };
}

/**
 * OSWorkflow rule `<arg name="X">value</arg>` children flatten into a
 * {configuration} map.
 *
 * Rule TYPE identification:
 *   - `class.name` arg is the Java class path (always present on DC class-based
 *     rules). For JSU and JMWE plugin rules this is the canonical identifier.
 *   - `full.module.key` arg is the plugin module key. DC's XML export
 *     serialises it WITHOUT the colon separator between appkey and moduleKey
 *     (e.g. `com.googlecode.jira-suite-utilitiesupdateIssueCustomField-function`
 *     — note no `:`), so it cannot be reliably matched against the standard
 *     Cloud-style `<appKey>:<moduleKey>` form. We therefore prefer
 *     `class.name` when present, and only fall back to `full.module.key` when
 *     no class is declared (rare — pure-Cloud-shape rules like
 *     `connect:com.foo__Bar`).
 *
 * Handles both single and multiple `<arg>` children (fast-xml-parser gives us
 * either an object for a single child or an array for multiple).
 */
function extractArgs(node) {
  const args = arrify(node && node.arg);
  let fullModuleKey = null;
  let className = null;
  const configuration = {};
  for (const a of args) {
    const name = a && a["@_name"];
    if (!name) continue;
    const resolved = typeof a === "string"
      ? a
      : a["#text"] !== undefined
        ? a["#text"]
        : "";
    if (name === "full.module.key") fullModuleKey = String(resolved);
    else if (name === "class.name") className = String(resolved);
    else configuration[name] = resolved === "" ? "" : resolved;
  }
  // Always keep class.name in configuration too — some mappers need it for
  // disambiguation when plugins expose multiple modules from the same class.
  if (className) configuration["class.name"] = className;
  const type = className || fullModuleKey || null;
  return { type, configuration };
}

function lookupMeta(meta, name) {
  if (!meta) return null;
  for (const m of arrify(meta)) {
    if (m && m["@_name"] === name) {
      return (m["#text"] !== undefined ? m["#text"] : typeof m === "string" ? m : "") || null;
    }
  }
  return null;
}

function arrify(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Read and parse a single XML file. The workflow name defaults to the filename
 * stem unless the file's meta provides one.
 */
function parseWorkflowXmlFile(filePath) {
  const xml = fs.readFileSync(filePath, "utf8");
  const workflowName = path.basename(filePath, path.extname(filePath));
  return parseWorkflowXml(xml, { workflowName });
}

/**
 * Read all .xml files in a directory. Returns successfully-parsed workflows
 * and a list of per-file parse errors. A single malformed file no longer
 * aborts the whole batch — important when running across hundreds of XMLs.
 */
function parseWorkflowXmlDir(dirPath) {
  const entries = fs.readdirSync(dirPath);
  const parsed = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".xml")) continue;
    const full = path.join(dirPath, entry);
    if (!fs.statSync(full).isFile()) continue;
    try {
      parsed.push({ file: entry, workflow: parseWorkflowXmlFile(full) });
    } catch (err) {
      errors.push({ file: entry, error: err.message });
    }
  }
  return { parsed, errors };
}

module.exports = {
  parseWorkflowXml,
  parseWorkflowXmlFile,
  parseWorkflowXmlDir,
};
