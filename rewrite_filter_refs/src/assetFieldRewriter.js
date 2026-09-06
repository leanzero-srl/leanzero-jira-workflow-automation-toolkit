// Rewrites direct references to Assets (CMDB) custom fields in JQL —
// the kind that appear OUTSIDE `aqlFunction(...)` wrappers.
//
// JCMA migrates the literal value verbatim, but on Cloud the DC numeric
// objectId, DC object key, and any ari:cloud:… handle are all stale because
// Cloud Assets regenerates IDs and keys on import. The Atlassian-documented
// Cloud syntax for direct asset-field references is the OBJECT NAME, e.g.
//   "Development Team" = "Platform Squad"
//   "Affected Device" IN ("Device A", "Device B")
//
// This module rewrites the following shapes — but only when the LHS field
// name matches the `assetFieldNames` set (so non-asset fields aren't touched):
//
//   "Field" = <value>          / "Field" != <value>
//   "Field" IN (a, "b", …)     / "Field" NOT IN (…)
//   Field   = <value>          (bare unquoted field name)
//
// Value resolution order:
//   1. ari:cloud:…/<numericObjectId>  → cloudObjectIdToCloudName
//   2. ASSET_KEY-form e.g. "CMDB-21171" → dcKeyToCloudName (or cloudKeyToCloudName)
//   3. pure numeric                    → dcObjectIdToCloudName
//   4. anything else (looks like a name already) → pass through unchanged
//
// Anything inside `aqlFunction("…")` is preserved verbatim (the existing
// aqlRewriter handles that pass).

const { splitTopLevelCommas } = require("./aqlRewriter");

// ari:cloud:[service]:[cloudId]:[resourceType]/[workspaceId]/[objectId]
// Example: ari:cloud:cmdb:00000010-0000-4000-8000-000000000010:object/27118
// We only care about the trailing numeric id (or alphanumeric object key).
const ARI_RE =
  /^ari:cloud:[^/]+\/(?:[^/]+\/)*([A-Z][A-Z0-9_]*-\d+|\d+)$/i;

const ASSET_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/i;
const NUMERIC_RE = /^\d+$/;
// "Display Name (CMDB-12345)" — the DC asset picker rendered values this way
// and JCMA copies the literal string into Cloud filter JQL. Cloud's asset
// names don't carry the trailing "(KEY)" so the as-is value matches nothing.
// We extract the key from the parens and resolve via dcKeyToCloudName.
const KEYED_NAME_RE =
  /^.+?\s*\(([A-Z][A-Z0-9_]*-\d+|\d+)\)\s*$/i;

function normalizeName(s) {
  return String(s || "").normalize("NFC").trim().toLowerCase();
}

function unescapeJqlString(s) {
  return String(s).replace(/\\(.)/g, "$1");
}

function escapeJqlString(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Mask aqlFunction("…") and aqlfunction("…") bodies so the field-ref rewriter
// regexes don't accidentally rewrite something inside an AQL body. Returns
// {masked, restore} where `restore` is a function that re-inserts the
// originals into a string that still contains the placeholders.
function maskAqlFunctionBlocks(jql) {
  const stash = [];
  const re = /\baqlFunction\s*\(\s*"(?:[^"\\]|\\.)*"\s*\)/gi;
  const masked = jql.replace(re, (m) => {
    const idx = stash.length;
    stash.push(m);
    return `\x01AQL${idx}\x02`;
  });
  return {
    masked,
    restore: (s) =>
      s.replace(/\x01AQL(\d+)\x02/g, (_m, n) => stash[Number(n)] || ""),
  };
}

