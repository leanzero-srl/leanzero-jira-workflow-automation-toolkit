#!/usr/bin/env node
/**
 * Generate source→target mappings ONCE and cache to disk, so per-rule audit and
 * import don't re-run the slow (~9 min) 44k-user cross-match every time.
 *
 * Env: SRC_USER/SRC_TOKEN/SRC_SITE, TGT_USER/TGT_TOKEN/TGT_SITE, OUT (output path)
 */
const fs = require("fs");
const mappingService = require("./src/services/mappingService");
const E = process.env;

(async () => {
  const out = E.OUT || "mappings.json";
  const mappings = await mappingService.generateMappings(
    E.SRC_USER, E.SRC_TOKEN, E.SRC_SITE,
    E.TGT_USER, E.TGT_TOKEN, E.TGT_SITE,
  );
  // Sets/Maps serialize poorly; generateMappings returns plain objects, so JSON is fine.
  fs.writeFileSync(out, JSON.stringify(mappings));
  const counts = Object.fromEntries(
    Object.entries(mappings).map(([k, v]) => [k, v && typeof v === "object" ? Object.keys(v).length : v]),
  );
  console.log("Wrote", out);
  console.log(JSON.stringify(counts, null, 2));
})().catch((e) => { console.error(e.message); process.exit(1); });
