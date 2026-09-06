// Reactive helper invoked from the filterProcessor 400-retry path. When
// Cloud rejects a filter PUT with messages like
//   "The value 'X' does not exist for the field 'Y'."
//   "The option 'X' for field 'Y' does not exist."
// we parse out the (field, value) pairs and remove the offending value from
// the JQL — typically by dropping it from a `Y IN (...)` / `Y NOT IN (...)`
// list — then retry the PUT once. This rescues filters that survive
// JQL-function stripping but still reference per-project values that don't
// exist on the target tenant (component, fixVersion, affectedVersion,
// status, custom-field options).
//
// Strategy is conservative:
//   * Only act on the exact known error patterns.
//   * Equality form (`Y = X`) is NOT auto-stripped — semantics-changing
//     equality removal would leave the rest of the boolean expression
//     unbalanced. Caller is told `equalityMiss=true` and bails out so the
//     human sees a plain failure to investigate.
//   * Every dropped value is recorded for the rewrite report.

// Quotes can be straight ASCII (' or ") or curly Unicode, so be tolerant in
// the regexes below. Two patterns cover the messages Cloud emits.
//
// Form 1 — "The value 'V' does not exist for the field 'F'."
const SIMPLE_VALUE_RE =
  /The\s+value\s+['"‘“]([^'"’”]+)['"’”]\s+does\s+not\s+exist\s+for\s+the\s+field\s+['"‘“]([^'"’”]+)['"’”]/gi;
// "The option 'O' for field 'F' does not exist."
const SIMPLE_OPTION_RE =
  /The\s+option\s+['"‘“]([^'"’”]+)['"’”]\s+for\s+field\s+['"‘“]([^'"’”]+)['"’”]\s+does\s+not\s+exist/gi;
// Form 3 — "A value with ID '<id>' does not exist for the field '<F>'."
// Cloud emits this for stale `filter = <id>` references (and similar
// numeric-ID lookups). The captured value is the bare numeric ID and the
// field name is e.g. "filter".
const ID_VALUE_RE =
  /A\s+value\s+with\s+ID\s+['"‘“]([^'"’”]+)['"’”]\s+does\s+not\s+exist\s+for\s+the\s+field\s+['"‘“]([^'"’”]+)['"’”]/gi;

/**
 * Extract `[{field, value}]` pairs from a Cloud 400 error body or message.
 * Tolerant to JSON envelopes, plain strings, and combined messages.
 *
 * @param {string|object} input — error.responseBody (object) or error.message (string)
 * @returns {Array<{field:string,value:string}>}
 */
function parseMissingFieldValues(input) {
  let text = "";
  if (input == null) return [];
  if (typeof input === "string") {
    text = input;
  } else if (typeof input === "object") {
    // Common shape: { errorMessages: [...], errors: {...} }
    const msgs = Array.isArray(input.errorMessages) ? input.errorMessages : [];
    text = msgs.join(" | ");
    if (input.errors && typeof input.errors === "object") {
      text += " | " + Object.values(input.errors).join(" | ");
    }
  }
  if (!text) return [];

  const out = [];
  const seen = new Set();
  function push(field, value) {
    if (!field || !value) return;
    const key = `${field.toLowerCase()}${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ field, value });
  }

  SIMPLE_VALUE_RE.lastIndex = 0;
  let m;
  while ((m = SIMPLE_VALUE_RE.exec(text)) !== null) {
    push(m[2], m[1]);
  }
  SIMPLE_OPTION_RE.lastIndex = 0;
  while ((m = SIMPLE_OPTION_RE.exec(text)) !== null) {
    push(m[2], m[1]);
  }
  ID_VALUE_RE.lastIndex = 0;
  while ((m = ID_VALUE_RE.exec(text)) !== null) {
    push(m[2], m[1]);
  }
  return out;
}

// JQL identifiers that may legitimately appear as a field token. We allow
// dotted forms (e.g. `Sprint.name`) and bracketed cf[N], but for the
// reactive strip we focus on the un-bracketed identifier path because Cloud
// reports field names like `component`, `fixVersion`, `status`, `Workstream`.
function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Regex factory: match `<field> [NOT] IN (...)` for a specific field name,
// case-insensitive, requiring word boundaries on both sides of the name.
// Field names with spaces (e.g. "Capability Areas") must be quoted in JQL,
// so we accept either a bare word or a `"..."` form. Capture group 1 is
// the field text as it appeared in the JQL (preserves quoting/casing).
function buildFieldInRe(field) {
  const f = escapeForRegex(field);
  const fieldPart = `((?:(?<![A-Za-z0-9_])${f}(?![A-Za-z0-9_])|"${f}"))`;
  return new RegExp(
    `${fieldPart}(\\s+)(not\\s+in|in)(\\s*)\\(([^)]*)\\)`,
    "gi",
  );
}

// Same idea but for equality form `<field> = X` / `<field> != X`. The value
// can be quoted (`"X"` / `'X'`, supporting escapes) — needed to detect cases
// like `fixVersion = "Product A v12.6"` where `[^\s,)]+` would otherwise stop at
// the first space inside the quoted string. Bare values (no whitespace) are
// also accepted.
function buildFieldEqRe(field) {
  const f = escapeForRegex(field);
  const fieldPart = `((?:(?<![A-Za-z0-9_])${f}(?![A-Za-z0-9_])|"${f}"))`;
  // Value alternatives: "double-quoted" | 'single-quoted' | bare-token
  const valuePart = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,)]+)`;
  return new RegExp(`${fieldPart}(\\s*)(=|!=)(\\s*)${valuePart}`, "gi");
}

