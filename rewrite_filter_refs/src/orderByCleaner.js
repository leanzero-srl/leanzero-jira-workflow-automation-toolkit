// Strips ORDER BY clauses referencing Assets (CMDB) custom fields. Cloud
// explicitly does not support sorting by Assets object fields — the docs
// say "in Assets for Cloud, users can't use an Assets object field to sort
// search results in a JQL query." Filters carrying such a clause hit a 400
// on PUT or silently lose the sort.
//
// Strategy:
//   1. Find the outermost ORDER BY (case-insensitive). Anything after is
//      the sort spec.
//   2. Split the sort spec by top-level commas.
//   3. Drop entries whose field (quoted or bare) matches an asset field name.
//   4. If everything was dropped, remove the whole ORDER BY. Otherwise leave
//      a partial clause with the survivors.
//
// Returns { rewritten, stripped: [{ field, direction }] }. Idempotent — a
// second run on the rewritten output drops nothing.

const { splitTopLevelCommas } = require("./aqlRewriter");

function normalizeName(s) {
  return String(s || "").normalize("NFC").trim().toLowerCase();
}

// Locate the start of the trailing ORDER BY. Naive scan is unsafe because
// "ORDER BY" can legally appear inside a quoted string (e.g.
// `summary ~ "set order by hand"`). Walk the string respecting JQL quote
// rules and return the index of the outermost ORDER BY keyword, or -1.
function findOrderByStart(jql) {
  const lower = jql.toLowerCase();
  let i = 0;
  while (i < jql.length) {
    const c = jql[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < jql.length) {
        const cc = jql[i];
        if (cc === "\\" && i + 1 < jql.length) {
          i += 2;
          continue;
        }
        if (cc === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (
      lower.startsWith("order by", i) &&
      (i === 0 || /[\s)]/.test(jql[i - 1])) &&
      /[\s"']/.test(jql[i + 8] || "")
    ) {
      return i;
    }
    i++;
  }
  return -1;
}

// Pull the field name (quoted or bare) and trailing direction off one
// ORDER BY token. Returns null if the token can't be parsed (defensive —
// leaves it intact in that case).
function parseSortToken(token) {
  const trimmed = token.trim();
  if (!trimmed) return null;
  // Quoted form
  let m = trimmed.match(/^(["'])((?:[^"'\\]|\\.)*)\1\s*(ASC|DESC)?\s*$/i);
  if (m) {
    return {
      field: m[2],
      direction: (m[3] || "").toUpperCase(),
      quoted: true,
      original: token,
    };
  }
  // Function call (e.g. cf[12345])
  m = trimmed.match(/^(cf\[\d+\]|customfield_\d+)\s*(ASC|DESC)?\s*$/i);
  if (m) {
    return {
      field: m[1],
      direction: (m[2] || "").toUpperCase(),
      quoted: false,
      original: token,
    };
  }
  // Bare identifier
  m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(ASC|DESC)?\s*$/);
  if (m) {
    return {
      field: m[1],
      direction: (m[2] || "").toUpperCase(),
      quoted: false,
      original: token,
    };
  }
  return null;
}

/**
 * @param {string} jql
 * @param {object} options
 * @param {Set<string>|Array<string>} options.assetFieldNames - normalized names
 * @returns {{ rewritten: string, stripped: Array<{field, direction}> }}
 */
function cleanOrderBy(jql, options = {}) {
  if (!jql || typeof jql !== "string") {
    return { rewritten: jql, stripped: [] };
  }
  const names =
    options.assetFieldNames instanceof Set
      ? options.assetFieldNames
      : new Set((options.assetFieldNames || []).map(normalizeName));
  if (names.size === 0) return { rewritten: jql, stripped: [] };

  const idx = findOrderByStart(jql);
  if (idx < 0) return { rewritten: jql, stripped: [] };

  const prefix = jql.slice(0, idx);
  const after = jql.slice(idx);
  // after begins with "ORDER BY" or "order by" — preserve original casing
  // for the survivors.
  const keyword = after.slice(0, 8);
  const sortSpec = after.slice(8);

  const tokens = splitTopLevelCommas(sortSpec);
  const stripped = [];
  const kept = [];

  for (const tok of tokens) {
    const parsed = parseSortToken(tok);
    if (!parsed) {
      kept.push(tok);
      continue;
    }
    const fieldNorm = normalizeName(parsed.field);
    if (names.has(fieldNorm)) {
      stripped.push({ field: parsed.field, direction: parsed.direction || "" });
      continue;
    }
    kept.push(tok);
  }

  if (stripped.length === 0) {
    return { rewritten: jql, stripped: [] };
  }

  // All sort entries dropped → remove the ORDER BY entirely.
  if (kept.length === 0) {
    return { rewritten: prefix.replace(/\s+$/, ""), stripped };
  }

  // Some survived → re-emit ORDER BY with the survivors. Reuse the
  // original casing of the keyword so a filter saying "Order By" stays
  // "Order By".
  const rebuilt = `${prefix}${keyword}${kept.join(",")}`;
  return { rewritten: rebuilt, stripped };
}

module.exports = { cleanOrderBy, findOrderByStart, parseSortToken };