// Parse a single RHS value token into {kind, raw, lookupKey}.
// The lookupKey is used to query the resolution maps; kind picks the map.
function classifyValueToken(rawToken) {
  let core = rawToken.trim();
  let originallyQuoted = false;
  let quote = '"';

  if (
    (core.startsWith('"') && core.endsWith('"')) ||
    (core.startsWith("'") && core.endsWith("'"))
  ) {
    quote = core[0];
    core = core.slice(1, -1);
    core = unescapeJqlString(core);
    originallyQuoted = true;
  }

  if (!core) return { kind: "empty", raw: rawToken, originallyQuoted, quote };

  const ariMatch = core.match(ARI_RE);
  if (ariMatch) {
    return {
      kind: "ari",
      raw: rawToken,
      originallyQuoted,
      quote,
      core,
      lookupKey: ariMatch[1],
      // sub-kind tells us which map to try first
      ariTail: ariMatch[1],
    };
  }

  if (ASSET_KEY_RE.test(core)) {
    return {
      kind: "key",
      raw: rawToken,
      originallyQuoted,
      quote,
      core,
      lookupKey: core,
    };
  }

  if (NUMERIC_RE.test(core)) {
    return {
      kind: "numeric",
      raw: rawToken,
      originallyQuoted,
      quote,
      core,
      lookupKey: core,
    };
  }

  // DC display-form "Some Name (CMDB-12345)" — extract the bracketed key and
  // resolve as if it were a bare key. Falls through to "name" pass-through if
  // the key has no mapping (we don't want to strip the parens guess-wise).
  const keyedMatch = core.match(KEYED_NAME_RE);
  if (keyedMatch) {
    const inner = keyedMatch[1];
    return {
      kind: NUMERIC_RE.test(inner) ? "keyed-numeric" : "keyed-key",
      raw: rawToken,
      originallyQuoted,
      quote,
      core,
      lookupKey: inner,
    };
  }

  return { kind: "name", raw: rawToken, originallyQuoted, quote, core };
}

// Resolve a classified token to {name, objectIds}. `objectIds` is the list of
// Cloud objectIds the token could refer to (1 for unambiguous tokens, ≥2 for
// bare-name tokens whose name has multiple matching Cloud objects). `name` is
// null when no resolution is possible. The collision-aware pass uses
// objectIds to (a) detect when a name is ambiguous within a single filter
// and (b) build ARI literals for the specific objects involved.
function resolveTokenToObject(classified, maps) {
  const {
    dcKeyToCloudName,
    dcObjectIdToCloudName,
    cloudObjectIdToCloudName,
    cloudKeyToCloudName,
    dcKeyToCloudObjectId,
    dcObjectIdToCloudObjectId,
    cloudKeyToCloudObjectId,
    cloudNameToCloudObjectIds,
  } = maps;

  if (classified.kind === "ari") {
    const tail = classified.ariTail;
    if (NUMERIC_RE.test(tail)) {
      // ARI tail is a numeric objectId — it IS the cloud objectId, no lookup
      // needed for that. Name resolution still uses the cloud-side map.
      const objectId = String(tail);
      const name =
        (cloudObjectIdToCloudName && cloudObjectIdToCloudName.get(objectId)) ||
        null;
      return { name, objectIds: [objectId], dcKey: String(tail) };
    }
    // ARI tail is an asset key (CI-NNN form)
    const name =
      (cloudKeyToCloudName && cloudKeyToCloudName.get(String(tail))) || null;
    const objectId =
      (cloudKeyToCloudObjectId && cloudKeyToCloudObjectId.get(String(tail))) ||
      null;
    return { name, objectIds: objectId ? [objectId] : [], dcKey: String(tail) };
  }

  if (classified.kind === "key" || classified.kind === "keyed-key") {
    const k = classified.lookupKey;
    const name =
      (dcKeyToCloudName && dcKeyToCloudName.get(k)) ||
      (cloudKeyToCloudName && cloudKeyToCloudName.get(k)) ||
      null;
    // Prefer the type-aware multi-candidate map when present (set by the
    // typed-enrichment pass for DC keys whose name+type matches multiple
    // Cloud objects). Otherwise use the single-id maps.
    const dcKeyToCloudObjectIdsMulti = maps.dcKeyToCloudObjectIdsMulti;
    const multi = dcKeyToCloudObjectIdsMulti && dcKeyToCloudObjectIdsMulti.get(k);
    if (multi && multi.length > 0) {
      return { name, objectIds: multi.map(String), dcKey: k };
    }
    const objectId =
      (dcKeyToCloudObjectId && dcKeyToCloudObjectId.get(k)) ||
      (cloudKeyToCloudObjectId && cloudKeyToCloudObjectId.get(k)) ||
      null;
    return { name, objectIds: objectId ? [objectId] : [], dcKey: k };
  }

  if (classified.kind === "numeric" || classified.kind === "keyed-numeric") {
    const k = classified.lookupKey;
    const name =
      (dcObjectIdToCloudName && dcObjectIdToCloudName.get(k)) ||
      (cloudObjectIdToCloudName && cloudObjectIdToCloudName.get(k)) ||
      null;
    // Prefer the explicit DC→Cloud objectId map; if absent, but the numeric
    // value already exists in cloudObjectIdToCloudName, then it IS the cloud
    // objectId itself (e.g. when DC and Cloud share an objectId in some
    // CMDB-imported edge cases).
    let objectId = null;
    if (dcObjectIdToCloudObjectId && dcObjectIdToCloudObjectId.has(k)) {
      objectId = dcObjectIdToCloudObjectId.get(k);
    } else if (cloudObjectIdToCloudName && cloudObjectIdToCloudName.has(k)) {
      objectId = k;
    }
    return { name, objectIds: objectId ? [objectId] : [], dcKey: k };
  }

  if (classified.kind === "name") {
    // FIX-MODE invariant: bare-name tokens are NEVER auto-expanded to all
    // matching cloud objectIds. We don't know which specific object the
    // filter author meant when they wrote just the name; auto-broadening
    // changes semantics. The collision-aware pass only emits ARIs for
    // tokens with explicit DC identification (keyed/numeric/ari forms).
    // A name token whose name happens to be globally ambiguous stays as
    // the plain name — same as the input.
    return { name: null, objectIds: [] };
  }

  return { name: null, objectIds: [] };
}

