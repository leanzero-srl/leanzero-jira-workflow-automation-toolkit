// Loads DC→Cloud asset maps from sibling `sync_asset_ticket_associations`
// plan JSON files. These files already hold, per migrated issue, a paired
// `dcAssets: [{key,name}]` and `cloudAssets: [{objectId,objectKey,name}]`
// array — the union of those pairs is a ready-made DC→Cloud mapping.
//
// Output shape:
//   {
//     dcKeyToCloudKey:         Map<string,string>
//     dcKeyToCloudObjectId:    Map<string,string>
//     dcKeyToCloudName:        Map<string,string>   // CMDB-99 → "Platform Squad"
//     dcNameToCloudKey:        Map<string,string>   (lowercased key)
//     dcNameToCloudObjectId:   Map<string,string>   (lowercased key)
//     dcNameToCloudName:       Map<string,string>   (lowercased key) — preserves
//                                                   the canonical (non-lowercased)
//                                                   Cloud display name as value
//     dcObjectIdToCloudObjectId: Map<string,string>
//     dcObjectIdToCloudName:   Map<string,string>
//     cloudObjectIdToCloudName: Map<string,string>  // for ARI parsing
//     cloudKeyToCloudName:     Map<string,string>
//     collisions: Array<{ dcKey, candidateCloudKeys }>
//     stats: { filesScanned, issuesScanned, dcKeysLearned, collisions }
//   }

const fs = require("fs");
const path = require("path");

// Minimal glob support: a single wildcard pattern like `plan_*.json` in a
// directory. We split the caller-provided pattern into (dir, filenameGlob)
// and match filenames against a translated regex. No recursion, no braces,
// no other metacharacters — that's all we need for the sibling plans path.
function resolveFiles(pattern, cwd) {
  const absolute = path.isAbsolute(pattern) ? pattern : path.resolve(cwd, pattern);
  const dir = path.dirname(absolute);
  const filePattern = path.basename(absolute);
  if (!fs.existsSync(dir)) return [];
  if (!filePattern.includes("*") && !filePattern.includes("?")) {
    const full = path.join(dir, filePattern);
    return fs.existsSync(full) ? [full] : [];
  }
  const re = new RegExp(
    "^" +
      filePattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && re.test(e.name))
    .map((e) => path.join(dir, e.name));
}

function normalizeName(s) {
  return String(s).normalize("NFC").trim().toLowerCase();
}

