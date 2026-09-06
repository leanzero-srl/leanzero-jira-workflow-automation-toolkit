/**
 * DC JSU + JMWE rule → Cloud JMWE Connect rule converters.
 *
 * Cloud JMWE rules come in three ruleKey shapes:
 *   - `connect:remote-workflow-function`        for post-functions (actions)
 *   - `connect:expression-condition`            for conditions (Jira Expression)
 *   - `connect:expression-validator`            for validators (Jira Expression)
 *
 * Each carries `parameters: { appKey, config: <stringified JSON>, id, disabled, tag }`.
 * The `config` JSON shape is module-specific and matches the schemas mined from
 * CMA-translated rules already living on opb-dryrun. The mapper output here is
 * faithful to those schemas so JMWE Cloud's editor renders them correctly.
 *
 * CMA contract: when Groovy can't be translated 1:1, preserve the source text
 * and emit a `problems[]` marker — `GroovyTemplateToNunjucks`,
 * `GroovyScriptToJiraExpression`, `OptionNotSupported`, `ValueNotMapped`. We
 * mirror this so operators get a worklist they can search for.
 */

const { uuidv4, stringifyParams } = require("./utils");
const {
  hasInsightContent,
  groovyTemplateToNunjucks,
  groovyExpressionToJiraExpression,
  groovyValueExpressionToNunjucks,
  jiraExprFieldRef,
  nunjucksFieldRef,
  markerFor,
} = require("./groovyToCloud");
const { translateConfigForEmit } = require("./configFieldTranslator");
const { detectGroovyResidue } = require("./groovyResidueDetector");
const { detectScriptRunnerApi } = require("./scriptRunnerApiDetector");
const { detectFieldRemapAmbiguity } = require("./fieldRemapAmbiguityDetector");
const { resolveRunAs } = require("./cloudUserResolver");

/**
 * Apply runAs resolution to an emit config. Mappers call this just
 * before passing the config to `wrap()`. Returns the same object
 * mutated with `runAsType` + (when applicable) `runAs`. Side effect:
 * pushes `UnresolvedRunAsUser` into the provided `problems` array when
 * the DC username isn't found in `ctx.dcUserMap`.
 */
function applyRunAs(cfg, configObj, ctx, problems) {
  const r = resolveRunAs(cfg.runAsUser, ctx);
  configObj.runAsType = r.runAsType;
  if (r.runAs) configObj.runAs = r.runAs;
  if (r.unresolved && problems) {
    problems.push(markerFor("UnresolvedRunAsUser", [
      `dcUsername=${r.dcUsername}`,
      "Mapper emitted runAsType=currentUser — re-run --apply after the user-resolver cache has the Cloud accountId.",
    ]));
  }
  return configObj;
}

const APP_KEY_DEFAULT = "com.innovalog.jmwe.jira-misc-workflow-extensions";

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

function appKey(moduleName, ctx) {
  const base = (ctx && ctx.jmweAppKey) || APP_KEY_DEFAULT;
  return `${base}__${moduleName}`;
}

function remapField(fieldId, ctx) {
  if (!fieldId) return fieldId;
  const id = String(fieldId);
  if (!id.startsWith("customfield_")) return id; // system field
  const map = ctx && ctx.fieldRemapping;
  if (!map) return id;
  return map[id] || id;
}

function remapStatus(statusId, ctx) {
  if (statusId == null || statusId === "") return statusId;
  const id = String(statusId).trim();
  const map = (ctx && ctx.statusRemapping) || {};
  return map[id] || id;
}

