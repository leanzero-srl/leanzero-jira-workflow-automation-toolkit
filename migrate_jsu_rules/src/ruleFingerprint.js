/**
 * Shared rule-fingerprint helpers used by:
 *   - jsuApplier.js dedup passes (`_pruneExactDuplicates`, `_appendIfAbsent`,
 *     `_collapseOnePerTxnConnectModules`, `_pruneCrossLevelDuplicateConditions`)
 *   - audit_oneforone.js plan-row presence check
 *   - compare_xml_to_cloud.js bipartite rule pairing
 *
 * Two rules with the same fingerprint are treated as the SAME rule for dedup
 * purposes, regardless of metadata that varies between persists (id, disabled
 * flag, tag, problems[]). The fingerprint is module-aware: well-known JMWE
 * Connect modules use a hand-tuned semantic key; everything else falls back to
 * a canonical hash of the parsed config with id-shaped keys removed.
 *
 * Field IDs inside Connect rule configs are translated through the supplied
 * field remap before hashing so older raw-DC-id copies and newer Cloud-id
 * copies normalize to the same fingerprint.
 *
 * Returns null for shapes we don't know how to fingerprint, in which case the
 * caller should fall back to ruleKey + parameter-hash equality.
 */

function canonicalStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(value[k])).join(",") + "}";
}

function stripEphemeralKeys(value) {
  if (Array.isArray(value)) return value.map(stripEphemeralKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Keys that vary between persisted copies of the SAME rule and must
      // never be part of a dedup fingerprint:
      //   id            — server-assigned UUID, regenerated on every persist
      //   extensionId   — alternate server-assigned ID for some Connect modules
      //   problems      — CMA-emitted Groovy translation markers; their
      //                   contents shift as our translator improves and as
      //                   CMA reruns annotate the same rule. Treating
      //                   problems[] as identity bytes caused near-duplicate
      //                   pairs (CMA-tagged with markers vs. our translated
      //                   no-marker copy) to fingerprint differently and
      //                   survive dedup. Strip it from the fingerprint
      //                   surface — the reconciliation pipeline tracks the
      //                   markers separately for operator review.
      //   _unmappedJsuConfiguration — passthrough leftover key from older
      //                   mappers; presence is itself non-canonical.
      if (
        k === "id" ||
        k === "extensionId" ||
        k === "problems" ||
        k === "_unmappedJsuConfiguration"
      )
        continue;
      out[k] = stripEphemeralKeys(v);
    }
    return out;
  }
  return value;
}

