// Pure JQL rewriter: extract numeric filter-ID references and rewrite them
// using a DC-id -> Cloud-id map. No I/O. Deterministic and testable in isolation.
//
// Supports:
//   filter = 12345            filter = "12345"
//   filter != 12345           filter != "12345"
//   filter IN (123, "456")    filter NOT IN (123, 456)
//   savedFilter = 12345       (alias — treated identically)
//
// Leaves untouched:
//   filter = "Some Name"      (non-numeric operand)
//   ORDER BY / other clauses
//   IN (...) lists whose inner tokens are function calls or named filters

// Skip anything preceded by a word char so `savedFilter` is matched by the
// savedFilter regex, not the filter regex; and `Xfilter` is never touched.
const EQ_RE = /(?<![A-Za-z0-9_])(filter|savedFilter)(\s*)(=|!=)(\s*)("?)(\d+)\5/gi;

const IN_RE = /(?<![A-Za-z0-9_])(filter|savedFilter)(\s+)(not\s+in|in)(\s*)\(([^)]*)\)/gi;

/**
 * @param {string} jql
 * @returns {Array<{ id: string, keyword: string, operator: string, form: "eq"|"in" }>}
 */
function extractFilterIds(jql) {
  if (!jql || typeof jql !== "string") return [];
  const found = [];

  EQ_RE.lastIndex = 0;
  let m;
  while ((m = EQ_RE.exec(jql)) !== null) {
    found.push({
      id: m[6],
      keyword: m[1],
      operator: m[3],
      form: "eq",
    });
  }

  IN_RE.lastIndex = 0;
  while ((m = IN_RE.exec(jql)) !== null) {
    const keyword = m[1];
    const operator = m[3];
    const inner = m[5];
    for (const token of inner.split(",")) {
      const t = token.trim();
      const num = t.match(/^"?(\d+)"?$/);
      if (num) {
        found.push({
          id: num[1],
          keyword,
          operator,
          form: "in",
        });
      }
    }
  }

  return found;
}

/**
 * Rewrites filter-ID references in `jql` using `dcToCloudMap` (string -> string).
 * IDs without a mapping are left intact and reported in `unresolved`.
 *
 * @param {string} jql
 * @param {Map<string,string>|Object<string,string>} dcToCloudMap
 * @returns {{ rewritten: string, replacements: Array<{dcId:string, cloudId:string, form:string}>, unresolved: string[] }}
 */
function rewriteJql(jql, dcToCloudMap) {
  if (!jql || typeof jql !== "string") {
    return { rewritten: jql, replacements: [], unresolved: [] };
  }

  const map =
    dcToCloudMap instanceof Map
      ? dcToCloudMap
      : new Map(Object.entries(dcToCloudMap || {}));

  const replacements = [];
  const unresolved = new Set();

  const lookup = (dcId) => {
    const v = map.get(String(dcId));
    return v != null ? String(v) : null;
  };

  // Phase 1: rewrite equality forms.
  let rewritten = jql.replace(
    EQ_RE,
    (match, keyword, ws1, op, ws2, quote, numId) => {
      const cloudId = lookup(numId);
      if (!cloudId) {
        unresolved.add(numId);
        return match;
      }
      replacements.push({ dcId: numId, cloudId, form: "eq" });
      return `${keyword}${ws1}${op}${ws2}${quote}${cloudId}${quote}`;
    }
  );

  // Phase 2: rewrite IN lists — per-token so numeric tokens get rewritten
  // while quoted/named/function tokens pass through.
  rewritten = rewritten.replace(
    IN_RE,
    (_match, keyword, ws1, op, ws2, inner) => {
      const tokens = inner.split(",");
      const newTokens = tokens.map((tok) => {
        const leading = tok.match(/^\s*/)[0];
        const trailing = tok.match(/\s*$/)[0];
        const core = tok.trim();
        const numMatch = core.match(/^("?)(\d+)("?)$/);
        if (!numMatch) return tok;
        const [, openQ, numId, closeQ] = numMatch;
        if (openQ !== closeQ) return tok;
        const cloudId = lookup(numId);
        if (!cloudId) {
          unresolved.add(numId);
          return tok;
        }
        replacements.push({ dcId: numId, cloudId, form: "in" });
        return `${leading}${openQ}${cloudId}${closeQ}${trailing}`;
      });
      return `${keyword}${ws1}${op}${ws2}(${newTokens.join(",")})`;
    }
  );

  return {
    rewritten,
    replacements,
    unresolved: Array.from(unresolved),
  };
}

// Scans JQL for `aqlFunction("...")` calls and rewrites the inner AQL string
// via the provided `aqlRewriteFn`. Handles backslash-escaped quotes inside
// the AQL body. Non-matching segments pass through unchanged.
//
// aqlRewriteFn signature: (aqlBody: string) => { rewritten, replacements, unresolved }
//
// Aggregates replacements + unresolved across all aqlFunction occurrences.
function rewriteAqlFunctionBodies(jql, aqlRewriteFn) {
  if (!jql || typeof jql !== "string" || typeof aqlRewriteFn !== "function") {
    return { rewritten: jql, replacements: [], unresolved: [] };
  }
  const replacements = [];
  const unresolved = new Set();

  // Match aqlFunction("<escape-aware body>").
  const re =
    /\b(aqlFunction)\s*\(\s*"((?:[^"\\]|\\.)*)"\s*\)/gi;

  const rewritten = jql.replace(re, (_match, fname, escapedBody) => {
    // Unescape inner body for the rewriter, then re-escape after.
    const body = escapedBody.replace(/\\(.)/g, "$1");
    const result = aqlRewriteFn(body);
    if (result && Array.isArray(result.replacements)) {
      for (const r of result.replacements) replacements.push({ ...r, function: fname });
    }
    if (result && Array.isArray(result.unresolved)) {
      for (const u of result.unresolved) unresolved.add(u);
    }
    const newBody = (result && result.rewritten) || body;
    const reescaped = newBody.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${fname}("${reescaped}")`;
  });

  return { rewritten, replacements, unresolved: Array.from(unresolved) };
}

module.exports = { extractFilterIds, rewriteJql, rewriteAqlFunctionBodies };
