// Pure AQL rewriter: given an AQL string (the body of an `aqlFunction("...")`
// call), rewrite DC identifiers to their Cloud equivalents using preloaded
// maps.
//
// Handles four fragments (case-insensitive keyword):
//   Key = "CMDB-21171"
//   Key IN ("CMDB-21171", "CMDB-21180")
//   objectId = 14032
//   objectId IN (14032, 14033)
//
// Unknown tokens are left untouched and reported in `unresolved`. Anything
// outside these shapes (e.g. Name = "...", attribute filters, logical
// operators) passes through unchanged.

const KEY_EQ_RE = /(?<![A-Za-z0-9_])(Key)(\s*)(=|!=)(\s*)"((?:[^"\\]|\\.)*)"/gi;
const KEY_IN_RE = /(?<![A-Za-z0-9_])(Key)(\s+)(not\s+in|in)(\s*)\(([^)]*)\)/gi;
const OBJID_EQ_RE = /(?<![A-Za-z0-9_])(objectId)(\s*)(=|!=)(\s*)(\d+)/gi;
const OBJID_IN_RE = /(?<![A-Za-z0-9_])(objectId)(\s+)(not\s+in|in)(\s*)\(([^)]*)\)/gi;

function unescapeAql(s) {
  return s.replace(/\\(.)/g, "$1");
}

function escapeAqlValue(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * @param {string} aql
 * @param {{ dcKeyToCloudKey?: Map|Object, dcObjectIdToCloudObjectId?: Map|Object }} maps
 * @returns {{ rewritten: string, replacements: Array, unresolved: Array }}
 */
function rewriteAql(aql, maps = {}) {
  if (!aql || typeof aql !== "string") {
    return { rewritten: aql, replacements: [], unresolved: [] };
  }

  const keyMap =
    maps.dcKeyToCloudKey instanceof Map
      ? maps.dcKeyToCloudKey
      : new Map(Object.entries(maps.dcKeyToCloudKey || {}));
  const idMap =
    maps.dcObjectIdToCloudObjectId instanceof Map
      ? maps.dcObjectIdToCloudObjectId
      : new Map(Object.entries(maps.dcObjectIdToCloudObjectId || {}));

  const replacements = [];
  const unresolved = new Set();

  const lookupKey = (dc) => {
    const v = keyMap.get(String(dc));
    return v != null ? String(v) : null;
  };
  const lookupId = (dc) => {
    const v = idMap.get(String(dc));
    return v != null ? String(v) : null;
  };

  // Key = "CMDB-21171"
  let rewritten = aql.replace(
    KEY_EQ_RE,
    (match, kw, ws1, op, ws2, inner) => {
      const dcKey = unescapeAql(inner);
      const cloudKey = lookupKey(dcKey);
      if (!cloudKey) {
        unresolved.add(`key:${dcKey}`);
        return match;
      }
      replacements.push({ kind: "key", dcValue: dcKey, cloudValue: cloudKey });
      return `${kw}${ws1}${op}${ws2}"${escapeAqlValue(cloudKey)}"`;
    },
  );

  // Key IN ("CMDB-21171", "CMDB-21180")
  rewritten = rewritten.replace(
    KEY_IN_RE,
    (_match, kw, ws1, op, ws2, inner) => {
      const tokens = splitTopLevelCommas(inner);
      const newTokens = tokens.map((tok) => {
        const leading = tok.match(/^\s*/)[0];
        const trailing = tok.match(/\s*$/)[0];
        const core = tok.trim();
        const q = core.match(/^"((?:[^"\\]|\\.)*)"$/);
        if (!q) return tok;
        const dcKey = unescapeAql(q[1]);
        const cloudKey = lookupKey(dcKey);
        if (!cloudKey) {
          unresolved.add(`key:${dcKey}`);
          return tok;
        }
        replacements.push({ kind: "key", dcValue: dcKey, cloudValue: cloudKey });
        return `${leading}"${escapeAqlValue(cloudKey)}"${trailing}`;
      });
      return `${kw}${ws1}${op}${ws2}(${newTokens.join(",")})`;
    },
  );

  // objectId = 14032
  rewritten = rewritten.replace(
    OBJID_EQ_RE,
    (match, kw, ws1, op, ws2, numId) => {
      const cloudId = lookupId(numId);
      if (!cloudId) {
        unresolved.add(`objectId:${numId}`);
        return match;
      }
      replacements.push({ kind: "objectId", dcValue: numId, cloudValue: cloudId });
      return `${kw}${ws1}${op}${ws2}${cloudId}`;
    },
  );

  // objectId IN (14032, 14033)
  rewritten = rewritten.replace(
    OBJID_IN_RE,
    (_match, kw, ws1, op, ws2, inner) => {
      const tokens = splitTopLevelCommas(inner);
      const newTokens = tokens.map((tok) => {
        const leading = tok.match(/^\s*/)[0];
        const trailing = tok.match(/\s*$/)[0];
        const core = tok.trim();
        const m = core.match(/^(\d+)$/);
        if (!m) return tok;
        const cloudId = lookupId(m[1]);
        if (!cloudId) {
          unresolved.add(`objectId:${m[1]}`);
          return tok;
        }
        replacements.push({ kind: "objectId", dcValue: m[1], cloudValue: cloudId });
        return `${leading}${cloudId}${trailing}`;
      });
      return `${kw}${ws1}${op}${ws2}(${newTokens.join(",")})`;
    },
  );

  return {
    rewritten,
    replacements,
    unresolved: Array.from(unresolved),
  };
}

// Split on commas that aren't inside quoted strings.
function splitTopLevelCommas(s) {
  const out = [];
  let depth = 0;
  let inQuote = false;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

module.exports = { rewriteAql, escapeAqlValue, splitTopLevelCommas };
