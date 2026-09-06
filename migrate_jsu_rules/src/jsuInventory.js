const { isJsuRule, getJsuShortName, getSpec } = require("./jsuRuleCatalog");
const { uuidv4, computeMigrationSourceId } = require("./utils");

/**
 * Walk a single DC workflow JSON, collecting only JSU rules.
 *
 * DC shape (from GET /rest/api/2/workflow):
 *   {
 *     name, description,
 *     transitions: [{
 *       id, name, to,
 *       rules: {
 *         conditionsTree: { nodeType: "simple"|"compound", ... } | legacy conditions,
 *         conditions: [...] | compound tree,
 *         validators: [ { type, configuration } ],
 *         postFunctions: [ { type, configuration } ]
 *       }
 *     }]
 *   }
 *
 * For the inventory we don't rewrite the tree — we just record every JSU leaf we
 * find with enough path context to correlate it back during --apply. The
 * applier's transitionMatcher / mapper pipeline uses {workflowName, transitionName,
 * ruleCategory, pathWithinTree} to re-locate the rule conceptually.
 */
function scanDcWorkflow(dcWorkflow, { perRuleOverrides = {} } = {}) {
  const workflowName =
    (dcWorkflow && dcWorkflow.name) ||
    (dcWorkflow && dcWorkflow.id && dcWorkflow.id.name) ||
    "<unnamed>";

  const transitionsOut = [];
  const transitions = Array.isArray(dcWorkflow && dcWorkflow.transitions)
    ? dcWorkflow.transitions
    : [];

  for (const transition of transitions) {
    const transitionName = (transition && transition.name) || "<unnamed>";
    const rules = transition && transition.rules;
    const record = {
      transitionName,
      transitionId: transition && transition.id != null ? transition.id : null,
      // Status identity carried for structural matching against Cloud at apply
      // time. `from` is an array because OSWorkflow common-actions are fanned
      // out by the parser into one record per source step; for a non-fanned-out
      // transition it has a single element. `to` is the destination status id.
      transitionFromStatusIds:
        transition && Array.isArray(transition.from)
          ? transition.from.map((s) => (s == null ? null : String(s)))
          : [],
      transitionToStatusId:
        transition && transition.to != null ? String(transition.to) : null,
      transitionType: (transition && transition.type) || null,
      conditions: [],
      validators: [],
      postFunctions: [],
    };

    if (!rules) {
      transitionsOut.push(record);
      continue;
    }

    // conditionsTree (compound) OR flat conditions array
    const condRoot = rules.conditionsTree || rules.conditions;
    if (condRoot) {
      harvestConditionsTree(condRoot, record.conditions, "", perRuleOverrides);
    }

    if (Array.isArray(rules.validators)) {
      rules.validators.forEach((v, idx) => {
        const entry = buildRuleEntry(v, "validator", `validators[${idx}]`, perRuleOverrides);
        if (entry) record.validators.push(entry);
      });
    }

    if (Array.isArray(rules.postFunctions)) {
      rules.postFunctions.forEach((pf, idx) => {
        const entry = buildRuleEntry(
          pf,
          "postFunction",
          `postFunctions[${idx}]`,
          perRuleOverrides,
        );
        if (entry) record.postFunctions.push(entry);
      });
    }

    transitionsOut.push(record);
  }

  return { workflowName, transitions: transitionsOut };
}

function harvestConditionsTree(node, out, pathPrefix, perRuleOverrides) {
  if (!node || typeof node !== "object") return;

  // Some payloads are arrays of leaf conditions (old shape).
  if (Array.isArray(node)) {
    node.forEach((child, idx) =>
      harvestConditionsTree(child, out, joinPath(pathPrefix, `[${idx}]`), perRuleOverrides),
    );
    return;
  }

  const nodeType = node.nodeType;
  if (nodeType === "compound" || Array.isArray(node.conditions)) {
    const children = Array.isArray(node.conditions) ? node.conditions : [];
    children.forEach((child, idx) => {
      const operator = node.operator ? node.operator.toUpperCase() : "AND";
      harvestConditionsTree(
        child,
        out,
        joinPath(pathPrefix, `(${operator})[${idx}]`),
        perRuleOverrides,
      );
    });
    return;
  }

  // Simple leaf (nodeType==="simple" or no nodeType)
  const entry = buildRuleEntry(
    node,
    "condition",
    pathPrefix || "conditions[0]",
    perRuleOverrides,
  );
  if (entry) out.push(entry);
}

function buildRuleEntry(rule, ruleCategory, path, perRuleOverrides) {
  if (!rule || typeof rule !== "object" || !rule.type) return null;
  if (!isJsuRule(rule.type)) return null;

  const shortName = getJsuShortName(rule.type);
  const spec = getSpec(rule.type, { perRuleOverrides });

  return {
    internalId: uuidv4(),
    ruleCategory,
    path,
    dcType: rule.type,
    shortName,
    configuration: rule.configuration || {},
    spec: spec
      ? {
          defaultStrategy: spec.defaultStrategy,
          resolvedStrategy: spec.resolvedStrategy,
          isOverridden: spec.isOverridden,
          confidence: spec.confidence,
          nativeRuleKey: spec.nativeRuleKey || null,
          jmweModuleKey: spec.jmweModuleKey || null,
          notes: spec.notes || "",
          ruleCategoryFromCatalog: spec.ruleCategory,
          inCatalog: spec.ruleCategory !== "unknown",
        }
      : null,
  };
}

function joinPath(prefix, suffix) {
  if (!prefix) return suffix;
  return `${prefix}${suffix}`;
}

