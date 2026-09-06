/**
 * fieldRemapAmbiguityDetector.js
 *
 * Detects emitted rules that reference DC custom fields with no Cloud
 * remap entry. When the remap is empty/null, the translator falls
 * through to the bare DC ID — which doesn't exist on Cloud. At runtime
 * the field accessor returns undefined and the rule silently no-ops.
 *
 * Used by `wrap()` in jsuJmweMappers.js alongside the Groovy-residue and
 * ScriptRunner-API detectors. Surfaces `FieldRemapAmbiguity` markers on
 * the rule's problems[] array. The applier's CSV writer picks them up
 * and gives the operator a targeted reason.
 *
 * Two failure modes detected:
 *   - `unremapped-dc-field`: rule config contains `customfield_NNN` (DC ID)
 *     AND the `ctx.fieldRemapping` value for that ID is null/missing.
 *   - `missing-cloud-display-name`: rule config contains a
 *     `customfield_NNN` (presumably a Cloud ID after remap) but
 *     `ctx.cloudFieldNames[...]` has no display-name entry. This usually
 *     means the Cloud catalog wasn't loaded.
 *
 * Both are advisory; the rule still emits (downstream Groovy-residue
 * detector decides disable/enable).
 */

const CUSTOMFIELD_REF_RE = /\bcustomfield_(\d+)\b/g;

function scanStringForFieldIds(s) {
  if (typeof s !== "string" || !s) return [];
  const found = new Set();
  let m;
  CUSTOMFIELD_REF_RE.lastIndex = 0;
  while ((m = CUSTOMFIELD_REF_RE.exec(s)) !== null) found.add(`customfield_${m[1]}`);
  return [...found];
}

function detectFieldRemapAmbiguity(config, ctx) {
  if (!config || typeof config !== "object") return [];
  const fieldRemapping = (ctx && ctx.fieldRemapping) || {};
  const cloudFieldNames = (ctx && ctx.cloudFieldNames) || {};
  const dcFieldNames = (ctx && ctx.dcFieldNames) || {};
  const hasCloudCatalog = Object.keys(cloudFieldNames).length > 0;
  const hasRemap = Object.keys(fieldRemapping).length > 0;
  const findings = [];
  const seen = new Set(); // dedupe per-rule
  const walk = (node, prefix) => {
    if (node == null) return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${prefix}[${i}]`)); return; }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "problems") continue;
        walk(v, prefix ? `${prefix}.${k}` : k);
      }
      return;
    }
    if (typeof node !== "string") return;
    for (const fid of scanStringForFieldIds(node)) {
      if (seen.has(fid)) continue;
      seen.add(fid);
      // `unremapped-dc-field`: the rule references a customfield ID that
      // EXISTS as a key in fieldRemapping (i.e. it's known to be a DC id we
      // tried to remap) but the resolved value is null/empty (no Cloud
      // equivalent found). We require the id to be a KEY because Cloud IDs
      // emitted post-translation aren't in the remap and shouldn't be flagged.
      const isRemapKey = Object.prototype.hasOwnProperty.call(fieldRemapping, fid);
      if (isRemapKey) {
        const remapValue = fieldRemapping[fid];
        if (remapValue == null || remapValue === "") {
          findings.push({
            field: prefix,
            pattern: "unremapped-dc-field",
            dcId: fid,
            dcName: dcFieldNames[fid] || "",
            snippet: `${fid} has null/missing entry in fieldRemapping`,
          });
        }
        continue;
      }
      // `missing-cloud-display-name`: id is NOT a remap key (so it's
      // presumably a Cloud id that came through the translator's remap or
      // was written directly). If the Cloud catalog is loaded and the id
      // isn't in it, flag — that's a Cloud-side reference to a non-existent
      // field.
      if (hasCloudCatalog && !cloudFieldNames[fid]) {
        findings.push({
          field: prefix,
          pattern: "missing-cloud-display-name",
          dcId: fid,
          dcName: dcFieldNames[fid] || "",
          snippet: `${fid} not found in cloudFieldNames catalog`,
        });
      }
    }
  };
  walk(config, "");
  return findings;
}

module.exports = {
  detectFieldRemapAmbiguity,
};
