// Builds a DC→Cloud priority NAME map by pairing /priority outputs by id.
//
// Post-migration, JCMA preserves priority IDs (the small system IDs 1-10
// usually). What CAN change is the priority's display NAME, both because
// JCMA itself maps DC names through and because operators rename priorities
// by hand in the Cloud UI ("Critical" → "P0 - Critical"). JQL stored at
// DC-name time then references stale names and Cloud rejects PUTs with
//   The value 'Critical' does not exist for the field 'priority'.
//
// ASSUMPTION (worth verifying per tenant): JCMA preserves priority IDs
// across migration. This is documented for the default 5 priorities
// (1=Highest .. 5=Lowest) and observed in practice for custom priorities,
// but corner cases exist when a Cloud tenant pre-existed with conflicting
// IDs. If id-pairing fails for your tenant, supply a manual override via
// `--priority-map dc_name,cloud_name` — manual entries win on conflict.
//
// Pairing by id (rather than by name) means we can detect renames
// automatically — the id never moves, the name does. The output map is
// keyed by the lowercased/NFC-normalized DC name; values are the current
// Cloud-side name with original casing preserved.
//
// Identity pairs (DC name === Cloud name, case-insensitively) are filtered
// out at build time so the rewriter only sees real renames.
//
// Output shape:
//   {
//     dcNameToCloudName:        Map<string,string>   normalized-dc → cloud-display
//     dcNameToCloudNameDisplay: Map<string,string>   dc-display    → cloud-display (for reports)
//     collisions: Array<{ key, names }>              two DC priorities with the same normalized name
//     skipped: Array<{ reason, dcId, dcName }>       DC priorities with no Cloud match
//     stats: { dcCount, cloudCount, paired, identities, collisions, skipped }
//   }

function normalizeName(s) {
  return String(s || "").normalize("NFC").trim().toLowerCase();
}

/**
 * Pair DC and Cloud /priority arrays by id.
 *
 * @param {Array} dcPriorities - raw output of /rest/api/2/priority
 * @param {Array} cloudPriorities - raw output of /rest/api/3/priority(/search)
 * @returns {object}
 */
function pairPrioritiesById(dcPriorities, cloudPriorities) {
  const dcById = new Map();
  const cloudById = new Map();

  for (const p of dcPriorities || []) {
    if (!p || p.id == null || !p.name) continue;
    dcById.set(String(p.id), { id: String(p.id), name: String(p.name) });
  }
  for (const p of cloudPriorities || []) {
    if (!p || p.id == null || !p.name) continue;
    cloudById.set(String(p.id), { id: String(p.id), name: String(p.name) });
  }

  const dcNameToCloudName = new Map();
  const dcNameToCloudNameDisplay = new Map();
  const collisions = [];
  const skipped = [];
  let identities = 0;

  for (const [id, dc] of dcById.entries()) {
    const cloud = cloudById.get(id);
    if (!cloud) {
      skipped.push({ reason: "no_cloud_match", dcId: id, dcName: dc.name });
      continue;
    }
    const dcKey = normalizeName(dc.name);
    const cloudKey = normalizeName(cloud.name);
    if (dcKey === cloudKey) {
      // No-op rename — skip so the rewriter doesn't waste cycles on it.
      identities++;
      continue;
    }
    if (dcNameToCloudName.has(dcKey)) {
      const existing = dcNameToCloudName.get(dcKey);
      if (existing !== cloud.name) {
        collisions.push({ key: dcKey, names: [existing, cloud.name] });
      }
      continue;
    }
    dcNameToCloudName.set(dcKey, cloud.name);
    dcNameToCloudNameDisplay.set(dc.name, cloud.name);
  }

  return {
    dcNameToCloudName,
    dcNameToCloudNameDisplay,
    collisions,
    skipped,
    stats: {
      dcCount: dcById.size,
      cloudCount: cloudById.size,
      paired: dcNameToCloudName.size,
      identities,
      collisions: collisions.length,
      skipped: skipped.length,
    },
  };
}

function emptyResult() {
  return {
    dcNameToCloudName: new Map(),
    dcNameToCloudNameDisplay: new Map(),
    collisions: [],
    skipped: [],
    stats: {
      dcCount: 0,
      cloudCount: 0,
      paired: 0,
      identities: 0,
      collisions: 0,
      skipped: 0,
    },
  };
}

/**
 * Live builder: fetches both sides and pairs them.
 * Returns the same shape as pairPrioritiesById. Tolerates a missing DC client
 * (returns an empty map — the caller can still merge a manual override).
 */
async function buildPriorityMap({ dcClient, cloudClient, log = console.log } = {}) {
  if (!cloudClient) throw new Error("buildPriorityMap: cloudClient required");

  log("  [priority-map] Fetching Cloud priorities...");
  let cloudPriorities = [];
  try {
    cloudPriorities = await cloudClient.getAllPriorities();
    log(
      `  [priority-map] Cloud: ${cloudPriorities.length} priorit${cloudPriorities.length === 1 ? "y" : "ies"}`,
    );
  } catch (err) {
    log(`  [priority-map] Cloud fetch failed: ${err.message} — name map will be empty.`);
    return emptyResult();
  }

  let dcPriorities = [];
  if (dcClient) {
    try {
      log("  [priority-map] Fetching DC priorities...");
      dcPriorities = await dcClient.getAllPriorities();
      log(
        `  [priority-map] DC: ${Array.isArray(dcPriorities) ? dcPriorities.length : 0} priorit${(Array.isArray(dcPriorities) && dcPriorities.length === 1) ? "y" : "ies"}`,
      );
    } catch (err) {
      log(`  [priority-map] DC fetch failed: ${err.message} — name map will be empty.`);
      dcPriorities = [];
    }
  } else {
    log("  [priority-map] No DC client configured; name map will be empty (manual --priority-map only).");
  }

  const result = pairPrioritiesById(dcPriorities, cloudPriorities);
  log(
    `  [priority-map] Paired: ${result.stats.paired} rename(s), ${result.stats.identities} identity (no-op), ${result.stats.collisions} collision(s), ${result.stats.skipped} skipped.`,
  );
  return result;
}

module.exports = {
  buildPriorityMap,
  pairPrioritiesById,
  normalizeName,
};