/**
 * Build the inventory across many workflows. Accepts an array of raw DC workflow objects.
 * Returns the per-workflow inventory plus aggregated statistics.
 */
function buildInventory(dcWorkflows, { perRuleOverrides = {} } = {}) {
  const perWorkflow = {};
  let totalJsuRules = 0;
  const byShortName = {};
  const byStrategy = { native: 0, jmwe: 0, skip: 0, "manual-review": 0 };
  const unknownShortNames = new Set();

  for (const wf of dcWorkflows) {
    const scan = scanDcWorkflow(wf, { perRuleOverrides });
    perWorkflow[scan.workflowName] = scan;
    for (const t of scan.transitions) {
      for (const bucket of ["conditions", "validators", "postFunctions"]) {
        for (const rule of t[bucket]) {
          totalJsuRules++;
          byShortName[rule.shortName] = (byShortName[rule.shortName] || 0) + 1;
          const strategy = rule.spec && rule.spec.resolvedStrategy;
          if (strategy && byStrategy[strategy] !== undefined) {
            byStrategy[strategy]++;
          }
          if (rule.spec && !rule.spec.inCatalog) {
            unknownShortNames.add(rule.shortName);
          }
        }
      }
    }
  }

  return {
    workflows: perWorkflow,
    stats: {
      totalJsuRules,
      byShortName,
      byStrategy,
      unknownShortNames: [...unknownShortNames],
    },
  };
}

/**
 * Build a flat conversion plan list from an inventory. Operators edit this file
 * between --collect and --apply to override any row's strategy (set to "skip" to
 * exclude).
 */
function inventoryToConversionPlan(inventory) {
  const rows = [];
  // Dedup by migrationSourceId — DC's OSWorkflow common-actions fan out into
  // one inventory record per source step (verified: e.g. "Start progress"
  // appears twice on FIN_/JSM default when the transition's `<step>` block
  // is shared by 2 statuses). All fan-outs share the same transitionId, so
  // they collapse to the same migrationSourceId. Emit a single plan row per
  // unique id so the applier doesn't repeatedly try to migrate the same
  // logical rule.
  const seenIds = new Set();
  for (const [workflowName, scan] of Object.entries(inventory.workflows)) {
    for (const t of scan.transitions) {
      for (const bucket of [
        ["conditions", "condition"],
        ["validators", "validator"],
        ["postFunctions", "postFunction"],
      ]) {
        const [key, category] = bucket;
        for (const rule of t[key]) {
          const migrationSourceId = computeMigrationSourceId({
            workflowName,
            transitionId: t.transitionId,
            transitionName: t.transitionName,
            ruleCategory: category,
            pathWithinTransition: rule.path,
            dcType: rule.dcType,
          });
          if (seenIds.has(migrationSourceId)) continue;
          seenIds.add(migrationSourceId);
          rows.push({
            workflowName,
            transitionName: t.transitionName,
            // Identity fields used by the applier to structurally match this
            // DC transition to the right Cloud transition (avoids name-only
            // spray when DC has multiple transitions sharing a display name).
            transitionId: t.transitionId != null ? String(t.transitionId) : null,
            transitionFromStatusIds: t.transitionFromStatusIds || [],
            transitionToStatusId: t.transitionToStatusId || null,
            transitionType: t.transitionType || null,
            ruleCategory: category,
            pathWithinTransition: rule.path,
            dcType: rule.dcType,
            shortName: rule.shortName,
            defaultStrategy: rule.spec ? rule.spec.defaultStrategy : "manual-review",
            strategy: rule.spec ? rule.spec.resolvedStrategy : "manual-review",
            confidence: rule.spec ? rule.spec.confidence : "none",
            nativeRuleKey: rule.spec ? rule.spec.nativeRuleKey : null,
            jmweModuleKey: rule.spec ? rule.spec.jmweModuleKey : null,
            notes: rule.spec ? rule.spec.notes : "",
            internalId: rule.internalId,
            // Deterministic identity hash anchored to the DC source. Stamped on
            // the emitted Cloud rule's `parameters.migrationSourceId` at apply
            // time so the next run can recognise the same logical rule even if
            // the semantic fingerprint drifts.
            migrationSourceId,
            configuration: rule.configuration,
          });
        }
      }
    }
  }
  return {
    _help: {
      purpose:
        "Review-before-apply: set strategy to one of native|jmwe|skip|manual-review per row.",
      strategies: {
        native: "Convert to a Cloud system:* rule (preferred when equivalent exists).",
        jmwe: "Convert to a JMWE connect:<appKey>__<ModuleKey> rule.",
        skip: "Do not migrate this rule.",
        "manual-review": "Flagged for human inspection; apply will skip it and list it in unmapped_rules.json AND in the manual-review Excel summary.",
      },
      editableFields: ["strategy"],
      dedupContract:
        "Apply ALWAYS re-fetches each Cloud workflow live and snapshots its " +
        "rule fingerprints BEFORE any mutation. Plan rows whose converted rule " +
        "is already present on Cloud are classified as 'already-on-cloud' and " +
        "never appended (recorded in already_on_cloud.json + the Excel summary). " +
        "Re-running --apply on the same plan is therefore guaranteed to converge, " +
        "not duplicate. Never edit a plan to remove rows you believe are 'already " +
        "there' — let the live snapshot decide.",
      notes:
        "Other fields (workflowName, transitionName, transitionId, transitionFromStatusIds, transitionToStatusId, transitionType, dcType, internalId, configuration) are identifiers — do not edit.",
    },
    rows,
  };
}

module.exports = { scanDcWorkflow, buildInventory, inventoryToConversionPlan };
