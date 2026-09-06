// Detects `project` clauses in JQL referencing keys/names that don't exist on
// the target Cloud tenant. Used to pre-skip filters that would otherwise
// 400 with "The value 'X' does not exist for the field 'project'" — the single
// largest failure class in post-migration runs.
//
// Strategy: replace every quoted string with a placeholder token (chr-1
// delimited so it can't collide with real JQL syntax), then run regex on the
// tokenized form. Placeholders pass through `IN (...)` lists unchanged and
// get expanded back when we need to compare against the known-projects set.

// Match `project = X` / `project != X` where X is one bare token.
const PROJECT_EQ_RE = /(?<![A-Za-z0-9_])project(\s*)(=|!=)(\s*)([^\s,)]+)/gi;
const PROJECT_IN_RE = /(?<![A-Za-z0-9_])project(\s+)(not\s+in|in)(\s*)\(([^)]*)\)/gi;

const PH_OPEN = "";
const PH_CLOSE = "";
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
    if (!p) return match; // input had literal control chars; leave intact
    return `${p.quote}${p.body}${p.quote}`;
  });
}

// Resolve a value token (which may be a placeholder OR a bare identifier)
// to the user-visible string for comparison against known-projects.
function expandValue(tok, placeholders) {
  const m = PH_RE.exec(tok);
  if (m) return placeholders[Number(m[1])].body.replace(/\\(.)/g, "$1");
  return tok.trim();
}

function isProjectKnown(value, knownLcSet) {
  if (!value) return true;
  const v = String(value).trim().toLowerCase();
  if (!v) return true;
  return knownLcSet.has(v);
}

function buildKnownProjectSet(cloudProjects) {
  const set = new Set();
  for (const p of cloudProjects || []) {
    if (p.key) set.add(String(p.key).toLowerCase());
    if (p.name) set.add(String(p.name).toLowerCase());
    if (p.id) set.add(String(p.id).toLowerCase());
  }
  return set;
}

/**
 * @param {string} jql
 * @param {Set<string>} knownLcSet
 * @returns {string[]} unique project values referenced in JQL that are NOT
 *   in `knownLcSet`. Original casing preserved.
 */
function detectMissingProjects(jql, knownLcSet) {
  if (!jql || typeof jql !== "string") return [];
  if (!knownLcSet || knownLcSet.size === 0) return [];
  const { tokenized, placeholders } = tokenizeQuoted(jql);
  const missing = new Set();

  PROJECT_EQ_RE.lastIndex = 0;
  let m;
  while ((m = PROJECT_EQ_RE.exec(tokenized)) !== null) {
    const v = expandValue(m[4], placeholders);
    if (!isProjectKnown(v, knownLcSet)) missing.add(v);
  }

  PROJECT_IN_RE.lastIndex = 0;
  while ((m = PROJECT_IN_RE.exec(tokenized)) !== null) {
    const inner = m[4];
    for (const tok of inner.split(",")) {
      const v = expandValue(tok, placeholders);
      if (!v) continue;
      if (!isProjectKnown(v, knownLcSet)) missing.add(v);
    }
  }

  return Array.from(missing);
}

/**
 * Rewrites JQL with missing tokens dropped from `project IN (...)` lists.
 * Equality misses are detected (set hasEqualityMiss=true) but the JQL is
 * NOT mutated for those — caller should mark the filter skipped.
 * If an IN list ends up empty, returns rewritten=null.
 *
 * @returns {{ rewritten: string|null, dropped: string[], hasEqualityMiss: boolean, missingValues: string[] }}
 */
function pruneMissingProjectsFromInLists(jql, knownLcSet) {
  if (!jql || typeof jql !== "string") {
    return { rewritten: jql, dropped: [], hasEqualityMiss: false, missingValues: [] };
  }
  if (!knownLcSet || knownLcSet.size === 0) {
    return { rewritten: jql, dropped: [], hasEqualityMiss: false, missingValues: [] };
  }

  const { tokenized, placeholders } = tokenizeQuoted(jql);
  const dropped = [];
  const allMissing = [];
  let hasEqualityMiss = false;
  let unfixable = false;

  PROJECT_EQ_RE.lastIndex = 0;
  let m;
  while ((m = PROJECT_EQ_RE.exec(tokenized)) !== null) {
    const v = expandValue(m[4], placeholders);
    if (!isProjectKnown(v, knownLcSet)) {
      hasEqualityMiss = true;
      allMissing.push(v);
    }
  }

  const rewrittenTok = tokenized.replace(PROJECT_IN_RE, (_match, ws1, op, ws2, inner) => {
    const tokens = inner.split(",");
    const kept = [];
    let anyDropped = false;
    for (const tok of tokens) {
      const core = tok.trim();
      if (!core) {
        kept.push(tok);
        continue;
      }
      const v = expandValue(core, placeholders);
      if (isProjectKnown(v, knownLcSet)) {
        kept.push(tok);
      } else {
        dropped.push(v);
        allMissing.push(v);
        anyDropped = true;
      }
    }
    if (kept.length === 0) {
      unfixable = true;
      return _match;
    }
    // If we dropped any tokens, normalize spacing so the surviving list
    // doesn't carry phantom leading/trailing whitespace from the drops.
    // E.g. `(Alpha, "X", "Y")` → kept `[" \x01Q0\x02", " \x01Q1\x02"]` →
    // join would produce `( "X", "Y")`. Trim the first kept token's leading
    // and the last kept token's trailing whitespace.
    if (anyDropped && kept.length > 0) {
      kept[0] = kept[0].replace(/^\s+/, "");
      kept[kept.length - 1] = kept[kept.length - 1].replace(/\s+$/, "");
    }
    return `project${ws1}${op}${ws2}(${kept.join(",")})`;
  });

  return {
    rewritten: unfixable ? null : detokenize(rewrittenTok, placeholders),
    dropped,
    hasEqualityMiss,
    missingValues: Array.from(new Set(allMissing)),
  };
}

module.exports = {
  buildKnownProjectSet,
  detectMissingProjects,
  pruneMissingProjectsFromInLists,
};
