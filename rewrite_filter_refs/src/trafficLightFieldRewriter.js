// Rewrites JQL clauses that reference Forge "Traffic Light" status fields.
//
// Two related fixes are applied to each comparison clause whose LHS is a
// quoted (or bare-identifier) traffic-light field:
//
//   1. APPEND `.Label`
//      On Cloud the field stores `{ shape, label }` so JQL like
//        "Team Priority" = "Important"
//      parses but matches zero rows. The only working form is the
//      dot-property accessor:
//        "Team Priority.Label" = "Important"
//
//   2. STRIP the DC value prefix
//      The DC plugin rendered values as `(color) Label` or `(,color,) Label`
//      (e.g. `"(yellow) Important"`, `"(,yellow,) Yellow"`). JCMA copies
//      that literal string into JQL but Cloud's `.label` is just `"Important"`
//      / `"Yellow"` — so the prefixed form matches zero rows. We strip the
//      `(…) ` prefix when it precedes the real label.
//
// Both fixes are applied independently — a filter that already has `.Label`
// but still carries a DC-prefixed value (or vice versa) is repaired.
//
// What stays untouched:
//   - `"Field" IS EMPTY` / `IS NOT EMPTY`            — works fine without .Label
//   - `"Field.Color" = X`, `"Field.Order"`, etc.     — different accessor; left alone
//   - `cf[12345] ...` / `customfield_12345 ...`      — Cloud rejects `cf[N].Label`
//     with a 400. Don't rewrite the bracket form; would break the parser.
//   - Anything inside `aqlFunction(…)`               — Asset field territory.

const { splitTopLevelCommas } = require("./aqlRewriter");

function normalizeName(s) {
  return String(s || "").normalize("NFC").trim().toLowerCase();
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// "(color) Label" or "(,color,) Label" — DC traffic-light value prefix.
// We require non-empty parens content + at least one space + a non-empty
// remainder, so plain values like "Yellow" or "(parens-only-name)" don't match.
const DC_VALUE_PREFIX_RE = /^\(\s*[^)]+\s*\)\s+(.+)$/;

function stripDcLabelPrefix(s) {
  const m = String(s).match(DC_VALUE_PREFIX_RE);
  return m ? m[1].trim() : s;
}

// Mask aqlFunction("…") and bare cf[N] / customfield_N references so the
// rewriter doesn't touch them.  Returns {masked, restore}.
function maskUntouchables(jql) {
  const stash = [];
  let masked = jql.replace(
    /\baqlFunction\s*\(\s*"(?:[^"\\]|\\.)*"\s*\)/gi,
    (m) => {
      const i = stash.length;
      stash.push(m);
      return `\x01TLM${i}\x02`;
    },
  );
  masked = masked.replace(/\bcf\[\d+\]|\bcustomfield_\d+\b/g, (m) => {
    const i = stash.length;
    stash.push(m);
    return `\x01TLM${i}\x02`;
  });
  return {
    masked,
    restore: (s) =>
      s.replace(/\x01TLM(\d+)\x02/g, (_m, n) => stash[Number(n)] || ""),
  };
}

function buildFieldNameRegex(names) {
  const arr = Array.from(names).filter(Boolean);
  if (arr.length === 0) return null;
  const quotedAlt = arr
    .map(escapeRegex)
    .map((n) => n.replace(/\s+/g, "\\s+"))
    .sort((a, b) => b.length - a.length)
    .join("|");
  const bareCandidates = arr
    .filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
    .map(escapeRegex)
    .sort((a, b) => b.length - a.length);
  return {
    // Match "Field" OR "Field.Label". Other accessors (.Color, .Order, …) don't
    // match because `\1` requires the close quote immediately after, and we
    // only allow `.Label` between the name and the close quote.
    quoted: new RegExp(
      `(["'])(${quotedAlt})(\\.Label)?\\1`,
      "gi",
    ),
    bare:
      bareCandidates.length > 0
        ? new RegExp(
            `(?<![A-Za-z0-9_"'])(${bareCandidates.join("|")})(\\.Label)?(?![A-Za-z0-9_.])`,
            "g",
          )
        : null,
  };
}