// Compare a JQL list-token to a target value. The token may be quoted
// (`"X"` / `'X'`) or bare. We compare body case-insensitively.
function tokenMatchesValue(rawToken, value) {
  let body = rawToken.trim();
  if (!body) return false;
  if (
    (body.startsWith('"') && body.endsWith('"')) ||
    (body.startsWith("'") && body.endsWith("'"))
  ) {
    body = body
      .slice(1, -1)
      .replace(/\\(["'\\])/g, "$1");
  }
  return body.toLowerCase() === String(value).toLowerCase();
}

/**
 * Apply a list of (field, value) drops to a JQL string.
 *
 *  - IN-list form: each missing value is removed from `field IN (...)` /
 *    `field NOT IN (...)`. If a list becomes empty, the entire
 *    `field [NOT] IN ()` clause is left for downstream cleanup
 *    (brokenFunctionStripper.cleanupJql empty-IN rule).
 *  - Equality form: when `options.stripEquality` is truthy, the entire
 *    `field = "X"` (or `!=`) clause IS removed, plus one adjacent AND/OR
 *    connector — same surgery as brokenFunctionStripper. Caller passes the
 *    flag explicitly because this is destructive (changes filter semantics).
 *    When the flag is falsy we just record the miss.
 *
 * @param {string} jql
 * @param {Array<{field:string,value:string}>} drops
 * @param {{stripEquality?: boolean}} [options]
 * @returns {{
 *   rewritten: string,
 *   dropped: Array<{field:string,value:string}>,
 *   equalityMiss: Array<{field:string,value:string}>,
 *   equalityStripped: Array<{field:string,value:string,removed:string}>,
 *   listsEmptied: Array<{field:string}>,
 * }}
 */
function stripMissingValues(jql, drops, options = {}) {
  if (!jql || typeof jql !== "string" || !Array.isArray(drops) || drops.length === 0) {
    return {
      rewritten: jql,
      dropped: [],
      equalityMiss: [],
      equalityStripped: [],
      listsEmptied: [],
    };
  }

  // Group drops by field for one-pass-per-field rewriting.
  const byField = new Map();
  for (const d of drops) {
    if (!d || !d.field || d.value == null) continue;
    const k = d.field;
    if (!byField.has(k)) byField.set(k, new Set());
    byField.get(k).add(String(d.value));
  }

  let working = jql;
  const dropped = [];
  const equalityMiss = [];
  const equalityStripped = [];
  const listsEmptied = [];

  for (const [field, values] of byField.entries()) {
    // 1. IN-list drops
    const inRe = buildFieldInRe(field);
    working = working.replace(inRe, (match, fieldText, ws1, op, ws2, inner) => {
      const tokens = inner.split(",");
      const kept = [];
      let anyDrop = false;
      for (const tok of tokens) {
        const core = tok.trim();
        if (!core) {
          kept.push(tok);
          continue;
        }
        let hit = null;
        for (const v of values) {
          if (tokenMatchesValue(core, v)) {
            hit = v;
            break;
          }
        }
        if (hit != null) {
          dropped.push({ field, value: hit });
          anyDrop = true;
        } else {
          kept.push(tok);
        }
      }
      if (kept.length === 0) {
        listsEmptied.push({ field });
        // Leave it as `field [NOT] IN ()` — the standard cleanup pass
        // (brokenFunctionStripper.cleanupJql empty-IN rule) will excise it.
        return `${fieldText}${ws1}${op}${ws2}()`;
      }
      if (anyDrop && kept.length > 0) {
        kept[0] = kept[0].replace(/^\s+/, "");
        kept[kept.length - 1] = kept[kept.length - 1].replace(/\s+$/, "");
      }
      return `${fieldText}${ws1}${op}${ws2}(${kept.join(",")})`;
    });

    // 2. Equality detection. When stripEquality is OFF (default), record
    // the miss for the caller to investigate. When ON, splice out the entire
    // `<field> <op> <value>` clause and one adjacent AND/OR connector, then
    // run the resulting JQL through cleanupJql in the caller.
    const eqRe = buildFieldEqRe(field);
    // Collect matches first so we don't mutate while iterating.
    const eqMatches = [];
    let m;
    while ((m = eqRe.exec(working)) !== null) {
      const tok = m[5];
      for (const v of values) {
        if (tokenMatchesValue(tok, v)) {
          eqMatches.push({
            field,
            value: v,
            start: m.index,
            end: m.index + m[0].length,
          });
          break;
        }
      }
    }

    if (eqMatches.length === 0) continue;

    if (!options.stripEquality) {
      for (const e of eqMatches) {
        equalityMiss.push({ field: e.field, value: e.value });
      }
      continue;
    }

    // Strip in DESCENDING order so earlier indices stay valid.
    eqMatches.sort((a, b) => b.start - a.start);
    const { expandToConnector } = require("./brokenFunctionStripper");
    for (const e of eqMatches) {
      const range = expandToConnector(working, e.start, e.end);
      const removed = working.slice(range.start, range.end);
      equalityStripped.push({
        field: e.field,
        value: e.value,
        removed: removed.trim(),
      });
      working = working.slice(0, range.start) + working.slice(range.end);
    }
  }

  return {
    rewritten: working,
    dropped,
    equalityMiss,
    equalityStripped,
    listsEmptied,
  };
}

module.exports = {
  parseMissingFieldValues,
  stripMissingValues,
  // exposed for tests
  buildFieldInRe,
  buildFieldEqRe,
};
