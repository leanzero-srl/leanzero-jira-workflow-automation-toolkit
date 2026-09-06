/**
 * JSU → Cloud NATIVE rule converters.
 *
 * Each converter receives the DC `configuration` object and a `ctx` that carries
 * per-run state:
 *   ctx.fieldRemapping   map of sourceFieldId -> targetFieldId (customfield_NNN)
 *   ctx.idRemapping      bucketed source->target ID map (statuses, roles, etc.)
 *   ctx.warnings         array to append non-fatal warnings to
 *   ctx.ruleId           precomputed UUID for this rule instance
 *
 * The returned object has shape:
 *   { ruleKey: "system:...", parameters: { ...all string values } }
 *
 * Per Cloud's /workflows/update API, `parameters` values must be strings — any
 * number/boolean is stringified by stringifyParams() at the boundary.
 *
 * Every mapper is best-effort on first pass — the expectation is that
 * --validate-only runs against a real target will surface Atlassian's authoritative
 * parameter names, and mappers get refined based on the structured error responses.
 */

const { stringifyParams, uuidv4 } = require("./utils");

// === Patch G (2026-05-10): JSU runtime macro → JMWE Nunjucks template ======
// JSU on DC substitutes a small set of macros at execution time:
//   %%CURRENT_USER%%, %%ADD_CURRENT_USER%%, %%CURRENT_DATETIME%%
// Native system:update-field has no templated-value support, so the older
// code path returned null and forced manual operator review (the workbook's
// "JSU Macros" sheet). Empirical scan of a production tenant (2026-05-10) showed
// EVERY occurrence (610 rules) used exactly these 3 macros, with field
// types that map cleanly to Nunjucks:
//   • %%CURRENT_USER%% / %%ADD_CURRENT_USER%% always target a userpicker
//     customfield → emit `{{ user.accountId }}` (Cloud user-picker accepts
//     accountId as the canonical user reference).
//   • %%CURRENT_DATETIME%% always targets a datetime customfield → emit
//     `{{ now }}` (JMWE Nunjucks renders this to the current ISO datetime).
//
// We therefore wrap the translation as a JMWE
// connect:remote-workflow-function/SetFieldValueFunction, mirroring the
// shape produced by jsuJmweMappers.js setFieldValueFunction. Inline emit
// (rather than lazy-require) keeps the dependency graph clean.
//
// %%ADD_CURRENT_USER%% is the multi-user-picker "append current user" form;
// 3 occurrences in a production tenant (a large IT Service Desk workflow). We
// emit the same SetFieldValueFunction body but tag the config with
// `_operatorNote` so reviewers know to verify append vs replace semantics
// (JMWE Cloud's behaviour for setting a single accountId on a multi-user
// field is field-specific). Operators have ≤3 to review by hand.
const _MACRO_TO_NUNJUCKS = Object.freeze({
  "%%CURRENT_USER%%": "{{ user.accountId }}",
  "%%ADD_CURRENT_USER%%": "{{ user.accountId }}",
  "%%CURRENT_DATETIME%%": "{{ now }}",
});
function _emitMacroAsJmweSetFieldValue(field, valueStr, ctx) {
  const trimmed = String(valueStr || "").trim();
  if (!Object.prototype.hasOwnProperty.call(_MACRO_TO_NUNJUCKS, trimmed)) {
    return null; // not a known auto-translatable macro
  }
  const nunjucks = _MACRO_TO_NUNJUCKS[trimmed];
  const jmweAppKey =
    (ctx && ctx.jmweAppKey) ||
    "com.innovalog.jmwe.jira-misc-workflow-extensions";
  const config = {
    conditionalExecution: false,
    conditionalExecutionScript: "",
    fieldsConfig: [{ fieldId: field, options: {}, value: nunjucks }],
    runAsType: "currentUser",
    targetIssue: "currentIssue:*",
  };
  if (trimmed === "%%ADD_CURRENT_USER%%") {
    // Note phrased without literal `%%MACRO%%` strings so the Patch B macro
    // defense-in-depth scanner doesn't reject this rule on output.
    config._operatorNote =
      "Patch-G auto-translation of JSU ADD_CURRENT_USER macro — multi-user " +
      "picker append semantics may need manual verification (this rule sets " +
      "the field to the current user's accountId; if the original DC rule " +
      "appended rather than replaced, adjust in JMWE config UI).";
  }
  return {
    ruleKey: "connect:remote-workflow-function",
    parameters: stringifyParams({
      appKey: jmweAppKey + "__SetFieldValueFunction",
      config: JSON.stringify(config),
      id: (ctx && ctx.ruleId) || uuidv4(),
      disabled: "false",
      // Match CMA's convention so re-runs treat our writes as canonical and
      // dedup stays clean.
      tag: "migration-success",
    }),
  };
}

