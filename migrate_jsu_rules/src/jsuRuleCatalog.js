/**
 * JSU (Jira Suite Utilities) rule catalog.
 *
 * This module is the single source of truth for:
 *   - detecting JSU rules on DC workflows,
 *   - deciding whether each rule type should be converted to a native Cloud rule,
 *     a JMWE Cloud rule, dropped, or flagged for manual review,
 *   - pointing at the per-type mapper function that produces the Cloud shape.
 *
 * Catalog entries ship with a `defaultStrategy` and `confidence`. Operators can
 * override strategy per type via config.json.perRuleOverrides. Rules encountered
 * in the wild that aren't in this catalog are automatically flagged as
 * "manual-review" by the inventory so the catalog can be extended in one place.
 *
 * Schema:
 *   shortName         string  — the short name after the appkey prefix
 *                                (e.g. "fields-required-validator")
 *   ruleCategory      "condition" | "validator" | "postFunction"
 *   defaultStrategy   "native" | "jmwe" | "skip" | "manual-review"
 *   nativeRuleKey     string  — Cloud system:* ruleKey when native mapping exists
 *   jmweModuleKey     string  — JMWE Connect module suffix when JMWE mapping exists
 *   confidence        "high" | "medium" | "low" | "none"
 *   notes             string  — free-form context
 *
 * The actual parameter-shape conversion functions live in
 * jsuNativeMappers.js and jsuJmweMappers.js, keyed by shortName.
 */

const JSU_APP_KEY = "com.googlecode.jira-suite-utilities";
const JSU_TYPE_PREFIX = JSU_APP_KEY + ":";
// On Jira DC, JSU rules are stored as Java class names (no plugin module key).
// All JSU Java classes live under this prefix.
const JSU_DC_CLASS_PREFIX = "com.googlecode.jsu.workflow.";
const JMWE_APP_KEY_DEFAULT = "com.innovalog.jmwe.jira-misc-workflow-extensions";
// JMWE (the same plugin author publishes a separate plugin "Jira Misc
// Workflow Extensions" with its own Java class hierarchy). Many of these have
// 1:1 semantic equivalents to JSU rules and are migrated through the same
// shortNames; the rest get JMWE Connect rules.
const JMWE_DC_CLASS_PREFIX = "com.innovalog.jmwe.plugins.";
// BeeCom Workflow Toolbox (ch.beecom.jira.jsu plugin) — third-party plugin used
// in some workflows. Mapped to JMWE Cloud equivalents on a best-effort basis.
// Verified against the live DC XML exports — full Java class paths live under
// `ch.beecom.jira.jsu.workflow.function.*`.
const BEECOM_DC_CLASS_PREFIX = "ch.beecom.jira.jsu.";

/**
 * Map from Jira DC JSU Java class names → catalog shortNames. Extended as
 * new classes are encountered during --collect.
 * The shortName is the Cloud-style canonical identifier used throughout the
 * pipeline (catalog keys, mapper function keys, conversion plan rows).
 */
