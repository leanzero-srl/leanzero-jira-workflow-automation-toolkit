// Removes calls to JQL functions that DC supported (via ScriptRunner /
// JQL Tricks plugins) but Cloud does not — e.g. `subtask("...")`,
// `parent("...")`, `linkedIssuesInProject(...)`, `membersOfGroups(...)`,
// `issueFunction in ...`. These cause the post-JCMA filter PUT to 400 with
// "Unable to find JQL function 'X'".
//
// Strategy:
//   1. Find each unsupported function call with paren-balanced bounds, ignoring
//      bodies inside quoted strings.
//   2. Walk LEFT from the call to swallow the field+operator that introduced
//      it (e.g. `issue in subtask(...)` → drop the whole `issue in subtask(...)`).
//   3. Walk OUTWARDS to swallow ONE adjacent boolean connector (AND or OR) so
//      the remaining JQL stays syntactically valid (`A AND B` → `A`).
//   4. Run a final cleanup pass: collapse whitespace, drop empty parens, strip
//      orphaned leading/trailing AND/OR.
//
// This is destructive (changes filter semantics) — the caller must opt in,
// and every strip is recorded so it can be reviewed in a CSV report.

// Functions we know don't exist in Cloud's native JQL engine. Lowercase for
// case-insensitive match.
//
// Cross-checked against the canonical Cloud JQL function reference at
// https://support.atlassian.com/jira-software-cloud/docs/jql-functions/
// — only names confirmed ABSENT from that list are added here. Names that
// were on a draft list but are actually Cloud-supported (e.g. parentEpic,
// componentsLeadByUser, projectsLeadByUser, myApproval, cascadeOption,
// membersOf, standardIssueTypes, votedIssues, watchedIssues, the now/start*/end*
// date helpers, …) are deliberately NOT added — including them here would
// corrupt valid filters.
//
// ScriptRunner Enhanced Search exposes its own JQL functions (issueFunction,
// subtasksOf, linkedIssuesOf, etc.) but ONLY inside the Enhanced Search app,
// not in native Cloud Jira filters that we PUT to. See
// https://docs.adaptavist.com/sr4js/9.13.0/scriptrunner-migration/migrating-to-cloud/troubleshoot-scriptrunner-migration
// — JCMA may auto-migrate ScriptRunner-flavoured filters to the Enhanced
// Search app, but for filters it could not migrate (owner missing perms /
// stale / nested), stripping the DC-only clauses is the only way to make the
// Cloud filter PUT succeed.
const DEFAULT_BROKEN_FUNCTIONS = [
  // (P) production-confirmed against this tenant — observed in HTTP 400s
  "subtask",
  "parent",
  "linkedissuesinproject",
  "membersofgroups",
  "issuefunction", // function-call form; field form handled separately
  "subtasksof", // P  via filter 19358 (issueFunction in subtasksOf("…"))
  "hassubtasks", // P  via 14270 / 14096 / 27370
  "versionsafterdate", // P  via 17405
  "issueswhereepicin", // P  via 25901

  // (S) ScriptRunner Enhanced Search / JQL Tricks — DC-only outside the app
  "linkedissuesof",
  "parentsof",
  "epicsof",
  "epicstoriesof",
  "versionsbeforedate",
  "issuesinepics",
  "hascomments",
  "hasattachments",
  "haslinks",
  "haslinktype",
  "hasworklogs",
  "hasepics",
  "addedafter",
  "addedbefore",
  "lastmodified",
  "lastcomment",
  "datecompare",
  "aggregateexpression",
  "expression",
  "commented",
  "voted",
  "watched",
  "linkedissuesofrecursive",
  "linkedissuesofquery",
  "linkedissuesofremote",
];

// Operators that may sit between a field and the function call. Order matters:
// longer first, so "not in" beats "in" and "is not" beats "is".
const OPERATORS = [
  "not in",
  "is not empty",
  "is empty",
  "is not",
  "is",
  "in",
  "!=",
  "=",
  "!~",
  "~",
];

/**
 * Find all unsupported function calls in `jql`. Returns matches sorted by
 * start index (descending) so the caller can splice them out from end to
 * start without invalidating earlier indices.
 */