// Build an ARI literal in the exact shape Cloud's JQL parser accepts for
// asset references: `ari:cloud:cmdb::object/<workspaceId>/<objectId>`.
// Empty cloudId segment between `cmdb` and `object` is intentional — that's
// the canonical form (the ARI_RE above accepts it too).
function buildAri(workspaceId, objectId) {
  return `ari:cloud:cmdb::object/${workspaceId}/${objectId}`;
}

// Build a regex that matches any of the supplied asset field names, both
// quoted and bare-identifier form. Field names with internal whitespace are
// only matched in the quoted form (bare names with spaces aren't valid JQL).
function buildFieldNameRegex(assetFieldNames) {
  const names = Array.from(assetFieldNames).filter(Boolean);
  if (names.length === 0) return null;

  const quotedAlternatives = names
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .map((n) => n.replace(/\s+/g, "\\s+"));
  // Sort longest-first so multi-word names match before single-word prefixes
  quotedAlternatives.sort((a, b) => b.length - a.length);

  // Quoted: "Field Name" or 'Field Name'. Bare: identifier characters only
  // (no spaces). We match both because both forms appear in real DC filters.
  const altGroup = quotedAlternatives.join("|");
  const bareCandidates = names
    .filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  bareCandidates.sort((a, b) => b.length - a.length);
  const bareGroup = bareCandidates.length ? bareCandidates.join("|") : null;

  // Two regexes — caller iterates both. Single regex with alternation could
  // misorder matches because lookahead boundaries differ.
  return {
    quoted: new RegExp(`(["'])(${altGroup})\\1`, "gi"),
    bare: bareGroup
      ? new RegExp(`(?<![A-Za-z0-9_"'])(${bareGroup})(?![A-Za-z0-9_])`, "gi")
      : null,
  };
}