const JSU_DC_CLASS_TO_SHORTNAME = {
  // Validators
  "com.googlecode.jsu.workflow.validator.FieldsRequiredValidator": "fields-required-validator",
  "com.googlecode.jsu.workflow.validator.RegexpFieldValidator": "regex-validator",
  "com.googlecode.jsu.workflow.validator.DateCompareValidator": "date-compare-validator",
  "com.googlecode.jsu.workflow.validator.PreviousStatusValidator": "previous-status-validator",
  "com.googlecode.jsu.workflow.validator.UserPermissionValidator": "user-permission-validator",
  "com.googlecode.jsu.workflow.validator.WindowsDateValidator": "windows-date-validator",
  "com.googlecode.jsu.workflow.validator.LoggedInConditionValidator": "logged-in-condition-validator",

  // Conditions
  "com.googlecode.jsu.workflow.condition.ValueFieldCondition": "value-field-condition",
  "com.googlecode.jsu.workflow.condition.SubTaskBlockingCondition": "subtasks-blocking-condition",
  "com.googlecode.jsu.workflow.condition.PreviousStatusCondition": "previous-status-condition",
  "com.googlecode.jsu.workflow.condition.HideFromUserCondition": "hide-from-user-condition",
  "com.googlecode.jsu.workflow.condition.NoOperationCondition": "no-operation-condition",
  "com.googlecode.jsu.workflow.condition.UserIsInAnyRolesCondition": "user-is-in-any-roles-condition",
  "com.googlecode.jsu.workflow.condition.UserIsInCustomFieldCondition": "user-is-in-custom-field-condition",
  "com.googlecode.jsu.workflow.condition.UserIsInAnyGroupsCondition": "user-is-in-any-groups-condition",
  "com.googlecode.jsu.workflow.condition.JqlCondition": "jsu-jql-condition",

  // Post-functions
  "com.googlecode.jsu.workflow.function.ClearFieldValuePostFunction": "clear-field-value",
  "com.googlecode.jsu.workflow.function.AssignToCurrentUserFunction": "assign-to-current-user",
  "com.googlecode.jsu.workflow.function.CopyValueFromOtherFieldPostFunction": "copy-value-from-other-field",
  "com.googlecode.jsu.workflow.function.UpdateIssueCustomFieldPostFunction": "update-issue-field",
  "com.googlecode.jsu.workflow.function.CopyValueFromPreviousStatusPostFunction": "copy-value-from-previous-status",
  "com.googlecode.jsu.workflow.function.SendCustomEmailFunction": "send-custom-email",
  "com.googlecode.jsu.workflow.function.CreateIssueFunction": "create-issue",
  "com.googlecode.jsu.workflow.function.TransitionIssueFunction": "transition-linked-issue",
  "com.googlecode.jsu.workflow.function.SetFieldValueAutomaticallyFunction": "set-field-value-automatically",

  // ─── JMWE plugin classes (alias to JSU shortNames where semantics match) ───
  // Validators
  "com.innovalog.jmwe.plugins.validators.FieldRequiredValidator": "fields-required-validator",
  "com.innovalog.jmwe.plugins.validators.RegexpFieldValidator": "regex-validator",
  "com.innovalog.jmwe.plugins.validators.DateComparisonValidator": "date-compare-validator",
  "com.innovalog.jmwe.plugins.validators.PreviousStatusValidator": "previous-status-validator",
  "com.innovalog.jmwe.plugins.validators.UserPermissionValidator": "user-permission-validator",
  "com.innovalog.jmwe.plugins.validators.CommentRequiredValidator": "jmwe-comment-required-validator",
  "com.innovalog.jmwe.plugins.validators.GroovyValidator": "jmwe-groovy-validator",

  // Conditions
  "com.innovalog.jmwe.plugins.conditions.SubtasksBlockingCondition": "subtasks-blocking-condition",
  "com.innovalog.jmwe.plugins.conditions.PreviousStatusCondition": "previous-status-condition",
  "com.innovalog.jmwe.plugins.conditions.CurrentStatusCondition": "jmwe-current-status-condition",
  "com.innovalog.jmwe.plugins.conditions.GroovyCondition": "jmwe-groovy-condition",
  "com.innovalog.jmwe.plugins.conditions.LinkedIssuesCondition": "jmwe-linked-issues-condition",

  // Post-functions — JMWE has multi-field variants; we route those to
  // dedicated jmwe-* shortNames that emit a JMWE Connect rule (one Cloud rule
  // per DC plan row, regardless of how many fields are in the list).
  "com.innovalog.jmwe.plugins.functions.ClearFieldValueFunction": "jmwe-clear-fields",
  "com.innovalog.jmwe.plugins.functions.SetFieldValueFunction": "jmwe-set-field-value",
  "com.innovalog.jmwe.plugins.functions.setissuefields.SetIssueFieldsFunction": "jmwe-set-field-value",
  "com.innovalog.jmwe.plugins.functions.CopyValueFromOtherFieldPostFunction": "copy-value-from-other-field",
  "com.innovalog.jmwe.plugins.functions.CopyValueFromIssueLinkPostFunction": "jmwe-copy-from-link",
  "com.innovalog.jmwe.plugins.functions.IncreaseFieldValueFunction": "jmwe-increase-field-value",
  "com.innovalog.jmwe.plugins.functions.AssignIssueFunction": "jmwe-assign-issue",
  "com.innovalog.jmwe.plugins.functions.CommentIssueFunction": "jmwe-comment-issue",
  "com.innovalog.jmwe.plugins.functions.EmailIssueFunction": "jmwe-email-issue",
  "com.innovalog.jmwe.plugins.functions.CreateIssueFunction": "create-issue",
  "com.innovalog.jmwe.plugins.functions.TransitionIssueFunction": "jmwe-transition-issue",
  "com.innovalog.jmwe.plugins.functions.TransitionLinkedIssuesFunction": "transition-linked-issue",
  "com.innovalog.jmwe.plugins.functions.GroovyFunction": "jmwe-groovy-function",
  "com.innovalog.jmwe.plugins.functions.CopyFieldValueFromParentFunction": "jmwe-copy-from-parent",
  "com.innovalog.jmwe.plugins.functions.SetFieldFromUserPropFunction": "jmwe-set-field-from-user-prop",
  "com.innovalog.jmwe.plugins.functions.SetIssueSecurityFromRoleFunction": "jmwe-set-issue-security-from-role",
  // JMWE niche validators / conditions seen in the survey
  "com.innovalog.jmwe.plugins.validators.ParentStatusValidator": "jmwe-parent-status-validator",
  "com.innovalog.jmwe.plugins.validators.LinkedIssuesStatusValidator": "jmwe-linked-issues-status-validator",
  "com.innovalog.jmwe.plugins.validators.FieldChangedValidator": "jmwe-field-changed-validator",
  "com.innovalog.jmwe.plugins.validators.GenericUserValidator": "jmwe-generic-user-validator",
  "com.innovalog.jmwe.plugins.validators.FieldHasSingleValueValidator": "jmwe-field-has-single-value-validator",
  "com.innovalog.jmwe.plugins.conditions.NonInteractiveCondition": "jmwe-non-interactive-condition",
  "com.innovalog.jmwe.plugins.conditions.LinkedIssuesStatusCondition": "jmwe-linked-issues-status-condition",
  "com.innovalog.jmwe.plugins.conditions.GenericUserCondition": "jmwe-generic-user-condition",
  "com.innovalog.jmwe.plugins.functions.CopyIssueFieldsFunction": "jmwe-copy-issue-fields",
  // ch.beecom plugin (BeeCom JSU Workflow Toolbox). Verified against the DC
  // XML exports — the live class names live under `ch.beecom.jira.jsu.*`,
  // NOT `com.beecom.jira.workflows.*` as earlier comments implied.
  "ch.beecom.jira.jsu.workflow.function.linkedtransition.LinkedTransitionFunction": "beecom-linked-transition-function",
  "ch.beecom.jira.jsu.workflow.function.createlinkedissue.CreateLinkedIssueFunction": "beecom-create-linked-issue-function",
  "ch.beecom.jira.jsu.workflow.function.valuefield.ValueFieldPreconditionFunction": "beecom-value-field-precondition-function",
  "ch.beecom.jira.jsu.workflow.condition.userisinanyusers.UserIsInAnyUsersCondition": "beecom-user-is-in-any-users-condition",
};

