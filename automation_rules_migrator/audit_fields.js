#!/usr/bin/env node
/**
 * Audit which custom-field references in the exported rules will NOT map to the
 * target (mapping is by field NAME). For each unmapped reference, also show what
 * the target's same-numeric-id field actually is — i.e. the silent-collision a
 * blind import would cause.
 *
 * Env: U, T (email, token), SRC_SITE, TGT_SITE, FULL_FILE
 */
const fs = require("fs");
const jc = require("./src/api/jiraClient");
const E = process.env;

async function fields(site) {
  // /rest/api/3/field is a flat array (not paginated); call axios via jiraClient.get.
  const url = `https://${site}/rest/api/3/field`;
  return jc.get(url, E.U, E.T);
}

(async () => {
  const data = JSON.parse(fs.readFileSync(E.FULL_FILE, "utf8"));
  const src = await fields(E.SRC_SITE);
  const tgt = await fields(E.TGT_SITE);

  const srcById = new Map(src.map((f) => [f.id, f]));
  const tgtByName = new Map();
  for (const f of tgt) tgtByName.set(f.name, f);
  const tgtById = new Map(tgt.map((f) => [f.id, f]));

  const cfRe = /customfield_\d+/g;
  const missingAgg = new Map(); // srcId -> {name, type, rules:Set, collision}
  const perRule = [];

  for (const rule of data.rules) {
    const ids = new Set((JSON.stringify(rule).match(cfRe) || []));
    const unmapped = [];
    for (const id of ids) {
      const sf = srcById.get(id);
      const sname = sf ? sf.name : "(unknown in source)";
      const hit = sf && tgtByName.get(sf.name);
      if (!hit) {
        unmapped.push({ id, sname, stype: sf && sf.schema && sf.schema.custom });
        if (!missingAgg.has(id)) {
          const coll = tgtById.get(id);
          missingAgg.set(id, {
            name: sname,
            type: sf && sf.schema && sf.schema.custom,
            rules: new Set(),
            collision: coll ? `${coll.id}="${coll.name}"` : "(no field at that id in target)",
          });
        }
        missingAgg.get(id).rules.add(rule.name);
      }
    }
    if (unmapped.length) perRule.push({ name: rule.name, state: rule.state, unmapped });
  }

  console.log(`\n=== FIELD MAPPING AUDIT (${data.rules.length} rules) ===`);
  console.log(`Rules with >=1 unmappable custom field: ${perRule.length}`);
  console.log(`Distinct unmappable source fields: ${missingAgg.size}\n`);

  console.log("--- Unmappable fields (source field -> what target's same id really is) ---");
  for (const [id, m] of [...missingAgg.entries()].sort((a, b) => b[1].rules.size - a[1].rules.size)) {
    console.log(`  ${id}  "${m.name}" [${m.type}]`);
    console.log(`      target ${id} is actually: ${m.collision}`);
    console.log(`      used by ${m.rules.size} rule(s): ${[...m.rules].slice(0, 6).join(" | ")}${m.rules.size > 6 ? " | ..." : ""}`);
  }

  console.log("\n--- Rules affected (name | state | unmapped fields) ---");
  for (const r of perRule.sort((a, b) => (a.state < b.state ? 1 : -1))) {
    console.log(`  [${r.state}] ${r.name.trim()}  ->  ${r.unmapped.map((u) => `${u.id}("${u.sname}")`).join(", ")}`);
  }
  const enabledAffected = perRule.filter((r) => r.state === "ENABLED").length;
  console.log(`\nSummary: ${perRule.length}/${data.rules.length} rules affected (${enabledAffected} of them ENABLED).`);
})().catch((e) => { console.error(e.message); process.exit(1); });