/**
 * Translate a DC field ID to its Cloud counterpart.
 *   - System fields (e.g. "summary", "status", "assignee") pass through unchanged.
 *   - Custom fields ("customfield_NNN") are looked up in ctx.fieldRemapping
 *     (which is the {dcId: cloudId} map produced by FieldMapper).
 *   - If the customfield is in the map but maps to null, returns null —
 *     signalling "unresolvable" so the caller can skip the rule.
 *   - If the customfield is absent from the map entirely (no DC catalog),
 *     passes through with a warning recorded to ctx.unresolved.
 */
function remapField(fieldId, ctx) {
  if (fieldId == null || fieldId === "") return fieldId;
  const id = String(fieldId);
  if (!id.startsWith("customfield_")) return id; // system field — same on both sides
  const map = ctx && ctx.fieldRemapping;
  if (!map) {
    if (ctx && ctx.unresolved) ctx.unresolved.add(id);
    return id;
  }
  if (Object.prototype.hasOwnProperty.call(map, id)) {
    const cloudId = map[id];
    if (cloudId == null) {
      if (ctx.unresolved) ctx.unresolved.add(id);
      return null;
    }
    return cloudId;
  }
  // Not in the catalog at all (e.g. a field referenced in a config that
  // wasn't seen during --collect). Pass through, but record.
  if (ctx.unresolved) ctx.unresolved.add(id);
  return id;
}

function remapFieldList(value, ctx) {
  // JSU DC stores field lists as "id1@@id2@@id3@@" (double-@ with optional trailing @@).
  // Cloud accepts them as comma-separated single strings.
  let raw = [];
  if (Array.isArray(value)) raw = value.map(String);
  else if (typeof value === "string") {
    const splitter = value.includes("@@") ? /@@/ : /,/;
    raw = value.split(splitter).map((f) => f.trim()).filter(Boolean);
  } else {
    return [];
  }
  // Drop null (unresolvable) entries; downstream will get the resolved survivors.
  return raw.map((id) => remapField(id, ctx)).filter((id) => id != null && id !== "");
}

/**
 * Translate a DC status ID (numeric, e.g. "5") to its Cloud counterpart by
 * name-match. Mirrors `remapField` semantics: pass-through with a warning if
 * we have no DC catalog at all, return null when the mapping exists but
 * resolves to null (DC status that has no name-matched Cloud status).
 *
 * Used by post-`previous-status-validator` and by any rule whose JSU config
 * carries Jira status IDs that must end up in a Cloud system:* rule's
 * parameters.
 */
function remapStatusId(statusId, ctx) {
  if (statusId == null || statusId === "") return statusId;
  const id = String(statusId);
  const map = (ctx && ctx.statusRemapping) || null;
  if (!map) {
    if (ctx && ctx.unresolved) ctx.unresolved.add(`status:${id}`);
    return id;
  }
  if (Object.prototype.hasOwnProperty.call(map, id)) {
    const cloudId = map[id];
    if (cloudId == null) {
      if (ctx.unresolved) ctx.unresolved.add(`status:${id}`);
      return null;
    }
    return cloudId;
  }
  if (ctx.unresolved) ctx.unresolved.add(`status:${id}`);
  return id;
}

