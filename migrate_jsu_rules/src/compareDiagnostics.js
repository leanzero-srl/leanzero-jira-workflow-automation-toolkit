/**
 * Bug-class taxonomy + predicates for compare_xml_to_cloud.js.
 *
 * Each diff entry produced by the comparison gets exactly one `category` from
 * the table below. Categories are evaluated in order; first match wins. Each
 * category has a baked-in `severity` so the operator can sort/triage.
 */

const SEVERITY = {
  BLOCKER: "BLOCKER",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  INFO: "INFO",
};

// Order matters — first matching category wins.
const CATEGORIES = [
  // Missing-rule causes (DC has it; Cloud doesn't). Ordered most-specific first
  // so the operator sees the actual root cause, not a generic "missing".
  { name: "MISSING_TRANSITION_UNRESOLVED", severity: SEVERITY.BLOCKER,
    test: (d) => d.kind === "missing" && d.evidence && d.evidence.transitionUnresolved },
  { name: "MISSING_CATALOG_MISS",         severity: SEVERITY.BLOCKER,
    test: (d) => d.kind === "missing" && d.evidence && d.evidence.catalogMiss },
  { name: "MISSING_FIELD_UNMAPPED",       severity: SEVERITY.BLOCKER,
    test: (d) => d.kind === "missing" && d.evidence && Array.isArray(d.evidence.unresolvedFields) && d.evidence.unresolvedFields.length > 0 },
  { name: "MISSING_STATUS_UNMAPPED",      severity: SEVERITY.BLOCKER,
    test: (d) => d.kind === "missing" && d.evidence && Array.isArray(d.evidence.unresolvedStatuses) && d.evidence.unresolvedStatuses.length > 0 },
  { name: "MISSING_MAPPER_NULL",          severity: SEVERITY.BLOCKER,
    test: (d) => d.kind === "missing" && d.evidence && d.evidence.mapperReturnedNull },
  { name: "MISSING_OTHER",                severity: SEVERITY.BLOCKER,
    test: (d) => d.kind === "missing" },

  // Native Jira rules placed on Cloud by Atlassian's CMA / standard migration —
  // not from our pipeline. Distinguished from EXTRA_ON_CLOUD by the absence of
  // any migration tag (we tag every rule we emit with `migration-success`).
  // These need operator review only if DC's source rule was actually different.
  { name: "PRESUMED_NATIVE_JIRA",         severity: SEVERITY.INFO,
    test: (d) => d.kind === "extra" && d.evidence && d.evidence.presumedNativeJira },

  // Sibling instance of a multi-emit DC source (e.g. EmailIssueFunction
  // configured 2-3x on the same transition). DC operators legitimately attach
  // multiple instances of certain post-functions to one transition; the
  // bipartite matcher only consumes one expected per DC row, so the remaining
  // siblings show up as "extra". Demoted to INFO because the rule IS one of
  // ours (tag === "migration-success") and there IS at least one plan row
  // targeting the same (transition, ruleKey, module). Must come BEFORE the
  // generic EXTRA_ON_CLOUD entry so the matching test wins first.
  { name: "MULTI_INSTANCE_OK",            severity: SEVERITY.INFO,
    test: (d) => d.kind === "extra" && d.evidence && d.evidence.multiInstanceOk },

  // Cloud-only and duplicates
  { name: "EXTRA_ON_CLOUD",               severity: SEVERITY.BLOCKER,
    test: (d) => d.kind === "extra" },
  { name: "DUPLICATE_ON_CLOUD",           severity: SEVERITY.HIGH,
    test: (d) => d.kind === "duplicate" },

  // Content bugs in matched pairs
  { name: "EXPRESSION_BROKEN",            severity: SEVERITY.BLOCKER,
    test: (d) => d.kind === "matched" && d.evidence && d.evidence.expressionBroken },
  { name: "NUNJUCKS_BROKEN",              severity: SEVERITY.BLOCKER,
    test: (d) => d.kind === "matched" && d.evidence && d.evidence.nunjucksBroken },
  { name: "DISABLED_MISMATCH",            severity: SEVERITY.HIGH,
    test: (d) => d.kind === "matched" && d.evidence && d.evidence.disabledOnCloud && !d.evidence.disabledExpected },

  { name: "OK", severity: SEVERITY.INFO, test: (d) => d.kind === "matched" },
];

