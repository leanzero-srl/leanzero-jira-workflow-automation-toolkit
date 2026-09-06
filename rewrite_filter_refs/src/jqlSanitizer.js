// Pure JQL sanitizer: fixes common post-JCMA-migration JQL issues that Cloud's
// strict parser rejects but DC accepted. Operates only on unquoted segments so
// string literals like `summary ~ "not in flight"` are never touched.
//
// Transforms, in order:
//   1. Field rename (unquoted and quoted forms):
//        "Customer Request Type" -> "Request Type"
//        Customer Request Type   -> Request Type
//      Plus user-supplied extra renames.
//   2. Uppercase reserved operators: not in, in, is empty, is not empty, and,
//      or, not.
//   3. Quote bare string tokens in IN-list operands:
//        labels NOT IN (Test, TEST) -> labels NOT IN ("Test", "TEST")
//      Skip reserved words and numeric tokens.

const DEFAULT_FIELD_RENAMES = {
  "Customer Request Type": "Request Type",
};

// Lowercase-keyed map of reserved JQL words we must not quote inside IN lists.
const RESERVED_WORDS = new Set([
  "empty",
  "null",
  "cf",
  "true",
  "false",
  "and",
  "or",
  "not",
  "in",
  "is",
  "was",
  "changed",
  "before",
  "after",
  "during",
  "by",
  "from",
  "to",
  "on",
  "currentuser",
  "currentlogin",
  "now",
  "startofday",
  "endofday",
  "startofweek",
  "endofweek",
  "startofmonth",
  "endofmonth",
  "startofyear",
  "endofyear",
]);

// Cloud JQL functions that DC permits to be written without parentheses.
// DC accepts `issuetype IN (standardIssueTypes, subTaskIssueTypes)` but
// Cloud's strict parser rejects this with
//   "Operator 'in' does not support the non-list value 'standardIssueTypes'"
// We rewrite the bare identifier to its proper `name()` call form. The
// IN-list quoter must NOT wrap these in quotes — that would change them
// from a function reference to a string literal value.
const PARENLESS_FUNCTION_NAMES = new Set([
  "standardissuetypes",
  "subtaskissuetypes",
  "standardworktypes",
  "subtaskworktypes",
  "votedissues",
  "watchedissues",
  "votedworkitems",
  "watchedworkitems",
  "issuehistory",
  "workitemhistory",
]);

// Replace each quoted string in `jql` with a single-token placeholder
// (delimited by SOH/STX control chars so it cannot collide with real JQL
// syntax). The placeholder format is `\x01Q<index>\x02` — non-letter
// boundaries make `\b` and lookbehind regexes treat them as inert.
//
// The original quote style and escape sequences are preserved in
// `placeholders[i].body` (raw, with backslash escapes still in place) so
// detokenize can reconstruct the original literal verbatim — except where
// caller mutated `body` first (e.g. for a field rename inside `"foo"`).
// SOH (Start of Heading, U+0001) and STX (Start of Text, U+0002) are control
// chars that cannot legally appear in user-authored JQL. They keep the
// placeholders inert against word-boundary and lookbehind regexes.
//
// CRITICAL: these were silently truncated to empty strings at some point in
// the file's history (likely a copy-paste through a tool that strips
// non-printable bytes). With empty delimiters, the detokenizer regex
// degenerates to /Q(\d+)/ — which COLLIDES with values like `2019Q4`,
// `2020Q1`, `2019Q3`, etc. Cloud then receives garbage like
// `labels = 2019"RiskHigh"` (where `Q4` was mistaken for placeholder index 4
// and replaced by whatever quoted string occupied that slot).
const PH_OPEN = "";
const PH_CLOSE = "";
const PH_RE = new RegExp(`${PH_OPEN}Q(\\d+)${PH_CLOSE}`);
const PH_RE_G = new RegExp(`${PH_OPEN}Q(\\d+)${PH_CLOSE}`, "g");

