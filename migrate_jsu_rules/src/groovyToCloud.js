/**
 * Groovy → Cloud DSL translation, used by JMWE mappers when they need to
 * carry a DC Groovy template/script into a Cloud Connect rule.
 *
 * Cloud has TWO surfaces:
 *   - Post-functions accept Nunjucks templates (e.g. `{{ issue.fields.summary }}`)
 *     for fields like comment, subject, textBody, value.
 *   - Conditions and validators accept Jira Expressions (e.g.
 *     `issue.summary == "X"`).
 *
 * CMA's behaviour: it does NOT auto-translate Groovy. It preserves the source
 * text and emits a `problems[]` array marking the rule as needing review. We
 * mirror that contract — best-effort regex translation for the few patterns
 * we can reliably handle, with a `problems[]` marker on every rule that had
 * Groovy content. Operators get a worklist, not a silent failure.
 *
 * IMPORTANT: when no Groovy markers are present in the input, we return the
 * text unchanged and an empty problems array — so plain-text fields don't
 * generate spurious markers.
 */

const { normalizeUserComparisons } = require("./userComparisonNormalizer");

// Detection — does the text look like it contains Groovy code/templates?
//   - `${...}` template expressions (Groovy GString)
//   - `<%...%>` JSP-style scriptlets used by some JMWE configs
//   - `issue.get(`, `issue.getAsString(`, `customFields.` references
//   - groovy keywords like `def `, `String `, `return ` at start of line
//   - method `?.first()`, `?.optionId` chains
function hasGroovyContent(text) {
  if (typeof text !== "string" || !text) return false;
  if (/\$\{[^}]+\}/.test(text)) return true;
  if (/<%[\s\S]*?%>/.test(text)) return true;
  if (/\bissue\.(?:get|getAsString|getAsHtml|getRawValue)\s*\(/.test(text)) return true;
  if (/\bcustomFields\./.test(text)) return true;
  if (/\?\s*\.(first|optionId|name|value)\s*\(?/.test(text)) return true;
  if (/^\s*(?:def|String|Integer|return)\s+/m.test(text)) return true;
  return false;
}

function hasInsightContent(text) {
  if (typeof text !== "string" || !text) return false;
  return /getInsightAttributeValue|getObjectAttribute|riadalabs\.jira\.plugins\.insight/.test(text);
}

/**
 * Translate Groovy template (text with `${...}` placeholders) to Nunjucks.
 * Returns { output, problems }. `problems` contains entries CMA-style:
 *   { type: "GroovyTemplateToNunjucks" | "OptionNotSupported" | ..., location: [...] }
 *
 * Patterns covered:
 *   ${issue.getAsString("X")}           → {{ issue.fields.X }}
 *   ${issue.get("X")}                   → {{ issue.fields.X }}
 *   ${issue.get("X")?.first()?.name}    → {{ issue.fields.X[0].name }}
 *   ${issue.get("X")?.first()?.value}   → {{ issue.fields.X[0].value }}
 *   ${issue.get("X")?.first()?.optionId} → {{ issue.fields.X[0].id }}
 *   ${customFields.X.value}             → {{ issue.fields.X.value }}
 *   ${currentUser.displayName}          → {{ user.displayName }}
 *
 * Anything else inside `${...}` is preserved with the GString syntax preserved
 * but flagged. Plain text outside placeholders passes through unchanged.
 */
function groovyTemplateToNunjucks(text, location = [], ctx = null) {
  const problems = [];
  if (typeof text !== "string" || !text) return { output: text || "", problems };

  // CMA inerts Groovy templates by inserting a zero-width character between
  // `$` and `{` (typically U+2063 INVISIBLE SEPARATOR), so the text renders
  // literally instead of evaluating. Normalise these so the regexes below
  // see the original `${...}` and we can finish the translation properly.
  let out = text.replace(/\$[​-‍⁠-⁯﻿]+\{/g, "${");

  if (!hasGroovyContent(out)) return { output: out, problems, translated: out !== text };

  let translated = out !== text; // ZWJ-strip already counts as translation work

  // Multi-statement translator — handles the common SetFieldValueFunction
  // `def X = ...; def Y = ...; if (X==...) return A else return B` shape.
  // Bails to false when the body doesn't fit the supported subset, so
  // single-expression / GString-template flows below stay intact.
  const multiResult = groovyMultiStatementToNunjucks(out, location, ctx);
  if (multiResult.translated) {
    if (Array.isArray(multiResult.problems)) for (const p of multiResult.problems) problems.push(p);
    return { output: multiResult.output, problems, translated: true };
  }

  // Complex translators (separate file for clarity) — handle the "weirder"
  // shapes the simple multi-statement translator can't: def-only bodies,
  // else-if chains, uninitialised-def + branch-assignment.
  try {
    const { complexGroovyToNunjucks } = require("./complexGroovyTranslator");
    const complex = complexGroovyToNunjucks(out, location, ctx);
    if (complex && complex.translated) {
      if (Array.isArray(complex.problems)) for (const p of complex.problems) problems.push(p);
      return { output: complex.output, problems, translated: true };
    }
  } catch {
    // Complex translator threw — fall through. Residue detector handles it.
  }

  // Bare-return collapse — JMWE-DC scripts sometimes use a single
  // `return <expr>` (CommentIssueFunction comment field is the typical
  // location: `return "KB documentation approval ..."`). Cloud's Nunjucks
  // engine has no return; the expression's value IS the output. Strip the
  // `return` keyword + matching quotes for the simple-literal case so the
  // template renders as plain text. For complex returns the rest of the
  // pipeline below picks up any `${...}` patterns inside the literal.
  const bareReturn = out.match(/^\s*return\s+(.+?)\s*;?\s*$/s);
  if (bareReturn) {
    let body = bareReturn[1].trim();
    // (1) Unwrap if the entire body is a quoted string literal.
    const strMatch = body.match(/^"((?:[^"\\]|\\.)*)"$/) || body.match(/^'((?:[^'\\]|\\.)*)'$/);
    if (strMatch) {
      out = strMatch[1].replace(/\\(["'\\])/g, "$1");
      translated = true;
    } else {
      // (2) Try the value-expression translator on the body. It handles
      // `"prefix " + issue.get("X").displayName` by splitting on top-level
      // `+` and rewriting each `issue.get(...)` atom into a `{{ }}` block.
      // When it can't translate (returns translated:false) we fall through
      // and the body stays as-is for the residue gate to catch.
      const inner = groovyValueExpressionToNunjucks(body, [...location, "return"], ctx);
      if (inner && inner.translated) {
        out = inner.output;
        translated = true;
        if (Array.isArray(inner.problems)) for (const p of inner.problems) problems.push(p);
      } else {
        out = body;
        translated = true;
      }
    }
  }

  // Velocity-style scriptlets `<%= EXPR %>` (some JMWE-DC subject/body
  // fields use these as an alternative to `${EXPR}`). JMWE Cloud's Nunjucks
  // engine does NOT interpret `<%=`; the rule renders the literal text.
  // Translate to `{{ EXPR_translated | default("") }}`, mirroring how we
  // handle `${EXPR}` for the same EXPR patterns. Common case: `<%= issue.
  // summary %>` and `<%= issue.get("X") %>`.
  out = out.replace(/<%=\s*([\s\S]*?)\s*%>/g, (_m, expr) => {
    translated = true;
    const e = expr.trim();
    // issue.<bareProp> — fast path
    let m = e.match(/^issue\s*\.\s*(\w+)$/);
    if (m) return `{{ issue.${m[1]} | default("") }}`;
    // issue.get|getAsString|getAsHtml|getRawValue("X")<chain>
    m = e.match(/^issue\s*\.\s*get(AsString|AsHtml|RawValue)?\s*\(\s*["']([^"']+)["']\s*\)((?:\s*\??\.\s*\w+\s*(?:\(\s*[^()]*\s*\))?)*)$/);
    if (m) {
      const fieldId = m[2];
      const chain = m[3] || "";
      const parsed = parseChainForNunjucks(chain);
      if (!parsed) return _m; // bail — let residue detector catch it
      const root = nunjucksFieldRef(fieldId, ctx, problems, location);
      const acc = root + parsed.tokens.join("");
      const filterPipe = [];
      if (parsed.formatArg) filterPipe.push(`dateformat("${parsed.formatArg}")`);
      filterPipe.push(...parsed.filters);
      filterPipe.push('default("")');
      return `{{ ${acc} | ${filterPipe.join(" | ")} }}`;
    }
    // currentUser[.prop]
    m = e.match(/^currentUser(?:\s*\.\s*(\w+))?$/);
    if (m) return `{{ user${m[1] ? "." + m[1] : ""} | default("") }}`;
    // String literal `<%= "Hello" %>` — render the literal directly.
    m = e.match(/^"((?:[^"\\]|\\.)*)"$|^'((?:[^'\\]|\\.)*)'$/);
    if (m) return (m[1] != null ? m[1] : m[2]).replace(/\\(["'\\])/g, "$1");
    // Anything else: preserve as Nunjucks-ish but flag — operator should
    // verify. Wrapping in `{{ }}` lets simple identifiers render correctly.
    problems.push({ type: "GroovyTemplateToNunjucks", location: [...location, "<%= ... %>"] });
    return `{{ ${e} | default("") }}`;
  });

  // CMA leaves `customfield_X/*custom field ID missing on Cloud*/` comments
  // inside its preserved Groovy. Strip them so the bare ID is what we render.
  // The field may still not exist on Cloud — that's the operator's call —
  // but the SYNTAX is now clean.
  out = out.replace(/\/\*\s*custom field ID missing on Cloud\s*\*\//g, "");

  // ${issue.<bareProp>?.format("FMT")} → {{ issue.fields.<X> | dateformat("FMT") | default("") }}
  // Common in HTML email bodies: `${issue.created?.format("dd-MM-yyyy")}` etc.
  // JMWE Cloud's Nunjucks supports a `dateformat` filter for date-typed fields.
  out = out.replace(
    /\$\{\s*issue\s*\.\s*(\w+)\s*\??\.\s*format\s*\(\s*["']([^"']+)["']\s*\)\s*\}/g,
    (_m, fieldId, fmt) => {
      translated = true;
      const root = nunjucksFieldRef(fieldId, ctx, problems, location);
      return `{{ ${root} | dateformat("${fmt}") | default("") }}`;
    },
  );

  // ${issue.get("X")<chain of ?.prop or ?.first() or ?.format("Y") or method
  // chains like .toString().replace("a","b").substring(0,3)>}
  // Accepts single/double-quoted field-id args, AsString/AsHtml/RawValue
  // accessor variants, and any chain `parseChainForNunjucks` can translate.
  // Chain segments that contain unrecognised methods cause the outer regex
  // to leave the substring untouched so the residue detector can catch it.
  out = out.replace(
    /\$\{\s*issue\s*\.\s*get(?:AsString|AsHtml|RawValue)?\s*\(\s*["']([^"']+)["']\s*\)((?:\s*\??\.\s*\w+\s*(?:\(\s*[^()]*\s*\))?)*)\s*\}/g,
    (whole, fieldId, chain) => {
      const parsed = parseChainForNunjucks(chain);
      if (!parsed) return whole; // bail — unrecognised method, let residue detector flag
      translated = true;
      const root = nunjucksFieldRef(fieldId, ctx, problems, location);
      const acc = root + parsed.tokens.join("");
      const filterPipe = [];
      if (parsed.formatArg) filterPipe.push(`dateformat("${parsed.formatArg}")`);
      filterPipe.push(...parsed.filters);
      filterPipe.push('default("")');
      return `{{ ${acc} | ${filterPipe.join(" | ")} }}`;
    },
  );

  // ${customFields.X.value} / ${customFields.X}
  out = out.replace(
    /\$\{\s*customFields\s*\.\s*([\w_]+)(?:\s*\.\s*(\w+))?\s*\}/g,
    (_m, fieldId, prop) => {
      translated = true;
      const root = nunjucksFieldRef(fieldId, ctx, problems, location);
      return `{{ ${root}${prop ? "." + prop : ".value"} | default("") }}`;
    },
  );

  // ${currentUser.<prop>}
  out = out.replace(
    /\$\{\s*currentUser(?:\s*\.\s*(\w+))?\s*\}/g,
    (_m, prop) => {
      translated = true;
      return `{{ user${prop ? "." + prop : ""} | default("") }}`;
    },
  );

  // ${issue.<simple>} — bare top-level access (issue.key, issue.id, etc).
  // These resolve via dot notation in JMWE Cloud's Nunjucks engine.
  out = out.replace(
    /\$\{\s*issue\s*\.\s*(\w+)\s*\}/g,
    (_m, prop) => { translated = true; return `{{ issue.${prop} | default("") }}`; },
  );

  // Generic `${...}` left over → preserve + mark.
  // Fallback: if no template pattern matched but the input is a single bare
  // Groovy atom (e.g., `issue.get("X")?.first()?.name` directly, without any
  // `${...}` wrapper), try the value-expression translator. This catches
  // the common SetFieldValueFunction `fieldsConfig[].value` case where DC
  // stores raw Groovy without GString syntax (the `${}` is added by the DC
  // plugin at render time, not in the persisted config). The value-expr
  // translator has its own multi-statement / def / return guards, so prose
  // that incidentally contains `issue.get` won't be incorrectly translated.
  if (!translated && !/\$\{[^}]+\}/.test(out) && !/<%[\s\S]*?%>/.test(out)) {
    const ve = groovyValueExpressionToNunjucks(out, location, ctx);
    if (ve && ve.translated) {
      out = ve.output;
      translated = true;
      if (Array.isArray(ve.problems)) for (const p of ve.problems) problems.push(p);
    }
  }
  const stillGroovy = /\$\{[^}]+\}/.test(out) || /<%[\s\S]*?%>/.test(out) || /^\s*def\s+/m.test(out) || /=~/.test(out);
  if (translated && !stillGroovy) {
    problems.push({ type: "GroovyTemplateToNunjucks", location });
  } else if (stillGroovy) {
    if (translated) problems.push({ type: "GroovyTemplateToNunjucks", location });
    problems.push({ type: "GroovyScriptToNunjucks", location });
  }
  if (hasInsightContent(out)) {
    problems.push({ type: "OptionNotSupported", location: [...location, "Insight/Assets reference"] });
  }
  return { output: out, problems, translated };
}

/**
 * Translate a Groovy expression to a Jira Expression. Used for ScriptedCondition,
 * ScriptedValidator, GroovyValidator, GroovyCondition, and the conditional-execution
 * scripts that JMWE post-functions sometimes carry.
 *
 * Patterns covered:
 *   issue.getAsString("X")         → issue.X
 *   issue.get("X")                 → issue.X
 *   issue.get("X")?.first()?.name  → issue.X[0].name
 *   issue.getRawValue("X")?.optionId → issue.X.id
 *   == / !=                        → == / !=
 *   && / ||                        → && / ||
 *
 * Multi-line scripts with `def`/`return` get preserved verbatim plus a marker.
 */
function groovyExpressionToJiraExpression(text, location = [], ctx = null) {
  const problems = [];
  if (typeof text !== "string" || !text) return { output: text || "", problems };
  const original = text;

  let out = text;

  // Strip `${...}` wrappers (some DC configs wrap the whole expression).
  out = out.replace(/^\s*\$\{\s*([\s\S]+?)\s*\}\s*$/, "$1");

  // Strip CMA's "field id missing on Cloud" comment markers — they break the
  // field-access path syntactically. We resolve the bare ID and let Cloud
  // surface the missing-field separately.
  out = out.replace(/\/\*\s*custom field ID missing on Cloud\s*\*\//g, "");

  // issue.get("X")?.first()?.<prop>  →  issue.X[0].<prop>  (.optionId → .id)
  // Greedy chain handler — captures any sequence of `?.` or `.` accessors
  // after the get() call.
  //
  // For object-typed system fields read via `getAsString` with no further
  // accessor, Jira Expressions need an explicit accessor on the resulting
  // object — `issue.project` is a Project (not a string), so a comparison
  // like `issue.project == "BUILD"` always evaluates false. Append the
  // canonical accessor: `.key` for project, `.name` for status/priority/
  // resolution/issuetype, `.displayName` for user fields. Operators that
  // wrote `issue.get("project").key` already provide the accessor; we only
  // add it when the chain is empty.
  const SYS_OBJECT_FIELDS_NAME = new Set(["status","priority","resolution","issuetype"]);
  const SYS_USER_FIELDS = new Set(["creator","reporter","assignee"]);
  const SYS_TOPLEVEL = { issuekey: "key", key: "key", id: "id" };
  out = out.replace(
    /\bissue\s*\.\s*get(AsString|AsHtml|RawValue)?\s*\(\s*["']([^"']+)["']\s*\)((?:\s*\??\.\s*\w+\s*(?:\(\s*\))?)*)/g,
    (_m, which, fieldId, chain) => {
      let path;
      if (Object.prototype.hasOwnProperty.call(SYS_TOPLEVEL, fieldId)) {
        path = `issue.${SYS_TOPLEVEL[fieldId]}`;
      } else {
        // Route through jiraExprFieldRef so DC customfield IDs get remapped to
        // Cloud IDs at emit. Without this, the raw DC ID flows through and the
        // Cloud rule references a non-existent field.
        path = jiraExprFieldRef(fieldId, ctx, problems, location);
      }
      // Convert chain like `?.first()?.name` or `.first().name` to `[0].name`
      const tokens = [];
      const re = /\??\.\s*(\w+)(\s*\(\s*\))?/g;
      let mm;
      while ((mm = re.exec(chain)) !== null) {
        const prop = mm[1];
        if (prop === "first") { tokens.push("[0]"); continue; }
        if (prop === "optionId") { tokens.push(".id"); continue; }
        tokens.push("." + prop);
      }
      // Auto-add a stringy accessor when the operator used getAsString on an
      // object-typed system field with no further chain. We do NOT add it
      // for plain `get()` because that could change semantics — a DC author
      // who wrote `issue.get("project") == "X"` was already comparing an
      // object to a string (always false on DC); silently fixing it would
      // change behavior. getAsString explicitly returns a string in DC, so
      // adding the accessor preserves intent.
      if (which === "AsString" && tokens.length === 0) {
        if (fieldId === "project") path += ".key";
        else if (SYS_OBJECT_FIELDS_NAME.has(fieldId)) path += ".name";
        else if (SYS_USER_FIELDS.has(fieldId)) path += ".displayName";
      }
      return path + tokens.join("");
    },
  );

  // ${currentUser.<prop>} → user.<prop>
  out = out.replace(/\bcurrentUser\b(?:\s*\.\s*(\w+))?/g, (_m, prop) =>
    prop ? `user.${prop}` : "user");

  // Strip remaining safe-navigation operators left over by CMA when there's
  // no right-hand chain (e.g. `issue.reporter?.emailAddress` kept as-is by
  // some CMA exports). Jira Expressions don't support `?.`; the operands are
  // already null-safe in JE so we can simply drop the question mark.
  out = out.replace(/\?\s*\.\s*/g, ".");

  // Normalise whitespace and trim.
  out = out.replace(/\s+/g, " ").trim();

  // User-object equality fix: `user == issue.reporter` etc. compare by object
  // identity in Jira Expressions, not user identity. Rewrite both sides to
  // `.accountId`. Targets only patterns that actually need it; null
  // comparisons and already-`.accountId` forms are left alone.
  const userCmp = normalizeUserComparisons(out);
  if (userCmp.changes.length) out = userCmp.output;

  // Detect remaining un-translatable Groovy:
  //   def / return / multi-line / regex literals (=~) / switch-case
  const looksLikeScript =
    /\b(?:def|return)\b/.test(out) ||
    /=~/.test(out) ||
    /\bswitch\s*\(/.test(out) ||
    /\$\{[^}]*\}/.test(out);
  if (looksLikeScript) {
    problems.push({ type: "GroovyScriptToJiraExpression", location });
  }
  if (hasInsightContent(out)) {
    problems.push({ type: "OptionNotSupported", location: [...location, "Insight/Assets reference"] });
  }
  // Dedup problem entries.
  const seen = new Set();
  const dedup = problems.filter((p) => {
    const k = JSON.stringify(p);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { output: out, problems: dedup, translated: out !== original };
}

/**
 * Marker helper — always produce a `problems[]` entry the operator can search
 * for. CMA uses these exact `type` values in its own output.
 */
function markerFor(type, location = []) {
  return { type, location };
}

// System fields that JMWE Cloud's Nunjucks engine resolves via dot notation
// because the property name IS the field name (e.g. `issue.fields.summary`,
// `issue.fields.priority`). Custom fields are NOT in this list — they require
// bracket-notation display-name lookups: `issue.fields["Raised By"]`.
const NUNJUCKS_DOT_OK_SYSTEM_FIELDS = new Set([
  "summary", "description", "priority", "status", "resolution", "assignee",
  "reporter", "creator", "issuetype", "project", "labels", "components",
  "fixVersions", "versions", "duedate", "environment", "comment", "created",
  "updated", "resolutiondate", "watches", "votes", "issuelinks", "attachment",
  "subtasks", "parent", "timeestimate", "timeoriginalestimate", "timespent",
  "aggregatetimeestimate", "aggregatetimespent", "workratio", "security",
  "progress", "aggregateprogress", "lastViewed",
]);

/**
 * Build the root path for an `issue.fields[…]` reference in a Nunjucks
 * template. JMWE Cloud's Nunjucks engine resolves customfield references via
 * the field's DISPLAY NAME, not its ID — `issue.fields.customfield_10389`
 * silently evaluates to undefined while `issue.fields["Raised By"]` works.
 *
 * Algorithm:
 *   1. Apply the DC→Cloud field-ID remap (ctx.fieldRemapping). The translator
 *      receives the raw DC ID from the source Groovy text; if we don't remap,
 *      the cloud-side template references a non-existent DC field ID.
 *   2. For non-customfields (system fields): emit `issue.fields.<id>` (dot
 *      notation works because the property name IS the field name).
 *   3. For customfields: look up the display name in ctx.cloudFieldNames
 *      (built from /rest/api/3/field at apply time). If found, emit
 *      `issue.fields["<Display Name>"]` with bracket notation. If not found,
 *      emit `issue.fields["customfield_NNNNN"]` and push an UnresolvedFieldName
 *      problem so the rule lands in manual-review.
 *
 * `problems` is the caller's accumulator; we push to it directly so the
 * UnresolvedFieldName marker travels with the rule.
 */
function nunjucksFieldRef(rawFieldId, ctx, problems, location) {
  if (!rawFieldId) return "issue.fields";
  const rid = String(rawFieldId);
  const cloudId = (ctx && ctx.fieldRemapping && ctx.fieldRemapping[rid]) || rid;
  if (!cloudId.startsWith("customfield_")) {
    if (NUNJUCKS_DOT_OK_SYSTEM_FIELDS.has(cloudId)) return `issue.fields.${cloudId}`;
    // Unknown non-customfield identifier — still safe under dot notation
    // (matches prior behaviour). System fields outside the allow-list go here.
    return `issue.fields.${cloudId}`;
  }
  const name = ctx && ctx.cloudFieldNames && ctx.cloudFieldNames[cloudId];
  if (name) {
    // Single-quote literal when the name doesn't contain an apostrophe; fall
    // back to JSON.stringify (double-quoted with escapes) when it does.
    const lit = /'/.test(name) ? JSON.stringify(name) : `'${name}'`;
    return `issue.fields[${lit}]`;
  }
  // Unresolved customfield — emit syntactically-valid bracket form with the
  // ID so the operator can find and fix it, and flag it.
  if (problems) {
    problems.push({
      type: "UnresolvedFieldName",
      location: Array.isArray(location) ? [...location, cloudId] : [cloudId],
    });
  }
  return `issue.fields['${cloudId}']`;
}

/**
 * Walk a Groovy accessor chain (the part after `issue.get("X")`) and produce
 * the Nunjucks-equivalent {tokens, filters, formatArg}. Returns null when any
 * segment can't be safely translated — caller bails and the residue detector
 * picks up the original snippet.
 *
 * Recognised methods:
 *   .first()        → [0]
 *   .optionId       → .id
 *   .format("FMT")  → formatArg (caller emits | dateformat)
 *   .toString()     → | string
 *   .length / .length() → | length
 *   .toLowerCase() → | lower
 *   .toUpperCase() → | upper
 *   .trim()         → | trim
 *   .replace("a","b") → | replace("a", "b")  (both args must be string literals)
 *   .substring(n)   → .slice(n)              (JS slice has identical semantics
 *                                              for non-negative ints)
 *   .substring(a,b) → .slice(a, b)
 *   .<bareProp>     → .<bareProp>
 *
 * Anything else (method with non-literal args, unrecognised method, regex
 * arg to replace, etc.) returns null.
 */
function parseChainForNunjucks(chain, opts = {}) {
  // `methodForm: true` emits everything as JS-method-call tokens (no filters)
  // — needed when the chain lives inside a `{% set %}` RHS or any other
  // expression context where the Nunjucks filter pipe isn't available.
  // JMWE Cloud's Nunjucks engine evaluates JS string methods directly, so
  // `obj.toLowerCase()` and `obj.slice(n)` work as expected.
  const methodForm = !!opts.methodForm;
  const result = { tokens: [], filters: [], formatArg: null };
  if (!chain) return result;
  const trimmed = chain.trim();
  if (!trimmed) return result;
  const re = /\s*\??\.\s*(\w+)\s*(\(\s*((?:"[^"]*"|'[^']*'|[^()]+)?)\s*\))?/y;
  let pos = 0;
  while (pos < trimmed.length) {
    re.lastIndex = pos;
    const m = re.exec(trimmed);
    if (!m) return null;
    const prop = m[1];
    const hasParens = m[2] !== undefined;
    const args = m[3] == null ? "" : m[3].trim();
    if (!hasParens) {
      if (prop === "optionId") result.tokens.push(".id");
      else if (prop === "length") {
        if (methodForm) result.tokens.push(".length");
        else result.filters.push("length");
      }
      else result.tokens.push("." + prop);
    } else if (prop === "first" && args === "") {
      result.tokens.push("[0]");
    } else if (prop === "format" && args) {
      const am = args.match(/^["']([^"']*)["']$/);
      if (!am) return null;
      result.formatArg = am[1];
    } else if (prop === "toString" && args === "") {
      if (methodForm) result.tokens.push(".toString()");
      else result.filters.push("string");
    } else if (prop === "length" && args === "") {
      if (methodForm) result.tokens.push(".length");
      else result.filters.push("length");
    } else if (prop === "toLowerCase" && args === "") {
      if (methodForm) result.tokens.push(".toLowerCase()");
      else result.filters.push("lower");
    } else if (prop === "toUpperCase" && args === "") {
      if (methodForm) result.tokens.push(".toUpperCase()");
      else result.filters.push("upper");
    } else if (prop === "trim" && args === "") {
      if (methodForm) result.tokens.push(".trim()");
      else result.filters.push("trim");
    } else if (prop === "replace") {
      const rm = args.match(/^(["'])((?:[^"'\\]|\\.)*)\1\s*,\s*(["'])((?:[^"'\\]|\\.)*)\3$/);
      if (!rm) return null;
      if (methodForm) {
        result.tokens.push(`.replace(${rm[1]}${rm[2]}${rm[1]}, ${rm[3]}${rm[4]}${rm[3]})`);
      } else {
        result.filters.push(`replace(${rm[1]}${rm[2]}${rm[1]}, ${rm[3]}${rm[4]}${rm[3]})`);
      }
    } else if (prop === "replaceAll") {
      // Groovy `.replaceAll(pattern, repl)` takes a regex; JS String has
      // .replaceAll(string|regex, repl). We accept string-pattern args here;
      // regex-arg shapes are too risky to auto-translate (Nunjucks regex
      // syntax differs from Groovy) — bail and let the residue detector
      // pick up the original.
      const rm = args.match(/^(["'])((?:[^"'\\]|\\.)*)\1\s*,\s*(["'])((?:[^"'\\]|\\.)*)\3$/);
      if (!rm) return null;
      if (methodForm) {
        result.tokens.push(`.replaceAll(${rm[1]}${rm[2]}${rm[1]}, ${rm[3]}${rm[4]}${rm[3]})`);
      } else {
        result.filters.push(`replace(${rm[1]}${rm[2]}${rm[1]}, ${rm[3]}${rm[4]}${rm[3]})`);
      }
    } else if (prop === "tokenize" && args === "") {
      // Groovy `.tokenize()` splits on whitespace. JMWE Cloud's Nunjucks
      // supports `.split()` JS method; emit as `.split(/\s+/)`. Since
      // Nunjucks-style regex literals can be tricky, fall back to
      // `.split(" ")` which is the most-common operator intent.
      if (methodForm) result.tokens.push('.split(" ")');
      else return null;
    } else if (prop === "tokenize" && args) {
      const rm = args.match(/^(["'])((?:[^"'\\]|\\.)*)\1$/);
      if (!rm) return null;
      if (methodForm) result.tokens.push(`.split(${rm[1]}${rm[2]}${rm[1]})`);
      else return null;
    } else if (prop === "substring") {
      const parts = args.split(",").map((s) => s.trim());
      if (parts.length === 1 && /^\d+$/.test(parts[0])) {
        result.tokens.push(`.slice(${parts[0]})`);
      } else if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
        result.tokens.push(`.slice(${parts[0]}, ${parts[1]})`);
      } else {
        return null;
      }
    } else {
      return null;
    }
    pos = re.lastIndex;
  }
  return result;
}

/**
 * Build a custom-field reference for a JIRA EXPRESSION (used by
 * connect:expression-condition and connect:expression-validator rules).
 *
 * Per Atlassian's Jira Expressions reference, custom fields are accessed
 * by Cloud ID directly on `issue` — `issue.customfield_10010`. Display-name
 * access is NOT supported (unlike JMWE Cloud's Nunjucks engine, which
 * resolves by name). System fields are exposed at the top level
 * (`issue.summary`, `issue.priority`).
 *
 * Algorithm:
 *   1. Apply ctx.fieldRemapping (DC ID → Cloud ID). If the source Groovy
 *      embedded a DC ID, we MUST remap before emit — the DC ID will not
 *      exist on Cloud.
 *   2. System field → `issue.<id>` (no `.fields` segment).
 *   3. customfield_NNNNN → `issue.customfield_<cloudId>` (dot form).
 *   4. Unresolved customfield (no remap entry) → emit bracket form so the
 *      expression remains syntactically valid, and push UnresolvedFieldId
 *      so the rule lands in manual-review.
 */
function jiraExprFieldRef(rawFieldId, ctx, problems, location) {
  if (!rawFieldId) return "issue";
  const rid = String(rawFieldId);
  const cloudId = (ctx && ctx.fieldRemapping && ctx.fieldRemapping[rid]) || rid;
  if (!cloudId.startsWith("customfield_")) {
    // System field — JE exposes them directly on `issue`, not `issue.fields`.
    return `issue.${cloudId}`;
  }
  // Detect "DC ID with no remapping found" — the lookup returned the same
  // value, AND the value is not in cloudFieldNames (so it's not already a
  // Cloud ID that happens to match). Flag for manual review.
  const isUnresolved =
    cloudId === rid &&
    !(ctx && ctx.fieldRemapping && Object.prototype.hasOwnProperty.call(ctx.fieldRemapping, rid)) &&
    !(ctx && ctx.cloudFieldNames && ctx.cloudFieldNames[rid]);
  if (isUnresolved && problems) {
    problems.push({
      type: "UnresolvedFieldId",
      location: Array.isArray(location) ? [...location, rid] : [rid],
    });
  }
  return `issue.${cloudId}`;
}

// ──────────────────────────────────────────────
//  Targeted translators for the residual 37 disabled rules
// ──────────────────────────────────────────────

/**
 * When a SetFieldValueFunction.value is the WHOLE Groovy expression (no
 * surrounding template text), wrap it as a Nunjucks template. Handles:
 *   issue.getAsString("X")             → {{ issue.fields.X }}
 *   issue.getAsString("X") + " " + Y   → {{ issue.fields.X }} {{ Y }}
 *   currentUser.name                   → {{ user.name }}
 *   issue.get("X")?.first()?.name      → {{ issue.fields.X[0].name }}
 *
 * For object-typed system fields (status, priority, resolution, issuetype,
 * project), `getAsString` returns the .name internally — Nunjucks needs
 * `.name` made explicit on the field reference.
 */
function groovyValueExpressionToNunjucks(text, location = [], ctx = null) {
  const problems = [];
  if (typeof text !== "string" || !text) return { output: text || "", problems, translated: false };
  // Skip if it doesn't look like a single Groovy expression (presence of
  // newlines/`def`/`return` / `;` indicates multi-statement script).
  const trimmed = text.trim();
  if (!trimmed) return { output: text, problems, translated: false };
  if (/[\n;]/.test(trimmed) || /\b(?:def|return)\b/.test(trimmed)) {
    return { output: text, problems, translated: false };
  }
  if (!hasGroovyContent(trimmed) && !/\bcurrentUser\b/.test(trimmed)) {
    return { output: text, problems, translated: false };
  }

  // Object-typed system fields where `getAsString` semantics imply `.name`.
  const SYS_OBJECT_FIELDS = new Set(["status","priority","resolution","issuetype","project"]);
  // DC field names whose Cloud Nunjucks equivalent is at issue.<key>, not
  // issue.fields.<key> (top-level convenience properties JMWE Cloud exposes).
  const SYS_TOPLEVEL = { issuekey: "key", key: "key", id: "id" };
  // User-object system fields — `getAsString` returns the username on DC; on
  // Cloud Nunjucks the user-friendly read is `.displayName`.
  const SYS_USER_FIELDS = new Set(["creator","reporter","assignee"]);

  // Translate one expression atom (no operators) to a Nunjucks variable.
  const atomToNunjucks = (atom) => {
    atom = atom.trim();
    // String literal — pass through as-is (Nunjucks handles inside {{ "x" }})
    if (/^"[^"]*"$/.test(atom) || /^'[^']*'$/.test(atom)) return atom;
    // currentUser[.prop]
    let m = atom.match(/^currentUser(?:\s*\.\s*(\w+))?$/);
    if (m) return m[1] ? `user.${m[1]}` : "user";
    // issue.get|getAsString|getAsHtml|getRawValue("X")<chain>
    m = atom.match(/^issue\s*\.\s*get(AsString|AsHtml|RawValue)?\s*\(\s*["']([^"']+)["']\s*\)((?:\s*\??\.\s*\w+\s*(?:\(\s*[^()]*\s*\))?)*)$/);
    if (m) {
      const which = m[1] || "get";
      const fieldId = m[2];
      const chain = m[3] || "";
      const parsed = parseChainForNunjucks(chain);
      if (!parsed) return null;
      let path;
      if (Object.prototype.hasOwnProperty.call(SYS_TOPLEVEL, fieldId)) {
        path = `issue.${SYS_TOPLEVEL[fieldId]}`;
      } else {
        path = nunjucksFieldRef(fieldId, ctx, problems, location);
      }
      // For getAsString on object-typed system fields, append .name.
      if (which === "AsString" && parsed.tokens.length === 0 && parsed.filters.length === 0 && SYS_OBJECT_FIELDS.has(fieldId)) {
        path += ".name";
      }
      // Same heuristic for user fields — surface displayName for getAsString.
      if (which === "AsString" && parsed.tokens.length === 0 && parsed.filters.length === 0 && SYS_USER_FIELDS.has(fieldId)) {
        path += ".displayName";
      }
      // Caller wraps in {{ }}; we return the raw expression path here. Filter
      // pipe (if any) gets folded into the caller's {{ ... | default("") }}
      // emit. To keep the contract simple, we encode filters by appending
      // ` | f1 | f2` to the returned string — caller's wrap will produce
      // `{{ ${nunj} | default("") }}`, yielding `{{ acc | f | default("") }}`.
      const acc = path + parsed.tokens.join("");
      if (parsed.filters.length === 0 && !parsed.formatArg) return acc;
      const pipes = [];
      if (parsed.formatArg) pipes.push(`dateformat("${parsed.formatArg}")`);
      pipes.push(...parsed.filters);
      return acc + " | " + pipes.join(" | ");
    }
    // issue.<prop>
    m = atom.match(/^issue\s*\.\s*(\w+)$/);
    if (m) return `issue.${m[1]}`;
    return null;
  };

  // Split top-level on `+` (string concatenation in Groovy). Quotes-aware.
  const splitTopLevel = (s) => {
    const parts = [];
    let buf = "";
    let depth = 0;
    let inStr = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { buf += ch; if (ch === inStr && s[i-1] !== "\\") inStr = null; continue; }
      if (ch === "'" || ch === '"') { inStr = ch; buf += ch; continue; }
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      if (ch === "+" && depth === 0) {
        parts.push(buf);
        buf = "";
        continue;
      }
      buf += ch;
    }
    parts.push(buf);
    return parts.map((p) => p.trim()).filter(Boolean);
  };

  const parts = splitTopLevel(trimmed);
  const out = [];
  for (const p of parts) {
    const nunj = atomToNunjucks(p);
    if (nunj == null) {
      // Failed to translate one atom — bail.
      return { output: text, problems, translated: false };
    }
    if (/^"[^"]*"$/.test(nunj) || /^'[^']*'$/.test(nunj)) {
      // String literal — render as raw text (without surrounding quotes).
      out.push(nunj.slice(1, -1));
    } else {
      out.push(`{{ ${nunj} | default("") }}`);
    }
  }
  problems.push({ type: "GroovyTemplateToNunjucks", location });
  return { output: out.join(""), problems, translated: true };
}

/**
 * Find the index of the `)` that closes the `(` at openIdx in s. Aware of
 * string literals so quoted parens don't confuse the depth count. Returns
 * -1 if no match.
 */
function findMatchingClose(s, openIdx) {
  let depth = 1;
  let inStr = null;
  for (let i = openIdx + 1; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === inStr && s[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Parse `if ( COND ) [return] A else [return] B` into { cond, ifBranch,
 * elseBranch } using a paren-balanced split (so nested `()` inside the
 * condition don't confuse the parser).
 */
function parseIfElseGroovy(src) {
  const trimmed = src.replace(/\s+/g, " ").trim();
  const m = trimmed.match(/^if\s*\(/);
  if (!m) return null;
  const openIdx = m[0].length - 1; // position of `(`
  const closeIdx = findMatchingClose(trimmed, openIdx);
  if (closeIdx === -1) return null;
  const cond = trimmed.slice(openIdx + 1, closeIdx).trim();
  let rest = trimmed.slice(closeIdx + 1).trim();
  // Optional `return ` on the if-branch.
  if (rest.startsWith("return ")) rest = rest.slice("return ".length).trim();
  const elseIdx = (() => {
    // Find ` else ` not inside parens/quotes.
    let depth = 0, inStr = null;
    for (let i = 0; i < rest.length - 4; i++) {
      const ch = rest[i];
      if (inStr) { if (ch === inStr && rest[i - 1] !== "\\") inStr = null; continue; }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (depth === 0 && rest.slice(i, i + 6) === " else ") return i;
    }
    return -1;
  })();
  if (elseIdx === -1) return null;
  const ifBranch = rest.slice(0, elseIdx).trim();
  let elseBranch = rest.slice(elseIdx + 6).trim();
  if (elseBranch.startsWith("return ")) elseBranch = elseBranch.slice("return ".length).trim();
  return { cond, ifBranch, elseBranch };
}

/**
 * Translate `if (cond) return X else (return Y | Y | false | true)` to a
 * Jira Expression. Used by ScriptedValidator/Condition.
 */
function groovyImperativeToJiraExpression(text, location = [], ctx = null) {
  const problems = [];
  if (typeof text !== "string" || !text) return { output: text || "", problems, translated: false };
  let src = text.replace(/\/\*\s*custom field ID missing on Cloud\s*\*\//g, "");
  const parsed = parseIfElseGroovy(src);
  if (!parsed) return { output: text, problems, translated: false };
  const { cond, ifBranch, elseBranch } = parsed;
  // Translate the condition and branches as JE expressions.
  const jeCond = groovyExpressionToJiraExpression(cond, location, ctx);
  const jeIf = groovyExpressionToJiraExpression(ifBranch, location, ctx);
  const jeElse = groovyExpressionToJiraExpression(elseBranch, location, ctx);
  if (!isCleanJiraExpression(jeCond.output) || !isCleanJiraExpression(jeIf.output) || !isCleanJiraExpression(jeElse.output)) {
    return { output: text, problems, translated: false };
  }
  // Special-case `if (X) return false else return true` → `!(X)`
  if (jeIf.output === "false" && jeElse.output === "true") {
    problems.push({ type: "GroovyScriptToJiraExpression", location });
    return { output: `!(${jeCond.output})`, problems, translated: true };
  }
  if (jeIf.output === "true" && jeElse.output === "false") {
    problems.push({ type: "GroovyScriptToJiraExpression", location });
    return { output: jeCond.output, problems, translated: true };
  }
  // General ternary
  problems.push({ type: "GroovyScriptToJiraExpression", location });
  return { output: `(${jeCond.output}) ? (${jeIf.output}) : (${jeElse.output})`, problems, translated: true };
}

/**
 * Translate `if (cond) return X else (return Y | Y | false)` to a Nunjucks
 * template. Used by SetFieldValueFunction.value (and others). Falls back to
 * single-expression handling when the input isn't an if/else.
 */
function groovyImperativeToNunjucks(text, location = [], ctx = null) {
  if (typeof text !== "string" || !text) return { output: text || "", problems: [], translated: false };
  let src = text.replace(/\/\*\s*custom field ID missing on Cloud\s*\*\//g, "");
  const parsed = parseIfElseGroovy(src);
  if (!parsed) return { output: text, problems: [], translated: false };
  const cond = parsed.cond;
  const ifB = parsed.ifBranch;
  const elB = parsed.elseBranch;
  const condJE = groovyExpressionToJiraExpression(cond, location, ctx);
  const ifNunj = groovyValueExpressionToNunjucks(ifB, location, ctx);
  const elNunj = groovyValueExpressionToNunjucks(elB, location, ctx);
  if (!isCleanJiraExpression(condJE.output)) return { output: text, problems: [], translated: false };
  // Branches: prefer Nunjucks template if it translated; otherwise treat as
  // literal text (e.g., "false", "true", quoted string, bare value).
  const branchOut = (b, nunjResult) => {
    if (nunjResult.translated) return nunjResult.output;
    if (/^"[^"]*"$/.test(b) || /^'[^']*'$/.test(b)) return b.slice(1, -1);
    return b;
  };
  const ifText = branchOut(ifB, ifNunj);
  const elText = branchOut(elB, elNunj);
  return {
    output: `{% if ${condJE.output} %}${ifText}{% else %}${elText}{% endif %}`,
    problems: [{ type: "GroovyTemplateToNunjucks", location }],
    translated: true,
  };
}

/**
 * Translate JSP-style `<%= ... %>` scriptlets to Nunjucks.
 * Used by EmailIssueFunction.subject/textBody/htmlBody.
 */
function jspScriptletToNunjucks(text, location = [], ctx = null) {
  if (typeof text !== "string" || !text) return { output: text || "", problems: [], translated: false };
  let translated = false;
  const out = text.replace(/<%=?([\s\S]+?)%>/g, (_m, body) => {
    translated = true;
    const nunj = groovyValueExpressionToNunjucks(body.trim(), location, ctx);
    if (nunj.translated) return nunj.output;
    // Fallback: best-effort atom translation.
    return `{{ ${body.trim().replace(/\bissue\.(\w+)/g, "issue.$1")} | default("") }}`;
  });
  return {
    output: out,
    problems: translated ? [{ type: "GroovyTemplateToNunjucks", location }] : [],
    translated,
  };
}

/**
 * Insight (Assets) email-attribute lookup translator. Multiple DC tenants use
 * a small family of Groovy snippets to read the "Email" attribute (or any
 * attribute) of an Insight object referenced by a customfield, optionally
 * stripping `[...]` brackets when the attribute renders as a list. The
 * patterns we cover:
 *
 *   ${issue.get("X")?.first()?.getInsightAttributeValue("Y")}
 *   ${ def Value = issue.get("X")?.first()?.getInsightAttributeValue("Y").toString();
 *      if (Value.contains("[")) { Value.substring(1, Value.length() - 1) }
 *      else { return Value } }
 *   <%= def Value = issue.get("X")?.first()?.getInsightAttributeValue("Y").toString();
 *       Value.substring(1, Value.length() - 1); return Value %>
 *
 * All translate to a single Nunjucks expression that reads the attribute's
 * first value. JMWE Cloud + Atlassian Assets exposes Insight attributes as
 * `issue.fields.<cf>[0].attributes.<name>[0].value`. When the original
 * stripped brackets, we layer JMWE's `replace` filter on top so the rendered
 * text matches what DC produced.
 *
 * Always emits an `OptionNotSupported`/Assets marker so the operator can
 * verify the attribute path matches their actual Cloud Assets schema.
 */
function groovyInsightEmailToNunjucks(text, location = [], ctx = null) {
  if (typeof text !== "string" || !text) return { output: text || "", problems: [], translated: false };

  // Normalise CMA's invisible-separator inerted templates back to real ${...}.
  let src = text.replace(/\$[​-‍⁠-⁯﻿]+\{/g, "${");

  if (!hasInsightContent(src)) return { output: text, problems: [], translated: false };

  // Capture the Insight call. Field ID is in customfield_NNNN (or any custom
  // ID), attribute name is a string literal.
  const insightRe = /issue\s*\.\s*get(?:AsString|AsHtml|RawValue)?\s*\(\s*["']([^"']+)["']\s*\)\s*\??\.\s*first\s*\(\s*\)\s*\??\.\s*getInsightAttributeValue\s*\(\s*["']([^"']+)["']\s*\)/;
  const m = insightRe.exec(src);
  if (!m) return { output: text, problems: [], translated: false };
  const fieldId = m[1];
  const attrName = m[2];

  // Detect `Value.substring(1, Value.length() - 1)` or `if (Value.contains("[")) { ... }`
  // — both indicate operator wanted brackets stripped from the multi-value
  // rendering. Apply replace filters to match.
  const wantsBracketStrip = /substring\s*\(\s*1\s*,\s*\w+\s*\.\s*length\s*\(\s*\)\s*-\s*1\s*\)/.test(src) ||
    /contains\s*\(\s*["']\[["']\s*\)/.test(src);

  const problems = [
    { type: "GroovyTemplateToNunjucks", location },
    { type: "OptionNotSupported", location: [...location, "Insight/Assets attribute path"] },
  ];
  const fieldRoot = nunjucksFieldRef(fieldId, ctx, problems, location);
  let attrPath = `${fieldRoot}[0].attributes.${attrName}[0].value`;
  if (wantsBracketStrip) {
    attrPath = `${attrPath} | replace("[","") | replace("]","")`;
  }
  return { output: `{{ ${attrPath} | default("") }}`, problems, translated: true };
}

/**
 * Translate a multi-switch "risk-score calculator" Groovy script to a
 * Nunjucks template. This is the CHANGE: Emergency/Normal/Standard Change
 * pattern — N `String <var> = issue.getRawValue("customfield_X")?.optionId`
 * declarations followed by N `switch(<var>) { case "Y": <scoreVar> = N; break; }`
 * blocks and a final `total = a+b+...; return (total)` reducer.
 *
 * The translation strategy:
 *   1. Walk the script line-by-line, collecting the set of (var → fieldId)
 *      mappings (the `String` lines) and the score variables (`int <name>`).
 *   2. For each `switch(var)` block, emit a `{% set scoreVar = 0 %}`
 *      followed by `{% if issue.fields.<fieldId>.id == "case" %}{% set ... %}`
 *      `{% elif ... %}` ... `{% endif %}` chain.
 *   3. For the reducer line `total = a+b+c+...`, capture the addends.
 *   4. For the final `return (total)` (or `return total`), emit `{{ a+b+c+... }}`.
 *
 * If the script doesn't match the structure the translator returns translated
 * false unchanged — no half-translations.
 */
function groovyScoreCalculatorToNunjucks(text, location = [], ctx = null) {
  if (typeof text !== "string" || !text) return { output: text || "", problems: [], translated: false };
  // The pattern is multi-line and bulky, so do a quick screening test first.
  if (!/^\s*String\s+\w+\s*=\s*issue\s*\.\s*getRawValue\s*\(/m.test(text)) {
    return { output: text, problems: [], translated: false };
  }
  if (!/\bswitch\s*\(\s*\w+\s*\)\s*\{/.test(text)) {
    return { output: text, problems: [], translated: false };
  }

  // 1) Collect String var → fieldId mappings.
  const varToField = new Map();
  const reStr = /^\s*String\s+(\w+)\s*=\s*issue\s*\.\s*getRawValue\s*\(\s*["']([^"']+)["']\s*\)\s*\??\.\s*optionId\s*$/gm;
  let m;
  while ((m = reStr.exec(text)) !== null) {
    varToField.set(m[1], m[2]);
  }
  if (varToField.size === 0) return { output: text, problems: [], translated: false };

  // 2) Collect int score variables (just to know their names — initial value 0).
  const scoreVars = new Set();
  const reInt = /^\s*int\s+(\w+)\s*$/gm;
  while ((m = reInt.exec(text)) !== null) scoreVars.add(m[1]);

  // 3) Walk switch blocks. A switch block looks like:
  //    switch(varName) {
  //      case "ID1": scoreVar = N; break;
  //      case "ID2": scoreVar = N; break;
  //      ...
  //    }
  // We capture the var, then iterate cases, expecting all cases to set the
  // SAME score variable. If they don't, we conservatively bail.
  const switchBlocks = []; // [{ var, fieldId, scoreVar, cases: [{caseValue, score}] }]
  const reSwitch = /switch\s*\(\s*(\w+)\s*\)\s*\{([\s\S]*?)\}/g;
  while ((m = reSwitch.exec(text)) !== null) {
    const sv = m[1];
    const body = m[2];
    const fieldId = varToField.get(sv);
    if (!fieldId) return { output: text, problems: [], translated: false };
    const cases = [];
    let scoreVar = null;
    const reCase = /case\s+["']([^"']+)["']\s*:\s*(\w+)\s*=\s*(-?\d+)\s*;\s*break\s*;/g;
    let cm;
    while ((cm = reCase.exec(body)) !== null) {
      const [, caseValue, sVar, score] = cm;
      if (scoreVar == null) scoreVar = sVar;
      else if (scoreVar !== sVar) return { output: text, problems: [], translated: false };
      cases.push({ caseValue, score: parseInt(score, 10) });
    }
    if (!scoreVar || cases.length === 0) return { output: text, problems: [], translated: false };
    switchBlocks.push({ var: sv, fieldId, scoreVar, cases });
  }
  if (switchBlocks.length === 0) return { output: text, problems: [], translated: false };

  // 4) Find the reducer: `total = a+b+c+...` (whitespace/newlines-tolerant)
  // and the trailing `return (total)` or `return total`.
  // The reducer's RHS is a sum of int variables; capture them in order.
  const reRet = /return\s*\(?\s*(\w+)\s*\)?\s*$/m;
  const retMatch = reRet.exec(text);
  if (!retMatch) return { output: text, problems: [], translated: false };
  const totalVar = retMatch[1];

  // Find the assignment `totalVar = a + b + c + ...`. The expression can span
  // multiple lines with trailing `+`. Locate the assignment, then slice off
  // everything up to the first terminator (blank line, `return`, `//`,
  // or end of input). Avoid the `m` flag's `$` per-line behaviour by doing
  // this manually.
  const assignRe = new RegExp(`(?:^|\\n)\\s*(?:int\\s+)?${totalVar}\\s*=\\s*`);
  const assignStart = assignRe.exec(text);
  if (!assignStart) return { output: text, problems: [], translated: false };
  const exprStart = assignStart.index + assignStart[0].length;
  // Find the next terminator from exprStart.
  const tail = text.slice(exprStart);
  const terminators = [
    /\n\s*\n/,
    /\n\s*return\b/,
    /\n\s*\/\//,
  ];
  let endIdx = tail.length;
  for (const t of terminators) {
    const m2 = t.exec(tail);
    if (m2 && m2.index < endIdx) endIdx = m2.index;
  }
  const exprText = tail.slice(0, endIdx);
  const addends = exprText
    .split(/\+/)
    .map((s) => s.replace(/[\s\n]+/g, "").trim())
    .filter(Boolean);
  if (addends.length === 0) return { output: text, problems: [], translated: false };
  // Each addend should be a known score variable.
  const knownVars = new Set([...scoreVars, ...switchBlocks.map((b) => b.scoreVar)]);
  for (const a of addends) {
    if (!knownVars.has(a)) return { output: text, problems: [], translated: false };
  }

  // 5) Emit Nunjucks. JMWE Cloud's templating supports `{% set %}`, `{% if %}`,
  // `{% elif %}`, `{% else %}`, `{% endif %}` (Nunjucks). Cumulative side-effect
  // works because Nunjucks `set` mutates the same scope across blocks within a
  // single template render.
  const lines = [];
  const switchProblems = [];
  for (const blk of switchBlocks) {
    lines.push(`{% set ${blk.scoreVar} = 0 %}`);
    const fieldRoot = nunjucksFieldRef(blk.fieldId, ctx, switchProblems, location);
    for (let i = 0; i < blk.cases.length; i++) {
      const c = blk.cases[i];
      const head = i === 0 ? "if" : "elif";
      lines.push(`{% ${head} ${fieldRoot}.id == "${c.caseValue}" %}{% set ${blk.scoreVar} = ${c.score} %}`);
    }
    lines.push("{% endif %}");
  }
  lines.push(`{{ ${addends.join(" + ")} }}`);

  return {
    output: lines.join("\n"),
    problems: [{ type: "GroovyScriptToNunjucks", location }, ...switchProblems],
    translated: true,
  };
}

/**
 * Repair Nunjucks output produced by an earlier buggy translator that
 * mis-balanced parens inside `{% if %}` tags. Specifically detects
 * `{% if EXPR_OPENING_PAREN_NO_CLOSE %})` patterns and rewrites them to
 * `{% if EXPR %}` form. The original Groovy this came from was
 * `if (issue.get("X")) return issue.getAsString("X") else false` — we
 * synthesise the correct Nunjucks shape directly when we recognise it.
 */
/**
 * Translate a Groovy array-concat expression (used as JMWE CommentIssueFunction
 * comment) to a Nunjucks template. The pattern:
 *
 *   [
 *     "*Issue Details*",
 *     "||Issue Type:||" + issue.getAsString("issuetype") + "||" + "\r\n",
 *     "||Key:||" + issue.get("issuekey") + "||" + "\r\n",
 *     ...
 *   ]
 *
 * JMWE evaluates the Groovy and joins list elements into one string. We turn
 * each element into a Nunjucks line and concatenate them — the resulting
 * template renders the same text the operator intended.
 *
 * Algorithm:
 *   1. Strip the outer `[ ... ]`.
 *   2. Split top-level on `,` (quotes-aware).
 *   3. For each element, split top-level on `+` to recover atoms.
 *   4. Each atom is either a string literal (rendered as-is) or a Groovy
 *      accessor (rendered via `groovyValueExpressionToNunjucks` / a one-shot
 *      atom translator).
 *   5. Concatenate atoms within an element; join elements with empty string.
 */
function groovyArrayConcatToNunjucks(text, location = [], ctx = null) {
  if (typeof text !== "string" || !text) return { output: text || "", problems: [], translated: false };
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) return { output: text, problems: [], translated: false };

  // Detect optional trailing `.join("SEP")`. Some operators write the Groovy
  // as `[a, b, c].join("\n")` — we honour the join separator. Without it the
  // elements are concatenated with no separator.
  let separator = "";
  let arrayInner = null;
  // Find the matching closing `]` (top-level, paren/quote-aware).
  let depth = 0;
  let inStr = null;
  let closeIdx = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inStr) {
      if (ch === inStr && trimmed[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) { closeIdx = i; break; }
    }
  }
  if (closeIdx < 0) return { output: text, problems: [], translated: false };
  arrayInner = trimmed.slice(1, closeIdx).trim();
  const tail = trimmed.slice(closeIdx + 1).trim();
  if (tail) {
    const joinMatch = tail.match(/^\.\s*join\s*\(\s*["']((?:[^"'\\]|\\.)*)["']\s*\)\s*$/);
    if (joinMatch) {
      // Unescape the separator literal.
      separator = joinMatch[1].replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
    } else {
      // Trailing content we don't understand — bail.
      return { output: text, problems: [], translated: false };
    }
  }
  if (!arrayInner) return { output: text, problems: [], translated: false };

  // Top-level comma split (quotes/parens-aware).
  const elements = topLevelSplit(arrayInner, ",");
  if (elements.length === 0) return { output: text, problems: [], translated: false };

  const parts = [];
  for (const elemRaw of elements) {
    const elem = elemRaw.trim();
    if (!elem) continue;
    // Top-level `+` split on this element.
    const atoms = topLevelSplit(elem, "+").map((a) => a.trim()).filter(Boolean);
    let elemOut = "";
    for (const atom of atoms) {
      const t = atomToNunjucks(atom, ctx);
      if (t === null) return { output: text, problems: [], translated: false };
      elemOut += t;
    }
    parts.push(elemOut);
  }
  return {
    output: parts.join(separator),
    problems: [{ type: "GroovyTemplateToNunjucks", location }],
    translated: true,
  };
}

/**
 * Top-level split: split `s` on `delim` only at depth 0 (paren/bracket-aware,
 * quotes-aware). Returns the segments.
 */
function topLevelSplit(s, delim) {
  const out = [];
  let buf = "";
  let depth = 0;
  let inStr = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      buf += ch;
      if (ch === inStr && s[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; buf += ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === delim && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

/**
 * Translate a single Groovy atom (no operators) to a Nunjucks fragment.
 * Returns null when we don't recognise it. The result is text that can be
 * literally concatenated with adjacent atoms (no surrounding quotes for
 * string literals, `{{ ... }}` wrappers for accessors).
 */
function atomToNunjucks(atom, ctx = null) {
  // Whitespace-only / empty
  if (!atom) return "";
  // Double-quoted or single-quoted string literal — strip quotes, unescape.
  let m = atom.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (m) return m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  m = atom.match(/^'((?:[^'\\]|\\.)*)'$/);
  if (m) return m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
  // currentUser[.prop]
  m = atom.match(/^currentUser(?:\s*\.\s*(\w+))?$/);
  if (m) return `{{ user${m[1] ? "." + m[1] : ""} | default("") }}`;
  // issue.get(AsString|AsHtml|RawValue)?("X")<chain>
  m = atom.match(/^issue\s*\.\s*get(AsString|AsHtml|RawValue)?\s*\(\s*["']([^"']+)["']\s*\)((?:\s*\??\.\s*\w+\s*(?:\(\s*[^()]*\s*\))?)*)$/);
  if (m) {
    const which = m[1] || "";
    const fieldId = m[2];
    const chain = m[3] || "";
    const SYS_USERS = new Set(["assignee","reporter","creator"]);
    const parsed = parseChainForNunjucks(chain);
    if (!parsed) return null;
    // For user-typed system fields, DC `.name` returns the username; Cloud's
    // equivalent is `.displayName`. Auto-correct the first chain token.
    if (parsed.tokens[0] === ".name" && SYS_USERS.has(fieldId)) {
      parsed.tokens[0] = ".displayName";
    }
    let path;
    const SYS_TOPLEVEL = { issuekey: "key", key: "key", id: "id" };
    if (Object.prototype.hasOwnProperty.call(SYS_TOPLEVEL, fieldId)) {
      path = `issue.${SYS_TOPLEVEL[fieldId]}`;
    } else {
      path = nunjucksFieldRef(fieldId, ctx, null, []);
    }
    if (which === "AsString" && parsed.tokens.length === 0 && parsed.filters.length === 0 && !parsed.formatArg) {
      const SYS_NAMES = new Set(["status","priority","resolution","issuetype"]);
      if (fieldId === "project") path += ".key";
      else if (SYS_NAMES.has(fieldId)) path += ".name";
      else if (SYS_USERS.has(fieldId)) path += ".displayName";
    }
    const acc = path + parsed.tokens.join("");
    const pipes = [];
    if (parsed.formatArg) pipes.push(`dateformat("${parsed.formatArg}")`);
    pipes.push(...parsed.filters);
    pipes.push('default("")');
    return `{{ ${acc} | ${pipes.join(" | ")} }}`;
  }
  // Bare issue.<word>?.<accessor>(...)
  m = atom.match(/^issue\s*\.\s*(\w+)\s*\??\.\s*format\s*\(\s*["']([^"']+)["']\s*\)$/);
  if (m) {
    const root = nunjucksFieldRef(m[1], ctx, null, []);
    return `{{ ${root} | dateformat("${m[2]}") | default("") }}`;
  }
  m = atom.match(/^issue\s*\.\s*(\w+)$/);
  if (m) {
    const root = nunjucksFieldRef(m[1], ctx, null, []);
    return `{{ ${root} | default("") }}`;
  }
  return null;
}

/**
 * Translate the SD "team handler" pattern: a multi-line Groovy script that
 * - Declares one or more `String <var>`/`String <var> = expr` locals
 * - Has an `if (condition) { ... } else { handledBySupport = "No"; }` block
 * - Returns one of the locals
 *
 * Concrete shape (from SD Incident / Request / TTP workflows on
 * customfield_10264):
 *
 *   String handledBySupport
 *   String newTeam = issue.getAsString("customfield_20038")
 *   if (newTeam == "" || newTeam == "CMDB-X" || ... ) {
 *     // do nothing
 *   } else {
 *     handledBySupport = "No";
 *   }
 *   return (handledBySupport)
 *
 * Translation strategy: parse the if-condition (a chain of `==` checks joined
 * by `||`) into a Nunjucks `{% if %}/{% else %}` block whose else-branch emits
 * the literal value. Anything outside this exact pattern bails (returns
 * translated:false) so the operator gets an honest "I couldn't handle this"
 * marker rather than a silently-wrong template.
 */
function groovyTeamHandlerScriptToNunjucks(text, location = [], ctx = null) {
  if (typeof text !== "string" || !text) return { output: text || "", problems: [], translated: false };
  // Strip CMA's "/* custom field ID missing on Cloud */" markers — we want
  // the bare ID to drive the Nunjucks accessor; the operator can fix the
  // missing-field issue separately.
  let src = text.replace(/\/\*\s*custom field ID missing on Cloud\s*\*\//g, "");
  // Also strip Groovy single-line comments (`// ...`) to avoid them
  // confusing the regex (they appear in the SD scripts).
  src = src.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");

  // 1. Find `String <var> = issue.getAsString("X")` — the variable being tested.
  const declRe = /String\s+(\w+)\s*=\s*issue\s*\.\s*getAsString\s*\(\s*["']([^"']+)["']\s*\)/;
  const decl = declRe.exec(src);
  if (!decl) return { output: text, problems: [], translated: false };
  const testVar = decl[1];
  const testFieldId = decl[2];

  // 2. Find `String <outVar>` (uninitialized local) declared earlier.
  const outVarRe = new RegExp(`String\\s+(\\w+)\\s*\\n`);
  const outVarMatch = outVarRe.exec(src);
  if (!outVarMatch) return { output: text, problems: [], translated: false };
  const outVar = outVarMatch[1];
  if (outVar === testVar) return { output: text, problems: [], translated: false };

  // 3. Find `if (<chain of testVar == "X" || ...>) { ... } else { <outVar> = "<lit>"; }`
  // — extract the case values and the else-branch literal.
  // Be tolerant of multiline whitespace.
  const ifRe = /if\s*\(([\s\S]*?)\)\s*\{([\s\S]*?)\}\s*else\s*\{([\s\S]*?)\}/;
  const ifMatch = ifRe.exec(src);
  if (!ifMatch) return { output: text, problems: [], translated: false };
  const condStr = ifMatch[1].trim();
  const elseBody = ifMatch[3].trim();

  // The condition must be a chain of `<testVar> == "X"` joined by `||`.
  const condParts = topLevelSplit(condStr, "|").map((p) => p.trim()).filter(Boolean);
  // After splitting on `|`, we may have empty strings between consecutive `||`.
  // Filter and re-collapse.
  const cleanedConds = [];
  for (const p of condParts) {
    if (!p || p === "|") continue;
    cleanedConds.push(p);
  }
  if (cleanedConds.length === 0) return { output: text, problems: [], translated: false };
  const caseValues = [];
  const eqRe = new RegExp(`^\\s*${testVar}\\s*==\\s*["']([^"']*)["']\\s*$`);
  for (const c of cleanedConds) {
    const em = eqRe.exec(c);
    if (!em) return { output: text, problems: [], translated: false };
    caseValues.push(em[1]);
  }

  // Else-branch body must be `<outVar> = "<literal>";` (allow trailing `;`).
  const elseAssignRe = new RegExp(`^${outVar}\\s*=\\s*["']([^"']*)["']\\s*;?\\s*$`);
  const elseAssign = elseAssignRe.exec(elseBody);
  if (!elseAssign) return { output: text, problems: [], translated: false };
  const elseLiteral = elseAssign[1];

  // 4. Assemble the Nunjucks template. The if-branch is a no-op (operator's
  // intent: leave outVar unset / default). When the if-branch fires, the
  // template renders empty (which JMWE Cloud treats as "leave the field as-is"
  // when the value is empty AND the rule's "skip if empty" setting is on —
  // but to be safe, we also render the literal value the operator probably
  // intended: an empty string for "no change").
  // Build the condition: any of the case values match.
  const handlerProblems = [];
  const fieldRoot = nunjucksFieldRef(testFieldId, ctx, handlerProblems, location);
  const condJE = caseValues
    .map((v) => `${fieldRoot} == "${v}"`)
    .join(" or ");
  const out =
    `{% if ${condJE} %}` +
    // No-op: render empty string. Operator may want to keep the prior value;
    // the JMWE "skip if empty" setting on the SetFieldValueFunction handles that.
    `` +
    `{% else %}${elseLiteral}{% endif %}`;
  return {
    output: out,
    problems: [{ type: "GroovyScriptToNunjucks", location }, ...handlerProblems],
    translated: true,
  };
}

function repairBrokenNunjucksIf(text, location = [], ctx = null) {
  if (typeof text !== "string" || !text) return { output: text || "", problems: [], translated: false };
  // Pattern: {% if issue.get("X" %}) return issue.getAsString("X") {% else %} ... {% endif %}
  const re = /\{%\s*if\s+issue\s*\.\s*get\s*\(\s*["']([^"']+)["']\s*%\}\)\s*return\s+issue\s*\.\s*get(?:AsString|RawValue)?\s*\(\s*["']\1["']\s*\)\s*\{%\s*else\s*%\}\s*([^{]*?)\s*\{%\s*endif\s*%\}/;
  const m = re.exec(text);
  if (!m) return { output: text, problems: [], translated: false };
  const fieldId = m[1];
  const elseBranch = m[2].trim();
  // For object-valued system fields (resolution, status, priority, ...) the
  // truthy access is .name; for scalar fields it's the raw value.
  const SYS_OBJECT_FIELDS = new Set(["status","priority","resolution","issuetype","project"]);
  const repairProblems = [];
  const fieldRoot = nunjucksFieldRef(fieldId, ctx, repairProblems, location);
  const valueSuffix = SYS_OBJECT_FIELDS.has(fieldId) ? ".name" : "";
  const valueExpr = `{{ ${fieldRoot}${valueSuffix} | default("") }}`;
  const truthyExpr = fieldRoot;
  const out = `{% if ${truthyExpr} %}${valueExpr}{% else %}${elseBranch}{% endif %}`;
  return {
    output: out,
    problems: [{ type: "GroovyTemplateToNunjucks", location }, ...repairProblems],
    translated: true,
  };
}

/**
 * Translate a Groovy `groupManager.isUserInGroup(<userExpr>, '<groupName>')`
 * call (often with `import` and `def groupManager` boilerplate prepended) to
 * a Jira Expression. Used by EmailIssueFunction.conditionalExecutionScript on
 * Change-Mgmt-Flow rules.
 *
 *   import com.atlassian.jira.component.ComponentAccessor;
 *   def groupManager = ComponentAccessor.getGroupManager();
 *   !(groupManager.isUserInGroup(issue.reporter?.name,'staff'));
 * →
 *   !issue.reporter.groups.some(g => g.name == "staff")
 *
 * The user expression is mapped: `issue.reporter?.name` → `issue.reporter`,
 * `currentUser` → `user`. Anything more exotic falls through untranslated.
 */
function groupManagerScriptToJiraExpression(text, location = []) {
  if (typeof text !== "string" || !text) return { output: text || "", problems: [], translated: false };
  const original = text;

  // Strip Groovy `import ...;` lines and `def groupManager = ComponentAccessor.getGroupManager();`
  let src = text
    .replace(/^\s*import\s+[\w.]+\s*;?\s*$/gm, "")
    .replace(/^\s*def\s+\w+\s*=\s*ComponentAccessor\s*\.\s*getGroupManager\s*\(\s*\)\s*;?\s*$/gm, "")
    .trim();
  // Drop trailing `;`
  src = src.replace(/;+\s*$/, "").trim();
  // Strip any leading `return `.
  src = src.replace(/^return\s+/, "");

  // Match `<groupManager>.isUserInGroup(<userExpr>, <groupExpr>)`, with optional
  // negation `!(...)`. The negation can wrap the call in parens or be a bare !.
  // Capture the user expression and group name.
  const callRe = /(\!?)\s*\(?\s*\w+\s*\.\s*isUserInGroup\s*\(\s*([\s\S]+?)\s*,\s*["']([^"']+)["']\s*\)\s*\)?/;
  const m = callRe.exec(src);
  if (!m) return { output: text, problems: [], translated: false };
  const negate = m[1] === "!";
  const userExpr = m[2].trim();
  const groupName = m[3];

  // Translate the user expression to JE.
  let je;
  if (/^issue\s*\.\s*reporter/.test(userExpr)) je = "issue.reporter";
  else if (/^issue\s*\.\s*assignee/.test(userExpr)) je = "issue.assignee";
  else if (/^issue\s*\.\s*creator/.test(userExpr)) je = "issue.creator";
  else if (/^currentUser\b/.test(userExpr)) je = "user";
  else return { output: text, problems: [], translated: false };

  const expr = `${negate ? "!" : ""}${je}.groups.some(g => g.name == "${groupName}")`;
  return {
    output: expr,
    problems: [{ type: "GroovyScriptToJiraExpression", location }],
    translated: expr !== original,
  };
}

/**
 * Returns true when `text` is a Jira Expression that JE's parser will accept
 * — i.e. no Groovy script remnants (def/return/regex literals/multi-statement).
 * Empty / non-string is considered clean.
 */
function isCleanJiraExpression(text) {
  if (typeof text !== "string" || !text) return true;
  if (/\b(?:def|return)\b/.test(text)) return false;
  if (/=~/.test(text)) return false; // Groovy regex literal
  if (/\bswitch\s*\(/.test(text)) return false;
  if (/\$\{[^}]*\}/.test(text)) return false; // GString placeholder
  if (/<%[\s\S]*?%>/.test(text)) return false;
  if (hasInsightContent(text)) return false;
  return true;
}

/**
 * Stricter structural validator for Jira Expressions. Use this at the
 * "ready-to-enable" gate: a rule that fails this check should remain
 * disabled regardless of marker state because it would error on Cloud.
 *
 * Returns { valid, problems: string[] }. Problems are tags, not messages —
 * intended for logs/the manual-review workbook.
 */
function validateJiraExpression(text) {
  const problems = [];
  if (typeof text !== "string" || !text) return { valid: true, problems };
  if (!isCleanJiraExpression(text)) problems.push("groovy-residue");

  // Walk char-by-char tracking string-literal state so semicolons / braces
  // inside string literals don't trip the checks. Single, double, and
  // template strings are tracked independently.
  let inStr = null;
  let escape = false;
  let braceDepth = 0;
  let semicolons = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === "\\") { escape = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "{") braceDepth++;
    else if (c === "}") braceDepth--;
    else if (c === ";") semicolons++;
  }
  if (semicolons > 0) problems.push("unexpected-semicolon");
  if (braceDepth !== 0) problems.push("unbalanced-braces");

  // Stray Groovy safe-nav operator. groovyExpressionToJiraExpression strips
  // these — a residue means translation didn't fire.
  if (/\?\s*\./.test(text)) problems.push("safe-nav-residue");

  return { valid: problems.length === 0, problems };
}

/**
 * Translate a Groovy atom (no operators, no concatenation) to a Nunjucks
 * expression suitable for use inside `{% set X = ... %}` or `{% if ... %}`.
 * Returns the unwrapped expression string (no `{{ }}` wrappers), or null.
 *
 * This is the "sister" of `atomToNunjucks` (which emits `{{ ... }}` blocks);
 * use it when the result needs to be embedded in a Nunjucks statement block
 * rather than a text-output block.
 *
 * Handles:
 *   "literal"                        → "literal"  (with quotes preserved)
 *   currentUser[.prop]               → user[.prop]
 *   issue.<prop>                     → issue.<prop>
 *   issue.get|getAsString|getAsHtml|getRawValue("X")<chain of property/.first/.optionId>
 *                                    → issue.fields[...]<.chain>
 *
 * Method chains that translate to FILTERS (.toString, .replace, .length etc.)
 * cannot be embedded in `{% set %}` RHS because filters live in `{{ }}`
 * blocks. So this helper returns null when filters are required — caller
 * bails to the residue path.
 */
function atomToNunjucksExpr(atom, ctx) {
  if (typeof atom !== "string" || !atom) return null;
  const t = atom.trim();
  // String literal (preserve quoting for Nunjucks)
  let m = t.match(/^"((?:[^"\\]|\\.)*)"$/);
  if (m) return `"${m[1]}"`;
  m = t.match(/^'((?:[^'\\]|\\.)*)'$/);
  if (m) return `'${m[1]}'`;
  // currentUser[.prop]
  m = t.match(/^currentUser(?:\s*\.\s*(\w+))?$/);
  if (m) return m[1] ? `user.${m[1]}` : "user";
  // issue.get accessor with chain. Use method-form so chains with .toString
  // / .replace / .substring / etc. emit as JS method calls (which JMWE Cloud
  // Nunjucks evaluates natively) instead of bailing on the filter mismatch.
  m = t.match(/^issue\s*\.\s*get(AsString|AsHtml|RawValue)?\s*\(\s*["']([^"']+)["']\s*\)((?:\s*\??\.\s*\w+\s*(?:\(\s*[^()]*\s*\))?)*)$/);
  if (m) {
    const fieldId = m[2];
    const chain = m[3] || "";
    const parsed = parseChainForNunjucks(chain, { methodForm: true });
    if (!parsed || parsed.formatArg) return null;
    return nunjucksFieldRef(fieldId, ctx, null, []) + parsed.tokens.join("");
  }
  // Bare issue.<prop>
  m = t.match(/^issue\s*\.\s*(\w+)$/);
  if (m) return `issue.${m[1]}`;
  // Boolean / null literals
  if (t === "true" || t === "false" || t === "null") return t;
  // Numeric literal
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  return null;
}

/**
 * Split a Groovy block into top-level statements, breaking on `;` or
 * newline outside parens/braces/strings. Empty fragments are dropped.
 */
function splitStatements(src) {
  const parts = [];
  let buf = "";
  let parenDepth = 0;
  let braceDepth = 0;
  let inStr = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      buf += ch;
      if (ch === inStr && src[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; buf += ch; continue; }
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth--;
    if ((ch === ";" || ch === "\n") && parenDepth === 0 && braceDepth === 0) {
      if (buf.trim()) parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

/**
 * Pre-pass that glues `if (COND)` + body + `else` + body across blank lines.
 * DC operators sometimes write:
 *
 *   def X = issue.get("Y")
 *
 *   if (X == "A")
 *
 *   return "B"
 *
 *   else
 *      return "C"
 *
 * Without joining, splitStatements would emit each line as a separate
 * statement and the `if` classifier (which requires a body) would bail.
 *
 * The join walks line-by-line. When it sees an `if (...)` line, it
 * accumulates subsequent non-blank lines into the same buffer until it
 * has both an else-branch return (or single-branch return). Everything
 * else passes through unchanged.
 */
function joinIfElseAcrossLines(src) {
  const lines = src.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }
    if (/^if\s*\(/.test(line)) {
      let buf = line;
      i++;
      let sawElse = false;
      let sawIfBody = false;
      let safety = 0;
      while (i < lines.length && safety++ < 200) {
        const t = lines[i].trim();
        i++;
        if (!t) continue;
        buf += " " + t;
        if (/^else\b/.test(t)) { sawElse = true; continue; }
        if (/^return\b/.test(t) || /^\{/.test(t)) {
          if (sawElse) break;
          sawIfBody = true;
          // Standalone if (no else) — break after the body.
          // But may still have an else on a later line, so peek ahead.
          const peek = (lines[i] || "").trim();
          if (!/^else\b/.test(peek) && peek !== "") break;
          continue;
        }
        // Any other content (likely an unclosed if condition spanning
        // multiple lines, or an unexpected statement). Keep accumulating
        // up to the safety bound — at worst we glue too much and the
        // downstream parser bails.
      }
      out.push(buf);
      // Avoid the for-now-unused-warning when sawIfBody is set without else.
      void sawIfBody;
    } else {
      out.push(line);
      i++;
    }
  }
  return out.join("\n");
}

/**
 * Translate a multi-statement Groovy block (typical SetFieldValueFunction
 * body) to a Nunjucks template. Recognised shape:
 *
 *   def X = issue.get("Y")
 *   def Z = issue.getAsString("W")
 *   if (X == "A" || Z == "B") return "RESULT-A" else return "RESULT-B"
 *
 * Or with braces:
 *
 *   def X = issue.get("Y")
 *   if (X == "A") { return "RESULT-A" } else { return "RESULT-B" }
 *
 * Or a single trailing return without an if:
 *
 *   def X = issue.get("Y")
 *   return X
 *
 * Anything outside this shape (nested defs inside if bodies, switch, try,
 * etc.) returns translated:false so the residue detector can auto-disable
 * the rule.
 */
function groovyMultiStatementToNunjucks(text, location = [], ctx = null) {
  if (typeof text !== "string" || !text) return { output: text || "", problems: [], translated: false };
  // Strip CMA comments and Groovy line comments.
  let src = text.replace(/\/\*\s*custom field ID missing on Cloud\s*\*\//g, "");
  src = src.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  // Glue if/else across blank lines before splitting.
  src = joinIfElseAcrossLines(src);
  const stmts = splitStatements(src);
  if (stmts.length === 0) return { output: text, problems: [], translated: false };

  const setBlocks = [];
  let ifBlock = null;
  let returnExpr = null;
  for (const raw of stmts) {
    const stmt = raw.trim().replace(/;$/, "").trim();
    if (!stmt) continue;
    // def IDENT = EXPR
    const defMatch = stmt.match(/^def\s+(\w+)\s*=\s*([\s\S]+)$/);
    if (defMatch) {
      if (ifBlock || returnExpr !== null) return { output: text, problems: [], translated: false };
      const ident = defMatch[1];
      const expr = atomToNunjucksExpr(defMatch[2].trim(), ctx);
      if (expr == null) return { output: text, problems: [], translated: false };
      setBlocks.push({ ident, expr });
      continue;
    }
    // if ( ... ) ...
    if (/^if\s*\(/.test(stmt)) {
      if (ifBlock) return { output: text, problems: [], translated: false };
      const parsed = parseIfElseGroovy(stmt);
      if (!parsed) return { output: text, problems: [], translated: false };
      ifBlock = parsed;
      continue;
    }
    // return EXPR
    const retMatch = stmt.match(/^return\s+([\s\S]+)$/);
    if (retMatch) {
      if (ifBlock || returnExpr !== null) return { output: text, problems: [], translated: false };
      returnExpr = retMatch[1].trim();
      continue;
    }
    // Unknown statement — bail.
    return { output: text, problems: [], translated: false };
  }
  // Must have either an if/else block or a return.
  if (!ifBlock && returnExpr == null) return { output: text, problems: [], translated: false };

  const parts = [];
  for (const s of setBlocks) parts.push(`{% set ${s.ident} = ${s.expr} %}`);

  const knownIdents = new Set(setBlocks.map((s) => s.ident));
  // Split a Groovy expression on a single-char top-level operator. Quote- and
  // paren-aware so `"a + b"` and `f(x + y)` don't split internally.
  const splitOnOp = (s, op) => {
    const out = [];
    let buf = "";
    let depth = 0;
    let inStr = null;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        buf += ch;
        if (ch === inStr && s[i - 1] !== "\\") inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = ch; buf += ch; continue; }
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      if (ch === op && depth === 0) {
        out.push(buf);
        buf = "";
        continue;
      }
      buf += ch;
    }
    out.push(buf);
    return out.map((p) => p.trim()).filter(Boolean);
  };
  const branchOut = (b) => {
    let t = b.trim();
    if (t.startsWith("{") && t.endsWith("}")) t = t.slice(1, -1).trim();
    if (t.startsWith("return ")) t = t.slice("return ".length).trim();
    if (t === "return") return ""; // bare void-return → empty branch
    if (t.endsWith(";")) t = t.slice(0, -1).trim();
    if (!t) return "";
    const sm = t.match(/^"((?:[^"\\]|\\.)*)"$/) || t.match(/^'((?:[^'\\]|\\.)*)'$/);
    if (sm) return sm[1].replace(/\\(["'\\])/g, "$1");
    if (t === "true" || t === "false") return t;
    // Bare reference to a `def` ident we already declared.
    if (/^[A-Za-z_]\w*$/.test(t) && knownIdents.has(t)) {
      return `{{ ${t} | default("") }}`;
    }
    // Concatenation: `A + " - " + B` — render each atom (string literals
    // inlined as text; known idents as `{{ I }}`; everything else through
    // the value-expression translator).
    const atoms = splitOnOp(t, "+");
    if (atoms.length > 1) {
      const out = [];
      for (const a of atoms) {
        const ssm = a.match(/^"((?:[^"\\]|\\.)*)"$/) || a.match(/^'((?:[^'\\]|\\.)*)'$/);
        if (ssm) { out.push(ssm[1].replace(/\\(["'\\])/g, "$1")); continue; }
        if (/^[A-Za-z_]\w*$/.test(a) && knownIdents.has(a)) {
          out.push(`{{ ${a} | default("") }}`);
          continue;
        }
        const ve = groovyValueExpressionToNunjucks(a, location, ctx);
        if (ve.translated) { out.push(ve.output); continue; }
        return null;
      }
      return out.join("");
    }
    // Single-atom fallback to value-expression translator.
    const ve = groovyValueExpressionToNunjucks(t, location, ctx);
    if (ve.translated) return ve.output;
    return null;
  };

  if (ifBlock) {
    // Reuse the JE translator for the condition. JMWE Cloud's Nunjucks
    // engine accepts JE-style `==`, `&&`, `||` inside `{% if %}` blocks
    // (verified live 2026-05 against the LBT SD handler rules), so we
    // route through groovyExpressionToJiraExpression rather than building
    // a separate Nunjucks-cond translator.
    const condJE = groovyExpressionToJiraExpression(ifBlock.cond, location, ctx);
    if (!isCleanJiraExpression(condJE.output)) return { output: text, problems: [], translated: false };
    const ifText = branchOut(ifBlock.ifBranch);
    const elText = branchOut(ifBlock.elseBranch);
    if (ifText == null || elText == null) return { output: text, problems: [], translated: false };
    parts.push(`{% if ${condJE.output} %}${ifText}{% else %}${elText}{% endif %}`);
  } else {
    // Standalone return — reuse branchOut so concatenation + known-ident
    // handling works the same way as inside if/else.
    const ret = branchOut(returnExpr);
    if (ret == null) return { output: text, problems: [], translated: false };
    parts.push(ret);
  }

  const output = parts.join("");
  // Safety gate — if the output still smells like Groovy, bail. The
  // detector will pick up the original text and disable the rule.
  if (!isCleanNunjucks(output)) return { output: text, problems: [], translated: false };
  return {
    output,
    problems: [{ type: "GroovyTemplateToNunjucks", location }],
    translated: true,
  };
}

/**
 * Returns true when `text` is a Nunjucks template clean of Groovy remnants.
 * Groovy giveaways: GString placeholders, JSP scriptlets, type-prefixed local
 * variable declarations, switch/case/import, regex literals, `?.` safe nav,
 * and bare `issue.getRawValue/.getAsString/.getInsightAttributeValue` calls.
 */
function isCleanNunjucks(text) {
  if (typeof text !== "string" || !text) return true;
  if (/\$\{[^}]+\}/.test(text)) return false; // GString left
  if (/<%[\s\S]*?%>/.test(text)) return false;
  if (/^\s*(?:def|String|Integer|int|boolean|long|double|float|char|return|switch|import)\s+/m.test(text)) return false;
  if (/^\s*case\s+["']/m.test(text)) return false;
  if (/=~/.test(text)) return false;
  if (/\?\s*\./.test(text)) return false; // Groovy safe-nav
  if (/\.\s*(?:getRawValue|getAsString|getInsightAttributeValue)\s*\(/.test(text)) return false;
  if (hasInsightContent(text)) return false;
  return true;
}

module.exports = {
  hasGroovyContent,
  hasInsightContent,
  groovyTemplateToNunjucks,
  groovyExpressionToJiraExpression,
  groovyValueExpressionToNunjucks,
  groovyImperativeToJiraExpression,
  groovyImperativeToNunjucks,
  groovyMultiStatementToNunjucks,
  atomToNunjucksExpr,
  jspScriptletToNunjucks,
  groovyInsightEmailToNunjucks,
  groovyScoreCalculatorToNunjucks,
  groovyArrayConcatToNunjucks,
  groovyTeamHandlerScriptToNunjucks,
  repairBrokenNunjucksIf,
  groupManagerScriptToJiraExpression,
  markerFor,
  isCleanJiraExpression,
  isCleanNunjucks,
  nunjucksFieldRef,
  jiraExprFieldRef,
  validateJiraExpression,
  parseChainForNunjucks,
};