function findFunctionCalls(jql, fnNames) {
  const wanted = new Set((fnNames || []).map((s) => s.toLowerCase()));
  if (wanted.size === 0) return [];
  const out = [];
  // Tokenize: find candidates `name(` outside quoted strings.
  let i = 0;
  let inQ = null;
  let escaped = false;
  while (i < jql.length) {
    const c = jql[i];
    if (escaped) {
      escaped = false;
      i++;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      i++;
      continue;
    }
    if (inQ) {
      if (c === inQ) inQ = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inQ = c;
      i++;
      continue;
    }
    // Try to match a name at position i
    const m = /^([A-Za-z_]\w*)\s*\(/.exec(jql.slice(i));
    if (m && wanted.has(m[1].toLowerCase())) {
      const nameStart = i;
      const openParen = i + m[0].length - 1;
      const closeParen = findMatchingClose(jql, openParen);
      if (closeParen === -1) {
        i++;
        continue; // unbalanced — give up on this call
      }
      out.push({
        name: m[1],
        start: nameStart,
        end: closeParen + 1,
      });
      i = closeParen + 1;
      continue;
    }
    i++;
  }
  // Sort descending so splicing right-to-left preserves earlier indices.
  out.sort((a, b) => b.start - a.start);
  return out;
}

/**
 * Find DC-style "issueFunction <op> name(...)" clauses where `issueFunction`
 * is being used as the FIELD name (a JQL Tricks / older ScriptRunner
 * construct). Cloud rejects this with
 *   "Field 'issueFunction' does not exist or you do not have permission to view it."
 * because Cloud's native JQL engine doesn't expose the `issueFunction` field
 * — it only exists inside the ScriptRunner Enhanced Search app.
 *
 * The whole clause — `issueFunction`, the operator, the function name, and
 * the paren-balanced body — is removed as one unit, regardless of which
 * function follows. This runs BEFORE the regular function-call detector and
 * is independent of the broken-function name list (because here the broken
 * thing is the FIELD, not the function).
 *
 * Returns matches sorted by `start` descending so callers can splice
 * right-to-left without invalidating earlier indices.
 */
function findIssueFunctionFieldClauses(jql) {
  const out = [];
  // Operators that may legitimately introduce a function-valued operand.
  // `is empty` / `is not empty` are deliberately excluded — they take no
  // operand. Longer operators must come first so "not in" beats "in" and
  // "is not" beats "is".
  const OPS_RE = [
    { name: "not in", re: /^not\s+in\b/i },
    { name: "is not", re: /^is\s+not\b/i },
    { name: "in", re: /^in\b/i },
    { name: "is", re: /^is\b/i },
    { name: "!=", re: /^!=/ },
    { name: "=", re: /^=/ },
    { name: "!~", re: /^!~/ },
    { name: "~", re: /^~/ },
  ];

  let i = 0;
  let inQ = null;
  let escaped = false;
  while (i < jql.length) {
    const c = jql[i];
    if (escaped) {
      escaped = false;
      i++;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      i++;
      continue;
    }
    if (inQ) {
      if (c === inQ) inQ = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inQ = c;
      i++;
      continue;
    }

    // Match "issueFunction" at a word boundary (case-insensitive).
    const before = i === 0 ? "" : jql[i - 1];
    if (
      (i === 0 || /[^A-Za-z0-9_]/.test(before)) &&
      /^issueFunction\b/i.test(jql.slice(i, i + 14))
    ) {
      const fieldStart = i;
      let j = i + "issueFunction".length;
      // Skip whitespace between field and operator
      while (j < jql.length && /\s/.test(jql[j])) j++;
      // Match operator (longest-first)
      const tail = jql.slice(j);
      let opLen = 0;
      let opName = null;
      for (const { name, re } of OPS_RE) {
        const m = re.exec(tail);
        if (m) {
          opLen = m[0].length;
          opName = name;
          break;
        }
      }
      if (!opLen) {
        i = j > i ? j : i + 1;
        continue;
      }
      let k = j + opLen;
      // Skip whitespace between operator and function name
      while (k < jql.length && /\s/.test(jql[k])) k++;
      // Expect `name(...)`
      const nameMatch = /^([A-Za-z_]\w*)\s*\(/.exec(jql.slice(k));
      if (!nameMatch) {
        i = k > i ? k : i + 1;
        continue;
      }
      const fnName = nameMatch[1];
      const openParen = k + nameMatch[0].length - 1;
      const closeParen = findMatchingClose(jql, openParen);
      if (closeParen === -1) {
        // Unbalanced — give up on this match, keep scanning.
        i = k + 1;
        continue;
      }
      out.push({
        kind: "issueFunctionField",
        name: `issueFunction ${opName} ${fnName}`,
        start: fieldStart,
        end: closeParen + 1,
      });
      i = closeParen + 1;
      continue;
    }
    i++;
  }
  out.sort((a, b) => b.start - a.start);
  return out;
}

function findMatchingClose(s, openIdx) {
  let depth = 0;
  let inQ = null;
  let escaped = false;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (inQ) {
      if (c === inQ) inQ = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inQ = c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Given the start of an unsupported function call, walk LEFT through optional
 * whitespace + operator + field, returning the new start index of the clause.
 * Falls back to the original start if the pattern doesn't match (we'd rather
 * leave the call than chop something we don't understand).
 */
function expandToClauseStart(jql, callStart) {
  // Skip whitespace
  let i = callStart;
  while (i > 0 && /\s/.test(jql[i - 1])) i--;
  // Try each operator (longest first), case-insensitive.
  const pre = jql.slice(0, i).toLowerCase();
  let opLen = 0;
  for (const op of OPERATORS) {
    // operator must be preceded by whitespace and not be part of a longer word
    const idx = pre.length - op.length;
    if (idx < 0) continue;
    const slice = pre.slice(idx);
    if (slice !== op) continue;
    // require boundary on the left (whitespace or start)
    const before = idx === 0 ? "" : pre[idx - 1];
    if (idx > 0 && /[A-Za-z0-9_]/.test(before)) continue;
    opLen = op.length;
    break;
  }
  if (opLen === 0) return callStart; // no operator found — abort
  let opStart = i - opLen;
  // Skip whitespace before operator
  while (opStart > 0 && /\s/.test(jql[opStart - 1])) opStart--;
  // Read field token: either `cf[N]`, "quoted name", or unquoted identifier
  let fieldStart = opStart;
  if (fieldStart > 0 && jql[fieldStart - 1] === "]") {
    // cf[N] / Foo[bar] — find matching `[`, then walk back over the identifier.
    const open = jql.lastIndexOf("[", fieldStart - 1);
    if (open === -1) return callStart;
    const idMatch = jql.slice(0, open).match(/[A-Za-z_]\w*$/);
    if (!idMatch) return callStart;
    fieldStart = open - idMatch[0].length;
  } else if (fieldStart > 0 && jql[fieldStart - 1] === '"') {
    const open = jql.lastIndexOf('"', fieldStart - 2);
    if (open === -1) return callStart;
    fieldStart = open;
  } else if (fieldStart > 0 && jql[fieldStart - 1] === "'") {
    const open = jql.lastIndexOf("'", fieldStart - 2);
    if (open === -1) return callStart;
    fieldStart = open;
  } else {
    const m = jql.slice(0, fieldStart).match(/[A-Za-z_][\w.]*$/);
    if (!m) return callStart;
    fieldStart = fieldStart - m[0].length;
  }
  return fieldStart;
}

/**
 * Expand a [start,end) range outwards to consume one adjacent AND/OR
 * connector (preferring leading, falling back to trailing). Returns the
 * new {start, end} or the original range if no connector is adjacent.
 */
function expandToConnector(jql, start, end) {
  const pre = jql.slice(0, start);
  const post = jql.slice(end);
  // Leading: " AND " or " OR " before clause
  const preMatch = /(\s+(?:AND|OR)\s+)$/i.exec(pre);
  if (preMatch) {
    return { start: start - preMatch[1].length, end };
  }
  // Trailing: " AND " or " OR " after clause
  const postMatch = /^(\s+(?:AND|OR)\s+)/i.exec(post);
  if (postMatch) {
    return { start, end: end + postMatch[1].length };
  }
  return { start, end };
}

/**
 * Final cleanup: collapse whitespace, kill empty parens, strip orphaned
 * leading/trailing AND/OR connectors, and remove duplicate connectors.
 */
function cleanupJql(jql) {
  if (!jql) return jql;
  let out = jql;
  // Collapse runs of horizontal whitespace
  out = out.replace(/[ \t]+/g, " ");
  // Empty / whitespace-only parens AND empty-IN-list cleanup, run together
  // to fixed point. The empty-IN rule must fire BEFORE empty-parens so it
  // can still see the `()` — otherwise `affectedVersion in ()` becomes
  // `affectedVersion in ` with the parens already collapsed, which would
  // syntactically rot the rest of the JQL.
  //
  // Field-name forms recognised:
  //   • bare identifier:  priority, status, Workstream.name (NOT reserved words)
  //   • bracket form:     cf[10037]
  //   • long form:        customfield_10037
  //   • quoted name:      "Sub-Account"
  //
  // CRITICAL: the bare-identifier branch must NOT match reserved words
  // (NOT, IN, AND, OR, IS, WAS, CHANGED, BEFORE, AFTER, DURING). Otherwise
  // a stray `NOT IN ()` is matched with "NOT" as the field-name, the regex
  // eats just "NOT IN ()", and the actual field left of it survives as an
  // orphan token followed by AND/OR — producing JQL like `cf[10037]  AND
  // status...` that Cloud rejects as "Expecting operator but got 'AND'".
  const RESERVED_WORDS_NOT_A_FIELD =
    "NOT|IN|AND|OR|IS|WAS|CHANGED|BEFORE|AFTER|DURING|FROM|TO|ON|BY|EMPTY|NULL";
  const FIELD_PATTERN =
    `(?:\\b(?!(?:${RESERVED_WORDS_NOT_A_FIELD})\\b)[A-Za-z_][\\w.]*` +
    `|cf\\[\\d+\\]|customfield_\\d+|"[^"\\\\]*(?:\\\\.[^"\\\\]*)*")`;
  const EMPTY_IN_RE = new RegExp(
    `${FIELD_PATTERN}\\s+(?:NOT\\s+)?IN\\s*\\(\\s*\\)`,
    "gi",
  );
  let prev;
  do {
    prev = out;
    out = out.replace(EMPTY_IN_RE, "");
    // CRITICAL: the empty-parens rule must NOT match function-call parens
    // (e.g. `startOfMonth()`, `currentUser()`, `subTaskIssueTypes()`). A
    // word char immediately before `(` is the function-call signal — use a
    // negative lookbehind to skip those. This rule still fires for empty
    // grouping parens like `(  )`, `(\n)`, `( AND foo` (which left over
    // `( )`), and the `()` byte-pair produced after the empty-IN regex
    // above strips its surrounding `field [NOT] IN ` prefix.
    out = out.replace(/(?<![A-Za-z0-9_])\(\s*\)/g, "");
  } while (out !== prev);

  // Orphan field reference (cf[N] / customfield_N) immediately followed by
  // AND/OR/ORDER BY with NO operator in between — survives from filters
  // previously corrupted by the empty-IN regex bug above. Recovery only.
  // Safe because `cf[N]` and `customfield_N` are always JQL field forms
  // (never values), so removing them when no operator follows can only
  // delete invalid JQL, never valid JQL.
  do {
    prev = out;
    out = out.replace(
      /(?:cf\[\d+\]|customfield_\d+)\s+(?=(?:AND|OR)\b|ORDER\s+BY\b)/gi,
      "",
    );
  } while (out !== prev);
  // Loop the orphan-connector cleanups since one removal can create another.
  do {
    prev = out;
    // Orphan AND/OR right after `(`: "( AND foo" → "(foo"
    out = out.replace(/\(\s*(?:AND|OR)\s+/gi, "(");
    // Orphan AND/OR at start of expression
    out = out.replace(/^\s*(?:AND|OR)\s+/i, "");
    // Orphan AND/OR right before `)`: "foo AND )" → "foo)"
    out = out.replace(/\s+(?:AND|OR)\s*\)/gi, ")");
    // Orphan AND/OR immediately before ORDER BY: "foo AND ORDER BY x"
    // → "foo ORDER BY x". Critical: replace with a single space, NOT empty,
    // to preserve the separator between the surviving clause and ORDER BY.
    // Otherwise `New AND ORDER BY` collapses to `NewORDER BY` and Cloud
    // emits "Expecting either 'OR' or 'AND' but got 'DESC'".
    out = out.replace(/\s+(?:AND|OR)\s+(?=ORDER\s+BY\b)/gi, " ");
    // Orphan AND/OR at end of expression: "foo AND" → "foo"
    out = out.replace(/\s+(?:AND|OR)\s*$/gi, "");
    // Orphan NOT directly followed by a boolean: " NOT AND ..." → " ..."
    // Lookahead is AND|OR — never IN — so a real `NOT IN (...)` is
    // unaffected. `IS NOT EMPTY` is also untouched (NOT followed by EMPTY).
    out = out.replace(/(^|\s|\()NOT\s+(?=AND\b|OR\b)/gi, "$1");
    // Orphan NOT immediately before ORDER BY or `)`: same separator trick.
    out = out.replace(/\s+NOT\s+(?=ORDER\s+BY\b)/gi, " ");
    out = out.replace(/\s+NOT\s*(?=\))/gi, "");
    // Orphan NOT at end of expression
    out = out.replace(/\s+NOT\s*$/gi, "");
    // Duplicate connector that may form after a split: "foo AND AND bar"
    out = out.replace(/\b(AND|OR)\s+\1\b/gi, "$1");
    // Conflicting adjacent connectors after orphan-field cleanup:
    //   "foo AND OR bar"  →  "foo OR bar"
    //   "foo OR AND bar"  →  "foo AND bar"
    // The second connector wins — it represents the boundary the original
    // expression intended once the orphan term between them was stripped.
    out = out.replace(/\b(?:AND|OR)\s+(AND|OR)\b/gi, "$1");
  } while (out !== prev);
  return out.trim();
}

/**
 * Strip unsupported function calls from JQL.
 *
 * @param {string} jql
 * @param {object} [options]
 * @param {string[]} [options.functions] override the default function list
 * @returns {{ rewritten: string, stripped: Array<{function: string, removed: string}> }}
 */
function stripBrokenFunctions(jql, options = {}) {
  if (!jql || typeof jql !== "string") {
    return { rewritten: jql, stripped: [] };
  }
  const fnNames = options.functions || DEFAULT_BROKEN_FUNCTIONS;

  // The issueFunction-as-field path runs unconditionally — `issueFunction`
  // is the *field*, so the user-supplied --broken-functions override (which
  // is a list of function names) doesn't gate it. This is intentional: the
  // single opt-in flag --strip-broken-functions enables both detectors.
  const fieldClauses = findIssueFunctionFieldClauses(jql);
  const calls = findFunctionCalls(jql, fnNames);

  // Drop any function-call match that lives entirely inside an
  // issueFunction-field range — the field clause already swallows it.
  const filteredCalls = calls.filter(
    (c) => !fieldClauses.some((fc) => c.start >= fc.start && c.end <= fc.end),
  );

  const all = [...fieldClauses, ...filteredCalls].sort(
    (a, b) => b.start - a.start,
  );

  if (all.length === 0) {
    return { rewritten: jql, stripped: [] };
  }

  let working = jql;
  const stripped = [];
  // Iterate descending (already sorted) so earlier slices stay valid.
  for (const m of all) {
    let range;
    if (m.kind === "issueFunctionField") {
      // The field+op are already part of m's range; only expand outward
      // to swallow ONE adjacent boolean connector.
      range = expandToConnector(working, m.start, m.end);
    } else {
      const clauseStart = expandToClauseStart(working, m.start);
      range = expandToConnector(working, clauseStart, m.end);
    }
    const removed = working.slice(range.start, range.end);
    stripped.push({
      function: m.name,
      removed: removed.trim(),
    });
    working = working.slice(0, range.start) + working.slice(range.end);
  }

  const rewritten = cleanupJql(working);
  return { rewritten, stripped };
}

module.exports = {
  stripBrokenFunctions,
  findFunctionCalls,
  findIssueFunctionFieldClauses,
  cleanupJql,
  expandToConnector,
  DEFAULT_BROKEN_FUNCTIONS,
};
