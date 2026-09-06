#!/usr/bin/env node
/**
 * RECONCILE-TARGET mode — fix + enable automation rules that ALREADY exist on the
 * target, IN PLACE. No export-from-source, no create/import.
 *
 * What it does:
 *   1. Reads every rule that already lives on the TARGET (full bodies).
 *   2. Reads the SOURCE-OF-TRUTH automation rules from a DATACENTER instance
 *      (configurable URL) — used for (a) which target rules are in scope and
 *      (b) each rule's desired ENABLED/DISABLED state. "as per source instance."
 *   3. Builds a DC-AUTHORITATIVE field map: for every field referenced in a target
 *      rule, the correct Cloud field is the one whose NAME matches the Datacenter
 *      field of that id (DC id -> DC name -> Cloud field by name -> Cloud id).
 *   4. For each target rule whose name matches a DC rule: rewrites field references
 *      (smart values, components, conditions) to the correct Cloud field ids, PUTs
 *      the corrected rule in place, and sets its state to match DC.
 *   5. SURPLUS target rules (no matching DC rule) are NEVER touched.
 *
 * Env (URLs are variables — point DC_RULES at whatever DC holds the rules):
 *   U, T              target creds (email + API token; client auto-detects base64)
 *   TGT_SITE          target site, e.g. your-sandbox.atlassian.net
 *   TGT_CLOUD         target cloudId
 *   DC_FIELDS_BASE    DC for the FIELD MAPPING, e.g. https://jira-dc.example.com
 *   DC_FIELDS_USER, DC_FIELDS_PASS    DC Basic-auth creds for fields
 *   DC_RULES_BASE     DC for the RULES/STATE source, e.g. https://servicedesk.example.com
 *                     (defaults to DC_FIELDS_BASE)
 *   DC_RULES_USER, DC_RULES_PASS      (default to DC_FIELDS_USER/PASS)
 *   DC_RULES_PATH     automation list endpoint (default /rest/cb-automation/latest/project/GLOBAL/rule)
 *   NO_SET_STATE=1    only fix fields, do NOT change enabled/disabled state
 *   DRY=1             plan only — no PUT, no state change
 */
const jc = require("./src/api/jiraClient");
const { logger } = require("./src/utils/logger");
const ruleService = require("./src/services/ruleService");
const mappingService = require("./src/services/mappingService");
const E = process.env;

const CREATE_FIELDS = ["actor","authorAccountId","canOtherRuleTrigger","collaborators","components","description","labels","name","notifyOnError","ruleScopeARIs","state","trigger","writeAccessType"];
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const norm = (s) => String(s || "").trim().toLowerCase();
const cfIds = (obj) => new Set((JSON.stringify(obj).match(/customfield_\d+/g) || []));

async function dcGetAll(base, path, user, pass) {
  // cb-automation GLOBAL list returns a flat array of rules.
  return jc.get(`${base.replace(/\/$/, "")}${path}`, user, pass, {}, 60000);
}
async function dcFields(base, user, pass) {
  return jc.get(`${base.replace(/\/$/, "")}/rest/api/2/field`, user, pass, {}, 60000);
}
async function targetCustomFields() {
  const out = [];
  let startAt = 0;
  for (;;) {
    const d = await jc.get(
      `https://${E.TGT_SITE}/rest/api/3/field/search`,
      E.U, E.T, { type: "custom", expand: "key", startAt, maxResults: 100 },
    );
    out.push(...((d && d.values) || []));
    if (!d || d.isLast || (d.values || []).length === 0) break;
    startAt += d.values.length;
  }
  return out;
}
async function targetEntities(endpoint) {
  // /project/search (paged) or flat arrays (/issuetype, /status, /priority, /resolution)
  const d = await jc.get(`https://${E.TGT_SITE}/rest/api/3${endpoint}`, E.U, E.T, { maxResults: 200 });
  return Array.isArray(d) ? d : (d.values || []);
}
function identity(list) {
  const m = {};
  for (const x of list) if (x && x.id != null) m[x.id] = x.id;
  return m;
}