/**
 * @param {string} jql
 * @param {object} options
 * @param {Set<string>|Array<string>} options.assetFieldNames - normalized (lowercased)
 * @param {Map<string,string>} [options.dcKeyToCloudName]
 * @param {Map<string,string>} [options.dcObjectIdToCloudName]
 * @param {Map<string,string>} [options.cloudObjectIdToCloudName]
 * @param {Map<string,string>} [options.cloudKeyToCloudName]
 * @param {Map<string,string>} [options.dcKeyToCloudObjectId]
 * @param {Map<string,string>} [options.dcObjectIdToCloudObjectId]
 * @param {Map<string,string>} [options.cloudKeyToCloudObjectId]
 * @param {Map<string,string[]>} [options.cloudNameToCloudObjectIds] - name (lowercased) → all matching cloud objectIds. When ≥2, the name is globally ambiguous and tokens emitting it must use ARI form.
 * @param {string} [options.workspaceId] - Cloud Assets workspace UUID. Required for ARI emission.
 * @returns {{ rewritten: string, replacements: Array, unresolved: Array, ariCollisions: Array }}
 */
function rewriteAssetFieldRefs(jql, options = {}) {
  if (!jql || typeof jql !== "string") {
    return { rewritten: jql, replacements: [], unresolved: [], ariCollisions: [] };
  }
  const nameSet =
    options.assetFieldNames instanceof Set
      ? options.assetFieldNames
      : new Set((options.assetFieldNames || []).map(normalizeName));
  if (nameSet.size === 0) {
    return { rewritten: jql, replacements: [], unresolved: [], ariCollisions: [] };
  }

  const maps = {
    dcKeyToCloudName: options.dcKeyToCloudName || null,
    dcObjectIdToCloudName: options.dcObjectIdToCloudName || null,
    cloudObjectIdToCloudName: options.cloudObjectIdToCloudName || null,
    cloudKeyToCloudName: options.cloudKeyToCloudName || null,
    dcKeyToCloudObjectId: options.dcKeyToCloudObjectId || null,
    dcKeyToCloudObjectIdsMulti: options.dcKeyToCloudObjectIdsMulti || null,
    dcObjectIdToCloudObjectId: options.dcObjectIdToCloudObjectId || null,
    cloudKeyToCloudObjectId: options.cloudKeyToCloudObjectId || null,
    cloudNameToCloudObjectIds: options.cloudNameToCloudObjectIds || null,
  };
  const workspaceId = options.workspaceId || null;
  // Collision-aware emission requires a workspaceId (we need it to build
  // ARIs). The strict per-name rule does NOT consult cloudNameToCloudObjectIds
  // — that map only matters when callers want global-ambiguity detection
  // (which we explicitly disabled per the "fix not modify" + "only same-name
  // duplicates in this filter" rule).
  const collisionAware = !!workspaceId;

  const replacements = [];
  const unresolvedSet = new Set();

  // 1. Mask any aqlFunction("...") bodies so they're invisible to the
  //    field-ref regex below.
  const { masked, restore } = maskAqlFunctionBlocks(jql);

  // 2. For each occurrence of an asset field name on the LHS of a JQL
  //    comparison, find the operator and the value and rewrite it.
  const fieldRe = buildFieldNameRegex(nameSet);
  if (!fieldRe) {
    return { rewritten: jql, replacements: [], unresolved: [] };
  }

  // Walk the masked string left-to-right. We need both regexes (quoted and
  // bare) considered together so positions interleave correctly. Approach:
  // collect all matches, sort by start index, then process them sequentially
  // tracking how much each splice shifts subsequent indices.
  const matches = [];
  for (const m of masked.matchAll(fieldRe.quoted)) {
    const fieldName = m[2];
    if (!nameSet.has(normalizeName(fieldName))) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      fieldName,
      original: m[0],
    });
  }
  if (fieldRe.bare) {
    for (const m of masked.matchAll(fieldRe.bare)) {
      const fieldName = m[1];
      if (!nameSet.has(normalizeName(fieldName))) continue;
      // De-dupe against a quoted match at the same position
      if (matches.some((mm) => mm.start === m.index)) continue;
      matches.push({
        start: m.index,
        end: m.index + m[0].length,
        fieldName,
        original: m[0],
      });
    }
  }
  matches.sort((a, b) => a.start - b.start);

  // Phase A: parse each match into a structured plan (no mutation). Each plan
  // captures the splice range covering the WHOLE clause (field + op + value),
  // the operator, and the resolved tokens. Operator switching (= → IN when
  // a single name expands to multiple ARIs) requires us to rewrite the field
  // and operator together, so the splice range starts at match.start, not
  // after the operator.
  const plans = [];
  for (const match of matches) {
    const plan = parseClause(masked, match, maps);
    if (plan) plans.push(plan);
  }

  // Phase B: per-filter, per-NAME KEY-based ambiguity ONLY.
  //
  // A cloud name is "ambiguous in this filter" when ≥2 tokens in the DC JQL
  // reference DIFFERENT keys but resolve to the same cloud name. ONLY those
  // duplicate-name tokens get ARI emission. Every other token (including
  // other keyed tokens in the same filter whose name happens to be unique)
  // resolves to plain name — NO escalation, NO broadening.
  const nameToDcKeys = new Map();    // lower(name) → Set<dcKey>
  for (const plan of plans) {
    for (const tok of plan.tokens) {
      if (!tok.resolved || !tok.resolved.name || !tok.resolved.dcKey) continue;
      const lc = normalizeName(tok.resolved.name);
      if (!nameToDcKeys.has(lc)) nameToDcKeys.set(lc, new Set());
      nameToDcKeys.get(lc).add(tok.resolved.dcKey);
    }
  }
  const ariCollisions = [];
  const ambigNames = new Set();
  for (const [lc, keys] of nameToDcKeys.entries()) {
    if (keys.size >= 2) ambigNames.add(lc);
  }

  // Phase C: walk plans in reverse and splice in the new text. Reverse order
  // so each splice doesn't invalidate earlier positions.
  let work = masked;
  for (let i = plans.length - 1; i >= 0; i--) {
    const plan = plans[i];
    const emit = emitClause(plan, {
      ambigNames,
      collisionAware,
      workspaceId,
      replacements,
      unresolvedSet,
      ariCollisions,
    });
    if (emit == null) continue; // no change for this clause
    work = work.slice(0, plan.spliceStart) + emit + work.slice(plan.spliceEnd);
  }

  // 3. Restore aqlFunction blocks.
  const rewritten = restore(work);

  return {
    rewritten,
    replacements,
    unresolved: Array.from(unresolvedSet),
    ariCollisions,
  };
}

