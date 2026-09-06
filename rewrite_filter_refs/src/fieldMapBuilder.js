// Builds a DC→Cloud custom-field ID map by pairing /field outputs by name.
//
// Post-migration, JCMA assigns brand-new numeric IDs to every custom field
// on Cloud. JQL stored as cf[NNN] or customfield_NNN therefore references
// stale DC IDs and Cloud returns "Field 'customfield_NNN' does not exist".
// Field NAMES, however, survive migration intact (subject to per-tenant
// renames). Pairing by name gives us a complete remap table.
//
// Output shape:
//   {
//     dcIdToCloudId:        Map<string,string>   "12345" → "67890"
//     dcLongToCloudLong:    Map<string,string>   "customfield_12345" → "customfield_67890"
//     cloudNameToCloudId:   Map<string,string>   normalized cloud name → numeric id
//     cloudAssetFieldNames: Set<string>          normalized names of cmdb-object-cftype fields
//     dcAssetFieldNames:    Set<string>          normalized names of DC asset/insight fields
//     collisions: Array<{ name, dcId, cloudIds }>
//     stats: { dcCount, cloudCount, paired, collisions, assetFields }
//   }

const ASSET_CUSTOM_TYPE = "com.atlassian.jira.plugins.cmdb:cmdb-object-cftype";
// DC's Insight plugin used a different custom-field type identifier than
// Cloud's CMDB. Both names occur in the wild depending on the DC version.
const DC_INSIGHT_CUSTOM_TYPES = new Set([
  "com.riadalabs.jira.plugins.insight:rlabs-insight-object-cftype",
  "com.riadalabs.jira.plugins.insight:rlabs-insight-references-cftype",
]);
// Forge "Traffic Light Status" custom field type. Stored value is an object
// `{ shape, label }` so JQL value-comparisons must use the `.Label` property
// accessor (`"<Field>.Label" = "Important"`); the plain field name returns
// zero rows on Cloud.  This token appears verbatim at the end of the schema
// ARI: ari:cloud:ecosystem::extension/<ext>/<inst>/static/traffic-light-status-field-type
const TRAFFIC_LIGHT_TYPE_SUFFIX = "static/traffic-light-status-field-type";

function normalizeName(s) {
  return String(s || "").normalize("NFC").trim().toLowerCase();
}

// Strip the "customfield_" prefix and any cf[…] wrapping to get the raw
// numeric id. Tolerant: returns null if the input isn't recognisable.
function numericId(idLike) {
  if (idLike == null) return null;
  const s = String(idLike);
  const m =
    s.match(/^customfield_(\d+)$/i) ||
    s.match(/^cf\[(\d+)\]$/i) ||
    s.match(/^(\d+)$/);
  return m ? m[1] : null;
}

function schemaCustom(field) {
  return field && field.schema && field.schema.custom
    ? String(field.schema.custom)
    : null;
}

function isCloudAssetField(field) {
  return schemaCustom(field) === ASSET_CUSTOM_TYPE;
}

function isTrafficLightField(field) {
  const c = schemaCustom(field) || "";
  return c.endsWith(TRAFFIC_LIGHT_TYPE_SUFFIX);
}

function isDcAssetField(field) {
  const c = schemaCustom(field);
  return c != null && DC_INSIGHT_CUSTOM_TYPES.has(c);
}

/**
 * Pair DC and Cloud /field arrays by normalized name.
 *
 * @param {Array} dcFields - raw output of /rest/api/2/field
 * @param {Array} cloudFields - raw output of /rest/api/3/field/search
 * @returns {object}
 */