function tokenizeQuoted(jql) {
  const placeholders = [];
  let result = "";
  let i = 0;
  while (i < jql.length) {
    const c = jql[i];
    if (c === '"' || c === "'") {
      const quote = c;
      let body = "";
      i++;
      while (i < jql.length) {
        const cc = jql[i];
        if (cc === "\\" && i + 1 < jql.length) {
          body += cc + jql[i + 1];
          i += 2;
          continue;
        }
        if (cc === quote) { i++; break; }
        body += cc;
        i++;
      }
      const idx = placeholders.length;
      placeholders.push({ quote, body });
      result += `${PH_OPEN}Q${idx}${PH_CLOSE}`;
    } else {
      result += c;
      i++;
    }
  }
  return { tokenized: result, placeholders };
}

function detokenize(s, placeholders) {
  return s.replace(PH_RE_G, (match, n) => {
    const p = placeholders[Number(n)];
    // Defensive: if the input JQL itself contained literal control chars
    // matching our placeholder pattern (very rare — seen in pathological
    // filters from JCMA imports), the index won't be in our array. Leave
    // the literal text alone rather than crashing.
    if (!p) return match;
    return `${p.quote}${p.body}${p.quote}`;
  });
}

function isPlaceholder(token) {
  return PH_RE.test(token.trim()) && PH_RE.exec(token.trim())[0] === token.trim();
}

function applyFieldRenamesInUnquoted(text, renames, changes) {
  let out = text;
  for (const [from, to] of Object.entries(renames)) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "g");
    out = out.replace(re, (match) => {
      changes.push({ kind: "field_rename", from: match, to });
      return to;
    });
  }
  return out;
}

// Apply field renames inside placeholder bodies (i.e. quoted strings).
// Mutates `placeholders[i].body` when the body exactly equals a rename key.
function applyFieldRenamesInPlaceholders(placeholders, renames, changes) {
  for (const ph of placeholders) {
    if (ph.body in renames) {
      const to = renames[ph.body];
      changes.push({ kind: "field_rename", from: ph.body, to });
      ph.body = to;
    }
  }
}

function uppercaseOperators(text, changes) {
  const rules = [
    { re: /\b(not\s+in)\b/gi, upper: "NOT IN" },
    { re: /\b(is\s+not\s+empty)\b/gi, upper: "IS NOT EMPTY" },
    { re: /\b(is\s+empty)\b/gi, upper: "IS EMPTY" },
    { re: /\b(in)\b/gi, upper: "IN" },
    { re: /\b(is)\b/gi, upper: "IS" },
    { re: /\b(and)\b/gi, upper: "AND" },
    { re: /\b(or)\b/gi, upper: "OR" },
    { re: /\b(not)\b/gi, upper: "NOT" },
    { re: /\b(was)\b/gi, upper: "WAS" },
    { re: /\b(changed)\b/gi, upper: "CHANGED" },
  ];
  let out = text;
  for (const { re, upper } of rules) {
    out = out.replace(re, (match) => {
      if (match !== upper) {
        changes.push({ kind: "op_upper", from: match, to: upper });
      }
      return upper;
    });
  }
  return out;
}