// Walk a single field-match into a structured plan. Returns null if the
// clause isn't a shape we rewrite (e.g. IS / IS NOT, unbalanced parens).
function parseClause(masked, match, maps) {
  const after = masked.slice(match.end);
  const opMatch = after.match(
    /^\s*(=|!=|~|!~|\bIS\s+NOT\b|\bIS\b|\bNOT\s+IN\b|\bIN\b)\s*/i,
  );
  if (!opMatch) return null;
  const opEnd = match.end + opMatch[0].length;
  const op = opMatch[1].toUpperCase().replace(/\s+/g, " ");
  if (op.startsWith("IS")) return null;
  if (op === "~" || op === "!~") return null; // text-search; never CMDB ARI

  if (op === "IN" || op === "NOT IN") {
    if (masked[opEnd] !== "(") return null;
    let depth = 1;
    let j = opEnd + 1;
    let inQuote = false;
    let quoteChar = "";
    while (j < masked.length && depth > 0) {
      const ch = masked[j];
      if (inQuote) {
        if (ch === "\\" && j + 1 < masked.length) {
          j += 2;
          continue;
        }
        if (ch === quoteChar) inQuote = false;
        j++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (depth === 0) break;
      j++;
    }
    if (depth !== 0) return null;
    const listInner = masked.slice(opEnd + 1, j);
    const rawTokens = splitTopLevelCommas(listInner);
    const tokens = rawTokens.map((raw) => {
      const cls = classifyValueToken(raw);
      let resolved = null;
      if (cls.kind !== "empty") {
        resolved = resolveTokenToObject(cls, maps);
      }
      return {
        raw,
        leading: raw.match(/^\s*/)[0],
        trailing: raw.match(/\s*$/)[0],
        cls,
        resolved,
      };
    });
    return {
      spliceStart: match.start,
      spliceEnd: j + 1, // include the closing paren
      fieldText: masked.slice(match.start, match.end),
      opPrefix: masked.slice(match.end, opEnd), // whitespace + op + whitespace + "("
      op,
      tokens,
      listForm: true,
    };
  }

  // op === "=" or "!="
  const valSlice = masked.slice(opEnd);
  let valMatch = valSlice.match(/^(["'])((?:[^"'\\]|\\.)*)\1/);
  let valLen;
  let valToken;
  if (valMatch) {
    valToken = valMatch[0];
    valLen = valMatch[0].length;
  } else {
    valMatch = valSlice.match(/^(ari:cloud:[^\s)]+|[A-Z][A-Z0-9_]*-\d+|\d+)/i);
    if (!valMatch) return null;
    valToken = valMatch[0];
    valLen = valMatch[0].length;
  }
  const cls = classifyValueToken(valToken);
  if (cls.kind === "empty") return null;
  const resolved = resolveTokenToObject(cls, maps);
  return {
    spliceStart: match.start,
    spliceEnd: opEnd + valLen,
    fieldText: masked.slice(match.start, match.end),
    opPrefix: masked.slice(match.end, opEnd), // whitespace + op + whitespace
    op,
    tokens: [
      {
        raw: valToken,
        leading: "",
        trailing: "",
        cls,
        resolved,
      },
    ],
    listForm: false,
  };
}

// Render the new text for a parsed clause. Returns null when the clause
// would be unchanged (so the caller can skip the splice). Side-effects:
// appends to `replacements`, `unresolvedSet`, and `ariCollisions`.
function emitClause(plan, ctx) {
  const { ambigNames, collisionAware, workspaceId, replacements, unresolvedSet, ariCollisions } = ctx;
  const fieldName = plan.fieldText.replace(/^['"]|['"]$/g, "");

  // For each token, compute its emit form. There are four kinds of output:
  //   - "passthrough"  → emit the raw token unchanged (unresolvable or pure name we don't touch)
  //   - "name"         → emit `"<cloudName>"`
  //   - "ari-single"   → emit `"<ari>"`
  //   - "ari-multi"    → emit `"<ari1>", "<ari2>", ...` (only valid inside list, OR triggers operator switch)
  const emits = plan.tokens.map((tok) => {
    const { cls, resolved } = tok;
    if (cls.kind === "empty") {
      return { kind: "passthrough", raw: tok.raw };
    }
    if (!resolved || !resolved.name) {
      // Unresolvable. For pure-name tokens we always pass-through (legacy
      // behavior). For specific-shape tokens (key/numeric/ari/keyed-*) we
      // record an unresolved entry and pass-through too.
      if (cls.kind !== "name") {
        unresolvedSet.add(`${fieldName}:${cls.core}`);
      }
      return { kind: "passthrough", raw: tok.raw };
    }
    const nameLc = normalizeName(resolved.name);
    // ARI fires ONLY when this token's specific name has same-name-different-
    // key duplicates within this filter. Other keyed tokens with unique
    // names in the same filter are NOT escalated — they resolve to plain
    // names. (No semantic broadening.)
    const isAmbig = collisionAware && ambigNames.has(nameLc);
    if (isAmbig) {
      // Emit ARI form. If we have multiple matching objectIds (bare-name
      // Case A), expand to all of them; otherwise emit the single specific
      // objectId we resolved to (Case B).
      const ids = resolved.objectIds;
      ariCollisions.push({
        field: fieldName,
        name: resolved.name,
        objectIds: ids.slice(),
        sourceForm: cls.kind,
        sourceValue: cls.core,
      });
      // Track each id as a "replacement" for audit symmetry with the
      // name-form path.
      for (const id of ids) {
        replacements.push({
          field: fieldName,
          dcValue: cls.core,
          cloudName: resolved.name,
          cloudObjectId: id,
          ari: buildAri(workspaceId, id),
          form: cls.kind,
          via: "ari",
        });
      }
      if (ids.length === 1) {
        return { kind: "ari-single", ari: buildAri(workspaceId, ids[0]) };
      }
      return {
        kind: "ari-multi",
        aris: ids.map((id) => buildAri(workspaceId, id)),
      };
    }
    // Non-ambiguous path: emit cloud name. For pure-name tokens with a
    // resolved unique cloud name, this is just `= "<name>"` — but in the
    // common case the name token is already the right shape so we
    // pass-through to avoid touching it.
    if (cls.kind === "name") {
      return { kind: "passthrough", raw: tok.raw };
    }
    replacements.push({
      field: fieldName,
      dcValue: cls.core,
      cloudName: resolved.name,
      form: cls.kind,
      via: "name",
    });
    return { kind: "name", name: resolved.name };
  });

  // Decide overall shape based on operator + emit kinds.
  if (plan.listForm) {
    // Inside an IN / NOT IN list: each token expands inline. ari-multi
    // contributes multiple comma-separated ARIs.
    const pieces = [];
    let anyChange = false;
    for (let i = 0; i < emits.length; i++) {
      const e = emits[i];
      const tok = plan.tokens[i];
      if (e.kind === "passthrough") {
        pieces.push(tok.raw);
        continue;
      }
      if (e.kind === "name") {
        anyChange = true;
        pieces.push(`${tok.leading}"${escapeJqlString(e.name)}"${tok.trailing}`);
        continue;
      }
      if (e.kind === "ari-single") {
        anyChange = true;
        pieces.push(`${tok.leading}"${e.ari}"${tok.trailing}`);
        continue;
      }
      // ari-multi: expand to N comma-separated quoted ARIs, preserving the
      // outer leading/trailing whitespace on the first/last sub-piece.
      anyChange = true;
      const ariQuoted = e.aris.map((a) => `"${a}"`);
      pieces.push(
        tok.leading + ariQuoted.join(", ") + tok.trailing,
      );
    }
    if (!anyChange) return null;
    return `${plan.fieldText}${plan.opPrefix}(${pieces.join(",")})`;
  }

  // Equality form (= or !=).
  const e = emits[0];
  if (e.kind === "passthrough") return null;
  if (e.kind === "name") {
    return `${plan.fieldText}${plan.opPrefix}"${escapeJqlString(e.name)}"`;
  }
  if (e.kind === "ari-single") {
    return `${plan.fieldText}${plan.opPrefix}"${e.ari}"`;
  }
  // ari-multi on a `=` / `!=` clause: switch operator to IN / NOT IN.
  const newOp = plan.op === "!=" ? "NOT IN" : "IN";
  const ariQuoted = e.aris.map((a) => `"${a}"`).join(", ");
  return `${plan.fieldText} ${newOp} (${ariQuoted})`;
}

module.exports = {
  rewriteAssetFieldRefs,
  classifyValueToken,
  buildFieldNameRegex,
  maskAqlFunctionBlocks,
  normalizeName,
  buildAri,
  resolveTokenToObject,
  // Legacy alias for callers that still expect the single-name resolver.
  resolveTokenToName: (cls, maps) => resolveTokenToObject(cls, maps).name,
};