const CATALOG = {
  // ──────────────────────────────────────────────
  //  Validators
  // ──────────────────────────────────────────────
  "fields-required-validator": {
    shortName: "fields-required-validator",
    ruleCategory: "validator",
    defaultStrategy: "native",
    nativeRuleKey: "system:validate-field-value",
    confidence: "high",
    notes: "Maps to system:validate-field-value with ruleType=fieldRequired. Verified against Atlassian docs.",
  },
  "regex-validator": {
    shortName: "regex-validator",
    ruleCategory: "validator",
    defaultStrategy: "native",
    nativeRuleKey: "system:validate-field-value",
    jmweModuleKey: "RegexpFieldValidator",
    confidence: "medium",
    notes: "Native ruleType=fieldMatches if supported on target; fallback to JMWE RegexpFieldValidator.",
  },
  "date-compare-validator": {
    shortName: "date-compare-validator",
    ruleCategory: "validator",
    defaultStrategy: "jmwe",
    nativeRuleKey: "system:validate-field-value",
    jmweModuleKey: "DateComparisonValidator",
    confidence: "medium",
    notes: "Native dateFieldComparison ruleType exists but exposes only a subset of JSU's compare options; JMWE is safer.",
  },
  "previous-status-validator": {
    shortName: "previous-status-validator",
    ruleCategory: "validator",
    defaultStrategy: "native",
    nativeRuleKey: "system:previous-status-validator",
    jmweModuleKey: "PreviousStatusValidator",
    confidence: "high",
    notes:
      "JSU PreviousStatusValidator → Cloud system:previous-status-validator. " +
      "Parameters: previousStatusIds (CSV of Cloud status IDs) + " +
      "mostRecentStatusOnly ('true'/'false'). DC arg names: 'jira.previousstatus' " +
      "OR 'previousStatuses' (CSV). Verified against Atlassian REST docs.",
  },
  "user-permission-validator": {
    shortName: "user-permission-validator",
    ruleCategory: "validator",
    defaultStrategy: "native",
    nativeRuleKey: "system:check-permission-validator",
    confidence: "high",
    notes: "Direct match to PermissionValidator.",
  },
  "windows-date-validator": {
    shortName: "windows-date-validator",
    ruleCategory: "validator",
    defaultStrategy: "jmwe",
    jmweModuleKey: "DateComparisonValidator",
    confidence: "low",
    notes: "JSU's 'windows of time' date validator has no native Cloud equivalent; closest is JMWE DateComparisonValidator with relative date config.",
  },
  "logged-in-condition-validator": {
    shortName: "logged-in-condition-validator",
    ruleCategory: "validator",
    defaultStrategy: "manual-review",
    confidence: "none",
    notes: "Asserts the executing user is logged in — Cloud transitions implicitly require auth, so this is usually redundant. Flagged for human decision.",
  },

  // ──────────────────────────────────────────────
  //  Conditions
  // ──────────────────────────────────────────────
  "value-field-condition": {
    shortName: "value-field-condition",
    ruleCategory: "condition",
    defaultStrategy: "native",
    nativeRuleKey: "system:check-field-value",
    confidence: "high",
    notes:
      "ValueFieldCondition → system:check-field-value. JSU comparator codes 1-6 map exactly to Cloud's >, >=, =, <=, <, != . " +
      "JSU comparisonType codes 1-5 map to STRING, NUMBER, DATE, DATE_WITHOUT_TIME, OPTIONID. " +
      "Cloud restricts STRING/OPTIONID to = / != only — exotic comparators are demoted to = / != on those types " +
      "(see jsuNativeMappers.valueFieldCondition).",
  },
  "subtasks-blocking-condition": {
    shortName: "subtasks-blocking-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "SubtasksBlockingCondition",
    confidence: "medium",
    notes: "Blocks transition if subtasks aren't in specified statuses; JMWE has a direct equivalent.",
  },
  "previous-status-condition": {
    shortName: "previous-status-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "PreviousStatusCondition",
    confidence: "medium",
    notes: "JMWE equivalent exists with similar parameter shape.",
  },
  "hide-from-user-condition": {
    shortName: "hide-from-user-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "HideFromUserCondition",
    confidence: "low",
    notes: "UI-gating condition; behaviour of JMWE equivalent needs verification.",
  },
  "no-operation-condition": {
    shortName: "no-operation-condition",
    ruleCategory: "condition",
    defaultStrategy: "skip",
    confidence: "high",
    notes: "No-op condition — safe to drop.",
  },

  // ──────────────────────────────────────────────
  //  Post-functions
  // ──────────────────────────────────────────────
  "clear-field-value": {
    shortName: "clear-field-value",
    ruleCategory: "postFunction",
    defaultStrategy: "native",
    nativeRuleKey: "system:update-field",
    confidence: "high",
    notes: "Cloud has no dedicated clear-field rule; emulated via system:update-field with empty value (verified via Cloud capabilities).",
  },
  "assign-to-current-user": {
    shortName: "assign-to-current-user",
    ruleCategory: "postFunction",
    defaultStrategy: "native",
    nativeRuleKey: "system:change-assignee",
    confidence: "high",
    notes: "Maps to system:change-assignee with type=to-current-user (verified from Cloud sample).",
  },
  "copy-value-from-other-field": {
    shortName: "copy-value-from-other-field",
    ruleCategory: "postFunction",
    defaultStrategy: "native",
    nativeRuleKey: "system:copy-value-from-other-field",
    jmweModuleKey: "CopyFieldValuePostFunction",
    confidence: "medium",
    notes: "Native ruleKey exists but param names are unverified; JMWE fallback available.",
  },
  "update-issue-field": {
    shortName: "update-issue-field",
    ruleCategory: "postFunction",
    defaultStrategy: "native",
    nativeRuleKey: "system:update-field",
    jmweModuleKey: "SetFieldValueFunction",
    confidence: "high",
    notes: "Cloud ruleKey is system:update-field (NOT update-issue-field); params are field, value, mode. Verified from Cloud sample.",
  },
  "copy-value-from-previous-status": {
    shortName: "copy-value-from-previous-status",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "CopyValueFromPreviousStatusFunction",
    confidence: "medium",
    notes: "No known native equivalent.",
  },
  "send-custom-email": {
    shortName: "send-custom-email",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "SendEmailFunction",
    confidence: "medium",
    notes: "No native Cloud equivalent. JMWE SendEmailFunction value schema needs --validate-only verification.",
  },
  "create-issue": {
    shortName: "create-issue",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "CreateIssueFunction",
    confidence: "medium",
    notes: "JMWE CreateIssueFunction. Issue-type IDs must be remapped via idRemapping.issueTypes.",
  },
  "transition-linked-issue": {
    shortName: "transition-linked-issue",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "TransitionLinkedIssueFunction",
    confidence: "low",
    notes: "Link type ID and target transition name must be remapped.",
  },
  "set-field-value-automatically": {
    shortName: "set-field-value-automatically",
    ruleCategory: "postFunction",
    defaultStrategy: "manual-review",
    confidence: "none",
    notes: "JSU has a very broad auto-setter. Coverage in JMWE is uneven — safer to force human review per instance.",
  },

  // ─── JMWE-only modules (no JSU equivalent; emit JMWE Connect rule) ───
  "jmwe-clear-fields": {
    shortName: "jmwe-clear-fields",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "ClearFieldsFunction",
    confidence: "high",
    notes: "JMWE multi-field clear (DC arg `fields`, comma-separated). Emits a single connect:remote-workflow-function rule.",
  },
  "jmwe-set-field-value": {
    shortName: "jmwe-set-field-value",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "SetFieldValueFunction",
    confidence: "medium",
    notes: "JMWE Set Field Value (single + multi-field). Groovy `valueType` configurations pass through under _unmappedJsuConfiguration for human review.",
  },
  "jmwe-copy-from-link": {
    shortName: "jmwe-copy-from-link",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "CopyValueFromIssueLinkPostFunction",
    confidence: "low",
    notes: "JMWE Insight/Issue-link copy — link type and source/target field IDs must be remapped.",
  },
  "jmwe-increase-field-value": {
    shortName: "jmwe-increase-field-value",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "IncreaseFieldValueFunction",
    confidence: "high",
    notes: "JMWE numeric increment. Maps target fieldId only.",
  },
  "jmwe-assign-issue": {
    shortName: "jmwe-assign-issue",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "AssignIssueFunction",
    confidence: "medium",
    notes: "JMWE Assign Issue. User identifier translation between DC and Cloud is on the operator.",
  },
  "jmwe-comment-issue": {
    shortName: "jmwe-comment-issue",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "CommentIssueFunction",
    confidence: "medium",
    notes: "JMWE Comment Issue with templating. Groovy templates pass through; restricted to internal flag preserved.",
  },
  "jmwe-email-issue": {
    shortName: "jmwe-email-issue",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "EmailIssueFunction",
    confidence: "medium",
    notes: "JMWE Email Issue with full configuration. Recipient field IDs and Groovy templates pass through.",
  },
  "jmwe-transition-issue": {
    shortName: "jmwe-transition-issue",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "TransitionIssueFunction",
    confidence: "low",
    notes: "JMWE TransitionIssue (current issue). Target transition name is operator-verified.",
  },
  "jmwe-groovy-function": {
    shortName: "jmwe-groovy-function",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "ScriptedPostFunction",
    confidence: "low",
    notes: "JMWE Groovy Post Function. Script body passes through as-is — Groovy semantic differences between DC and Cloud are an operator review item.",
  },
  "jmwe-current-status-condition": {
    shortName: "jmwe-current-status-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "CurrentStatusCondition",
    confidence: "medium",
    notes: "JMWE Current Status Condition.",
  },
  "jmwe-groovy-condition": {
    shortName: "jmwe-groovy-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "ScriptedCondition",
    confidence: "low",
    notes: "JMWE Groovy condition. Script body passes through.",
  },
  "jmwe-linked-issues-condition": {
    shortName: "jmwe-linked-issues-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "LinkedIssuesCondition",
    confidence: "low",
    notes: "JMWE Linked Issues Condition.",
  },
  "jmwe-comment-required-validator": {
    shortName: "jmwe-comment-required-validator",
    ruleCategory: "validator",
    defaultStrategy: "native",
    nativeRuleKey: "system:validate-field-value",
    confidence: "high",
    notes: "JMWE Comment Required validator. Maps to Cloud's native fieldChanged validator on the comment field.",
  },
  "jmwe-groovy-validator": {
    shortName: "jmwe-groovy-validator",
    ruleCategory: "validator",
    defaultStrategy: "jmwe",
    jmweModuleKey: "ScriptedValidator",
    confidence: "medium",
    notes: "JMWE Groovy validator. Script and error message pass through.",
  },

  // ─── JSU edge-case + JMWE niche conditions/validators (translate-everything pass) ───
  "user-is-in-any-roles-condition": {
    shortName: "user-is-in-any-roles-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "ScriptedCondition",
    confidence: "high",
    notes:
      "JSU UserIsInAnyRolesCondition → JMWE ScriptedCondition. Jira Expression " +
      "uses user.getProjectRoles(issue.project) — a documented method on the User " +
      "type returning List<ProjectRole {id, name, description}>. Earlier mapper " +
      "emitted user.roles (does not exist on User type) producing always-false " +
      "expressions silently rejected by Cloud's validator.",
  },
  "user-is-in-custom-field-condition": {
    shortName: "user-is-in-custom-field-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "ScriptedCondition",
    confidence: "medium",
    notes:
      "JSU UserIsInCustomFieldCondition → JMWE ScriptedCondition. Jira Expression " +
      "uses bracket access (issue[\"customfield_NNN\"]) since field IDs aren't " +
      "valid identifier names. Verified: User type has accountId for comparison.",
  },
  "user-is-in-any-groups-condition": {
    shortName: "user-is-in-any-groups-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "ScriptedCondition",
    confidence: "high",
    notes:
      "JSU UserIsInAnyGroupsCondition → JMWE ScriptedCondition. Jira Expression " +
      "uses user.groups: List<String> of group names — a documented User-type property. " +
      "Some(name in user.groups) ↔ DC's 'user is in any of these groups' semantics.",
  },
  "jmwe-non-interactive-condition": {
    shortName: "jmwe-non-interactive-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "NonInteractiveCondition",
    confidence: "low",
    notes: "JMWE NonInteractiveCondition has no native Cloud equivalent — review on Cloud.",
  },
  "jmwe-linked-issues-status-condition": {
    shortName: "jmwe-linked-issues-status-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "LinkedIssuesCondition",
    confidence: "medium",
    notes: "JMWE LinkedIssuesStatusCondition. Link types and status IDs need Cloud verification.",
  },
  "jmwe-parent-status-validator": {
    shortName: "jmwe-parent-status-validator",
    ruleCategory: "validator",
    defaultStrategy: "native",
    nativeRuleKey: "system:parent-or-child-blocking-validator",
    jmweModuleKey: "ParentStatusValidator",
    confidence: "high",
    notes:
      "JMWE ParentStatusValidator → Cloud system:parent-or-child-blocking-validator with " +
      "blocker=PARENT. DC arg `jira.parentstatuses` carries status NAMES (\"@@\"-separated); " +
      "they're resolved via the DC status catalog → Cloud IDs by name match. " +
      "Verified against live Cloud sample (CHG_ Change_Task workflow).",
  },
  "jmwe-linked-issues-status-validator": {
    shortName: "jmwe-linked-issues-status-validator",
    ruleCategory: "validator",
    defaultStrategy: "jmwe",
    jmweModuleKey: "LinkedIssueStatusValidator",
    confidence: "medium",
    notes: "JMWE LinkedIssuesStatusValidator. Link types and status IDs need Cloud verification.",
  },
  "jmwe-field-changed-validator": {
    shortName: "jmwe-field-changed-validator",
    ruleCategory: "validator",
    defaultStrategy: "jmwe",
    jmweModuleKey: "FieldChangedValidator",
    confidence: "medium",
    notes: "JMWE FieldChangedValidator expressed as Jira Expression over issue.changelog.",
  },
  "jmwe-generic-user-validator": {
    shortName: "jmwe-generic-user-validator",
    ruleCategory: "validator",
    defaultStrategy: "jmwe",
    jmweModuleKey: "GenericUserValidator",
    confidence: "low",
    notes: "JMWE GenericUserValidator. Cloud has no equivalent — review.",
  },
  "jmwe-copy-from-parent": {
    shortName: "jmwe-copy-from-parent",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "CopyMultipleFieldsFunction",
    confidence: "medium",
    notes: "JMWE CopyFieldValueFromParentFunction → CopyMultipleFieldsFunction with sourceIssues=parentIssue:*.",
  },
  "jmwe-set-field-from-user-prop": {
    shortName: "jmwe-set-field-from-user-prop",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "ScriptedPostFunction",
    confidence: "low",
    notes: "JMWE SetFieldFromUserPropFunction has no Cloud equivalent — emitted as Scripted Post Function for review.",
  },
  "jmwe-set-issue-security-from-role": {
    shortName: "jmwe-set-issue-security-from-role",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "ScriptedPostFunction",
    confidence: "low",
    notes: "JMWE SetIssueSecurityFromRoleFunction emitted as Scripted Post Function for review.",
  },

  // ─── ch.beecom (BeeCom Workflow Toolbox) ───
  "beecom-linked-transition-function": {
    shortName: "beecom-linked-transition-function",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "TransitionIssueFunction",
    confidence: "low",
    notes: "BeeCom LinkedTransitionFunction → JMWE TransitionIssueFunction targeting linked issues.",
  },
  "beecom-create-linked-issue-function": {
    shortName: "beecom-create-linked-issue-function",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "CreateIssueFunction",
    confidence: "low",
    notes: "BeeCom CreateLinkedIssueFunction → JMWE CreateIssueFunction with link config.",
  },
  "beecom-value-field-precondition-function": {
    shortName: "beecom-value-field-precondition-function",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "ScriptedPostFunction",
    confidence: "low",
    notes: "BeeCom ValueFieldPreconditionFunction has no direct Cloud equivalent — emitted as Scripted Post Function for review.",
  },
  "beecom-user-is-in-any-users-condition": {
    shortName: "beecom-user-is-in-any-users-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "ScriptedCondition",
    confidence: "medium",
    notes:
      "BeeCom UserIsInAnyUsersCondition restricts transition to a list of specific users. " +
      "Mapped to a JMWE ScriptedCondition whose Jira Expression compares user.accountId " +
      "against an inline list. DC config carries DC usernames/userKeys — these need " +
      "operator hand-replacement with Cloud accountIds (see /rest/api/3/user/search by " +
      "displayName/email). Native system:restrict-issue-transition is the ideal target " +
      "but requires offline username → accountId resolution we don't have at emit time.",
  },

  // ─── Phase 2 catalog additions (unknown shortNames surfaced by collect against
  //     the SM/HR/IT workflow corpus on jira-dc.example.com 2026-05). ───
  "jsu-jql-condition": {
    shortName: "jsu-jql-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "JqlCondition",
    confidence: "medium",
    notes:
      "JSU JqlCondition: transition is allowed only if the current issue satisfies a JQL " +
      "query. JMWE Cloud has a JqlCondition module that takes a JQL string. The DC config " +
      "carries the JQL in `jqlquery` (or similar) arg; needs field-name → cloud-field-name " +
      "translation since JQL references custom fields by name (with cf prefix syntax) on " +
      "Cloud. Cloud-native alternative would be a ScriptedCondition emitting a Jira " +
      "Expression equivalent, but Jira Expressions doesn't have a JQL evaluator — JMWE is " +
      "the only practical migration target.",
  },
  "jmwe-field-has-single-value-validator": {
    shortName: "jmwe-field-has-single-value-validator",
    ruleCategory: "validator",
    defaultStrategy: "jmwe",
    jmweModuleKey: "FieldHasSingleValueValidator",
    confidence: "medium",
    notes:
      "JMWE FieldHasSingleValueValidator: enforces that a multi-value field (e.g. " +
      "components, labels, version[]) has exactly one selected value at transition time. " +
      "Direct JMWE Cloud equivalent module exists; config carries the field ID which goes " +
      "through customfield remapping. Native alternative would be a custom Jira Expression " +
      "via system:validate-field-value (ruleType=expression) but the JMWE module is the " +
      "operator-friendly migration target.",
  },
  "jmwe-copy-issue-fields": {
    shortName: "jmwe-copy-issue-fields",
    ruleCategory: "postFunction",
    defaultStrategy: "jmwe",
    jmweModuleKey: "CopyIssueFieldsFunction",
    confidence: "medium",
    notes:
      "JMWE CopyIssueFieldsFunction: bulk-copies multiple fields from one issue to another " +
      "(typically current → linked, or current → parent). Has a direct JMWE Cloud module. " +
      "Config carries fieldsConfig[] (sourceFieldId, targetFieldId), targetIssue selector, " +
      "and conditionalExecutionScript. Field IDs on both sides need DC→Cloud remapping.",
  },
  "jmwe-generic-user-condition": {
    shortName: "jmwe-generic-user-condition",
    ruleCategory: "condition",
    defaultStrategy: "jmwe",
    jmweModuleKey: "ScriptedCondition",
    confidence: "low",
    notes:
      "JMWE GenericUserCondition: configurable check on the current user (combinations of " +
      "roles/groups/permissions). No 1:1 Cloud module — best mapped to ScriptedCondition " +
      "with a Jira Expression composing the same predicates from the documented User type " +
      "surface: user.getProjectRoles(issue.project), user.groups (List<String>), " +
      "user.groupIds (List<String>), user.permissions. Note: User.applicationRoles is NOT " +
      "exposed in Jira Expressions (verified against Atlassian's type reference 2026-05); " +
      "use groups/roles instead. Complex configs may need operator review.",
  },
};

