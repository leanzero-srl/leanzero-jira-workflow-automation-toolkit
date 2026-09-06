#!/usr/bin/env node
/**
 * Repoint automation rules from the off-screen MIGRATED fields to their on-screen twins,
 * IN PLACE (PUT /rule/{uuid}). Data was already synced migrated->twin; the migrated
 * fields were removed from screens, so rules referencing them miss new data.
 *   Start Date (migrated) cf_10202  ->  Start date cf_10015
 *   Approvers (migrated)  cf_10196  ->  Approvers  cf_10003
 * Handles all forms: JQL name "Field (migrated)"/[type], cf[id], customfield_id.
 * Env: U, T, TGT_SITE, TGT_CLOUD ; DRY=1 to preview.
 */
const ruleService = require("./src/services/ruleService");
const E = process.env;
const CREATE_FIELDS = ["actor", "authorAccountId", "canOtherRuleTrigger", "collaborators", "components", "description", "labels", "name", "notifyOnError", "ruleScopeARIs", "state", "trigger", "writeAccessType"];
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const RE = /cf\[10202\]|cf\[10196\]|customfield_10202|customfield_10196|Start Date \(migrated\)|Approvers \(migrated\)/i;

function repoint(str) {
  return str
    .replace(/"Start Date \(migrated\)(\[[^\]]*\])?"/gi, "cf[10015]")
    .replace(/cf\[10202\]/gi, "cf[10015]")
    .replace(/\bcustomfield_10202\b/g, "customfield_10015")
    .replace(/"Approvers \(migrated\)(\[[^\]]*\])?"/gi, "cf[10003]")
    .replace(/cf\[10196\]/gi, "cf[10003]")
    .replace(/\bcustomfield_10196\b/g, "customfield_10003");
}
// Deep map over string values, collecting before/after diffs.
function transform(obj, diffs) {
  if (typeof obj === "string") { const n = repoint(obj); if (n !== obj) diffs.push({ before: obj, after: n }); return n; }
  if (Array.isArray(obj)) return obj.map((v) => transform(v, diffs));
  if (obj && typeof obj === "object") { const o = {}; for (const k of Object.keys(obj)) o[k] = transform(obj[k], diffs); return o; }
  return obj;
}

(async () => {
  const dry = E.DRY === "1";
  const sums = await ruleService.getAllRules(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, "jira", true);
  let touched = 0, ok = 0, fail = 0;
  for (const s of sums) {
    const uuid = s.uuid || s.id;
    let full;
    try { const r = await ruleService.getRuleByUuid(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, uuid); full = r.rule || r; }
    catch (e) { continue; }
    if (!RE.test(JSON.stringify(full))) continue;
    touched++;
    const diffs = [];
    const fixed = transform(JSON.parse(JSON.stringify(full)), diffs);
    console.log(`\n${dry ? "[DRY] " : ""}⚑ "${full.name}" [${full.state}] — ${diffs.length} string(s) repointed:`);
    for (const d of diffs) console.log(`     - ${d.before.slice(0, 150)}\n     + ${d.after.slice(0, 150)}`);
    if (!dry) {
      const payload = pick(fixed, CREATE_FIELDS);
      const up = await ruleService.updateRule(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, uuid, { rule: payload, connections: [] });
      if (up.success) { ok++; console.log(`     => UPDATED`); }
      else { fail++; console.log(`     => FAIL: ${JSON.stringify(up.error).slice(0, 200)}`); }
    }
  }
  console.log(`\n${dry ? "DRY " : ""}DONE — rules touched: ${touched}${dry ? "" : ` | updated: ${ok} | failed: ${fail}`}`);
})().catch((e) => { console.error("FATAL", e.stack || e.message); process.exit(1); });
