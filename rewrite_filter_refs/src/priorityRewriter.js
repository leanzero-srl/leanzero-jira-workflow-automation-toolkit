// Pure rewriter for the system `priority` field VALUES in JQL.
//
// Cloud preserves priority IDs across JCMA migration but the visible NAME
// is mutable — both because JCMA may transform names and because operators
// rename priorities by hand in the Cloud UI. JQL stored at DC-name time
// then references stale names; Cloud rejects PUTs with
//   "The value 'X' does not exist for the field 'priority'."
//
// The fix: given a DC-name → Cloud-name map (built upstream from the two
// /priority endpoints, paired by id; see priorityMapBuilder.js), rewrite
// every value token that follows a `priority` clause in JQL.
//
// Forms handled (case-insensitive on the `priority` field token; the field
// can be bare or quoted as `"priority"` / `'priority'`):
//   priority = X            priority != X
//   priority IN  (X, Y)     priority NOT IN (X, Y)
//
// Explicitly NOT handled (left untouched):
//   priority IS [NOT] EMPTY   ← no value to rewrite
//   ORDER BY priority         ← no value
//   priority WAS / CHANGED    ← out of scope v1 (history operators)
//   priority = 1              ← numeric ID form; IDs survive JCMA, no rewrite needed
//
// Implementation note: we tokenize quoted strings into placeholders before
// matching. This is what protects us against two classes of false positive:
//   (a) the substring `priority` appearing inside a custom-field name
//       like `"Delivery Priority"` — would be matched by a naïve regex
//       on the raw JQL because of the word boundaries, but after tokenize
//       the whole `"Delivery Priority"` collapses to a single placeholder
//       whose body !== "priority", so the field check fails.
//   (b) the substring `priority = X` appearing INSIDE a string literal
//       (e.g. `description ~ "priority = High"`) — the literal collapses to
//       a placeholder so the regex sees nothing to match.

// Sentinel chars for placeholder tokens. We deliberately use US (U+001F)
// and RS (U+001E) — different from jqlSanitizer's SOH/STX — so this
// rewriter's placeholder stream cannot collide with the sanitizer's if both
// ran without intermediate detokenization. (They don't; the sanitizer runs
// AFTER us and re-tokenizes from scratch. But the redundancy is cheap.)
const PH_OPEN = "\x1F";
const PH_CLOSE = "\x1E";
const PH_RE_GLOBAL = new RegExp(`${PH_OPEN}Q(\\d+)${PH_CLOSE}`, "g");
const PH_RE_ONCE = new RegExp(`^${PH_OPEN}Q(\\d+)${PH_CLOSE}$`);
const PH_RE_AT_START = new RegExp(`^${PH_OPEN}Q\\d+${PH_CLOSE}`);

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
        if (cc === quote) {
          i++;
          break;
        }
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
  return s.replace(PH_RE_GLOBAL, (m, n) => {
    const p = placeholders[Number(n)];
    if (!p) return m;
    return `${p.quote}${p.body}${p.quote}`;
  });
}

function normalizeName(s) {
  return String(s || "").normalize("NFC").trim().toLowerCase();
}