// Collapse syntactically-equivalent Groovy accessor forms before whitespace
// stripping, so that two rules whose only difference is `issue.reporter` vs
// `issue.get("reporter")` fingerprint identically. The accessor patterns are
// matched BEFORE whitespace is stripped, with a strict identifier capture
// `[a-zA-Z_]\w*`, so display-name lookups like `issue.get("Problem Summary")`
// (which has no equivalent property-access form) are left alone.
//
// Wrapper-form equivalence (e.g. `{{X}}` vs `(X)` vs `X`) is intentionally NOT
// collapsed here — `{{...}}` is JMWE Smart Values evaluation and `(...)` is
// Groovy, two different engines that can disagree on null/type semantics. Any
// post-translate survivors with different wrapper forms are caught by the
// per-workflow tail sanitizer that compares actual cloud-side post-function
// configs byte-for-byte.
function groovyAccessorNorm(v) {
  if (v == null) return "";
  let s = String(v);
  s = s.replace(/issue\.get\(\s*["']([a-zA-Z_]\w*)["']\s*\)/g, "issue.$1");
  s = s.replace(/issue\.getAsString\(\s*["']([a-zA-Z_]\w*)["']\s*\)/g, "issue.$1");
  s = s.replace(/issue\.fields\.([a-zA-Z_]\w*)/g, "issue.$1");
  return s.replace(/\s+/g, "");
}

function normalizeConnectConfigFields(value, remap) {
  if (Array.isArray(value)) return value.map((v) => normalizeConnectConfigFields(v, remap));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeConnectConfigFields(v, remap);
    }
    return out;
  }
  if (typeof value === "string") {
    return value.replace(/customfield_\d+/g, (m) =>
      Object.prototype.hasOwnProperty.call(remap, m) && remap[m] ? remap[m] : m,
    );
  }
  return value;
}

/**
 * Semantic fingerprint for a Connect (JMWE / Forge / Atlassian-Connect) rule.
 * `fieldRemap` is the {dcId: cloudId} map used to normalize embedded field ids.
 */
function connectRuleFingerprint(rule, fieldRemap = {}) {
  if (!rule || typeof rule.ruleKey !== "string") return null;
  if (!rule.ruleKey.startsWith("connect:")) return null;
  const p = rule.parameters || {};
  const ruleKey = rule.ruleKey;

  let appKey = p.appKey || "";
  if (!appKey && ruleKey !== "connect:remote-workflow-function" &&
      ruleKey !== "connect:expression-validator" &&
      ruleKey !== "connect:expression-condition") {
    appKey = ruleKey.slice("connect:".length);
  }
  const moduleName = appKey.includes("__") ? appKey.slice(appKey.lastIndexOf("__") + 2) : appKey;

  const rawCfg = (typeof p.config === "string" && p.config) ||
                 (typeof p.value === "string" && p.value) || "";
  let cfg;
  if (rawCfg) {
    try { cfg = JSON.parse(rawCfg); }
    catch { cfg = { _rawConfig: rawCfg }; }
  } else if (p && typeof p === "object") {
    cfg = p;
  } else {
    cfg = {};
  }
  // Unwrap our jmwePassthrough nesting so the same shape is seen as a
  // CMA-translated rule with fields lifted to the top of the config.
  if (cfg && typeof cfg === "object" && cfg._unmappedJsuConfiguration && typeof cfg._unmappedJsuConfiguration === "object") {
    cfg = { ...cfg._unmappedJsuConfiguration, ...cfg };
    delete cfg._unmappedJsuConfiguration;
  }

  const fld = (id) => {
    if (!id) return "";
    const s = String(id);
    return Object.prototype.hasOwnProperty.call(fieldRemap, s) && fieldRemap[s] ? fieldRemap[s] : s;
  };
  const sortedFieldList = (raw) => {
    if (!raw) return "";
    const arr = Array.isArray(raw) ? raw : String(raw).split(/[,@]+/);
    return arr.map((s) => String(s).trim()).filter(Boolean).map(fld).sort().join(",");
  };
  const norm = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
  // Expression-bearing rules (ScriptedCondition/Validator/PostFunction): strip
  // ALL whitespace AND collapse syntactically-equivalent Groovy accessors so
  // that `issue.reporter`, `issue.get("reporter")`, `issue.getAsString("reporter")`,
  // and `issue.fields.reporter` fingerprint identically. Without this, two
  // CMA migration generations (older `issue.reporter` form, newer `issue.get(...)`
  // form) leave duplicate copies on Cloud that the strict fingerprint can't
  // see as the same rule.
  const exprNorm = (v) => groovyAccessorNorm(v);

  let semanticKey = null;
  switch (moduleName) {
    case "CurrentStatusCondition":
    case "PreviousStatusCondition":
    case "PreviousStatusValidator":
    case "ParentStatusValidator":
      semanticKey = [
        "statuses=" + sortedFieldList(cfg.statusIds || cfg["jira.previousstatus"] || cfg.previousStatuses || cfg.statuses),
        "not=" + (cfg["jira.not"] || cfg.not || (typeof cfg.expression === "string" && cfg.expression.startsWith("!") ? "yes" : "")),
      ].join("|");
      break;
    case "ClearFieldsFunction":
      semanticKey = "fields=" + sortedFieldList(cfg.fields || cfg.fieldIds);
      break;
    case "SetFieldValueFunction": {
      // Two SetFieldValueFunction rules are the SAME only when they target the
      // same field(s) AND set the same value AND fire under the same condition.
      // The earlier "fields-only" fingerprint silently collapsed N distinct DC
      // rules (different conditional branches setting the same field) into one
      // Cloud rule, losing 90%+ of the operator's logic. Include each
      // (fieldId, value) entry plus the conditional-execution script in the
      // semantic key so distinct rules fingerprint distinctly.
      const fc = Array.isArray(cfg.fieldsConfig) ? cfg.fieldsConfig : [];
      const entries = fc
        .map((f) => `${fld(f && f.fieldId)}=${exprNorm(f && f.value)}`)
        .filter((s) => s !== "=" && s)
        .sort();
      if (entries.length === 0 && cfg.fieldId) {
        entries.push(`${fld(cfg.fieldId)}=${exprNorm(cfg.value)}`);
      }
      const cond = exprNorm(cfg.conditionalExecutionScript || "");
      semanticKey = "entries=" + entries.join(",") + "|cond=" + cond;
      break;
    }
    case "IncreaseFieldValueFunction":
      semanticKey = "field=" + fld(cfg.fieldId || cfg.field);
      break;
    case "CommentIssueFunction":
      semanticKey = [
        "comment=" + norm(cfg.comment),
        "internal=" + (cfg.restrictToInternal === true || cfg.restrictToInternal === "true" ? "1" : "0"),
      ].join("|");
      break;
    case "EmailIssueFunction":
      semanticKey = [
        "subject=" + norm(cfg.subject),
        "to=" + sortedFieldList(cfg.toUsers || cfg.toAddresses),
        "toScript=" + norm(cfg.toEmailsScript),
      ].join("|");
      break;
    case "ScriptedPostFunction":
    case "ScriptedCondition":
    case "ScriptedValidator":
      semanticKey = "script=" + exprNorm(cfg.script || cfg.expression || cfg.conditionalExecutionScript);
      break;
    case "LinkedIssuesCondition":
      semanticKey = [
        "linkType=" + norm(cfg.linkType || cfg.linkTypeId),
        "statuses=" + sortedFieldList(cfg.statuses || cfg.statusIds),
      ].join("|");
      break;
    case "TransitionLinkedIssueFunction":
    case "TransitionIssueFunction":
      semanticKey = [
        "linkType=" + norm(cfg.linkType || cfg.linkTypeId),
        "transition=" + norm(cfg.transition || cfg.transitionName || cfg.targetTransition),
      ].join("|");
      break;
    case "DateComparisonValidator":
      semanticKey = [
        "first=" + fld(cfg.firstDateFieldId || cfg.date1),
        "second=" + fld(cfg.secondDateFieldId || cfg.date2),
        "cond=" + norm(cfg.condition || cfg.comparison),
      ].join("|");
      break;
    default: {
      const stripped = stripEphemeralKeys(cfg);
      const normalized = normalizeConnectConfigFields(stripped, fieldRemap);
      semanticKey = "raw=" + canonicalStringify(normalized);
      break;
    }
  }
  return ["connect", ruleKey, appKey, semanticKey || ""].join("|");
}

/**
 * Identity fingerprint for any rule shape we know — system:* or connect:*.
 * Returns null for unknown shapes (caller should fall back to coarser hash).
 */
// Sort a CSV-or-JSON-array of IDs into a canonical comma-separated form so two
// fingerprints that differ only in list ORDER ("5,6" vs "6,5") collide. Any
// non-CSV scalar passes through unchanged.
function _sortIdCsv(raw) {
  if (raw == null || raw === "") return "";
  if (Array.isArray(raw)) return [...raw].map(String).sort().join(",");
  const s = String(raw).trim();
  // JSON-array form (e.g. `["10001","10002"]` from Cloud check-field-value).
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return JSON.stringify([...arr].map(String).sort());
    } catch {
      // fall through to CSV split
    }
  }
  return s.split(",").map((p) => p.trim()).filter(Boolean).sort().join(",");
}

function ruleFingerprint(rule, fieldRemap = {}) {
  if (!rule || !rule.ruleKey) return null;
  const p = rule.parameters || {};
  const k = rule.ruleKey;
  if (k === "system:check-field-value") {
    // fieldValue arrives as a JSON-array string; sort the array so
    // ["A","B"] and ["B","A"] fingerprint identically.
    return [k, p.fieldId || "", _sortIdCsv(p.fieldValue), p.comparator || "", p.comparisonType || ""].join("|");
  }
  if (k === "system:update-field") {
    // Cloud normalizes an absent/empty `mode` to "replace" on persist, but the
    // applier's mappers emit `mode: ""` for the default case. Without
    // normalization, the FP from a freshly-mapped rule (`...|`) differs from
    // the FP of the same rule read back from Cloud (`...|replace`), and the
    // sanitizer's `_detectMissingSystemRules` flags every just-pushed rule as
    // still missing — producing the false-positive duplicate-push pattern we
    // saw on "Product B v1.4" (2026-05-11). Canonicalize so "" == "replace".
    const rawMode = (p.mode || "").toString().toLowerCase();
    const mode = rawMode === "" || rawMode === "replace" ? "replace" : rawMode;
    return [k, p.field || "", p.value || "", mode].join("|");
  }
  if (k === "system:copy-value-from-other-field") {
    return [k, p.sourceFieldKey || "", p.targetFieldKey || "", p.issueSource || ""].join("|");
  }
  if (k === "system:validate-field-value") {
    const ruleType = p.ruleType || "";
    if (ruleType === "fieldRequired") {
      // Sort the comma-separated field list to dedup [a,b] and [b,a].
      return [k, ruleType, _sortIdCsv(p.fieldsRequired)].join("|");
    }
    return [k, ruleType, p.fieldId || p.fieldKey || ""].join("|");
  }
  if (k === "system:check-permission-validator") {
    return [k, p.permissionKey || ""].join("|");
  }
  if (k === "system:change-assignee") {
    return [k, p.type || "", p.accountId || ""].join("|");
  }
  if (k === "system:restrict-issue-transition") {
    return [
      k,
      _sortIdCsv(p.accountIds),
      _sortIdCsv(p.roleIds),
      _sortIdCsv(p.groupIds),
      _sortIdCsv(p.permissionKeys),
      _sortIdCsv(p.groupCustomFields),
      _sortIdCsv(p.allowUserCustomFields),
      _sortIdCsv(p.denyUserCustomFields),
    ].join("|");
  }
  if (k === "system:previous-status-validator") {
    // Two PreviousStatusValidators are duplicates when they enforce the same
    // status set under the same `mostRecentStatusOnly` flag — order of IDs is
    // irrelevant. Sourced from Atlassian REST docs (params: previousStatusIds,
    // mostRecentStatusOnly).
    return [k, _sortIdCsv(p.previousStatusIds), p.mostRecentStatusOnly || "false"].join("|");
  }
  if (k === "system:parent-or-child-blocking-validator") {
    // Parameters: blocker (PARENT|CHILD enum), statusIds (CSV).
    // Sort the status list for canonical comparison.
    return [k, p.blocker || "", _sortIdCsv(p.statusIds)].join("|");
  }
  if (k === "system:proforma-forms-submitted") {
    // JSM Proforma forms validator — no parameters typically; identity is
    // the rule key itself plus whatever optional params Atlassian adds.
    return [k, JSON.stringify(p || {})].join("|");
  }
  if (typeof k === "string" && k.startsWith("connect:")) {
    return connectRuleFingerprint(rule, fieldRemap);
  }
  return null;
}

/**
 * Identity fingerprint anchored to the DC source rule, not the Cloud rule
 * content. Stamped at apply time onto `parameters.migrationSourceId` from the
 * deterministic plan-row identity (workflow + transition + slot + dcType). The
 * primary dedup signal across re-runs and code revisions — semantic
 * fingerprints drift as the translator hardens, but this id is stable as long
 * as the DC source is unchanged.
 *
 * Returns null for rules without the tag (legacy Cloud rules from before the
 * tag was introduced) — callers then fall back to the semantic fingerprint
 * (`ruleFingerprint`) so legacy dedup still works.
 */
function migrationFingerprint(rule) {
  const id = rule && rule.parameters && rule.parameters.migrationSourceId;
  return id ? `migration:${id}` : null;
}

/**
 * Coarse module-level fingerprint for a Connect rule. Used as a fallback when
 * the strict semantic fingerprint can't match (e.g. CMA-translated rules
 * carry Cloud-side IDs we can't reverse-map). A same-module sibling on the
 * resolved transition counts as evidence the plan row landed.
 */
function connectPresenceFp(rule) {
  if (!rule || typeof rule.ruleKey !== "string" || !rule.ruleKey.startsWith("connect:")) return null;
  const p = rule.parameters || {};
  let appKey = p.appKey || "";
  if (!appKey && rule.ruleKey !== "connect:remote-workflow-function" &&
      rule.ruleKey !== "connect:expression-validator" &&
      rule.ruleKey !== "connect:expression-condition") {
    appKey = rule.ruleKey.slice("connect:".length);
  }
  const moduleName = appKey.includes("__") ? appKey.slice(appKey.lastIndexOf("__") + 2) : appKey;
  return `connect-presence|${moduleName}`;
}

/**
 * Walk a Cloud transition object and emit the full set of fingerprints it
 * "owns" — strict semantic fingerprints + per-field expansions for
 * fieldRequired validators + module-level Connect presence fingerprints.
 *
 * Used by the audit and the comparison tool to test plan-row presence.
 */
function collectRuleFps(transition, fieldRemap = {}) {
  const out = new Set();
  const addFp = (fp) => { if (fp) out.add(fp); };
  const addConnectPresence = (rule) => {
    const fp = connectPresenceFp(rule);
    if (fp) out.add(fp);
  };
  // Emit a migration:<id> fingerprint per rule that carries our identity tag.
  // Dedup compares this against the converted plan row's migration fp so that
  // a previously-pushed copy of "the same logical rule" matches regardless of
  // whether the semantic content has drifted between mapper revisions.
  const addMigrationFp = (rule) => {
    const fp = migrationFingerprint(rule);
    if (fp) out.add(fp);
  };
  const addValidator = (v) => {
    addFp(ruleFingerprint(v, fieldRemap));
    const p = v && v.parameters;
    if (p && p.ruleType === "fieldRequired" && typeof p.fieldsRequired === "string") {
      for (const f of p.fieldsRequired.split(",").map((s) => s.trim()).filter(Boolean)) {
        addFp(`system:validate-field-value|fieldRequired|${f}`);
      }
    }
  };
  for (const a of transition.actions || []) {
    addFp(ruleFingerprint(a, fieldRemap));
    addConnectPresence(a);
    addMigrationFp(a);
  }
  for (const v of transition.validators || []) {
    addValidator(v);
    addConnectPresence(v);
    addMigrationFp(v);
  }
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    for (const c of node.conditions || []) {
      addFp(ruleFingerprint(c, fieldRemap));
      addConnectPresence(c);
      addMigrationFp(c);
    }
    for (const cg of node.conditionGroups || []) walk(cg);
  };
  if (transition.conditions) walk(transition.conditions);
  return out;
}

module.exports = {
  canonicalStringify,
  stripEphemeralKeys,
  normalizeConnectConfigFields,
  groovyAccessorNorm,
  connectRuleFingerprint,
  ruleFingerprint,
  migrationFingerprint,
  connectPresenceFp,
  collectRuleFps,
};