function pairFieldsByName(dcFields, cloudFields) {
  const dcByName = new Map(); // name → [{id, name}, ...]
  const cloudByName = new Map();

  const cloudAssetFieldNames = new Set();
  const dcAssetFieldNames = new Set();
  const cloudTrafficLightFieldNames = new Set();

  for (const f of dcFields || []) {
    if (!f || !f.name) continue;
    // Skip system fields — their IDs ("status", "priority") don't change
    // post-migration, so they don't need a remap entry.
    const isCustom = f.custom === true || /^customfield_\d+$/.test(String(f.id || ""));
    if (!isCustom) continue;
    const n = normalizeName(f.name);
    if (!dcByName.has(n)) dcByName.set(n, []);
    dcByName.get(n).push(f);
    if (isDcAssetField(f)) dcAssetFieldNames.add(n);
  }

  for (const f of cloudFields || []) {
    if (!f || !f.name) continue;
    const isCustom = f.custom === true || /^customfield_\d+$/.test(String(f.id || ""));
    if (!isCustom) continue;
    const n = normalizeName(f.name);
    if (!cloudByName.has(n)) cloudByName.set(n, []);
    cloudByName.get(n).push(f);
    if (isCloudAssetField(f)) cloudAssetFieldNames.add(n);
    if (isTrafficLightField(f)) cloudTrafficLightFieldNames.add(n);
  }

  const dcIdToCloudId = new Map();
  const dcLongToCloudLong = new Map();
  const cloudNameToCloudId = new Map();
  const collisions = [];

  // Build the reverse name→id for ORDER BY validation and assetFieldRewriter
  // field-name lookups.
  for (const [name, fields] of cloudByName.entries()) {
    // Prefer the first asset field if multiple by name; otherwise first.
    const preferred = fields.find(isCloudAssetField) || fields[0];
    const cid = numericId(preferred.id);
    if (cid) cloudNameToCloudId.set(name, cid);
  }

  for (const [name, dcEntries] of dcByName.entries()) {
    const cloudEntries = cloudByName.get(name) || [];
    if (cloudEntries.length === 0) continue;

    if (dcEntries.length > 1 || cloudEntries.length > 1) {
      collisions.push({
        name,
        dcIds: dcEntries.map((f) => numericId(f.id)).filter(Boolean),
        cloudIds: cloudEntries.map((f) => numericId(f.id)).filter(Boolean),
      });
    }

    // First-wins: pair the first DC field with the first Cloud field. The
    // collision report lets the operator manually override via --cf-map.
    const dcId = numericId(dcEntries[0].id);
    const cloudId = numericId(cloudEntries[0].id);
    if (dcId && cloudId && dcId !== cloudId) {
      dcIdToCloudId.set(dcId, cloudId);
      dcLongToCloudLong.set(`customfield_${dcId}`, `customfield_${cloudId}`);
    }
  }

  return {
    dcIdToCloudId,
    dcLongToCloudLong,
    cloudNameToCloudId,
    cloudAssetFieldNames,
    dcAssetFieldNames,
    cloudTrafficLightFieldNames,
    collisions,
    stats: {
      dcCount: dcByName.size,
      cloudCount: cloudByName.size,
      paired: dcIdToCloudId.size,
      collisions: collisions.length,
      assetFields: cloudAssetFieldNames.size,
      trafficLightFields: cloudTrafficLightFieldNames.size,
    },
  };
}

/**
 * Live builder: fetches both sides and pairs them.
 * Returns the same shape as pairFieldsByName plus a `source` tag.
 */
async function buildFieldMap({ dcClient, cloudClient, log = console.log } = {}) {
  if (!cloudClient) throw new Error("buildFieldMap: cloudClient required");

  log("  [field-map] Fetching Cloud custom fields...");
  const cloudFields = await cloudClient.getAllFields();
  log(`  [field-map] Cloud: ${cloudFields.length} custom field(s)`);

  let dcFields = [];
  if (dcClient) {
    try {
      log("  [field-map] Fetching DC fields...");
      dcFields = await dcClient.getAllFields();
      log(`  [field-map] DC: ${Array.isArray(dcFields) ? dcFields.length : 0} field(s) (custom + system)`);
    } catch (err) {
      log(`  [field-map] DC fetch failed: ${err.message} — continuing with Cloud-only catalogue.`);
      dcFields = [];
    }
  } else {
    log("  [field-map] No DC client configured; building Cloud-only asset/name catalogue (no DC→Cloud id pairing).");
  }

  const result = pairFieldsByName(dcFields, cloudFields);
  log(
    `  [field-map] Paired: ${result.stats.paired} DC→Cloud id(s), ${result.stats.collisions} name collision(s), ${result.stats.assetFields} asset field(s), ${result.stats.trafficLightFields} traffic-light field(s).`,
  );
  return result;
}

module.exports = {
  buildFieldMap,
  pairFieldsByName,
  normalizeName,
  numericId,
  isCloudAssetField,
  isDcAssetField,
  isTrafficLightField,
  ASSET_CUSTOM_TYPE,
  DC_INSIGHT_CUSTOM_TYPES,
  TRAFFIC_LIGHT_TYPE_SUFFIX,
};