function splitAtAt(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return String(raw)
    .split(/@@|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function boolFromYesNo(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (typeof v !== "string") return false;
  const lc = v.trim().toLowerCase();
  return lc === "yes" || lc === "true" || lc === "1";
}

function pushProblems(problems, arr) {
  if (!arr) return;
  for (const p of arr) problems.push(p);
}

// Translate a JMWE post-function conditionalExecutionScript (Groovy gate) to a
// Jira Expression at emit-time. Without this, the raw Groovy was shoved into
// the Cloud rule, requiring the apply-time recovery pass to fix it up — which
// itself was not threading ctx, so DC customfield IDs leaked through.
function translateCondScript(raw, problems, ctx) {
  const t = groovyExpressionToJiraExpression(
    String(raw || ""),
    ["Conditional execution script"],
    ctx,
  );
  pushProblems(problems, t.problems);
  return t.output || "";
}

function dedupProblems(problems) {
  const seen = new Set();
  return problems.filter((p) => {
    const k = JSON.stringify(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Wrap a config object into a Cloud Connect rule. `kind` is "action" |
 * "condition" | "validator", determining the ruleKey.
 *
 * Applies emit-time field-ID translation (DC `customfield_NNN` → Cloud ID,
 * plus Nunjucks display-name rewrite where ctx.cloudFieldNames is available)
 * so every emitted rule carries Cloud-canonical references. This obsoletes
 * the post-hoc `_sanitizeFieldIdReferences` repair pass for rules WE emit;
 * the sanitizer stays as a defense-in-depth backstop for any rule that
 * arrives broken through other paths (e.g. stale Cloud rules read into
 * `cloudWorkflow` before P1.2's pre-snapshot repair).
 */
function wrap(kind, moduleName, configObj, problems, ctx) {
  const ruleKey = kind === "action"
    ? "connect:remote-workflow-function"
    : kind === "condition"
      ? "connect:expression-condition"
      : "connect:expression-validator";
  // Emit-time field-ID translation. No-op when ctx is absent or the maps are
  // empty (e.g. mapper_self_test.js running offline). Non-destructive — returns
  // a new tree, leaving the mapper's local `configObj` untouched for callers
  // that might still inspect it.
  const translated = translateConfigForEmit(configObj, ctx);
  // Groovy-residue gate: scan the post-translation config for surviving
  // Groovy syntax (def/return/=~/try/customFields./issue.get/unconverted
  // GString/etc.). If anything survived translation, the rule will fail
  // silently on Cloud — Nunjucks renders empty, Jira Expression throws and
  // JMWE treats that as "condition not met". Auto-disable those rules and
  // mark them so the operator can hand-fix in the Cloud UI before enabling.
  const residue = detectGroovyResidue(translated);
  const allProblems = [...(problems || [])];
  for (const r of residue) {
    allProblems.push(markerFor("GroovyResidue", [
      r.field,
      `${r.pattern}: ${r.snippet.slice(0, 120)}`,
    ]));
  }
  // ScriptRunner DC-API detector. Rules that reference ComponentAccessor /
  // SearchService / java imports / etc. are NOT auto-translatable to Cloud
  // and require a hand-written Forge app or REST-API-backed JMWE rule.
  // We emit a separate marker so the operator's CSV gets an actionable
  // reason ("scriptrunner-api-not-translatable") instead of the generic
  // residue reason.
  const srApi = detectScriptRunnerApi(translated);
  for (const r of srApi) {
    allProblems.push(markerFor("ScriptRunnerApiNotTranslatable", [
      r.field,
      `${r.pattern}: ${r.snippet.slice(0, 120)}`,
    ]));
  }
  // Field-remap ambiguity detector. Flags rules that reference DC
  // customfields with no Cloud remap entry, OR Cloud customfields with
  // no display-name in the catalog. Both manifest at Cloud runtime as
  // silent no-op rules (field accessor returns undefined).
  const ambiguities = detectFieldRemapAmbiguity(translated, ctx);
  for (const a of ambiguities) {
    allProblems.push(markerFor("FieldRemapAmbiguity", [
      a.field,
      `${a.pattern}: ${a.snippet}`,
      a.dcName ? `dcName=${a.dcName}` : "dcName=?",
    ]));
  }
  const dedup = dedupProblems(allProblems);
  const finalConfig = dedup.length > 0 ? { ...translated, problems: dedup } : translated;
  return {
    ruleKey,
    parameters: stringifyParams({
      appKey: appKey(moduleName, ctx),
      config: JSON.stringify(finalConfig),
      id: (ctx && ctx.ruleId) || uuidv4(),
      // Auto-disable on Groovy residue (or untranslatable ScriptRunner-API
      // usage) so the rule doesn't fire broken in production. Operator
      // re-enables in Cloud UI after hand-fixing.
      disabled: (residue.length > 0 || srApi.length > 0) ? "true" : "false",
      // Match CMA's convention so re-runs treat our writes as canonical and
      // dedup stays clean.
      tag: "migration-success",
    }),
  };
}

// ──────────────────────────────────────────────
//  Conditions  (connect:expression-condition)
// ──────────────────────────────────────────────

/**
 * JMWE CurrentStatusCondition.
 * DC args: jira.previousstatus="ID,ID,...", jira.not="yes"|"no",
 *          jira.includeCurrent, jira.mostRecentStatusOnly.
 * Despite the arg name, this checks the CURRENT issue status against the list.
 * Cloud shape (mined): { expression: "config.statusIds.includes(issue.status.id)",
 *                        statusIds: [<numeric IDs>], options: {...} }
 */
function currentStatusCondition(cfg, ctx) {
  const problems = [];
  const rawStatuses = cfg["jira.previousstatus"] || cfg.statuses || cfg.statusIds || "";
  const statusIds = splitAtAt(rawStatuses)
    .map((id) => {
      const cloudId = remapStatus(id, ctx);
      if (cloudId === id && !(ctx && ctx.statusRemapping && ctx.statusRemapping[id])) {
        problems.push(markerFor("ValueNotMapped", ["statusIds", id]));
      }
      return Number.isFinite(Number(cloudId)) ? Number(cloudId) : cloudId;
    });
  const negated = boolFromYesNo(cfg["jira.not"]);
  const expression = negated
    ? "!config.statusIds.includes(issue.status.id)"
    : "config.statusIds.includes(issue.status.id)";
  return wrap("condition", "CurrentStatusCondition", {
    expression,
    statusIds,
    // CMA emits `options: {not: true}` only when the rule is negated; for the
    // non-negated case it omits the key entirely. Mirror that shape so our
    // emit fingerprint-matches CMA's exactly.
    ...(negated ? { options: { not: true } } : {}),
  }, problems, ctx);
}

/**
 * JMWE PreviousStatusCondition. DC arg names mirror CurrentStatusCondition.
 * jira.includeCurrent="no" + jira.mostRecentStatusOnly="yes" are the common case.
 * Cloud Jira Expression: walk issue.changelog.histories backwards, find the
 * most recent status field change, and check if its previous-status id is
 * (or is not) in config.statusIds.
 */
function previousStatusCondition(cfg, ctx) {
  const problems = [];
  const rawStatuses = cfg["jira.previousstatus"] || cfg.previousStatuses || cfg.statuses || "";
  const statusIds = splitAtAt(rawStatuses)
    .map((id) => {
      const cloudId = remapStatus(id, ctx);
      if (cloudId === id && !(ctx && ctx.statusRemapping && ctx.statusRemapping[id])) {
        problems.push(markerFor("ValueNotMapped", ["statusIds", id]));
      }
      return Number.isFinite(Number(cloudId)) ? Number(cloudId) : cloudId;
    });
  const negated = boolFromYesNo(cfg["jira.not"]);
  const includeCurrent = boolFromYesNo(cfg["jira.includeCurrent"]);
  const mostRecentOnly = boolFromYesNo(cfg["jira.mostRecentStatusOnly"]);
  // Jira Expression that walks the changelog. Uses Cloud's first-class
  // changelog access — see Atlassian docs on Jira Expressions for issue.
  const baseExpr =
    `(issue.changelog && issue.changelog.histories ? issue.changelog.histories : [])` +
    `.flatMap(h => h.items.filter(i => i.field === "status").map(i => Number(i.fromAccountId || i.from)))` +
    `.some(id => config.statusIds.includes(id))`;
  let expression = negated ? `!(${baseExpr})` : baseExpr;
  if (includeCurrent) {
    expression = `(${expression}) || config.statusIds.includes(issue.status.id)`;
  }
  return wrap("condition", "PreviousStatusCondition", {
    expression,
    statusIds,
    options: { includeCurrent, mostRecentOnly },
  }, problems, ctx);
}

/**
 * JMWE Subtasks Blocking Condition.
 * Cloud expression: subtasks of selected statuses don't block.
 */
function subtasksBlockingCondition(cfg, ctx) {
  const problems = [];
  const rawStatuses = cfg["jira.subtaskstatus"] || cfg["jira.allowed"] || cfg.statuses || "";
  const statusIds = splitAtAt(rawStatuses)
    .map((id) => {
      const cloudId = remapStatus(id, ctx);
      if (cloudId === id && !(ctx && ctx.statusRemapping && ctx.statusRemapping[id])) {
        problems.push(markerFor("ValueNotMapped", ["statusIds", id]));
      }
      return Number.isFinite(Number(cloudId)) ? Number(cloudId) : cloudId;
    });
  const expression =
    `!issue.subtasks || issue.subtasks.every(st => config.statusIds.includes(st.status.id))`;
  return wrap("condition", "SubtasksBlockingCondition", {
    expression,
    statusIds,
    options: {},
  }, problems, ctx);
}

/**
 * JMWE Linked Issues Condition.
 * DC args carry linkType + linkDirection + statuses.
 */
function linkedIssuesCondition(cfg, ctx) {
  const problems = [];
  const rawStatuses = cfg["jira.linked.statuses"] || cfg.statuses || "";
  const statusIds = splitAtAt(rawStatuses).map((id) => {
    const cloudId = remapStatus(id, ctx);
    if (cloudId === id && !(ctx && ctx.statusRemapping && ctx.statusRemapping[id])) {
      problems.push(markerFor("ValueNotMapped", ["statusIds", id]));
    }
    return Number.isFinite(Number(cloudId)) ? Number(cloudId) : cloudId;
  });
  const linkType = cfg["jira.linkType"] || cfg.linkType || cfg.linkTypeId || "";
  const linkDirection = cfg["jira.linkDirection"] || cfg.linkDirection || "outward";
  problems.push(markerFor("ValueNotMapped", ["linkType", String(linkType)]));
  return wrap("condition", "LinkedIssuesCondition", {
    expression:
      `issue.links.some(l => l.type.id == config.linkType && l.direction == config.linkDirection && config.statusIds.includes(l.linkedIssue.status.id))`,
    statusIds,
    linkType: String(linkType),
    linkDirection,
    options: {},
  }, problems, ctx);
}

/**
 * JMWE Groovy Condition / ScriptedCondition.
 * Cloud shape: { expression, problems }
 * Groovy is preserved verbatim with translator best-effort + marker.
 */
function scriptedCondition(cfg, ctx) {
  const raw = cfg.groovyExpression || cfg.script || cfg.expression || "";
  const t = groovyExpressionToJiraExpression(String(raw), ["expression"], ctx);
  const problems = [...t.problems];
  if (raw && !t.problems.length) problems.push(markerFor("GroovyScriptToJiraExpression", ["expression"]));
  return wrap("condition", "ScriptedCondition", {
    expression: t.output || "true",
  }, problems, ctx);
}

/**
 * JMWE NonInteractiveCondition — no UI, the condition is always met but the
 * transition is hidden from manual users (only callable programmatically).
 */
function nonInteractiveCondition(cfg, ctx) {
  return wrap("condition", "NonInteractiveCondition", {
    expression: "!user || user.accountId == null", // crude — only runs if no user (system)
  }, [markerFor("OptionNotSupported", ["NonInteractiveCondition: Cloud has no native equivalent — review"])], ctx);
}

/**
 * JMWE LinkedIssuesStatusCondition.
 */
function linkedIssuesStatusCondition(cfg, ctx) {
  return linkedIssuesCondition(cfg, ctx);
}

// JSU UserIsInAnyRolesCondition / UserIsInCustomFieldCondition: emit a
// canonical ScriptedCondition (Cloud only knows `expression` + `problems`
// for that module — extra config keys are dropped silently and the
// expression can't reference them via `config.X`). Inline the role-name
// list directly into the Jira Expression.
//
// Jira Expressions DOES NOT expose `user.roles` — the User type has only
// `accountId`, `displayName`, `groups` (List<String>), `groupIds`,
// `timeZone`, `locale`, `active`, `avatarUrls`, `permissions`, `properties`.
// Project roles are accessed via `user.getProjectRoles(project)` which
// returns a List<ProjectRole> with `id`, `name`, `description`. Source:
// developer.atlassian.com/cloud/jira/platform/jira-expressions-type-reference.
//
// Earlier mapper output `user.roles.some(...)` evaluates to FALSE under any
// runtime — surfaced as MISSING_OTHER in the audit because Cloud silently
// rejects rules whose expression has unknown property accesses (no
// fingerprint match).
function userIsInAnyRolesCondition(cfg, ctx) {
  // DC stores role NAMES (not IDs) under `hidRolesList`, separated by `@@`.
  const rolesRaw = cfg.hidRolesList || cfg["jira.projectroles"] || cfg.rolesList || cfg.roles || "";
  const roleNames = splitAtAt(rolesRaw).map((s) => String(s));
  const namesLit = JSON.stringify(roleNames);
  // user.getProjectRoles(issue.project) returns the user's project roles
  // for the issue's project. Some(role.name in list) ↔ DC's "user is in any
  // of these roles" semantics.
  const expression =
    `user && issue && issue.project && user.getProjectRoles(issue.project).some(role => ${namesLit}.includes(role.name))`;
  return wrap("condition", "ScriptedCondition", {
    expression,
  }, [], ctx);
}

function userIsInCustomFieldCondition(cfg, ctx) {
  const fieldId = remapField(cfg.fieldsList || cfg.fieldId || cfg.field, ctx);
  // Cloud exposes user-picker customfields as `issue.customfield_NNNNN`
  // (single User) or `issue.customfield_NNNNN` (User[]). Dot access works
  // because `customfield_NNNNN` is a valid JS identifier.
  const access = jiraExprFieldRef(fieldId, ctx, [], ["expression"]);
  const expression =
    `user && ${access} != null && ` +
    `(Array.isArray(${access}) ? ` +
      `${access}.some(u => u && u.accountId == user.accountId) : ` +
      `(${access}.accountId == user.accountId))`;
  return wrap("condition", "ScriptedCondition", {
    expression,
  }, [], ctx);
}

/**
 * JSU/JMWE UserIsInAnyGroupsCondition → JMWE ScriptedCondition.
 *
 * Jira Expressions exposes `user.groups: List<String>` of group NAMES.
 * Membership check is symmetric — keep both forms readable: any of the
 * configured group names appears in user.groups.
 */
function userIsInAnyGroupsCondition(cfg, ctx) {
  const groupsRaw =
    cfg.hidGroupsList ||
    cfg["jira.projectgroups"] ||
    cfg.groupsList ||
    cfg.groups ||
    "";
  const groupNames = splitAtAt(groupsRaw).map((s) => String(s));
  const namesLit = JSON.stringify(groupNames);
  const expression =
    `user && user.groups != null && ` +
    `${namesLit}.some(g => user.groups.includes(g))`;
  return wrap("condition", "ScriptedCondition", { expression }, [], ctx);
}

// ──────────────────────────────────────────────
//  Validators  (connect:expression-validator)
// ──────────────────────────────────────────────

/**
 * JMWE Groovy Validator / ScriptedValidator.
 * Cloud shape: { errorMessage, expression, problems }
 */
function scriptedValidator(cfg, ctx) {
  const raw = cfg.groovyExpression || cfg.script || cfg.expression || "";
  const t = groovyExpressionToJiraExpression(String(raw), ["expression"], ctx);
  const problems = [...t.problems];
  if (raw && !t.problems.length) problems.push(markerFor("GroovyScriptToJiraExpression", ["expression"]));
  return wrap("validator", "ScriptedValidator", {
    expression: t.output || "true",
    errorMessage: cfg.errorMessage || "",
  }, problems, ctx);
}

/**
 * JMWE FieldRequiredValidator with `conditionalValidation: yes` carries a
 * Groovy gate (`conditionalValidationScript`) that decides whether the
 * required-field check fires. Native `system:validate-field-value` has no
 * gate, so we emit a JMWE Cloud ScriptedValidator (`connect:expression-validator`)
 * whose Jira Expression expresses both the gate and the field-set check in
 * one go: the validator passes when the gate is FALSE (the rule was meant to
 * skip) OR every required field is non-null.
 *
 * This loses the per-field error-message UX (operator sees the global
 * error message rather than "field X is required"), but preserves the
 * intent — a fair trade-off versus letting the validator fire unconditionally
 * for every project/issue type.
 *
 * Called from `jsuNativeMappers.fieldsRequiredValidator` when conditional
 * validation is detected. fieldIds is the already-remapped list.
 */
function conditionalFieldRequiredValidator(cfg, ctx, fieldIds) {
  const gateRaw = String(cfg.conditionalValidationScript || "");
  const t = groovyExpressionToJiraExpression(gateRaw, ["expression"], ctx);
  const problems = [...t.problems];
  if (gateRaw && !t.problems.length) problems.push(markerFor("GroovyScriptToJiraExpression", ["expression"]));
  const gateExpr = t.output || "true";
  // Route each fieldId through jiraExprFieldRef so customfield refs use the
  // correct Cloud-ID dot form (e.g., `issue.customfield_18722`) instead of
  // the raw DC ID. fieldIds arrives already-remapped from the caller, but the
  // helper handles both cases idempotently.
  const fieldChecks = fieldIds
    .map((f) => `${jiraExprFieldRef(f, ctx, problems, ["expression"])} != null`)
    .join(" && ");
  const expression = fieldChecks
    ? `!(${gateExpr}) || (${fieldChecks})`
    : `!(${gateExpr})`;
  return wrap("validator", "ScriptedValidator", {
    expression,
    errorMessage: cfg.errorMessage || "Required field(s) are missing",
  }, problems, ctx);
}

function dateComparisonValidator(cfg, ctx) {
  const problems = [];
  const first = remapField(cfg["date1Selected"] || cfg.firstDateFieldId || cfg.date1, ctx);
  const second = remapField(cfg["date2Selected"] || cfg.secondDateFieldId || cfg.date2, ctx);
  const condition = cfg["conditionSelected"] || cfg.condition || cfg.comparison || "GREATER_OR_EQUAL";
  const includeTime = boolFromYesNo(cfg["includeTimeSelected"] || cfg.includeTime);
  const errorMessage = cfg["customErrorMessage-textValue"] || cfg.errorMessage || "";
  return wrap("validator", "DateComparisonValidator", {
    firstDateFieldId: first,
    secondDateFieldId: second,
    condition,
    includeTime,
    errorMessage,
    includeBlank: boolFromYesNo(cfg.includeBlank),
  }, problems, ctx);
}

function previousStatusValidator(cfg, ctx) {
  const problems = [];
  const rawStatuses = cfg["jira.previousstatus"] || cfg.previousStatuses || cfg.statuses || "";
  const statusIds = splitAtAt(rawStatuses).map((id) => {
    const c = remapStatus(id, ctx);
    if (c === id && !(ctx && ctx.statusRemapping && ctx.statusRemapping[id])) {
      problems.push(markerFor("ValueNotMapped", ["statusIds", id]));
    }
    return Number.isFinite(Number(c)) ? Number(c) : c;
  });
  const expression =
    `(issue.changelog && issue.changelog.histories ? issue.changelog.histories : [])` +
    `.flatMap(h => h.items.filter(i => i.field === "status").map(i => Number(i.from)))` +
    `.some(id => config.statusIds.includes(id))`;
  return wrap("validator", "PreviousStatusValidator", {
    expression,
    statusIds,
    errorMessage: cfg.errorMessage || "",
  }, problems, ctx);
}

function linkedIssueStatusValidator(cfg, ctx) {
  const problems = [];
  const rawStatuses = cfg["jira.linked.statuses"] || cfg.statuses || cfg.statusIds || "";
  const statusIds = splitAtAt(rawStatuses).map((id) => {
    const c = remapStatus(id, ctx);
    if (c === id && !(ctx && ctx.statusRemapping && ctx.statusRemapping[id])) {
      problems.push(markerFor("ValueNotMapped", ["statusIds", id]));
    }
    return Number.isFinite(Number(c)) ? Number(c) : c;
  });
  return wrap("validator", "LinkedIssueStatusValidator", {
    expression:
      `issue.links.every(l => config.statusIds.includes(l.linkedIssue.status.id))`,
    statusIds,
    selectedLinkTypeId: String(cfg["jira.linkType"] || cfg.linkType || ""),
    selectedLinkTypeDirection: cfg["jira.linkDirection"] || "outward",
    selectedIssueTypeId: String(cfg["jira.issueType"] || ""),
    validatorMode: cfg.validatorMode || "ALL",
    conditionalValidation: false,
    errorMessage: cfg.errorMessage || "",
  }, problems, ctx);
}

function commentRequiredValidator(cfg, ctx) {
  // Native equivalent is preferred (handled in jsuNativeMappers.js); this is the
  // JMWE-Connect form for completeness when the operator opts in to JMWE.
  const groups = splitAtAt(cfg.hidGroupsList || cfg.groupsExemptFromValidation || "").join(",");
  return wrap("validator", "CommentRequiredValidator", {
    expression: "issue.comments && issue.comments.length > 0",
    groupsExemptFromValidation: groups,
    errorMessage: cfg.errorMessage || "Please add a comment",
  }, [], ctx);
}

function parentStatusValidator(cfg, ctx) {
  const problems = [];
  const rawStatuses = cfg["jira.parent.statuses"] || cfg["jira.previousstatus"] || cfg.statuses || "";
  const statusIds = splitAtAt(rawStatuses).map((id) => {
    const c = remapStatus(id, ctx);
    if (c === id && !(ctx && ctx.statusRemapping && ctx.statusRemapping[id])) {
      problems.push(markerFor("ValueNotMapped", ["statusIds", id]));
    }
    return Number.isFinite(Number(c)) ? Number(c) : c;
  });
  return wrap("validator", "ParentStatusValidator", {
    expression: `issue.parent && config.statusIds.includes(issue.parent.status.id)`,
    statusIds,
    errorMessage: cfg.errorMessage || "Parent issue is not in an allowed status",
  }, problems, ctx);
}

function fieldChangedValidator(cfg, ctx) {
  const fieldId = remapField(cfg.fieldId || cfg.field, ctx);
  return wrap("validator", "FieldChangedValidator", {
    expression: `issue.changelog.histories.some(h => h.items.some(i => i.field === "${fieldId}"))`,
    fieldId,
    errorMessage: cfg.errorMessage || "",
  }, [], ctx);
}

function genericUserValidator(cfg, ctx) {
  return wrap("validator", "GenericUserValidator", {
    expression: "user != null",
    errorMessage: cfg.errorMessage || "User check failed",
  }, [markerFor("OptionNotSupported", ["GenericUserValidator: review on Cloud"])], ctx);
}

// ──────────────────────────────────────────────
//  Post-functions  (connect:remote-workflow-function)
// ──────────────────────────────────────────────

/**
 * JMWE ClearFieldValueFunction / JSU ClearFieldValuePostFunction.
 * Cloud shape (mined): {
 *   conditionalExecution, conditionalExecutionScript?, fields, problems?, targetIssue
 * }
 * `fields` is comma-separated field IDs.
 */
function clearFieldsFunction(cfg, ctx) {
  const problems = [];
  const rawFields = cfg.fields || cfg.fieldIds || cfg.field || "";
  const fields = splitAtAt(rawFields).map((id) => remapField(id, ctx)).filter(Boolean);
  const conditionalExecution = boolFromYesNo(cfg.useGroovyCondition);
  const conditionalExecutionScript = translateCondScript(cfg.groovyExpression, problems, ctx);
  const clearConfig = applyRunAs(cfg, {
    conditionalExecution,
    conditionalExecutionScript,
    fields: fields.join(","),
    targetIssue: "currentIssue:*",
  }, ctx, problems);
  return wrap("action", "ClearFieldsFunction", clearConfig, problems, ctx);
}

/**
 * JMWE SetFieldValueFunction (single-field) AND
 * JMWE SetIssueFieldsFunction (multi-field via cfg.fields list).
 * Cloud shape (mined): {
 *   conditionalExecution, conditionalExecutionScript?,
 *   fieldsConfig: [{fieldId, options, value}],
 *   runAsType, targetIssue, problems?
 * }
 *
 * `value` is a Nunjucks template when valueType is "template", or a Groovy
 * script preserved verbatim with marker when valueType is "groovy".
 */
function setFieldValueFunction(cfg, ctx) {
  const problems = [];
  // Translate any value through the Nunjucks template path — JMWE Cloud's
  // SetFieldValueFunction renders `fieldsConfig[].value` as a Nunjucks
  // template, so DC Groovy `${issue.get("X")}` and `issue.get("X")` chains
  // need to come out as `{{ issue.fields["X"] }}` / `{{ issue.X }}`. The
  // previous "groovy"-typed branch just attached a marker and dropped the
  // value through verbatim, producing the 92-hit residue cluster (2026-05
  // post-translate audit).
  const translateValue = (raw, label) => {
    if (raw == null || raw === "") return { output: "", problems: [] };
    const s = String(raw);
    // JMWE Cloud's SetFieldValueFunction renders each `fieldsConfig[].value`
    // as a Nunjucks template. DC source most often has either:
    //   (a) a Groovy GString fragment like `${issue.get("X")}` — handled by
    //       groovyTemplateToNunjucks.
    //   (b) a bare Groovy atom like `issue.get("X")?.first()?.name` — also
    //       handled, by atom-rewrite + `{{ }}` wrap inside the same fn.
    //   (c) complex multi-statement Groovy (`def X = ...; return ...`) —
    //       the translator bails, and the residue gate will auto-disable
    //       the resulting rule.
    return groovyTemplateToNunjucks(s, ["Set Fields", label], ctx);
  };
  const targetField = remapField(cfg.field || cfg.fieldId, ctx);
  // Multi-field shape (SetIssueFieldsFunction) sometimes uses cfg.fields
  // serialized as JSON. Handle if present.
  let fieldsConfig;
  if (Array.isArray(cfg.fieldsConfig)) {
    fieldsConfig = cfg.fieldsConfig.map((f, i) => {
      const t = translateValue(f.value, `value[${i}]`);
      pushProblems(problems, t.problems);
      return {
        fieldId: remapField(f.fieldId, ctx),
        options: f.options || {},
        value: t.output,
      };
    });
  } else if (typeof cfg.fields === "string" && cfg.fields.startsWith("[")) {
    try {
      const arr = JSON.parse(cfg.fields);
      fieldsConfig = arr.map((f, i) => {
        const t = translateValue(f.value, `fields[${i}]`);
        pushProblems(problems, t.problems);
        return {
          fieldId: remapField(f.fieldId || f.id, ctx),
          options: f.options || {},
          value: t.output,
        };
      });
    } catch {
      const t = translateValue(cfg.value, "value");
      pushProblems(problems, t.problems);
      fieldsConfig = [{ fieldId: targetField, options: {}, value: t.output }];
    }
  } else {
    const t = translateValue(cfg.value, "value");
    pushProblems(problems, t.problems);
    fieldsConfig = [{ fieldId: targetField, options: {}, value: t.output }];
  }
  const conditionalExecution = boolFromYesNo(cfg.useGroovyCondition);
  const sfvfConfig = applyRunAs(cfg, {
    conditionalExecution,
    conditionalExecutionScript: translateCondScript(cfg.groovyExpression, problems, ctx),
    fieldsConfig,
    targetIssue: cfg.selectedLinkType || "currentIssue:*",
  }, ctx, problems);
  return wrap("action", "SetFieldValueFunction", sfvfConfig, problems, ctx);
}

/**
 * JMWE CommentIssueFunction.
 * Cloud shape (mined): { comment, conditionalExecution, conditionalExecutionScript?,
 *   restrictToInternal, runAs, runAsType, targetIssue, problems? }
 * `comment` is Nunjucks (best-effort translated).
 */
function commentIssueFunction(cfg, ctx) {
  const problems = [];
  const rawComment = cfg.comment || cfg.value || "";
  const t = groovyTemplateToNunjucks(String(rawComment), ["Comment"], ctx);
  pushProblems(problems, t.problems);
  const commentConfig = applyRunAs(cfg, {
    conditionalExecution: boolFromYesNo(cfg.useGroovyCondition),
    conditionalExecutionScript: translateCondScript(cfg.groovyExpression, problems, ctx),
    restrictToInternal: boolFromYesNo(cfg.restrictToInternal) || cfg.restrictToInternal === "yes",
    targetIssue: cfg.selectedLinkType || "currentIssue:*",
    comment: t.output,
  }, ctx, problems);
  return wrap("action", "CommentIssueFunction", commentConfig, problems, ctx);
}

/**
 * JMWE EmailIssueFunction.
 * Cloud shape (mined): { subject, textBody, htmlBody, toReporter, toAssignee,
 *   toWatchers, toVoters, toUsers, toUserFields, toUsersScript, toGroups,
 *   toEmailsScript, toRoleMembers, conditionalExecution, runAs, runAsType,
 *   targetIssue, problems? }
 */
function emailIssueFunction(cfg, ctx) {
  const problems = [];
  const subj = groovyTemplateToNunjucks(String(cfg.subject || ""), ["Subject"], ctx);
  pushProblems(problems, subj.problems);
  const text = groovyTemplateToNunjucks(String(cfg.textBody || cfg.body || ""), ["Text Body"], ctx);
  pushProblems(problems, text.problems);
  const html = groovyTemplateToNunjucks(String(cfg.htmlBody || ""), ["HTML Body"], ctx);
  pushProblems(problems, html.problems);
  // Recipient scripts (toEmailsScript, toUsersScript) live in JMWE Cloud as
  // Nunjucks template strings — same surface as subject/textBody. Translate
  // them through the same value-expression pipeline so DC's `${issue.get(
  // "customfield_X").emailAddress}` patterns end up as `{{ issue.fields["X"]
  // .emailAddress }}` instead of leaking GString syntax to Cloud (where it
  // renders as literal text). Insight/Assets references stay flagged for
  // manual review.
  const rawEmails = String(cfg.toEmailAddresses || cfg.toEmailsScript || "");
  let toEmailsScript = rawEmails;
  if (rawEmails) {
    if (hasInsightContent(rawEmails)) {
      problems.push(markerFor("OptionNotSupported", ["Recipients", "Insight/Assets reference"]));
    }
    const tEmails = groovyTemplateToNunjucks(rawEmails, ["Recipients"], ctx);
    toEmailsScript = tEmails.output || rawEmails;
    pushProblems(problems, tEmails.problems);
  }
  const rawUsersScript = String(cfg.toUsersScript || "");
  let toUsersScript = rawUsersScript;
  if (rawUsersScript) {
    const tUs = groovyTemplateToNunjucks(rawUsersScript, ["Users script"], ctx);
    toUsersScript = tUs.output || rawUsersScript;
    pushProblems(problems, tUs.problems);
  }
  const emailConfig = applyRunAs(cfg, {
    conditionalExecution: boolFromYesNo(cfg.useGroovyCondition),
    conditionalExecutionScript: translateCondScript(cfg.groovyExpression, problems, ctx),
    subject: subj.output,
    textBody: text.output,
    htmlBody: html.output,
    toReporter: boolFromYesNo(cfg.toReporter),
    toAssignee: boolFromYesNo(cfg.toAssignee),
    toWatchers: boolFromYesNo(cfg.toWatchers),
    toVoters: boolFromYesNo(cfg.toVoters),
    toUsers: cfg.toUsers || "",
    toUserFields: cfg.toUserFields || "",
    toUsersScript,
    toGroups: cfg.toGroups || "",
    toEmailsScript,
    toRoleMembers: cfg.toRoleMembers || "",
    targetIssue: cfg.selectedLinkType || "currentIssue:*",
  }, ctx, problems);
  return wrap("action", "EmailIssueFunction", emailConfig, problems, ctx);
}

/**
 * JSU UpdateIssueCustomFieldPostFunction (handled natively by jsuNativeMappers).
 * Provided here only as a fallback when strategy=jmwe is forced.
 */
function updateIssueCustomFieldFunction(cfg, ctx) {
  const fieldId = remapField(cfg["field.name"] || cfg.fieldId || cfg.field, ctx);
  const value = String(cfg["field.value"] != null ? cfg["field.value"] : (cfg.fieldValue || cfg.value || ""));
  return setFieldValueFunction({ field: fieldId, value, valueType: "text", appendValues: cfg["append.value"] }, ctx);
}

/**
 * JSU CopyValueFromOtherFieldPostFunction (JSU + JMWE versions).
 */
function copyFieldValuePostFunction(cfg, ctx) {
  const sourceField = remapField(cfg.sourceField || cfg.sourceFieldId || cfg.sourceFieldKey, ctx);
  const targetField = remapField(cfg.destinationField || cfg.destinationFieldId || cfg.destinationFieldKey, ctx);
  return wrap("action", "CopyMultipleFieldsFunction", {
    conditionalExecution: false,
    copyFieldsConfig: [{ sourceFieldId: sourceField, targetFieldId: targetField, options: {} }],
    sourceIssues: "currentIssue:*",
    destinationIssues: "currentIssue:*",
  }, [], ctx);
}

/**
 * JMWE CopyFieldValueFromParentFunction.
 */
function copyFromParentFunction(cfg, ctx) {
  const fieldId = remapField(cfg.fieldId || cfg.field, ctx);
  return wrap("action", "CopyMultipleFieldsFunction", {
    conditionalExecution: false,
    copyFieldsConfig: [{ sourceFieldId: fieldId, targetFieldId: fieldId, options: {} }],
    sourceIssues: "parentIssue:*",
    destinationIssues: "currentIssue:*",
  }, [markerFor("ValueNotMapped", ["sourceIssues parent reference — verify on Cloud"])], ctx);
}

function copyValueFromPreviousStatusFunction(cfg, ctx) {
  const fieldId = remapField(cfg.fieldId || cfg.field, ctx);
  const problems = [markerFor("GroovyScriptToNunjucks", ["script"])];
  // LHS uses the JMWE Cloud Nunjucks-style display-name reference so the
  // engine can resolve the customfield by name. The changelog `field` key,
  // however, is the raw Cloud customfield ID on both sides — not the display
  // name — so we keep the remapped ID literal there.
  const lhs = nunjucksFieldRef(fieldId, ctx, problems, ["script"]);
  return wrap("action", "ScriptedPostFunction", {
    script: `${lhs} = (issue.changelog.histories.findLast(h => h.items.some(i => i.field === "${fieldId}")) || {}).items?.[0]?.fromString;`,
    scriptDescription: "Copy value from previous status (auto-translated from JSU)",
  }, problems, ctx);
}

/**
 * JMWE IncreaseFieldValueFunction.
 * Cloud shape: { fieldId, conditionalExecution }
 */
function increaseFieldValueFunction(cfg, ctx) {
  const fieldId = remapField(cfg.field || cfg.fieldId, ctx);
  return wrap("action", "IncreaseFieldValueFunction", {
    conditionalExecution: boolFromYesNo(cfg.useGroovyCondition),
    fieldId,
  }, [], ctx);
}

/**
 * JMWE AssignIssueFunction.
 * Canonical Cloud shape (mined from CMA):
 *   {
 *     assignmentBehavior: "force"|"safe",
 *     conditionalExecution: bool,
 *     multipleUserBehavior: "first"|"random"|...,
 *     selectUser: <user reference, e.g. "currentUser" | accountId | groovy script>,
 *     selectUserType: "specificUser"|"currentUser"|"unassigned"|"groovy",
 *     targetIssue: "currentIssue:*",
 *     throwIfNoMatch: bool
 *   }
 */
function assignIssueFunction(cfg, ctx) {
  const userId = cfg.userId || cfg.username || cfg["jira.assignee"] || "";
  let selectUserType, selectUser;
  const problems = [];
  if (userId === "%%CURRENT_USER%%") {
    selectUserType = "currentUser";
    selectUser = "";
  } else if (!userId || String(userId).toLowerCase() === "unassigned") {
    selectUserType = "unassigned";
    selectUser = "";
  } else {
    selectUserType = "specificUser";
    selectUser = String(userId);
    problems.push(markerFor("ValueNotMapped", ["selectUser — DC username does not map automatically to Cloud accountId"]));
  }
  return wrap("action", "AssignIssueFunction", {
    assignmentBehavior: "force",
    conditionalExecution: boolFromYesNo(cfg.useGroovyCondition),
    multipleUserBehavior: "first",
    selectUser,
    selectUserType,
    targetIssue: cfg.selectedLinkType || "currentIssue:*",
    throwIfNoMatch: false,
  }, problems, ctx);
}

/**
 * JMWE TransitionIssueFunction (current issue) and TransitionLinkedIssuesFunction.
 * Cloud shape: { conditionalExecution, fields, runAsType, targetIssue, transition }
 */
function transitionIssueFunction(cfg, ctx) {
  const transitionName = cfg.transition || cfg.transitionName || cfg.targetTransition || "";
  const problems = [markerFor("ValueNotMapped", ["transition", String(transitionName)])];
  const txnConfig = applyRunAs(cfg, {
    conditionalExecution: boolFromYesNo(cfg.useGroovyCondition),
    fields: {},
    targetIssue: cfg.selectedLinkType || "currentIssue:*",
    transition: String(transitionName),
  }, ctx, problems);
  return wrap("action", "TransitionIssueFunction", txnConfig, problems, ctx);
}

function transitionLinkedIssuesFunction(cfg, ctx) {
  // Canonical Cloud shape (mined from CMA): same as TransitionIssueFunction
  // but with targetIssue describing the link traversal, e.g.
  //   "outward:jira_subtask_link"  /  "outward:10004"  /  "linkedIssue:*"
  const transitionName = cfg.transition || cfg.transitionName || cfg.targetTransition || "";
  let linkType = cfg.selectedLinkType || cfg["jira.linkType"] || cfg.linkType || "";
  // DC sometimes stores values like "outward:10004" already; otherwise build it.
  let targetIssue;
  if (typeof linkType === "string" && (linkType.startsWith("outward:") || linkType.startsWith("inward:") || linkType.startsWith("linkedIssue:") || linkType.startsWith("currentIssue:"))) {
    targetIssue = linkType;
  } else if (linkType) {
    targetIssue = `outward:${linkType}`;
  } else {
    targetIssue = "linkedIssue:*";
  }
  const linkedTxnProblems = [markerFor("ValueNotMapped", ["linkType/transition — verify on Cloud"])];
  const linkedTxnConfig = applyRunAs(cfg, {
    conditionalExecution: boolFromYesNo(cfg.useGroovyCondition),
    fields: {},
    targetIssue,
    transition: String(transitionName),
  }, ctx, linkedTxnProblems);
  return wrap("action", "TransitionIssueFunction", linkedTxnConfig, linkedTxnProblems, ctx);
}

function createIssueFunction(cfg, ctx) {
  // Canonical Cloud shape (mined from CMA):
  //   { comment, commentIssue, conditionalExecution, fields, issuetype,
  //     parentIssue, problems?, project, runAsType, selectedLinkType }
  const createProblems = [markerFor("ValueNotMapped", ["project / issuetype IDs — verify on Cloud"])];
  const createConfig = applyRunAs(cfg, {
    comment: cfg.commentText || "",
    commentIssue: boolFromYesNo(cfg.commentIssue || cfg.addComment),
    conditionalExecution: boolFromYesNo(cfg.useGroovyCondition),
    fields: cfg.fields && typeof cfg.fields === "object" ? cfg.fields : {},
    issuetype: String(cfg.issueType || cfg.issueTypeId || ""),
    parentIssue: cfg.parentIssue || (cfg.linkType || cfg.linkTypeId ? "$currentIssue$" : false),
    project: cfg.projectKey || cfg["jira.project"] || cfg.project || "$sameAsCurrentIssue$",
    selectedLinkType: String(cfg.linkType || cfg.linkTypeId || ""),
  }, ctx, createProblems);
  return wrap("action", "CreateIssueFunction", createConfig, createProblems, ctx);
}

/**
 * Parse a Groovy body as a sequence of `issue.setFieldValue("F", V)` statements.
 * Returns the parsed list `[{fieldId, value}]` when the body contains ONLY
 * setFieldValue calls (plus whitespace, semicolons, and comments), or null
 * when any non-matching content is present.
 *
 * V is captured as-is (paren-balanced, string-literal-aware), so the caller
 * can pass each value through groovyTemplateToNunjucks.
 */
function parseSetFieldValueStatements(body) {
  const stmts = [];
  let pos = 0;
  const skipNoise = () => {
    while (pos < body.length) {
      const ch = body[pos];
      if (/\s/.test(ch) || ch === ";") { pos++; continue; }
      if (body.slice(pos, pos + 2) === "//") {
        while (pos < body.length && body[pos] !== "\n") pos++;
        continue;
      }
      if (body.slice(pos, pos + 2) === "/*") {
        const end = body.indexOf("*/", pos + 2);
        if (end === -1) return false;
        pos = end + 2;
        continue;
      }
      break;
    }
    return true;
  };
  while (pos < body.length) {
    if (!skipNoise()) return null;
    if (pos >= body.length) break;
    const headRe = /issue\s*\.\s*setFieldValue\s*\(/y;
    headRe.lastIndex = pos;
    const hm = headRe.exec(body);
    if (!hm) return null;
    pos = headRe.lastIndex;
    const fieldRe = /\s*["']([^"']+)["']\s*,\s*/y;
    fieldRe.lastIndex = pos;
    const fm = fieldRe.exec(body);
    if (!fm) return null;
    const fieldId = fm[1];
    pos = fieldRe.lastIndex;
    // Capture value until matching close paren (paren-balanced + string-aware).
    const start = pos;
    let depth = 1;
    let inStr = null;
    while (pos < body.length) {
      const ch = body[pos];
      if (inStr) {
        if (ch === inStr && body[pos - 1] !== "\\") inStr = null;
        pos++;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = ch; pos++; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) break; }
      pos++;
    }
    if (depth !== 0) return null;
    const value = body.slice(start, pos).trim();
    pos++; // consume `)`
    stmts.push({ fieldId, value });
  }
  return stmts.length > 0 ? stmts : null;
}

/**
 * JMWE GroovyFunction → ScriptedPostFunction (preserve script + marker).
 *
 * Fast path: when the script body is purely `issue.setFieldValue("F", V)`
 * calls (one or more, separated by `;` / whitespace / comments), reroute
 * through `setFieldValueFunction`. This produces a native Cloud rule that
 * actually runs at transition time instead of a ScriptedPostFunction stub
 * that fires the script verbatim — Cloud's ScriptedPostFunction engine has
 * no compatibility with DC Groovy, so the script silently no-ops.
 */
function scriptedPostFunction(cfg, ctx) {
  const script = String(cfg.groovyExpression || cfg.script || "");
  const stmts = parseSetFieldValueStatements(script);
  if (stmts) {
    return setFieldValueFunction({
      fieldsConfig: stmts.map((s) => {
        // Unquote pure string literals — `"PENDING"` is a Groovy string,
        // but the Nunjucks template engine would render the quotes literally.
        // GString literals `"text ${expr}"` get unquoted here too; the
        // `${...}` inside gets picked up by setFieldValueFunction's
        // groovyTemplateToNunjucks pass.
        let v = s.value;
        const dq = v.match(/^"((?:[^"\\]|\\.)*)"$/);
        const sq = v.match(/^'((?:[^'\\]|\\.)*)'$/);
        if (dq) v = dq[1].replace(/\\(["'\\])/g, "$1");
        else if (sq) v = sq[1].replace(/\\(["'\\])/g, "$1");
        return { fieldId: s.fieldId, options: {}, value: v };
      }),
    }, ctx);
  }
  const desc = cfg.scriptDescription || "Auto-translated from JMWE GroovyFunction";
  return wrap("action", "ScriptedPostFunction", {
    script,
    scriptDescription: desc,
  }, [markerFor("GroovyScriptToNunjucks", ["script"])], ctx);
}

function setFieldFromUserPropFunction(cfg, ctx) {
  return scriptedPostFunction({
    groovyExpression: `// auto-translated SetFieldFromUserPropFunction\n// fields: ${JSON.stringify(cfg).slice(0, 200)}`,
    scriptDescription: "SetFieldFromUserPropFunction (review)",
  }, ctx);
}

function setIssueSecurityFromRoleFunction(cfg, ctx) {
  return scriptedPostFunction({
    groovyExpression: `// auto-translated SetIssueSecurityFromRoleFunction\n// fields: ${JSON.stringify(cfg).slice(0, 200)}`,
    scriptDescription: "SetIssueSecurityFromRoleFunction (review)",
  }, ctx);
}

// ──────────────────────────────────────────────
//  ch.beecom plugin (BeeCom Workflow Toolbox)
// ──────────────────────────────────────────────

/**
 * BeeCom Linked Transition (JSU class
 * `ch.beecom.jira.jsu.workflow.function.linkedtransition.LinkedTransitionFunction`)
 * triggers a transition on a related issue (typically the parent or an issue
 * reachable via a Jira link) using a transition declared by NUMERIC ACTION ID
 * in a NAMED target workflow.
 *
 * DC arg keys (verified against live XML):
 *   workflowName-textValue : target workflow name (e.g. "CHANGE: Normal / Standard Change")
 *   integerValue           : numeric action ID in that workflow (e.g. 651)
 *   destination-scopeTarget: PARENT | ISSUE_IN_TRANSITION | LINK_END
 *   scopeDestination-linkEnd: link type when destination=LINK_END
 *   status                 : numeric DC status ID the target transition resolves to
 *   preconditionAwareFunctionMode-textValue: ALWAYS | CONDITIONALLY
 *   performTransitionAsUser-user: optional user override
 *
 * JMWE Cloud TransitionIssueFunction expects the transition NAME (not ID) and
 * a `targetIssue` describing which related issue(s) to act on. We resolve the
 * action ID through `ctx.dcInventory` (which has every workflow's transitions
 * keyed by id). The target-workflow lookup is sanitisation-aware: DC stores
 * `:` and `/` in the textValue but the inventory keys substitute `_` for both.
 */
function beecomLinkedTransitionFunction(cfg, ctx) {
  const targetWorkflowDeclared = String(cfg["workflowName-textValue"] || "");
  const actionId = String(cfg.integerValue || "").trim();
  const dest = String(cfg["destination-scopeTarget"] || cfg.scopeType || "").trim();
  const linkEnd = String(cfg["scopeDestination-linkEnd"] || "").trim();

  // Resolve action ID -> action name via the inventory. The DC-exported
  // workflow name uses `:` and `/`; inventory keys substitute these with `_`.
  const inv = (ctx && ctx.dcInventory && ctx.dcInventory.workflows) || {};
  const tryNames = [
    targetWorkflowDeclared,
    targetWorkflowDeclared.replace(/[/:]/g, "_"),
    targetWorkflowDeclared.replace(/:/g, "_"),
    targetWorkflowDeclared.replace(/\//g, "_"),
  ];
  let transitionName = "";
  let resolvedWfKey = "";
  for (const n of tryNames) {
    if (n && inv[n]) {
      const t = (inv[n].transitions || []).find((x) => String(x.transitionId) === actionId);
      if (t) { transitionName = t.transitionName; resolvedWfKey = n; break; }
    }
  }

  // Pick the JMWE Cloud `targetIssue` value from the destination scope.
  // PARENT → `parentIssue:*`; ISSUE_IN_TRANSITION → `currentIssue:*`;
  // LINK_END → `outward:<linkType>` when a link end is provided.
  let targetIssue;
  let scopeUnresolved = false;
  if (dest === "PARENT") targetIssue = "parentIssue:*";
  else if (dest === "ISSUE_IN_TRANSITION" || dest === "SAME") targetIssue = "currentIssue:*";
  else if (dest === "LINK_END" && linkEnd) targetIssue = `outward:${linkEnd}`;
  else if (dest === "LINK_END") { targetIssue = "linkedIssue:*"; scopeUnresolved = true; }
  else { targetIssue = "linkedIssue:*"; scopeUnresolved = true; }

  const problems = [];
  if (!transitionName) {
    problems.push(markerFor("ValueNotMapped", [
      "transition", `${targetWorkflowDeclared} action ${actionId}`,
    ]));
  }
  if (scopeUnresolved) {
    problems.push(markerFor("ValueNotMapped", [
      "destination-scopeTarget", dest,
    ]));
  }

  const beecomConfig = applyRunAs(cfg, {
    conditionalExecution: false,
    fields: {},
    targetIssue,
    transition: transitionName || `<DC action ${actionId} in ${targetWorkflowDeclared}>`,
  }, ctx, problems);
  return wrap("action", "TransitionIssueFunction", beecomConfig, problems, ctx);
}

function beecomCreateLinkedIssueFunction(cfg, ctx) {
  return createIssueFunction(cfg, ctx);
}

function beecomValueFieldPreconditionFunction(cfg, ctx) {
  // Precondition functions on DC act like inline conditions; emit a
  // ScriptedPostFunction that no-ops with a marker so the operator can
  // re-author it as a condition or remove.
  return scriptedPostFunction({
    groovyExpression: `// BeeCom ValueFieldPreconditionFunction precondition — re-author on Cloud\n// cfg: ${JSON.stringify(cfg).slice(0, 200)}`,
    scriptDescription: "BeeCom precondition (review)",
  }, ctx);
}

// ──────────────────────────────────────────────
//  Phase 2 additions (2026-05) — mappers for shortNames previously surfaced
//  as "unknown" by --collect. Configs sampled from the SM/HR/IT workflow
//  corpus on jira-dc.example.com. Verified empirically by
//  scripts/mapper_self_test.js; live Cloud validation pending.
// ──────────────────────────────────────────────

/**
 * BeeCom UserIsInAnyUsersCondition: transition allowed only if the current
 * user is in a specific list. DC config carries usernames or DC userKeys
 * under `usersList` / `hidUsersList` / `users` (`@@`-separated).
 *
 * Cloud's native `system:restrict-issue-transition` would be the ideal target
 * (it accepts an `accountIds` CSV) but we don't have a DC-username →
 * Cloud-accountId remap at mapper time. Fall back to a JMWE ScriptedCondition
 * whose Jira Expression compares `user.accountId` against the list; the
 * actual accountIds need to be resolved by the operator post-migration.
 *
 * Emit the user identifiers verbatim and tag a `ValueNotMapped` problem so
 * the manual-review workbook surfaces them.
 */
function beecomUserIsInAnyUsersCondition(cfg, ctx) {
  const raw = cfg.usersList || cfg.hidUsersList || cfg.users || cfg["jira.users"] || "";
  const userIds = splitAtAt(raw).map((s) => String(s));
  if (userIds.length === 0) {
    return wrap(
      "condition",
      "ScriptedCondition",
      { expression: "false" },
      [markerFor("OptionNotSupported", ["beecom-user-is-in-any-users-condition: empty user list — defaulting to false"])],
      ctx,
    );
  }
  const usersLit = JSON.stringify(userIds);
  // Match by accountId; the DC-side identifiers may be usernames or userKeys
  // which Cloud doesn't index by — the operator must hand-replace them with
  // Cloud accountIds. Marker flags this loudly.
  const expression = `user && ${usersLit}.includes(user.accountId)`;
  const problems = [
    markerFor("ValueNotMapped", [
      "userAccountIds: DC usernames/userKeys (" + userIds.slice(0, 5).join(", ") + (userIds.length > 5 ? ", ..." : "") +
        ") must be replaced with Cloud accountIds — see /rest/api/3/user/search by displayName/email",
    ]),
  ];
  return wrap("condition", "ScriptedCondition", { expression }, problems, ctx);
}

/**
 * JSU JqlCondition: transition allowed only if the current issue matches a
 * JQL query. JMWE Cloud has a `JqlCondition` module that takes a JQL string.
 *
 * DC arg carries the JQL under `query` / `jqlquery` / `jql`. JQL on Cloud
 * references custom fields by name with cf prefix syntax (`cf[Foo Bar]` or
 * `"Foo Bar"`) — DC-style `customfield_NNN` refs in JQL would need name
 * translation, but that's a separate concern handled by the JMWE Cloud
 * JQL parser if the field names match.
 */
function jqlCondition(cfg, ctx) {
  const jql =
    cfg.query ||
    cfg.jqlquery ||
    cfg.jql ||
    cfg["jira.jql"] ||
    "";
  const problems = [];
  if (!jql) {
    problems.push(markerFor("OptionNotSupported", ["jsu-jql-condition: no JQL configured — emitting empty query"]));
  }
  if (/customfield_\d+/.test(jql)) {
    problems.push(markerFor("GroovyScriptToJiraExpression", [
      "JQL contains customfield_NNN references; Cloud's JQL parser requires field NAMES (cf[Name]) — operator must hand-fix.",
    ]));
  }
  return wrap("condition", "JqlCondition", {
    jqlQuery: String(jql),
  }, problems, ctx);
}

/**
 * JMWE FieldHasSingleValueValidator: validate that a multi-value field has
 * exactly one selected value at transition time. JMWE Cloud has a matching
 * `FieldHasSingleValueValidator` module.
 *
 * DC config: `fieldId` (or `field.name`/`field.id`), optional `errorMessage`.
 */
function fieldHasSingleValueValidator(cfg, ctx) {
  // DC config uses `fieldKey` (confirmed from a JSM sandbox corpus 2026-05).
  // The legacy `field.id` / `field.name` / `fieldId` / `field` shapes are kept
  // as fallbacks for older JMWE configs.
  const dcFieldId =
    cfg.fieldKey ||
    cfg.fieldId ||
    cfg["field.id"] ||
    cfg["field.name"] ||
    cfg.field;
  const cloudFieldId = remapField(String(dcFieldId || ""), ctx);
  const problems = [];
  if (!dcFieldId) {
    problems.push(markerFor("OptionNotSupported", ["fieldHasSingleValueValidator: no field configured"]));
  }
  const errorMessage = cfg.errorMessage || cfg["jmwe.errormessage"] || "This field must have exactly one value.";
  // JMWE FieldHasSingleValueValidator passes through the optional
  // conditional-validation gate (DC arg `conditionalValidationScript` /
  // `conditionalValidation`). When present we forward both so JMWE Cloud's
  // editor renders the gate alongside the field check.
  const config = {
    fieldId: cloudFieldId,
    errorMessage: String(errorMessage),
  };
  if (cfg.conditionalValidation || cfg.conditionalValidationScript) {
    config.conditionalValidation = String(cfg.conditionalValidation || "no");
    if (cfg.conditionalValidationScript) {
      config.conditionalValidationScript = translateCondScript(
        cfg.conditionalValidationScript,
        problems,
        ctx,
      );
    }
  }
  if (cfg["jira.excludingSubtasks"]) {
    config.excludingSubtasks = String(cfg["jira.excludingSubtasks"]);
  }
  return wrap("validator", "FieldHasSingleValueValidator", config, problems, ctx);
}

/**
 * JMWE CopyIssueFieldsFunction: bulk-copy multiple fields from one issue to
 * another (typically current → linked, or current → parent). JMWE Cloud has
 * a matching `CopyIssueFieldsFunction` module.
 *
 * DC config: `fieldMappings` (list of "sourceField=targetField" or similar)
 *            OR multiple per-field args. We harvest both shapes.
 * Target issue selector is in `targetIssue` / `issueSelector`.
 */
function copyIssueFieldsFunction(cfg, ctx) {
  const problems = [];
  // Parse fieldMappings into [{ sourceFieldId, targetFieldId }, ...]
  const fieldsConfig = [];
  const rawMappings = cfg.fieldMappings || cfg["jmwe.fieldmappings"] || cfg.mappings;
  if (rawMappings) {
    const entries = Array.isArray(rawMappings)
      ? rawMappings
      : String(rawMappings).split(/\n|@@|,/).map((s) => s.trim()).filter(Boolean);
    for (const entry of entries) {
      const m = /^(.+?)\s*[=:>→]\s*(.+)$/.exec(String(entry || ""));
      if (m) {
        fieldsConfig.push({
          sourceFieldId: remapField(m[1].trim(), ctx),
          targetFieldId: remapField(m[2].trim(), ctx),
        });
      }
    }
  }
  if (fieldsConfig.length === 0) {
    problems.push(markerFor("OptionNotSupported", ["copyIssueFieldsFunction: no field mappings parsed from DC config"]));
  }
  const targetIssue = cfg.targetIssue || cfg["jmwe.targetissue"] || cfg.issueSelector || "currentIssue";
  const cond = cfg.conditionalExecutionScript ? translateCondScript(cfg.conditionalExecutionScript, problems, ctx) : "";
  return wrap("action", "CopyIssueFieldsFunction", {
    fieldsConfig,
    targetIssue: String(targetIssue),
    conditionalExecutionScript: cond,
    runAsType: cfg.runAs || "INITIATING_USER",
  }, problems, ctx);
}

/**
 * JMWE GenericUserCondition: configurable user predicate combining
 * roles/groups/permissions. No 1:1 Cloud module — emit a ScriptedCondition
 * whose expression composes the documented Jira-Expression User-type
 * predicates (`user.getProjectRoles(...)`, `user.groups`, `user.permissions`).
 *
 * The DC config is heterogeneous; we make a best-effort translation from the
 * most common keys and mark the rule for operator review.
 */
function genericUserCondition(cfg, ctx) {
  // DC's GenericUserCondition was DISABLED at the source — emit nothing.
  // Without this guard we'd ship a no-op `expression:"true"` that becomes
  // a phantom "always pass" condition AND collides with other no-op
  // emissions (verified 2026-05 — two of these in the same transition
  // produced an identical-hash duplicate).
  if (String(cfg.enabled || "").toLowerCase() === "false") return null;

  const parts = [];
  const problems = [];
  // Roles by NAME — DC keys: `roles` / `hidRolesList` / `rolesToCheck`.
  const rolesRaw = cfg.roles || cfg.hidRolesList || cfg.rolesToCheck || cfg["jira.projectroles"] || "";
  const roleNames = splitAtAt(rolesRaw).concat(
    typeof rolesRaw === "string" ? rolesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
  ).filter((v, i, arr) => v && arr.indexOf(v) === i);
  if (roleNames.length > 0) {
    parts.push(
      `user.getProjectRoles(issue.project).some(role => ${JSON.stringify(roleNames)}.includes(role.name))`,
    );
  }
  // Groups by NAME — DC keys: `groups` / `hidGroupsList` / `groupsToCheck`.
  const groupsRaw = cfg.groups || cfg.hidGroupsList || cfg.groupsToCheck || cfg["jira.groups"] || "";
  const groupNames = splitAtAt(groupsRaw).concat(
    typeof groupsRaw === "string" ? groupsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
  ).filter((v, i, arr) => v && arr.indexOf(v) === i);
  if (groupNames.length > 0) {
    parts.push(`${JSON.stringify(groupNames)}.some(g => user.groups.includes(g))`);
  }
  // User-field predicates: `userField`/`userFieldsToCheck` — current-user
  // must equal the user-value in the named field. Common JMWE pattern.
  const userFieldRaw = cfg.userField || cfg.userFieldsToCheck || "";
  const userFields = typeof userFieldRaw === "string"
    ? userFieldRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  for (const uf of userFields) {
    const ref = uf.startsWith("customfield_") ? `issue.${uf}` : `issue.${uf}`;
    parts.push(`(!!${ref} && (Array.isArray(${ref}) ? ${ref}.some(u => u.accountId == user.accountId) : ${ref}.accountId == user.accountId))`);
  }
  // Built-in role predicates: isAssignee / isReporter / isVoter / isWatcher /
  // isProjectLead — each is a "yes"/"no" string in DC.
  const isYes = (v) => String(v || "").toLowerCase() === "yes" || String(v || "").toLowerCase() === "true";
  if (isYes(cfg.isAssignee)) parts.push("issue.assignee && issue.assignee.accountId == user.accountId");
  if (isYes(cfg.isReporter)) parts.push("issue.reporter && issue.reporter.accountId == user.accountId");
  if (isYes(cfg.isProjectLead)) parts.push("issue.project.lead && issue.project.lead.accountId == user.accountId");
  // Permission keys (DC `permissions`) — too configuration-heavy.
  const permsRaw = cfg.permissions || cfg["jira.permissions"] || "";
  const perms = splitAtAt(permsRaw);
  if (perms.length > 0) {
    problems.push(markerFor("OptionNotSupported", [
      "genericUserCondition: DC permissions (" + perms.join(", ") + ") need manual translation to user.permissions.X.havePermission",
    ]));
  }
  // No predicate at all → don't emit. A no-op `true` becomes a phantom
  // condition that always passes AND collides with other no-ops on the
  // same transition (duplicate-rule).
  if (parts.length === 0) return null;
  // Apply reverse flag if set
  let expression = `user && issue && (${parts.join(" || ")})`;
  if (isYes(cfg.reverse)) expression = `!(${expression})`;
  return wrap("condition", "ScriptedCondition", { expression }, problems, ctx);
}

// ──────────────────────────────────────────────
//  Registry
// ──────────────────────────────────────────────

const JMWE_MAPPERS = {
  // Conditions
  "value-field-condition": null, // handled natively
  "subtasks-blocking-condition": subtasksBlockingCondition,
  "previous-status-condition": previousStatusCondition,
  "hide-from-user-condition": null,
  "no-operation-condition": null,
  "jmwe-current-status-condition": currentStatusCondition,
  "jmwe-groovy-condition": scriptedCondition,
  "jmwe-linked-issues-condition": linkedIssuesCondition,
  "jmwe-non-interactive-condition": nonInteractiveCondition,
  "jmwe-linked-issues-status-condition": linkedIssuesStatusCondition,
  "user-is-in-any-roles-condition": userIsInAnyRolesCondition,
  "user-is-in-custom-field-condition": userIsInCustomFieldCondition,
  "user-is-in-any-groups-condition": userIsInAnyGroupsCondition,

  // Validators
  "regex-validator": null, // handled natively
  "date-compare-validator": dateComparisonValidator,
  "previous-status-validator": previousStatusValidator,
  "windows-date-validator": dateComparisonValidator,
  "user-permission-validator": null, // handled natively
  "logged-in-condition-validator": null,
  "jmwe-comment-required-validator": commentRequiredValidator,
  "jmwe-groovy-validator": scriptedValidator,
  "jmwe-linked-issues-status-validator": linkedIssueStatusValidator,
  "jmwe-parent-status-validator": parentStatusValidator,
  "jmwe-field-changed-validator": fieldChangedValidator,
  "jmwe-generic-user-validator": genericUserValidator,

  // Post-functions
  "clear-field-value": clearFieldsFunction,
  "assign-to-current-user": assignIssueFunction,
  "copy-value-from-other-field": copyFieldValuePostFunction,
  "update-issue-field": updateIssueCustomFieldFunction,
  "copy-value-from-previous-status": copyValueFromPreviousStatusFunction,
  "send-custom-email": emailIssueFunction,
  "create-issue": createIssueFunction,
  "transition-linked-issue": transitionLinkedIssuesFunction,
  "set-field-value-automatically": setFieldValueFunction,

  "jmwe-clear-fields": clearFieldsFunction,
  "jmwe-set-field-value": setFieldValueFunction,
  "jmwe-copy-from-link": copyFieldValuePostFunction,
  "jmwe-increase-field-value": increaseFieldValueFunction,
  "jmwe-assign-issue": assignIssueFunction,
  "jmwe-comment-issue": commentIssueFunction,
  "jmwe-email-issue": emailIssueFunction,
  "jmwe-transition-issue": transitionIssueFunction,
  "jmwe-groovy-function": scriptedPostFunction,
  "jmwe-copy-from-parent": copyFromParentFunction,
  "jmwe-set-field-from-user-prop": setFieldFromUserPropFunction,
  "jmwe-set-issue-security-from-role": setIssueSecurityFromRoleFunction,

  // ch.beecom
  "beecom-linked-transition-function": beecomLinkedTransitionFunction,
  "beecom-create-linked-issue-function": beecomCreateLinkedIssueFunction,
  "beecom-value-field-precondition-function": beecomValueFieldPreconditionFunction,
  "beecom-user-is-in-any-users-condition": beecomUserIsInAnyUsersCondition,

  // Phase 2 mapper additions
  "jsu-jql-condition": jqlCondition,
  "jmwe-field-has-single-value-validator": fieldHasSingleValueValidator,
  "jmwe-copy-issue-fields": copyIssueFieldsFunction,
  "jmwe-generic-user-condition": genericUserCondition,
};

function hasJmweMapper(shortName) {
  return Boolean(JMWE_MAPPERS[shortName]);
}

// === Patch B (2026-05-10): defense-in-depth JSU macro scan =================
// Same intent as the native-side scanner in jsuNativeMappers.js. JMWE rules
// stash most substantive content inside parameters.config (a stringified
// JSON blob), so we scan BOTH the top-level parameters AND every string
// inside the parsed config. A surviving `%%CURRENT_USER%%` etc. would
// silently render as literal text on Cloud — far better to reject and
// surface for manual review.
const _JSU_MACRO_RE = /%%[A-Z0-9_][A-Z0-9_.]+%%/;
function _hasMacroDeep(val) {
  if (val == null) return null;
  if (typeof val === "string") {
    return _JSU_MACRO_RE.test(val) ? val : null;
  }
  if (Array.isArray(val)) {
    for (const v of val) {
      const hit = _hasMacroDeep(v);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof val === "object") {
    for (const v of Object.values(val)) {
      const hit = _hasMacroDeep(v);
      if (hit) return hit;
    }
    return null;
  }
  return null;
}
function _scanForMacrosJmwe(rule, ctx) {
  if (!rule || !rule.parameters) return rule;
  for (const [k, v] of Object.entries(rule.parameters)) {
    if (typeof v !== "string") continue;
    // Try parsing as JSON (config blob); fall back to flat string scan
    let parsed = null;
    if ((k === "config" || k === "value") && v.trim().startsWith("{")) {
      try { parsed = JSON.parse(v); } catch { parsed = null; }
    }
    const hit = parsed ? _hasMacroDeep(parsed) : (_JSU_MACRO_RE.test(v) ? v : null);
    if (hit) {
      if (ctx && ctx.unresolved) {
        ctx.unresolved.add(`macro:jmwe.${k}="${String(hit).length > 80 ? String(hit).slice(0, 77) + "..." : hit}"`);
      }
      return null;
    }
  }
  return rule;
}

function convertToJmwe(shortName, dcConfiguration, ctx) {
  const fn = JMWE_MAPPERS[shortName];
  if (!fn) return null;
  const out = fn(dcConfiguration || {}, ctx || {});
  return _scanForMacrosJmwe(out, ctx);
}

module.exports = { JMWE_MAPPERS, hasJmweMapper, convertToJmwe, conditionalFieldRequiredValidator, _scanForMacrosJmwe };