// Rewrite a single quoted value token (e.g. `"(yellow) Important"`): strip
// the DC prefix from its content. Returns the rewritten token (still quoted)
// or null if no change.
function rewriteQuotedValueToken(tok) {
  const m = tok.match(/^(\s*)(["'])((?:[^"'\\]|\\.)*)\2(\s*)$/);
  if (!m) return null;
  const inner = m[3].replace(/\\(.)/g, "$1"); // unescape
  const stripped = stripDcLabelPrefix(inner);
  if (stripped === inner) return null;
  const reEscaped = stripped.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${m[1]}${m[2]}${reEscaped}${m[2]}${m[4]}`;
}

// Read one RHS value (quoted or bare) starting at `from`. Returns
// { len, replacement } where len is the byte length consumed and
// replacement is the new token to splice in (or null if unchanged).
function readAndRewriteSingleValue(s, from) {
  const slice = s.slice(from);
  // Quoted value
  const quoted = slice.match(/^\s*(["'])((?:[^"'\\]|\\.)*)\1/);
  if (quoted) {
    const full = quoted[0];
    const newTok = rewriteQuotedValueToken(full);
    return { len: full.length, replacement: newTok };
  }
  // Bare token — nothing to strip, leave as-is.
  return { len: 0, replacement: null };
}

// Read an IN/NOT IN list starting at the `(` after the operator. Returns
// { len, replacement, valueChanges } where len is the total length
// consumed (including the surrounding parens), replacement is the new
// list (or null if nothing changed), and valueChanges is an array of
// per-token before/after pairs for reporting.
function readAndRewriteInList(s, from) {
  // s[from] must be `(`.
  if (s[from] !== "(") return { len: 0, replacement: null, valueChanges: [] };
  // Find the matching close-paren, respecting quotes.
  let depth = 1;
  let i = from + 1;
  let inQuote = false;
  let q = "";
  while (i < s.length && depth > 0) {
    const ch = s[i];
    if (inQuote) {
      if (ch === "\\" && i + 1 < s.length) {
        i += 2;
        continue;
      }
      if (ch === q) inQuote = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      q = ch;
    } else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0) return { len: 0, replacement: null, valueChanges: [] };

  const inner = s.slice(from + 1, i);
  const tokens = splitTopLevelCommas(inner);
  const valueChanges = [];
  let anyChange = false;
  const rewritten = tokens.map((tok) => {
    const newTok = rewriteQuotedValueToken(tok);
    if (newTok != null) {
      valueChanges.push({ from: tok.trim(), to: newTok.trim() });
      anyChange = true;
      return newTok;
    }
    return tok;
  });
  if (!anyChange) {
    return { len: i + 1 - from, replacement: null, valueChanges: [] };
  }
  return {
    len: i + 1 - from,
    replacement: `(${rewritten.join(",")})`,
    valueChanges,
  };
}

/**
 * @param {string} jql
 * @param {object} options
 * @param {Set<string>|Array<string>} options.trafficLightFieldNames - normalized (lowercased)
 * @returns {{
 *   rewritten: string,
 *   replacements: Array<{ field, original, rewritten, kind: "appendLabel"|"valueStrip"|"both", valueChanges?: Array<{from,to}> }>
 * }}
 */
function rewriteTrafficLightFields(jql, options = {}) {
  if (!jql || typeof jql !== "string") {
    return { rewritten: jql, replacements: [] };
  }
  const names =
    options.trafficLightFieldNames instanceof Set
      ? options.trafficLightFieldNames
      : new Set((options.trafficLightFieldNames || []).map(normalizeName));
  if (names.size === 0) return { rewritten: jql, replacements: [] };

  const re = buildFieldNameRegex(names);
  if (!re) return { rewritten: jql, replacements: [] };

  const { masked, restore } = maskUntouchables(jql);

  // Collect candidate field-name occurrences, both quoted and bare.
  const candidates = [];
  for (const m of masked.matchAll(re.quoted)) {
    candidates.push({
      start: m.index,
      end: m.index + m[0].length,
      original: m[0],
      fieldName: m[2],
      hadLabel: !!m[3], // ".Label" suffix was present
      quoted: true,
    });
  }
  if (re.bare) {
    for (const m of masked.matchAll(re.bare)) {
      if (candidates.some((c) => c.start === m.index)) continue;
      candidates.push({
        start: m.index,
        end: m.index + m[0].length,
        original: m[0],
        fieldName: m[1],
        hadLabel: !!m[2],
        quoted: false,
      });
    }
  }
  candidates.sort((a, b) => a.start - b.start);

  const replacements = [];
  // Walk end-to-start so index splices don't shift earlier matches.
  let work = masked;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];

    const tail = work.slice(c.end);
    const opMatch = tail.match(
      /^\s*(=|!=|~|!~|\bIS\s+NOT\s+EMPTY\b|\bIS\s+EMPTY\b|\bIS\s+NOT\b|\bIS\b|\bNOT\s+IN\b|\bIN\b)/i,
    );
    if (!opMatch) continue;
    const op = opMatch[1].toUpperCase();
    // IS EMPTY / IS NOT EMPTY work fine without .Label — don't rewrite.
    if (/^IS\s+(NOT\s+)?EMPTY$/.test(op)) continue;
    // Plain IS / IS NOT with a non-EMPTY value still maps to NULL semantics
    // for traffic-light fields; leave alone.
    if (/^IS(\s+NOT)?$/.test(op)) continue;

    // Find the position right after the operator (and its trailing whitespace).
    const opMatchFull = tail.match(
      /^(\s*)(=|!=|~|!~|\bNOT\s+IN\b|\bIN\b)(\s*)/i,
    );
    if (!opMatchFull) continue;
    const valueStart = c.end + opMatchFull[0].length;
    const opUpper = opMatchFull[2].toUpperCase();

    // Walk the value(s) and strip the DC prefix from each.
    let valueChanges = [];
    let valueSpliceLen = 0;
    let valueSpliceReplacement = null;
    if (opUpper === "IN" || opUpper === "NOT IN") {
      const r = readAndRewriteInList(work, valueStart);
      valueSpliceLen = r.len;
      valueSpliceReplacement = r.replacement;
      valueChanges = r.valueChanges;
    } else {
      const r = readAndRewriteSingleValue(work, valueStart);
      valueSpliceLen = r.len;
      valueSpliceReplacement = r.replacement;
      if (r.replacement) {
        valueChanges = [{ from: work.slice(valueStart, valueStart + r.len).trim(), to: r.replacement.trim() }];
      }
    }

    const needsLabel = !c.hadLabel;
    if (!needsLabel && !valueSpliceReplacement) continue;

    // Splice value first (later in string) so the earlier field splice
    // indices stay valid.
    if (valueSpliceReplacement) {
      work =
        work.slice(0, valueStart) +
        valueSpliceReplacement +
        work.slice(valueStart + valueSpliceLen);
    }

    if (needsLabel) {
      const fieldReplacement = `"${c.fieldName}.Label"`;
      work = work.slice(0, c.start) + fieldReplacement + work.slice(c.end);
    }

    let kind;
    if (needsLabel && valueChanges.length > 0) kind = "both";
    else if (needsLabel) kind = "appendLabel";
    else kind = "valueStrip";

    replacements.push({
      field: c.fieldName,
      original: c.original,
      rewritten: needsLabel ? `"${c.fieldName}.Label"` : c.original,
      kind,
      valueChanges,
    });
  }

  const rewritten = restore(work);
  return { rewritten, replacements };
}

module.exports = {
  rewriteTrafficLightFields,
  buildFieldNameRegex,
  maskUntouchables,
  stripDcLabelPrefix,
  rewriteQuotedValueToken,
};