// Unescape a placeholder body (`\"` → `"`, `\'` → `'`, `\\` → `\`).
function unescapeBody(body) {
  return String(body).replace(/\\(["'\\])/g, "$1");
}

// Escape a value to be safely stored as a placeholder body for the given
// quote char. We escape backslashes first to avoid double-escaping, then
// the active quote char.
function escapeBody(s, quote) {
  let out = String(s).replace(/\\/g, "\\\\");
  if (quote === '"') {
    out = out.replace(/"/g, '\\"');
  } else {
    out = out.replace(/'/g, "\\'");
  }
  return out;
}

// A value is safer when quoted if it contains whitespace, list/group
// delimiters, or starts with a digit (where Cloud might mis-parse it as
// a numeric ID).
function needsQuoting(s) {
  return /\s|[,()]/.test(s) || /^\d/.test(s);
}

// Find the index of the `)` that closes the `(` at openIdx. Tracks paren
// depth so nested groups (function calls inside an IN list) are handled.
// Quotes are already tokenized to placeholders so they're inert here.
function findMatchingClose(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Split a comma-separated list, respecting paren depth so function-call
// arguments don't trigger a split. Inputs are post-tokenization, so
// quoted strings are already placeholders — no quote awareness needed.
function splitTopLevelCommas(s) {
  const out = [];
  let buf = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  out.push(buf);
  return out;
}

// Given a captured "field token" (either the bare word `priority` or any
// placeholder), determine whether it actually denotes the system priority
// field. Bare matches always qualify (the regex already enforced the word
// `priority`). Placeholder matches qualify only when the placeholder body
// normalizes to exactly `priority` — this is what distinguishes the legit
// quoted form `"priority"` from custom-field names like `"Engineering
// Priority"` or unrelated string literals like `"foo bar"`.
function isPriorityFieldToken(fieldTok, placeholders) {
  if (!fieldTok) return false;
  const phMatch = PH_RE_ONCE.exec(fieldTok);
  if (!phMatch) {
    return normalizeName(fieldTok) === "priority";
  }
  const p = placeholders[Number(phMatch[1])];
  if (!p) return false;
  return normalizeName(unescapeBody(p.body)) === "priority";
}

// Rewrite a single value token. Token shapes:
//   - Placeholder: `\x1FQ<n>\x1E` (originally a quoted value)
//   - Bare numeric: `1`, `23` (priority ID form — skipped)
//   - Bare word: `High`, `Medium` (DC name)
//
// Leading/trailing whitespace on the raw token is preserved exactly. For
// placeholder values we mutate the placeholder body in place (cheaper and
// keeps the quote style the user wrote). For bare values that need
// quoting on output, we synthesize a new placeholder rather than emitting
// raw `"..."` text — the new placeholder participates in the same
// detokenize round-trip and can't be confused with the surrounding JQL.
function rewriteValueToken(rawToken, placeholders, map, form, replacements) {
  const leading = rawToken.match(/^\s*/)[0];
  const trailing = rawToken.match(/\s*$/)[0];
  const core = rawToken.trim();
  if (!core) return rawToken;

  const phMatch = PH_RE_ONCE.exec(core);
  if (phMatch) {
    const p = placeholders[Number(phMatch[1])];
    if (!p) return rawToken;
    const dcName = unescapeBody(p.body);
    const key = normalizeName(dcName);
    if (!key) return rawToken;
    const cloudName = map.get(key);
    if (cloudName == null) return rawToken;
    // Defensive — the map builder filters identities, but a hand-built map
    // could include them. Don't record a no-op rewrite.
    if (normalizeName(cloudName) === key) return rawToken;
    p.body = escapeBody(cloudName, p.quote);
    replacements.push({ form, from: dcName, to: cloudName });
    return rawToken;
  }

  // Bare token: numeric IDs are out of scope (JCMA preserves them).
  if (/^-?\d+$/.test(core)) return rawToken;

  const key = normalizeName(core);
  if (!key) return rawToken;
  const cloudName = map.get(key);
  if (cloudName == null) return rawToken;
  if (normalizeName(cloudName) === key) return rawToken;

  replacements.push({ form, from: core, to: cloudName });
  if (needsQuoting(cloudName)) {
    const idx = placeholders.length;
    placeholders.push({ quote: '"', body: escapeBody(cloudName, '"') });
    return `${leading}${PH_OPEN}Q${idx}${PH_CLOSE}${trailing}`;
  }
  return `${leading}${cloudName}${trailing}`;
}

/**
 * @param {string} jql
 * @param {object} opts
 * @param {Map<string,string>} opts.dcNameToCloudName — keyed by normalized
 *        (NFC + lowercased + trimmed) DC name; values are Cloud display names.
 * @returns {{ rewritten: string, replacements: Array<{form:string, from:string, to:string}>, unresolved: string[] }}
 */
function rewritePriorityValues(jql, opts = {}) {
  if (!jql || typeof jql !== "string") {
    return { rewritten: jql, replacements: [], unresolved: [] };
  }
  const map = opts.dcNameToCloudName;
  if (!map || typeof map.get !== "function" || map.size === 0) {
    return { rewritten: jql, replacements: [], unresolved: [] };
  }

  const replacements = [];
  const { tokenized, placeholders } = tokenizeQuoted(jql);

  // Field token: either the bare word `priority` (with word boundaries) OR
  // any placeholder (we check the body in isPriorityFieldToken). The `i`
  // flag makes `priority` case-insensitive; lookbehind/lookahead guard
  // against partial matches inside identifiers like `mypriority`.
  const FIELD_RE = new RegExp(
    `(?:(?<![A-Za-z0-9_])priority(?![A-Za-z0-9_])|${PH_OPEN}Q\\d+${PH_CLOSE})`,
    "gi",
  );

  let out = "";
  let cursor = 0;
  let m;
  FIELD_RE.lastIndex = 0;
  while ((m = FIELD_RE.exec(tokenized)) !== null) {
    const fieldStart = m.index;
    const fieldEnd = m.index + m[0].length;
    const fieldTok = m[0];

    if (!isPriorityFieldToken(fieldTok, placeholders)) continue;

    // Read forward: optional whitespace, then operator, then value or list.
    let pos = fieldEnd;
    while (pos < tokenized.length && /\s/.test(tokenized[pos])) pos++;
    const wsAfterField = tokenized.slice(fieldEnd, pos);

    // IN / NOT IN — requires at least one whitespace before the operator
    // (matches the JQL grammar) so we don't false-match `priorityIN(...)`.
    if (wsAfterField.length > 0) {
      const inMatch = /^(NOT\s+IN|IN)\b/i.exec(tokenized.slice(pos));
      if (inMatch) {
        const opEnd = pos + inMatch[0].length;
        let q = opEnd;
        while (q < tokenized.length && /\s/.test(tokenized[q])) q++;
        if (tokenized[q] === "(") {
          const closeIdx = findMatchingClose(tokenized, q);
          if (closeIdx > q) {
            const inner = tokenized.slice(q + 1, closeIdx);
            const op = /not/i.test(inMatch[0]) ? "NOT IN" : "IN";
            const tokens = splitTopLevelCommas(inner);
            const newTokens = tokens.map((t) =>
              rewriteValueToken(t, placeholders, map, op, replacements),
            );
            out += tokenized.slice(cursor, fieldStart);
            out += fieldTok;
            out += wsAfterField;
            out += inMatch[0];
            out += tokenized.slice(opEnd, q); // ws between IN and (
            out += "(";
            out += newTokens.join(",");
            out += ")";
            cursor = closeIdx + 1;
            FIELD_RE.lastIndex = cursor;
            continue;
          }
        }
      }
    }

    // = / != .
    const eqMatch = /^(!=|=)/.exec(tokenized.slice(pos));
    if (eqMatch) {
      const opEnd = pos + eqMatch[0].length;
      let q = opEnd;
      while (q < tokenized.length && /\s/.test(tokenized[q])) q++;
      const wsAfterOp = tokenized.slice(opEnd, q);

      // Value: a placeholder or a bare token (not whitespace/comma/paren).
      let valEnd = q;
      const phHere = PH_RE_AT_START.exec(tokenized.slice(q));
      if (phHere) {
        valEnd = q + phHere[0].length;
      } else {
        while (
          valEnd < tokenized.length &&
          !/[\s,)]/.test(tokenized[valEnd])
        ) {
          valEnd++;
        }
      }

      if (valEnd > q) {
        const value = tokenized.slice(q, valEnd);
        const newValue = rewriteValueToken(
          value,
          placeholders,
          map,
          eqMatch[0],
          replacements,
        );
        out += tokenized.slice(cursor, fieldStart);
        out += fieldTok;
        out += wsAfterField;
        out += eqMatch[0];
        out += wsAfterOp;
        out += newValue;
        cursor = valEnd;
        FIELD_RE.lastIndex = cursor;
        continue;
      }
    }

    // Neither IN nor = matched — likely IS [NOT] EMPTY, WAS, CHANGED, or
    // an unfamiliar clause shape. Leave untouched; don't update cursor so
    // the field token + everything after stays in the output as-is.
  }

  out += tokenized.slice(cursor);
  return {
    rewritten: detokenize(out, placeholders),
    replacements,
    unresolved: [],
  };
}

module.exports = {
  rewritePriorityValues,
  // Exported for tests / debugging.
  tokenizeQuoted,
  detokenize,
  splitTopLevelCommas,
  normalizeName,
  needsQuoting,
};
