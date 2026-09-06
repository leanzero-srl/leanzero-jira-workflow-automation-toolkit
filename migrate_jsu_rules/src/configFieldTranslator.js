/**
 * Shared helpers for emit-time field-ID translation inside JMWE Connect rule
 * config objects. Used by `wrap()` in jsuJmweMappers.js so every emitted rule
 * carries Cloud-canonical field references — not the DC IDs the mapper got as
 * input.
 *
 * Two complementary passes:
 *   1. translateConfigFieldIds — string-replace `customfield_NNN` occurrences
 *      in every string value of the config tree with the Cloud equivalent
 *      from ctx.fieldRemapping. Safe for JSON values, Jira-Expression
 *      identifiers, and Groovy/Nunjucks template bodies.
 *   2. translateNunjucksFieldRefs — additionally rewrite `issue.fields.<id>`
 *      to `issue.fields["<Display Name>"]` form inside string values that
 *      look like Nunjucks templates (`{{ ... }}` blocks). JMWE Cloud's
 *      Nunjucks engine can't resolve custom fields by ID — bracket-notation
 *      with display name is the canonical shape.
 *
 * The previous architecture ran these as a POST-HOC repair pass
 * (`_sanitizeFieldIdReferences` in jsuApplier.js) after rules were already
 * emitted and dedup-compared. Moving them UP to mapper emit time means:
 *   - dedup snapshots see Cloud-canonical forms immediately,
 *   - mapper outputs are testable in isolation without the apply pipeline,
 *   - the post-hoc sanitizer becomes a defense-in-depth no-op rather than
 *     load-bearing.
 *
 * Non-destructive: returns a new object tree rather than mutating the input.
 * No-ops when ctx.fieldRemapping / ctx.cloudFieldNames is absent or empty.
 */

const FIELD_ID_RE = /customfield_\d+/g;
const NUNJUCKS_BLOCK_RE = /\{\{[\s\S]*?\}\}/;
// In Nunjucks: convert `issue.fields.customfield_NNN<chain>` to
// `issue.fields["<Display Name>"]<chain>`. Capture the chain so the rewrite
// preserves accessors like `.displayName` or `[0]` that follow the field ref.
const NUNJUCKS_FIELD_REF_RE = /issue\.fields\.(customfield_\d+)/g;

function translateConfigFieldIds(value, fieldRemap) {
  if (!fieldRemap || Object.keys(fieldRemap).length === 0) return value;
  return _walkTranslate(value, (s) => _replaceFieldIds(s, fieldRemap));
}

function translateNunjucksFieldRefs(value, cloudFieldNames, fieldRemap) {
  const names = cloudFieldNames || {};
  if (Object.keys(names).length === 0) return value;
  const fallbackRemap = fieldRemap || {};
  return _walkTranslate(value, (s) => _rewriteNunjucks(s, names, fallbackRemap));
}

function _walkTranslate(value, rewriteString) {
  if (Array.isArray(value)) return value.map((v) => _walkTranslate(v, rewriteString));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = _walkTranslate(v, rewriteString);
    }
    return out;
  }
  if (typeof value === "string") return rewriteString(value);
  return value;
}

function _replaceFieldIds(s, fieldRemap) {
  if (typeof s !== "string" || !s) return s;
  return s.replace(FIELD_ID_RE, (m) => {
    if (Object.prototype.hasOwnProperty.call(fieldRemap, m) && fieldRemap[m]) {
      return fieldRemap[m];
    }
    return m;
  });
}

function _rewriteNunjucks(s, cloudFieldNames, fallbackRemap) {
  if (typeof s !== "string" || !s) return s;
  // Only touch strings that LOOK Nunjucks-y — i.e. contain a `{{ ... }}` block.
  // Jira-Expression identifiers (`issue.customfield_NNN`) live in different
  // surfaces (expression-condition / expression-validator config.expression)
  // and use Cloud IDs directly via dot-access; they must NOT be rewritten
  // here. The presence of `{{` is the cheapest disambiguator.
  if (!NUNJUCKS_BLOCK_RE.test(s)) return s;
  let changed = false;
  let out = s.replace(NUNJUCKS_FIELD_REF_RE, (m, cfId) => {
    // Look up display name. Try Cloud ID directly first; if absent, try
    // mapping via fieldRemap (in case the ID is still DC-side).
    let resolvedId = cfId;
    let name = cloudFieldNames[resolvedId];
    if (!name && fallbackRemap[cfId]) {
      resolvedId = fallbackRemap[cfId];
      name = cloudFieldNames[resolvedId];
    }
    if (!name) return m; // leave broken; post-hoc sanitizer or operator review
    changed = true;
    const lit = /'/.test(name) ? JSON.stringify(name) : `'${name}'`;
    return `issue.fields[${lit}]`;
  });
  // If we rewrote anything, ensure each `{{ ... }}` we touched has a
  // `| default("")` safety net. Idempotent — adds only when missing.
  if (changed) {
    out = out.replace(/\{\{\s*([\s\S]+?)\s*\}\}/g, (full, body) => {
      if (/\|\s*default\s*\(/.test(body)) return full;
      return `{{ ${body} | default("") }}`;
    });
  }
  return out;
}

/**
 * Combined pass used by `wrap()` in jsuJmweMappers.js. Runs both translations
 * in the right order — ID rewrite first (so subsequent Nunjucks lookups have
 * the Cloud ID to resolve), then Nunjucks display-name rewrite.
 */
function translateConfigForEmit(cfg, ctx) {
  if (!ctx) return cfg;
  let out = cfg;
  out = translateConfigFieldIds(out, ctx.fieldRemapping || {});
  out = translateNunjucksFieldRefs(out, ctx.cloudFieldNames || {}, ctx.fieldRemapping || {});
  return out;
}

module.exports = {
  translateConfigFieldIds,
  translateNunjucksFieldRefs,
  translateConfigForEmit,
};