function isJsuRule(typeString) {
  if (typeof typeString !== "string") return false;
  // Cloud-style plugin module key (forward-port), DC-style JSU Java class name,
  // JMWE-plugin Java class name, OR BeeCom-plugin Java class name. We
  // catalogue all three so the inventory captures every workflow rule the
  // mapper pipeline knows how to translate.
  return (
    typeString.startsWith(JSU_TYPE_PREFIX) ||
    typeString.startsWith(JSU_DC_CLASS_PREFIX) ||
    typeString.startsWith(JMWE_DC_CLASS_PREFIX) ||
    typeString.startsWith(BEECOM_DC_CLASS_PREFIX)
  );
}

function getJsuShortName(typeString) {
  if (!isJsuRule(typeString)) return null;
  if (typeString.startsWith(JSU_TYPE_PREFIX)) {
    return typeString.slice(JSU_TYPE_PREFIX.length);
  }
  // DC Java class — look up in the class → shortName map
  const mapped = JSU_DC_CLASS_TO_SHORTNAME[typeString];
  if (mapped) return mapped;
  // Unknown DC class — derive a stable synthetic shortName from the class's
  // tail so unknown rules still surface in stats.unknownShortNames and get
  // flagged as manual-review. The applier won't find a mapper and will
  // correctly route them to unmapped_rules.json.
  if (typeString.startsWith(JSU_DC_CLASS_PREFIX)) {
    return "dc-class:" + typeString.slice(JSU_DC_CLASS_PREFIX.length);
  }
  if (typeString.startsWith(JMWE_DC_CLASS_PREFIX)) {
    return "jmwe-class:" + typeString.slice(JMWE_DC_CLASS_PREFIX.length);
  }
  if (typeString.startsWith(BEECOM_DC_CLASS_PREFIX)) {
    return "beecom-class:" + typeString.slice(BEECOM_DC_CLASS_PREFIX.length);
  }
  return null;
}

function getSpec(typeString, { perRuleOverrides = {} } = {}) {
  const shortName = getJsuShortName(typeString);
  if (!shortName) return null;

  const baseEntry = CATALOG[shortName] || {
    shortName,
    ruleCategory: "unknown",
    defaultStrategy: "manual-review",
    confidence: "none",
    notes: "Unknown JSU rule type — not in seeded catalog. Extend src/jsuRuleCatalog.js.",
  };

  const override = perRuleOverrides[shortName];
  const resolvedStrategy = override || baseEntry.defaultStrategy;

  return {
    ...baseEntry,
    resolvedStrategy,
    isOverridden: Boolean(override),
  };
}

function allSpecs() {
  return Object.values(CATALOG);
}

module.exports = {
  JSU_APP_KEY,
  JSU_TYPE_PREFIX,
  JSU_DC_CLASS_PREFIX,
  JMWE_DC_CLASS_PREFIX,
  JSU_DC_CLASS_TO_SHORTNAME,
  JMWE_APP_KEY_DEFAULT,
  CATALOG,
  isJsuRule,
  getJsuShortName,
  getSpec,
  allSpecs,
};