async function loadAssetMaps(globPattern, { log = console.log, cwd = process.cwd() } = {}) {
  const dcKeyToCloudKey = new Map();
  const dcKeyToCloudObjectId = new Map();
  const dcKeyToCloudName = new Map();
  const dcNameToCloudKey = new Map();
  const dcNameToCloudObjectId = new Map();
  const dcNameToCloudName = new Map();
  const dcObjectIdToCloudObjectId = new Map();
  const dcObjectIdToCloudName = new Map();
  const cloudObjectIdToCloudName = new Map();
  const cloudKeyToCloudName = new Map();
  // Cloud key → cloud objectId (so ARI-form emission can resolve from a key
  // token without a second lookup). Same first-wins rule as other maps.
  const cloudKeyToCloudObjectId = new Map();
  // Name → ALL cloud objectIds with that name (lowercased key). Drives the
  // collision-aware rewrite: when ≥2 objectIds share a name, we must emit
  // ARI form because the plain name is ambiguous on Cloud's JQL parser.
  // Stored as Set<string> to keep insertion idempotent across many plan files.
  const cloudNameToCloudObjectIds = new Map();

  // Collision detection: if a DC key maps to >1 distinct Cloud keys across
  // plan files, keep the first and report the rest.
  const collisionSources = new Map(); // dcKey -> Set<cloudKey>

  let filesScanned = 0;
  let issuesScanned = 0;

  const files = globPattern ? resolveFiles(globPattern, cwd) : [];

  for (const file of files) {
    const base = path.basename(file);
    // The sync_asset_ticket_associations script writes master_<ts>.json and
    // merged_<ts>.json files too. Only per-field plan files have the
    // dcAssets/cloudAssets shape.
    if (base.startsWith("master_") || base.startsWith("merged_")) continue;

    let parsed;
    try {
      const raw = fs.readFileSync(file, "utf8");
      parsed = JSON.parse(raw);
    } catch (err) {
      log(`  [assetMapLoader] Skip ${base}: ${err.message}`);
      continue;
    }

    const issues = parsed.issues || {};
    const issueKeys = Object.keys(issues);
    if (issueKeys.length === 0) continue;

    filesScanned++;
    for (const issueKey of issueKeys) {
      const entry = issues[issueKey];
      if (!entry) continue;
      issuesScanned++;
      const dcAssets = Array.isArray(entry.dcAssets) ? entry.dcAssets : [];
      const cloudAssets = Array.isArray(entry.cloudAssets) ? entry.cloudAssets : [];

      // Index cloud by lowercased name for fast lookup
      const cloudByName = new Map();
      for (const c of cloudAssets) {
        const n = c && c.name ? normalizeName(c.name) : null;
        if (!n) continue;
        if (!cloudByName.has(n)) cloudByName.set(n, c);
        // Direct cloud-only indexes (used by ARI resolution and the
        // assetFieldRewriter's preferred-form fallback).
        const cName = c.name ? String(c.name) : null;
        const cObjectId = c.objectId ? String(c.objectId) : null;
        const cObjectKey = c.objectKey ? String(c.objectKey) : null;
        if (cObjectId && cName && !cloudObjectIdToCloudName.has(cObjectId)) {
          cloudObjectIdToCloudName.set(cObjectId, cName);
        }
        if (cObjectKey && cName && !cloudKeyToCloudName.has(cObjectKey)) {
          cloudKeyToCloudName.set(cObjectKey, cName);
        }
        if (cObjectKey && cObjectId && !cloudKeyToCloudObjectId.has(cObjectKey)) {
          cloudKeyToCloudObjectId.set(cObjectKey, cObjectId);
        }
        if (cObjectId && cName) {
          // Collect ALL objectIds per name — collision-aware rewriter relies
          // on this to detect ambiguous names (≥2 objectIds for the same name).
          const lc = normalizeName(cName);
          if (!cloudNameToCloudObjectIds.has(lc)) {
            cloudNameToCloudObjectIds.set(lc, new Set());
          }
          cloudNameToCloudObjectIds.get(lc).add(cObjectId);
        }
      }

      for (const dc of dcAssets) {
        if (!dc) continue;
        const dcKey = dc.key ? String(dc.key) : null;
        const dcName = dc.name ? normalizeName(dc.name) : null;
        if (!dcName) continue;

        const cloud = cloudByName.get(dcName);
        if (!cloud) continue;

        const cloudKey = cloud.objectKey ? String(cloud.objectKey) : null;
        const cloudObjectId = cloud.objectId ? String(cloud.objectId) : null;
        const cloudName = cloud.name ? String(cloud.name) : null;
        const dcObjectId = dc.objectId ? String(dc.objectId) : null;

        if (dcKey && cloudKey) {
          const prior = dcKeyToCloudKey.get(dcKey);
          if (!prior) {
            dcKeyToCloudKey.set(dcKey, cloudKey);
          } else if (prior !== cloudKey) {
            if (!collisionSources.has(dcKey)) {
              collisionSources.set(dcKey, new Set([prior]));
            }
            collisionSources.get(dcKey).add(cloudKey);
          }
        }
        if (dcKey && cloudObjectId && !dcKeyToCloudObjectId.has(dcKey)) {
          dcKeyToCloudObjectId.set(dcKey, cloudObjectId);
        }
        if (dcKey && cloudName && !dcKeyToCloudName.has(dcKey)) {
          dcKeyToCloudName.set(dcKey, cloudName);
        }
        if (cloudKey && !dcNameToCloudKey.has(dcName)) {
          dcNameToCloudKey.set(dcName, cloudKey);
        }
        if (cloudObjectId && !dcNameToCloudObjectId.has(dcName)) {
          dcNameToCloudObjectId.set(dcName, cloudObjectId);
        }
        if (cloudName && !dcNameToCloudName.has(dcName)) {
          dcNameToCloudName.set(dcName, cloudName);
        }
        // DC numeric objectId → Cloud counterparts. The sibling script has
        // historically not recorded DC objectIds, so these maps may stay
        // empty. Populated defensively for the rare case where it does.
        if (dcObjectId && cloudObjectId && !dcObjectIdToCloudObjectId.has(dcObjectId)) {
          dcObjectIdToCloudObjectId.set(dcObjectId, cloudObjectId);
        }
        if (dcObjectId && cloudName && !dcObjectIdToCloudName.has(dcObjectId)) {
          dcObjectIdToCloudName.set(dcObjectId, cloudName);
        }
      }
    }
  }

  const collisions = [];
  for (const [dcKey, set] of collisionSources.entries()) {
    collisions.push({ dcKey, candidateCloudKeys: Array.from(set) });
  }

  // Convert name→objectIds Sets to plain arrays for downstream consumers.
  // Also count how many names actually collide (≥2 distinct objectIds).
  const cloudNameToCloudObjectIdsArr = new Map();
  let nameCollisionCount = 0;
  for (const [name, idSet] of cloudNameToCloudObjectIds.entries()) {
    const arr = Array.from(idSet);
    cloudNameToCloudObjectIdsArr.set(name, arr);
    if (arr.length >= 2) nameCollisionCount++;
  }

  return {
    dcKeyToCloudKey,
    dcKeyToCloudObjectId,
    dcKeyToCloudName,
    dcNameToCloudKey,
    dcNameToCloudObjectId,
    dcNameToCloudName,
    dcObjectIdToCloudObjectId,
    dcObjectIdToCloudName,
    cloudObjectIdToCloudName,
    cloudKeyToCloudName,
    cloudKeyToCloudObjectId,
    cloudNameToCloudObjectIds: cloudNameToCloudObjectIdsArr,
    collisions,
    stats: {
      filesScanned,
      issuesScanned,
      dcKeysLearned: dcKeyToCloudKey.size,
      cloudObjectsIndexed: cloudObjectIdToCloudName.size,
      collisions: collisions.length,
      cloudNameCollisions: nameCollisionCount,
    },
  };
}

module.exports = { loadAssetMaps };