(async () => {
  for (const k of ["U", "T", "TGT_SITE", "TGT_CLOUD", "DC_FIELDS_BASE", "DC_FIELDS_USER", "DC_FIELDS_PASS"])
    if (!E[k]) throw new Error(`Missing env ${k}`);
  const dcRulesBase = E.DC_RULES_BASE || E.DC_FIELDS_BASE;
  const dcRulesUser = E.DC_RULES_USER || E.DC_FIELDS_USER;
  const dcRulesPass = E.DC_RULES_PASS || E.DC_FIELDS_PASS;
  const dcRulesPath = E.DC_RULES_PATH || "/rest/cb-automation/latest/project/GLOBAL/rule";
  const dry = E.DRY === "1";
  const setState = E.NO_SET_STATE !== "1";

  logger.transports && (logger.level = "info");
  console.log(`RECONCILE-TARGET${dry ? " [DRY]" : ""}`);
  console.log(`  target:    ${E.TGT_SITE} (${E.TGT_CLOUD})`);
  console.log(`  DC fields: ${E.DC_FIELDS_BASE}`);
  console.log(`  DC rules:  ${dcRulesBase}${dcRulesPath}`);

  // ── 1. DC rules → desired {nameLower: state} ──
  const dcRulesRaw = await dcGetAll(dcRulesBase, dcRulesPath, dcRulesUser, dcRulesPass);
  const dcRules = Array.isArray(dcRulesRaw) ? dcRulesRaw : (dcRulesRaw.rules || dcRulesRaw.values || []);
  const dcState = new Map();
  for (const r of dcRules) {
    const st = (r.state || (r.enabled ? "ENABLED" : "DISABLED") || "").toUpperCase();
    if (r.name) dcState.set(norm(r.name), st === "ENABLED" ? "ENABLED" : "DISABLED");
  }
  console.log(`  DC rules read: ${dcRules.length} (desired-state for ${dcState.size} distinct names)`);

  // ── 2. DC-authoritative field map ──
  const dcF = (await dcFields(E.DC_FIELDS_BASE, E.DC_FIELDS_USER, E.DC_FIELDS_PASS))
    .filter((f) => String(f.id).startsWith("customfield_"));
  const dcIdToName = new Map(dcF.map((f) => [f.id, f.name]));
  const tgtF = await targetCustomFields();
  const tgtNameToId = new Map();
  const tgtIdToName = new Map();
  for (const f of tgtF) { if (!tgtNameToId.has(f.name)) tgtNameToId.set(f.name, f.id); tgtIdToName.set(f.id, f.name); }
  // customFieldMapping: dcId -> cloudId (by name). DEFAULT-SAFE: only remap a DC id
  // that is BROKEN on the target (i.e. dcId is NOT itself a valid target field) —
  // a rule reference to such an id can't be correct, so resolving it via the DC
  // name is unambiguous. When dcId IS also a valid target field id (a collision —
  // the same number means different fields in DC vs Cloud), we DON'T remap by
  // default, to avoid clobbering a legitimately-correct cloud reference. Pass
  // AGGRESSIVE=1 to remap those too (full DC-authoritative; review the diff).
  const aggressive = E.AGGRESSIVE === "1";
  const customFieldMapping = {};
  const customFieldNameMapping = {};
  for (const f of tgtF) customFieldNameMapping[f.id] = f.name;
  let movedSafe = 0, collisions = 0;
  for (const [dcId, dcName] of dcIdToName) {
    const cloudId = tgtNameToId.get(dcName);
    if (!cloudId || cloudId === dcId) continue;
    const isCollision = tgtIdToName.has(dcId); // dcId is also a real (different) target field
    if (isCollision && !aggressive) { collisions++; continue; }
    customFieldMapping[dcId] = cloudId;
    movedSafe++;
  }
  console.log(`  Field map: ${dcIdToName.size} DC fields, ${tgtF.length} target fields | remappable broken ids: ${movedSafe}` +
    (aggressive ? " (AGGRESSIVE: incl. collisions)" : ` | ${collisions} collision id(s) skipped (set AGGRESSIVE=1 to include)`));

  // ── 3. Identity maps for non-field entities (so fixAutomationRules leaves them unchanged) ──
  const [projects, issuetypes, statuses, priorities, resolutions] = await Promise.all([
    targetEntities("/project/search"), targetEntities("/issuetype"),
    targetEntities("/status"), targetEntities("/priority"), targetEntities("/resolution"),
  ]);
  const mappings = {
    customFieldMapping, customFieldNameMapping,
    projectMapping: identity(projects), issueTypeMapping: identity(issuetypes),
    statusMapping: identity(statuses), priorityMapping: identity(priorities),
    resolutionMapping: identity(resolutions), userMapping: {},
  };

  // ── 4. Read ALL target rules (full bodies) ──
  console.log("\nReading target rules ...");
  const summaries = await ruleService.getAllRules(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, "jira", true);
  console.log(`  ${summaries.length} rules on target`);

  const res = { fixed: [], stateOnly: [], unchanged: [], surplus: [], failed: [] };

  for (let i = 0; i < summaries.length; i++) {
    const sum = summaries[i];
    const uuid = sum.uuid || sum.id;
    const nameL = norm(sum.name);
    if (!dcState.has(nameL)) { res.surplus.push(sum.name); continue; } // SURPLUS — never touched
    const desiredState = dcState.get(nameL);
    let full;
    try { const r = await ruleService.getRuleByUuid(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, uuid); full = r.rule || r; }
    catch (e) { res.failed.push(`${sum.name}: read ${e.message}`); continue; }

    // Correct field references (DC-authoritative), capturing whether anything changed.
    const before = cfIds(full);
    let fixed;
    const ow = logger.warn, oi = logger.info, od = logger.debug;
    logger.warn = () => {}; logger.info = () => {}; logger.debug = () => {};
    try { fixed = mappingService.fixAutomationRules([JSON.parse(JSON.stringify(full))], mappings, E.TGT_CLOUD, undefined, true, false).rules[0]; }
    finally { logger.warn = ow; logger.info = oi; logger.debug = od; }
    const after = cfIds(fixed);
    const changedFields = [...before].filter((x) => !after.has(x));
    const fieldChanged = JSON.stringify(before) !== JSON.stringify(after) || changedFields.length > 0;

    const tag = `${i + 1}/${summaries.length}`;
    try {
      if (fieldChanged) {
        if (!dry) {
          const payload = pick(fixed, CREATE_FIELDS);
          const up = await ruleService.updateRule(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, uuid, { rule: payload, connections: [] });
          if (!up.success) throw new Error(`update ${JSON.stringify(up.error).slice(0, 160)}`);
        }
        res.fixed.push(`${sum.name} [${changedFields.join(",") || "fields rewritten"}]`);
        console.log(`  ${tag} [FIX${dry ? "/dry" : ""}] ${sum.name}  (remapped: ${changedFields.join(", ") || "—"})`);
      }
      if (setState && sum.state !== desiredState) {
        if (!dry) {
          const ok = desiredState === "ENABLED"
            ? await ruleService.enableRule(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, uuid)
            : await ruleService.disableRule(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, uuid);
          if (!ok) throw new Error(`set state ${desiredState} failed`);
        }
        if (!fieldChanged) res.stateOnly.push(`${sum.name} -> ${desiredState}`);
        console.log(`  ${tag} [STATE${dry ? "/dry" : ""}] ${sum.name}: ${sum.state} -> ${desiredState}`);
      }
      if (!fieldChanged && (!setState || sum.state === desiredState)) res.unchanged.push(sum.name);
    } catch (e) {
      res.failed.push(`${sum.name}: ${e.message}`);
      console.log(`  ${tag} [FAIL] ${sum.name}: ${e.message}`);
    }
  }

  console.log(`\n=== DONE${dry ? " (DRY)" : ""} ===`);
  console.log(`  Fields corrected: ${res.fixed.length}`);
  console.log(`  State-only changes: ${res.stateOnly.length}`);
  console.log(`  Already correct:  ${res.unchanged.length}`);
  console.log(`  Surplus (untouched): ${res.surplus.length}`);
  console.log(`  Failed: ${res.failed.length}`);
  if (res.surplus.length) console.log(`  surplus: ${res.surplus.join(" | ")}`);
  if (res.failed.length) { console.log("  failures:"); res.failed.forEach((f) => console.log(`    - ${f}`)); }
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
