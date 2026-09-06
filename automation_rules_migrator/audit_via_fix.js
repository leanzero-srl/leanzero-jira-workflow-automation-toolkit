#!/usr/bin/env node
/**
 * TRUE unmapped-field audit: runs the tool's own fixAutomationRules over every
 * exported rule (using cached mappings) and captures what IT reports as unmapped.
 * This catches bare-numeric field IDs the literal-regex audit misses.
 *
 * Env: MAP_FILE (cached mappings json), FULL_FILE, TGT_CLOUD,
 *      U, T, SRC_SITE, TGT_SITE (for field name/collision detail)
 */
const fs = require("fs");
const jc = require("./src/api/jiraClient");
const { logger } = require("./src/utils/logger");
const mappingService = require("./src/services/mappingService");
const E = process.env;

const CATS = ["Custom Fields", "Projects", "Issue Types", "Statuses", "Users", "Resolutions", "Priorities"];
const lineRe = /^\s*-\s+(Custom Fields|Projects|Issue Types|Statuses|Users|Resolutions|Priorities)\s+\((\d+)\):\s*(.+)$/;

(async () => {
  const mappings = JSON.parse(fs.readFileSync(E.MAP_FILE, "utf8"));
  const data = JSON.parse(fs.readFileSync(E.FULL_FILE, "utf8"));

  // Field name/collision detail
  const src = await jc.get(`https://${E.SRC_SITE}/rest/api/3/field`, E.U, E.T);
  const tgt = await jc.get(`https://${E.TGT_SITE}/rest/api/3/field`, E.U, E.T);
  const sName = new Map(src.map((f) => [f.id, f.name]));
  const tById = new Map(tgt.map((f) => [f.id, f.name]));

  // Capture logger output (suppress console noise, keep summary lines).
  let buf = [];
  const cap = (m) => buf.push(String(m));
  logger.info = cap; logger.warn = cap; logger.debug = () => {}; logger.error = cap;

  const perRule = [];
  const fieldAgg = new Map(); // id -> Set(ruleNames)

  for (const rule of data.rules) {
    buf = [];
    const clone = JSON.parse(JSON.stringify(rule));
    delete clone.connections;
    try {
      mappingService.fixAutomationRules([clone], mappings, E.TGT_CLOUD, undefined, true, false);
    } catch (e) {
      perRule.push({ name: rule.name, state: rule.state, error: e.message });
      continue;
    }
    const unmapped = {};
    for (const line of buf) {
      const m = line.match(lineRe);
      if (m) unmapped[m[1]] = m[3].split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (Object.keys(unmapped).length) {
      perRule.push({ name: rule.name, state: rule.state, unmapped });
      for (const id of unmapped["Custom Fields"] || []) {
        if (!fieldAgg.has(id)) fieldAgg.set(id, new Set());
        fieldAgg.get(id).add(rule.name.trim());
      }
    }
  }
  // restore console
  delete logger.info; delete logger.warn; delete logger.debug; delete logger.error;

  console.log(`\n================ TRUE UNMAPPED AUDIT (${data.rules.length} rules) ================`);
  const affected = perRule.filter((r) => !r.error);
  const enabledAffected = affected.filter((r) => r.state === "ENABLED").length;
  console.log(`Rules with ANY unmapped reference: ${affected.length}  (${enabledAffected} ENABLED)`);

  // Category totals
  const catRules = {};
  for (const c of CATS) catRules[c] = affected.filter((r) => r.unmapped[c]).length;
  console.log("Rules affected by category:");
  for (const c of CATS) if (catRules[c]) console.log(`  ${c}: ${catRules[c]} rules`);

  console.log(`\n--- Unmappable custom fields (source name -> target's same-id field = collision) ---`);
  for (const [id, rules] of [...fieldAgg.entries()].sort((a, b) => b[1].size - a[1].size)) {
    const num = id.replace("customfield_", "");
    const sn = sName.get(id) || sName.get(`customfield_${num}`) || "(unknown in source)";
    const coll = tById.get(id) || tById.get(`customfield_${num}`);
    console.log(`  ${id}  src="${sn}"   target ${id} = ${coll ? `"${coll}"` : "(absent)"}   [${rules.size} rule(s)]`);
  }

  console.log(`\n--- Per-rule (state | name | unmapped by category) ---`);
  for (const r of affected.sort((a, b) => (a.state < b.state ? 1 : -1))) {
    const parts = CATS.filter((c) => r.unmapped[c]).map((c) => `${c}:${r.unmapped[c].length}`);
    console.log(`  [${r.state}] ${r.name.trim()}  ->  ${parts.join(", ")}`);
  }
  const errs = perRule.filter((r) => r.error);
  if (errs.length) {
    console.log(`\n--- fix() THREW for ${errs.length} rule(s) ---`);
    errs.forEach((r) => console.log(`  ${r.name.trim()}: ${r.error}`));
  }
  console.log(`\nClean (fully-mappable) rules: ${data.rules.length - perRule.length}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