function classify(diff) {
  for (const c of CATEGORIES) {
    if (c.test(diff)) return { category: c.name, severity: c.severity };
  }
  return { category: "UNKNOWN", severity: SEVERITY.INFO };
}

/**
 * Detect the object-vs-string Jira Expression bug. Mirrors the predicate used
 * by `_repairBuggySystemFieldComparisons` in `src/jsuApplier.js` so a positive
 * detection here is fix-able by re-running apply.
 *
 *   `issue.<obj_field> == "literal"` → broken (the LHS is an object, RHS a string)
 *
 * The fix the applier already does: insert `.key` for project, `.name` for the
 * typed system fields, `.displayName` for user fields.
 */
const BROKEN_EXPRESSION_FIELDS = [
  "project", "status", "priority", "resolution", "issuetype",
  "assignee", "reporter", "creator",
];
const BROKEN_EXPRESSION_RE = new RegExp(
  `\\bissue\\.(?:${BROKEN_EXPRESSION_FIELDS.join("|")})\\b(?!\\s*\\.)\\s*(?:==|!=)\\s*["']`,
  "g",
);
function isExpressionBroken(text) {
  if (typeof text !== "string" || !text) return false;
  return BROKEN_EXPRESSION_RE.test(text);
}

/**
 * Detect Nunjucks template content that didn't fully translate. Looks for
 * residual GString placeholders, JSP scriptlets, or unbalanced if-blocks.
 * Wraps `isCleanNunjucks` from groovyToCloud.js.
 */
function isNunjucksBroken(text, isCleanNunjucks) {
  if (typeof text !== "string" || !text) return false;
  if (typeof isCleanNunjucks === "function") return !isCleanNunjucks(text);
  // Best-effort fallback if helper not provided.
  if (/\$\{[^}]+\}/.test(text)) return true;
  if (/<%[\s\S]*?%>/.test(text)) return true;
  return false;
}

/**
 * Build a fresh ctx for a mapper invocation. Records cause-of-death evidence
 * in addition to the standard remapping carriage. Pass to `convertToNative`
 * or `convertToJmwe`.
 *
 * Each mapper currently appends to ctx.unresolved (Set of unresolved DC field
 * IDs); we add `unresolvedStatuses` (Set), and capture `mapperReturnedNull` /
 * `catalogMiss` flags after the call.
 */
function makeMapperCtx({ fieldRemapping, statusRemapping, jmweAppKey, ruleId, dcInventory }) {
  return {
    fieldRemapping: fieldRemapping || {},
    statusRemapping: statusRemapping || {},
    idRemapping: {},
    jmweAppKey,
    ruleId,
    dcInventory,
    unresolved: new Set(),          // DC field IDs that didn't resolve
    unresolvedStatuses: new Set(),  // DC status IDs that didn't resolve (mappers TBD-instrumented)
    warnings: [],
  };
}

/**
 * Snapshot of the ctx after a mapper invocation, ready to embed under
 * `diff.evidence`. JSON-friendly (Sets become arrays).
 */
function snapshotMapperCtx(ctx, opts = {}) {
  return {
    unresolvedFields: Array.from(ctx.unresolved || []),
    unresolvedStatuses: Array.from(ctx.unresolvedStatuses || []),
    warnings: Array.isArray(ctx.warnings) ? ctx.warnings.slice() : [],
    mapperReturnedNull: opts.mapperReturnedNull === true,
    catalogMiss: opts.catalogMiss === true,
    transitionUnresolved: opts.transitionUnresolved === true,
    mapperUsed: opts.mapperUsed || null,
  };
}

module.exports = {
  SEVERITY,
  CATEGORIES,
  classify,
  isExpressionBroken,
  isNunjucksBroken,
  makeMapperCtx,
  snapshotMapperCtx,
  BROKEN_EXPRESSION_FIELDS,
  BROKEN_EXPRESSION_RE,
};