function remapStatusList(value, ctx) {
  // JSU PreviousStatusValidator carries CSV; older shapes carry "@@" lists.
  let raw = [];
  if (Array.isArray(value)) raw = value.map(String);
  else if (typeof value === "string") {
    raw = value
      .split(/[,@]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    return [];
  }
  return raw.map((id) => remapStatusId(id, ctx)).filter((id) => id != null && id !== "");
}

/**
 * Resolve a status NAME (e.g. "Implementation") to its Cloud status ID by
 * scanning ctx.statusRemapping (a {dcId: cloudId} map) plus
 * ctx.dcStatusCatalog (a {dcId: dcName} map). Some DC plugin variants
 * (notably JMWE's ParentStatusValidator) persist status NAMES rather than
 * IDs; this helper bridges name → DC ID → Cloud ID.
 *
 * Returns null when no Cloud status with a matching name exists. Records
 * unresolved entries to ctx.unresolved with `status:` prefix.
 */
function remapStatusByName(name, ctx) {
  if (!name) return null;
  const trimmed = String(name).trim();
  if (!trimmed) return null;
  const dcCatalog = (ctx && ctx.dcStatusCatalog) || null;
  const map = (ctx && ctx.statusRemapping) || null;
  if (!dcCatalog || !map) {
    if (ctx && ctx.unresolved) ctx.unresolved.add(`statusName:${trimmed}`);
    return null;
  }
  const lower = trimmed.toLowerCase();
  for (const [dcId, dcName] of Object.entries(dcCatalog)) {
    if (!dcName) continue;
    if (String(dcName).trim().toLowerCase() === lower) {
      const cloudId = map[dcId];
      if (cloudId) return cloudId;
      if (ctx && ctx.unresolved) ctx.unresolved.add(`statusName:${trimmed}`);
      return null;
    }
  }
  if (ctx && ctx.unresolved) ctx.unresolved.add(`statusName:${trimmed}`);
  return null;
}

function remapStatusNameOrIdList(value, ctx) {
  // JMWE ParentStatusValidator persists status NAMES in `jira.parentstatuses`
  // separated by `@@`. JSU rule variants may persist IDs. Try ID-first; if
  // an entry doesn't look like a numeric ID, fall back to name resolution.
  let raw = [];
  if (Array.isArray(value)) raw = value.map(String);
  else if (typeof value === "string") {
    raw = value.split(/@@|,/).map((s) => s.trim()).filter(Boolean);
  } else {
    return [];
  }
  return raw
    .map((entry) => {
      if (/^\d+$/.test(entry)) return remapStatusId(entry, ctx);
      return remapStatusByName(entry, ctx);
    })
    .filter((id) => id != null && id !== "");
}

// ──────────────────────────────────────────────
//  Validators
// ──────────────────────────────────────────────

function fieldsRequiredValidator(cfg, ctx) {
  // DC arg names vary across plugin variants:
  //   JSU FieldsRequiredValidator (plural): `hidFieldsList` ("a@@b@@c@@")
  //   JMWE FieldRequiredValidator  (singular): `fieldKey` ("a,b,c")
  //   JMWE legacy:                              `fields` / `fieldIds` / `fieldsList`
  // Cloud native accepts `fieldsRequired` (comma-separated) on
  // `system:validate-field-value` with `ruleType: "fieldRequired"`.
  const rawFields =
    cfg.hidFieldsList ||
    cfg.fieldKey ||
    cfg.fields ||
    cfg.fieldIds ||
    cfg.fieldsList ||
    [];
  const fieldIds = remapFieldList(rawFields, ctx);
  if (fieldIds.length === 0) return null; // every referenced field unresolved → no rule to apply

  // JMWE FieldRequiredValidator can carry a `conditionalValidation: yes` flag
  // and a `conditionalValidationScript` that gates whether the validator fires.
  // Cloud's native `system:validate-field-value` has no equivalent gate, so a
  // lossy native mapping would make the validator unconditional — which is
  // exactly what triggered the "validator fires for non-BUILD projects too"
  // bug. When a non-trivial gate is present we re-route to a JMWE Cloud
  // ScriptedValidator whose Jira Expression expresses both the gate and the
  // field-required check inline.
  const isConditional = (cfg.conditionalValidation === "yes" || cfg.conditionalValidation === true)
    && typeof cfg.conditionalValidationScript === "string"
    && cfg.conditionalValidationScript.trim();
  if (isConditional) {
    // Lazy require to avoid a circular import (JMWE mappers depend on this file).
    const { conditionalFieldRequiredValidator } = require("./jsuJmweMappers");
    return conditionalFieldRequiredValidator(cfg, ctx, fieldIds);
  }
  // === Patch A (2026-05-10): sort + dedup so two re-runs with the same
  // fields in different orders produce identical fingerprints. Previously
  // `customfield_10001,customfield_10002` and `customfield_10002,customfield_10001`
  // hashed to different fingerprints, so a re-apply against a Cloud workflow
  // that already had the rule would append a duplicate. Canonical CSV =
  // sorted unique IDs joined by ",". ===
  const canonicalFieldsRequired = [...new Set(fieldIds)].sort().join(",");
  // === Patch B (2026-05-10): if the operator-provided errorMessage embeds a
  // JSU runtime macro (`%%CURRENT_USER%%` etc.) we'd persist the literal
  // four-character sequence on Cloud — silently broken end-user UX. Refuse
  // the rule and tag for manual review. Same approach updateIssueField
  // already takes for non-assignee field VALUES carrying macros. ===
  const errMsg = cfg.errorMessage || "";
  if (typeof errMsg === "string" && errMsg.includes("%%")) {
    if (ctx && ctx.unresolved) ctx.unresolved.add(`macro:errorMessage="${errMsg}"`);
    return null;
  }
  return {
    ruleKey: "system:validate-field-value",
    parameters: stringifyParams({
      ruleType: "fieldRequired",
      fieldsRequired: canonicalFieldsRequired,
      ignoreContext: cfg.ignoreContext || false,
      errorMessage: errMsg,
    }),
  };
}

function regexValidator(cfg, ctx) {
  // JSU DC arg names: `fieldsList` (single field id) + `regex`/`regexp`
  const fieldId = remapField(cfg.fieldsList || cfg.fieldId || cfg.field, ctx);
  if (!fieldId) return null;
  return {
    ruleKey: "system:validate-field-value",
    parameters: stringifyParams({
      ruleType: "fieldMatches",
      fieldId,
      regex: cfg.regex || cfg.regExp || cfg.regexp || "",
      errorMessage: cfg.errorMessage || "",
    }),
  };
}

function userPermissionValidator(cfg) {
  return {
    ruleKey: "system:check-permission-validator",
    parameters: stringifyParams({
      permissionKey: cfg.permissionKey || cfg.permission || "ADMINISTER_PROJECTS",
    }),
  };
}

function jmweCommentRequiredValidator(cfg) {
  // JMWE CommentRequiredValidator → Cloud's native ruleType=fieldChanged on
  // the comment field. Optional `hidGroupsList` (DC: "G1@@G2@@") becomes
  // `groupsExemptFromValidation` on Cloud (comma-separated).
  const groups = String(cfg.hidGroupsList || cfg.groupsExemptFromValidation || "")
    .split(/@@|,/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(",");
  return {
    ruleKey: "system:validate-field-value",
    parameters: stringifyParams({
      ruleType: "fieldChanged",
      groupsExemptFromValidation: groups,
      fieldKey: "comment",
      errorMessage: cfg.errorMessage || "Please add a comment",
    }),
  };
}

/**
 * JSU/JMWE PreviousStatusValidator → Cloud `system:previous-status-validator`.
 *
 * Cloud parameters (verified against Atlassian REST docs + live workflow
 * samples):
 *   previousStatusIds      — comma-separated Cloud status IDs
 *   mostRecentStatusOnly   — "true" | "false" stringified boolean
 *
 * DC arg names (covers JSU + JMWE + BeeCom variants):
 *   `jira.previousstatus`        JSU 2.x and JMWE legacy (CSV or "@@"-list)
 *   `previousStatuses`           JMWE current
 *   `previousStatusIds`          forward-port from Cloud config
 *   `mostRecentStatusOnly`       only-the-immediately-prior-status flag
 *
 * Status IDs are remapped through ctx.statusRemapping. Rules whose entire
 * status list resolves to nothing return null (caller will record the rule
 * as unresolvable).
 */
function previousStatusValidator(cfg, ctx) {
  const raw =
    cfg["jira.previousstatus"] ||
    cfg.previousStatuses ||
    cfg.previousStatusIds ||
    cfg.statuses ||
    cfg.statusIds ||
    "";
  const cloudIds = remapStatusList(raw, ctx);
  if (cloudIds.length === 0) return null;
  const mostRecent =
    cfg.mostRecentStatusOnly === true ||
    cfg.mostRecentStatusOnly === "true" ||
    cfg.lastStatusOnly === "true" ||
    cfg["jira.mostrecent"] === "true";
  return {
    ruleKey: "system:previous-status-validator",
    parameters: stringifyParams({
      previousStatusIds: cloudIds.join(","),
      mostRecentStatusOnly: mostRecent ? "true" : "false",
    }),
  };
}

/**
 * JMWE ParentStatusValidator → Cloud `system:parent-or-child-blocking-validator`
 * with `blocker: PARENT`.
 *
 * Cloud parameters (verified against live workflow samples):
 *   blocker    — "PARENT" or "CHILD"
 *   statusIds  — comma-separated Cloud status IDs (the "blocking" set)
 *
 * "blocker: PARENT" gates a CHILD issue's transition on the PARENT being in
 * one of the listed statuses — matching JMWE ParentStatusValidator semantics:
 * the issue can only transition if its parent is in one of these statuses.
 *
 * DC arg names:
 *   `jira.parentstatuses` — STATUS NAMES separated by "@@"
 *   `parentStatusIds`     — newer JMWE shape with IDs
 *
 * Status NAMES are resolved to Cloud IDs via remapStatusByName (which uses
 * the DC catalog + DC→Cloud ID map). Rules whose entire status list resolves
 * to nothing return null.
 */
function parentStatusValidator(cfg, ctx) {
  // Try ID-keyed configs first; fall back to name-based JMWE shape.
  let cloudIds = [];
  if (cfg.parentStatusIds || cfg.statusIds) {
    cloudIds = remapStatusList(cfg.parentStatusIds || cfg.statusIds, ctx);
  } else if (cfg["jira.parentstatuses"] || cfg.parentStatuses || cfg.statuses) {
    cloudIds = remapStatusNameOrIdList(
      cfg["jira.parentstatuses"] || cfg.parentStatuses || cfg.statuses,
      ctx,
    );
  }
  if (cloudIds.length === 0) return null;
  return {
    ruleKey: "system:parent-or-child-blocking-validator",
    parameters: stringifyParams({
      blocker: "PARENT",
      statusIds: cloudIds.join(","),
    }),
  };
}

// ──────────────────────────────────────────────
//  Conditions
// ──────────────────────────────────────────────

// JSU `conditionList` integer-code → Cloud `comparator` symbol. Sourced from
// JSU's `ConditionCheckerFactory` constants:
//   1 GREATER (>), 2 GREATER_EQUAL (>=), 3 EQUAL (=), 4 LESS_EQUAL (<=),
//   5 LESS (<), 6 NOT_EQUAL (!=).
// Cloud's `system:check-field-value` accepts the exact same six symbols; the
// only restriction is that for `comparisonType: "STRING"` only `=` and `!=`
// are valid — that constraint is enforced below by remapping >/</>=/<= to =
// when the JSU comparisonType is also STRING.
const JSU_CONDITION_CODE_TO_COMPARATOR = {
  "1": ">",
  "2": ">=",
  "3": "=",
  "4": "<=",
  "5": "<",
  "6": "!=",
};

// JSU `comparisonType` integer-code → Cloud comparisonType enum. Sourced from
// JSU's `ConditionCheckerFactory`:
//   1 STRING, 2 NUMBER, 3 DATE, 4 DATE_WITHOUT_TIME, 5 OPTIONID.
// Cloud accepts the exact same five values verbatim.
const JSU_COMPARISON_TYPE_TO_CLOUD = {
  "1": "STRING",
  "2": "NUMBER",
  "3": "DATE",
  "4": "DATE_WITHOUT_TIME",
  "5": "OPTIONID",
};

function valueFieldCondition(cfg, ctx) {
  // JSU DC arg names: `fieldsList` (field id), `fieldValue`,
  // `comparisonType` (int code), `conditionList` (int comparator code).
  //
  // Cloud `system:check-field-value` accepts:
  //   fieldId           — Cloud field id
  //   fieldValue        — JSON-array-string (`["Done"]` for STRING/OPTIONID)
  //                       or plain stringified scalar for NUMBER/DATE.
  //                       Empty list `[""]` with `!=` means "field has a value".
  //   comparator        — `>`, `>=`, `=`, `<=`, `<`, `!=`
  //                       (STRING/OPTIONID restricted to `=` / `!=`)
  //   comparisonType    — STRING | NUMBER | DATE | DATE_WITHOUT_TIME | OPTIONID
  //
  // Earlier versions hardcoded comparisonType=STRING and bucketed every JSU
  // conditionList code into = / != only. That round-tripped fine for equality
  // checks but silently corrupted numeric / date / option-ID comparisons —
  // surfaced as MISSING_OTHER in the audit/compare reports because the
  // operator's `priority > 5` JSU rule got persisted as `priority = 5` on
  // Cloud, fingerprint-mismatched, and counted as missing.
  const fieldId = remapField(cfg.fieldsList || cfg.fieldId || cfg.field, ctx);
  if (!fieldId) return null;
  const rawValue =
    cfg.fieldValue != null ? cfg.fieldValue : cfg.value != null ? cfg.value : "";

  // Comparator: exact JSU mapping; unknown codes default to `=` (the most
  // forgiving choice — the validation pass will surface any rule whose
  // semantics actually need >/</etc.).
  const condCodeRaw = String(cfg.conditionList || cfg.comparator || "3");
  const directComparator = JSU_CONDITION_CODE_TO_COMPARATOR[condCodeRaw];
  // Some JSU XMLs persist the SYMBOL itself (`!=`, `=`) instead of the code
  // (notably configs round-tripped through some 3rd-party tools). Accept both.
  const symbolicSet = new Set([">", ">=", "=", "<=", "<", "!="]);
  let comparator =
    directComparator ||
    (symbolicSet.has(condCodeRaw) ? condCodeRaw : "=");

  // Comparison type: JSU integer or, in the wild, occasionally already the
  // string mnemonic. Default to STRING (covers JSU's omitted-arg case).
  const compTypeRaw = String(
    cfg.comparisonType != null ? cfg.comparisonType : "1",
  );
  const directCompType = JSU_COMPARISON_TYPE_TO_CLOUD[compTypeRaw];
  const upperCompType = String(compTypeRaw).toUpperCase();
  const validCloudCompTypes = new Set([
    "STRING",
    "NUMBER",
    "DATE",
    "DATE_WITHOUT_TIME",
    "OPTIONID",
  ]);
  let comparisonType =
    directCompType ||
    (validCloudCompTypes.has(upperCompType) ? upperCompType : "STRING");

  // Cloud restriction: STRING / OPTIONID accept only `=` / `!=`. Demote
  // exotic comparators when caller passed STRING/OPTIONID — preserves the
  // operator's intent (equality vs not) while keeping the rule valid.
  if (
    (comparisonType === "STRING" || comparisonType === "OPTIONID") &&
    comparator !== "=" &&
    comparator !== "!="
  ) {
    // > and >= bias toward existence (`!=`); < and <= bias toward absence (`=`).
    comparator = comparator === ">" || comparator === ">=" ? "!=" : "=";
  }

  // === Patch E (2026-05-10): Cloud requires JSON-array shape for ALL
  // comparisonTypes on system:check-field-value — verified live against
  // your-site.atlassian.net validation: NUMBER rules with plain `"2"` failed
  // with INVALID_RULE_PARAMETER "Invalid value for parameter 'fieldValue'"
  // while the same rules with `'["2"]'` passed. Older comments above said
  // NUMBER/DATE used a plain stringified scalar — that was wrong; Cloud's
  // 2026-era validator enforces the array form for every type. Always wrap. ===
  const fieldValue = JSON.stringify([String(rawValue)]);

  return {
    ruleKey: "system:check-field-value",
    parameters: stringifyParams({
      fieldId,
      fieldValue,
      comparator,
      comparisonType,
    }),
  };
}

// ──────────────────────────────────────────────
//  Post-functions
// ──────────────────────────────────────────────

function clearFieldValue(cfg, ctx) {
  // JSU DC arg name: `field` (single field id). Cloud has no dedicated clear-field
  // system rule — we reuse `system:update-field` with an empty `value`, which
  // sets the field to null (matching JSU's semantics). Same assignee-routing
  // exception as updateIssueField.
  const field = remapField(cfg.field || cfg.fieldId, ctx);
  if (!field) return null;
  if (field === "assignee") {
    return {
      ruleKey: "system:change-assignee",
      parameters: stringifyParams({ type: "to-unassigned" }),
    };
  }
  return {
    ruleKey: "system:update-field",
    parameters: stringifyParams({ field, value: "", mode: "" }),
  };
}

function assignToCurrentUser() {
  // Cloud equivalent uses `system:change-assignee` with `type: "to-current-user"`.
  return {
    ruleKey: "system:change-assignee",
    parameters: stringifyParams({
      type: "to-current-user",
    }),
  };
}

function copyValueFromOtherField(cfg, ctx) {
  // JSU and JMWE use DIFFERENT DC arg names:
  //   JMWE  (com.innovalog.jmwe.plugins.functions.CopyValueFromOtherFieldPostFunction)
  //         → `sourceField`, `destinationField`
  //   JSU   (com.googlecode.jsu.workflow.function.CopyValueFromOtherFieldPostFunction)
  //         → `field.copyFieldSource1`, `field.copyFieldDestination1`
  // The earlier mapper only read JMWE's keys, so JSU rules silently became
  // null and never reached Cloud. The fallback chain below handles both.
  // Cloud native `system:copy-value-from-other-field` parameter names are
  // `sourceFieldKey` + `targetFieldKey` (per the workflow capabilities API spec —
  // see /rest/api/3/workflows/capabilities). Sending `sourceField` /
  // `destinationField` is silently accepted but Cloud writes empty values for
  // the real keys, producing the "field ??? will take the value from ???" UI.
  const sourceFieldKey = remapField(
    cfg.sourceField ||
      cfg.sourceFieldId ||
      cfg.sourceFieldKey ||
      cfg["field.copyFieldSource1"],
    ctx,
  );
  const targetFieldKey = remapField(
    cfg.destinationField ||
      cfg.destinationFieldId ||
      cfg.destinationFieldKey ||
      cfg["field.copyFieldDestination1"],
    ctx,
  );
  if (!sourceFieldKey || !targetFieldKey) return null;
  return {
    ruleKey: "system:copy-value-from-other-field",
    parameters: stringifyParams({ sourceFieldKey, targetFieldKey, issueSource: "SAME" }),
  };
}

/**
 * JSU DC stores well-known runtime substitutions as `%%MACRO%%` literals.
 * Documented values (JSU "Field values" page on appfire.atlassian.net):
 *
 *   %%CURRENT_USER%%       — user who triggered the transition (User fields)
 *   %%PREVIOUS_USER%%      — prior user assigned to the field
 *   %%CURRENT_DATETIME%%   — server time at transition (Date / Date-Time fields)
 *   %%issue.<FieldName>%%  — value of another field on the SAME issue (v2.43+)
 *
 * Cloud's `system:update-field` accepts a single `value` string only — it has
 * no concept of templated values. Sending the literal `%%CURRENT_USER%%`
 * stores the macro text verbatim, which is silently broken (the field on
 * Cloud ends up containing the four-character string `%%CURRENT_USER%%`).
 *
 * For the cases we CAN handle natively:
 *   - assignee = %%CURRENT_USER%%   → system:change-assignee to-current-user
 *   - assignee = "" or "unassigned" → system:change-assignee to-unassigned
 *
 * For everything else we return null and let the applier route the rule to
 * `unmapped_rules.json` with a clear reason — far better than silently
 * persisting a broken literal value on Cloud.
 */
function _jsuMacroFor(value) {
  if (typeof value !== "string") return null;
  const m = value.match(/^%%([A-Z0-9_]+(?:\.[A-Za-z0-9_]+)?)%%$/);
  return m ? m[1] : null;
}

function updateIssueField(cfg, ctx) {
  // JSU DC arg names: `field.name` (target field id), `field.value` (value to set).
  // Cloud native is `system:update-field` (NOT `system:update-issue-field`) with
  // `field`, `value`, and optional `mode` params.
  const field = remapField(cfg["field.name"] || cfg.fieldId || cfg.field, ctx);
  if (!field) return null;
  const rawValue = cfg["field.value"] != null
    ? cfg["field.value"]
    : cfg.fieldValue != null
      ? cfg.fieldValue
      : cfg.value != null
        ? cfg.value
        : "";
  const valueStr = String(rawValue);

  // Cloud's `system:update-field` doesn't accept the `assignee` system field —
  // assignment uses the dedicated `system:change-assignee` rule. The Cloud-
  // accepted `type` enum is exactly: `to-current-user`, `to-selected-user`,
  // `to-unassigned`. Any other literal here means we have a DC username we
  // can't translate — drop the rule (return null) so the operator sets the
  // assignee manually rather than us writing a payload Cloud will reject.
  if (field === "assignee") {
    if (valueStr === "" || valueStr.toLowerCase() === "unassigned") {
      return {
        ruleKey: "system:change-assignee",
        parameters: stringifyParams({ type: "to-unassigned" }),
      };
    }
    if (valueStr === "%%CURRENT_USER%%") {
      return {
        ruleKey: "system:change-assignee",
        parameters: stringifyParams({ type: "to-current-user" }),
      };
    }
    // DC username literal or unsupported macro — Cloud needs an accountId.
    return null;
  }

  // === Patch G entry point: auto-translate KNOWN macros to JMWE ===========
  // For known JSU runtime macros (CURRENT_USER, CURRENT_DATETIME,
  // ADD_CURRENT_USER) we emit a JMWE SetFieldValueFunction with a Nunjucks
  // template instead of returning null. See _emitMacroAsJmweSetFieldValue
  // and the file header for rationale.
  const macroJmweRule = _emitMacroAsJmweSetFieldValue(field, valueStr, ctx);
  if (macroJmweRule) return macroJmweRule;

  // For UNKNOWN macros (anything else with `%%`) we keep the historical
  // behaviour: refuse to write a literal-macro payload to a native rule and
  // route to manual review. This keeps the safety net for any macro pattern
  // we haven't validated end-to-end yet.
  if (_jsuMacroFor(valueStr) || valueStr.includes("%%")) {
    if (ctx && ctx.unresolved) ctx.unresolved.add(`macro:${valueStr}`);
    return null;
  }

  // Cloud's `system:update-field` accepts `mode: "" | "append" | "replace"`
  // (replace is the default; append concatenates onto multi-value fields).
  // JSU's `append.value` arg toggles append-mode. JSU also has a separate
  // append-suffix arg in some plugin variants.
  const appendVal = cfg["append.value"];
  const appendMode =
    appendVal === true ||
    appendVal === "true" ||
    appendVal === "yes" ||
    cfg.appendValue === true ||
    cfg.appendValue === "true";
  return {
    ruleKey: "system:update-field",
    parameters: stringifyParams({
      field,
      value: valueStr,
      mode: appendMode ? "append" : "",
    }),
  };
}

// ──────────────────────────────────────────────
//  Registry
// ──────────────────────────────────────────────

const NATIVE_MAPPERS = {
  // validators
  "fields-required-validator": fieldsRequiredValidator,
  "regex-validator": regexValidator,
  "user-permission-validator": userPermissionValidator,
  "jmwe-comment-required-validator": jmweCommentRequiredValidator,
  "previous-status-validator": previousStatusValidator,
  "jmwe-parent-status-validator": parentStatusValidator,
  // conditions
  "value-field-condition": valueFieldCondition,
  // post-functions
  "clear-field-value": clearFieldValue,
  "assign-to-current-user": assignToCurrentUser,
  "copy-value-from-other-field": copyValueFromOtherField,
  "update-issue-field": updateIssueField,
};

function hasNativeMapper(shortName) {
  return Object.prototype.hasOwnProperty.call(NATIVE_MAPPERS, shortName);
}

// === Patch B (2026-05-10): defense-in-depth macro scan =====================
// JSU has ~10 runtime macros (`%%CURRENT_USER%%`, `%%CURRENT_DATETIME%%`,
// `%%TARGET_ISSUE_KEY%%`, `%%FIELD_VALUE_<name>%%`, `%%issue.<field>%%`, etc.)
// that are substituted at execution time on DC. Cloud has no equivalent —
// sending the literal `%%FOO%%` text persists the macro string verbatim,
// which is silently broken. updateIssueField + fieldsRequiredValidator
// already detect and reject these in their dedicated paths. This scanner
// catches the residue: any string-valued parameter on the OUTPUT rule that
// still contains `%%...%%` is a sign the caller didn't translate it.
//
// Behaviour:
//   - returns null + tags `ctx.unresolved.add("macro:<param>=...")` if a
//     macro slipped through any string-valued parameter.
//   - leaves the rule alone otherwise.
//
// Conservative regex: requires at least 2 uppercase letters / digits between
// the %%-pairs to avoid false positives on percent-encoded text or
// occasional double-percent literals in regex patterns.
const _JSU_MACRO_RE = /%%[A-Z0-9_][A-Z0-9_.]+%%/;
function _scanForMacros(rule, ctx) {
  if (!rule || !rule.parameters) return rule;
  for (const [k, v] of Object.entries(rule.parameters)) {
    if (typeof v !== "string") continue;
    if (_JSU_MACRO_RE.test(v)) {
      if (ctx && ctx.unresolved) {
        ctx.unresolved.add(`macro:${k}="${v.length > 80 ? v.slice(0, 77) + "..." : v}"`);
      }
      return null;
    }
  }
  return rule;
}

function convertToNative(shortName, dcConfiguration, ctx) {
  const fn = NATIVE_MAPPERS[shortName];
  if (!fn) return null;
  const out = fn(dcConfiguration || {}, ctx || {});
  return _scanForMacros(out, ctx);
}

module.exports = { NATIVE_MAPPERS, hasNativeMapper, convertToNative, _scanForMacros };