// Quote bare identifiers inside IN / NOT IN lists. Operates on placeholder-
// tokenized text so quoted strings already in the list show up as
// placeholders (`\x01Q<n>\x02`) and are recognized as "already quoted".
function quoteInListValues(text, changes) {
  const re = /\b(NOT\s+IN|IN)\s*\(([^)]*)\)/g;
  return text.replace(re, (match, op, inner) => {
    const rewritten = inner
      .split(",")
      .map((raw) => {
        const leading = raw.match(/^\s*/)[0];
        const trailing = raw.match(/\s*$/)[0];
        const core = raw.trim();
        if (core === "") return raw;
        // Placeholder = a tokenized quoted string → already quoted, skip.
        if (isPlaceholder(core)) return raw;
        // Already quoted in raw form (defensive — shouldn't happen post-tokenize)?
        if (/^".*"$/.test(core) || /^'.*'$/.test(core)) return raw;
        // Numeric literal?
        if (/^-?\d+(\.\d+)?$/.test(core)) return raw;
        // Reserved word / function call?
        if (RESERVED_WORDS.has(core.toLowerCase())) return raw;
        if (/\(/.test(core)) return raw; // function call like currentUser()
        // DC-style paren-less function name (e.g. `standardIssueTypes`)?
        // Cloud requires the `()` form. Convert in place rather than quote.
        if (PARENLESS_FUNCTION_NAMES.has(core.toLowerCase())) {
          const fixed = `${core}()`;
          changes.push({ kind: "fn_parens_added", from: core, to: fixed });
          return `${leading}${fixed}${trailing}`;
        }
        // Quote it.
        const quoted = `"${core.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        changes.push({ kind: "quote_in_list", from: core, to: quoted });
        return `${leading}${quoted}${trailing}`;
      })
      .join(",");
    return `${op} (${rewritten})`;
  });
}

// Rewrites custom-field references from DC ids to Cloud ids using the
// supplied map. Handles both wire forms that appear in DC-authored JQL:
//   cf[NNNN]            — the bracket form, common in dashboard gadgets
//   customfield_NNNN    — the long form, common in REST-API-built filters
// Operates on the whole JQL (these forms don't occur inside string literals
// legitimately, and replacing the literal text inside quotes wouldn't change
// semantics).
function rewriteCfReferences(jql, cfMap, changes) {
  if (!cfMap) return jql;
  const map = cfMap instanceof Map ? cfMap : new Map(Object.entries(cfMap));
  if (map.size === 0) return jql;
  let out = jql.replace(/\bcf\[(\d+)\]/g, (match, n) => {
    const cloud = map.get(String(n));
    if (cloud == null) return match;
    if (changes) {
      changes.push({ kind: "cf_remap", from: `cf[${n}]`, to: `cf[${cloud}]` });
    }
    return `cf[${cloud}]`;
  });
  out = out.replace(/\bcustomfield_(\d+)\b/g, (match, n) => {
    const cloud = map.get(String(n));
    if (cloud == null) return match;
    if (changes) {
      changes.push({
        kind: "cf_remap",
        from: `customfield_${n}`,
        to: `customfield_${cloud}`,
      });
    }
    return `customfield_${cloud}`;
  });
  return out;
}

/**
 * @param {string} jql
 * @param {object} [options]
 * @param {Record<string,string>} [options.fieldRenames]
 * @param {boolean} [options.uppercaseOperators]
 * @param {boolean} [options.quoteInLists]
 * @param {Map<string,string>|Record<string,string>} [options.cfMap] DC cf-id → Cloud cf-id
 * @returns {{ sanitized: string, changes: Array<{kind:string,from:string,to:string}> }}
 */
function sanitizeJql(jql, options = {}) {
  if (!jql || typeof jql !== "string") {
    return { sanitized: jql, changes: [] };
  }
  const renames = { ...DEFAULT_FIELD_RENAMES, ...(options.fieldRenames || {}) };
  const doUppercase = options.uppercaseOperators !== false;
  const doQuoteLists = options.quoteInLists !== false;
  const cfMap = options.cfMap || null;

  const changes = [];

  // cf[N] rewrite runs first, on the raw input. cf-bracket syntax doesn't
  // legitimately appear inside string literals, and a literal occurrence
  // there wouldn't change semantics if it did.
  let working = cfMap ? rewriteCfReferences(jql, cfMap, changes) : jql;

  // Tokenize quoted strings → placeholders. From here on, transforms run
  // on the tokenized text — the regexes can't accidentally match inside
  // string literals, AND constructs like `IN (Foo, "Bar", Baz)` survive
  // intact across the boundary because the placeholder is a single token.
  const { tokenized, placeholders } = tokenizeQuoted(working);

  // Field renames inside quoted strings: e.g. `"Customer Request Type"`
  // (used as a field reference, not a search value).
  applyFieldRenamesInPlaceholders(placeholders, renames, changes);

  // Unquoted-text transforms.
  let t = tokenized;
  t = applyFieldRenamesInUnquoted(t, renames, changes);
  if (doUppercase) t = uppercaseOperators(t, changes);
  if (doQuoteLists) t = quoteInListValues(t, changes);

  return { sanitized: detokenize(t, placeholders), changes };
}

module.exports = {
  sanitizeJql,
  rewriteCfReferences,
  DEFAULT_FIELD_RENAMES,
  RESERVED_WORDS,
};
