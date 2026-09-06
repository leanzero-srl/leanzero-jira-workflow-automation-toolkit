#!/usr/bin/env node
/**
 * Migrate the fully-mappable ("clean") rules from the FULL export into the target.
 * Clean = fixAutomationRules reports ZERO unmapped references for that rule.
 *
 * Per rule: fix IDs -> build wrapped {rule, connections} payload -> POST create
 * -> set state to match source (enable/disable). Skips rules whose name already
 * exists in target. Email-sending rules are imported DISABLED for safety (the
 * tool's own default) and listed, regardless of source state.
 *
 * RULE ACTOR ("Run rule as") — IMPORTANT: a rule's actor is the identity its actions run
 * with and are attributed to. The SOURCE rule's actor is the SOURCE site's Automation-for-Jira
 * app account (557058:<source-uuid>); that account does not exist on the target, so creating
 * with it FAILS `400 component.missing.permissions.actor`. By DEFAULT this script now sets the
 * actor to the TARGET site's Automation-for-Jira app account (the "Jira" actor) — auto-discovered
 * from existing target rules — so imported rules run with app-level permissions and match native
 * rules, instead of running as the API token's user.
 *   - APP_ACTOR=<accountId>     override/seed the app actor (needed on a FRESH target with no
 *                               existing rules to discover from; format 557058:<uuid>).
 *   - ACTOR_OVERRIDE=<accountId> run rules as a specific USER instead of the app — only if you
 *                               want actions attributed to a person. That user must hold the
 *                               needed perms; for JSM projects it must be an AGENT (Service Desk
 *                               Team role) — Jira-admin alone is NOT enough and /mypermissions
 *                               can misleadingly report Y — so first run ensure_actor_access.js.
 *
 * Env: FULL_FILE, MAP_FILE, U/T (target creds), TGT_SITE, TGT_CLOUD, SRC_SITE
 *      APP_ACTOR=<accountId>       -> app actor to run rules as (else auto-discovered = "Jira")
 *      ACTOR_OVERRIDE=<accountId>  -> run all rules as this USER instead (see above)
 *      PLAN=1                      -> only print the plan, do not write
 */
const fs = require("fs");
const jc = require("./src/api/jiraClient");
const { logger } = require("./src/utils/logger");
const ruleService = require("./src/services/ruleService");
const mappingService = require("./src/services/mappingService");
const E = process.env;

const CREATE_FIELDS = ["actor","authorAccountId","canOtherRuleTrigger","collaborators","components","description","labels","name","notifyOnError","ruleScopeARIs","state","trigger","writeAccessType"];
const unmappedRe = /No mapping found|Unmapped custom field|unmapped project in ruleScope/;
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// The "Automation for Jira" app actor — what shows as "Jira" / "Automation for Jira" in a
// rule's "Run rule as". On every Cloud site the app's account id is namespaced with this
// prefix (only the trailing UUID differs per site). Rules should run as THIS, not as the
// API token's user, so they execute with app-level permissions and match native rules.
const APP_ACTOR_PREFIX = "557058:";
// Discover the TARGET site's Automation-for-Jira app account by inspecting the actor of
// existing rules (native rules run as the app). Returns the most common app-actor id, or null.
function discoverAppActor(existingRules) {
  const counts = new Map();
  for (const r of existingRules || []) {
    const a = r.actorAccountId || (r.actor && (r.actor.actor || r.actor.value));
    if (typeof a === "string" && a.startsWith(APP_ACTOR_PREFIX)) counts.set(a, (counts.get(a) || 0) + 1);
  }
  let best = null, max = -1;
  for (const [a, c] of counts) if (c > max) { best = a; max = c; }
  return best;
}

// Run fix on a clone, return {fixed, clean} using captured logger warnings.
function fixAndCheck(rule, mappings) {
  const clone = JSON.parse(JSON.stringify(rule));
  delete clone.connections;
  let warned = false;
  const origWarn = logger.warn, origInfo = logger.info, origDebug = logger.debug;
  logger.warn = (m) => { if (unmappedRe.test(String(m))) warned = true; };
  logger.info = () => {}; logger.debug = () => {};
  try {
    const res = mappingService.fixAutomationRules([clone], mappings, E.TGT_CLOUD, undefined, true, false);
    return { fixed: res.rules[0], clean: !warned };
  } finally {
    logger.warn = origWarn; logger.info = origInfo; logger.debug = origDebug;
  }
}

// Discover an instance's Assets/CMDB workspaceId (JSM Assets is single-workspace per site).
async function assetsWorkspaceId(site) {
  try {
    const r = await jc.get(`https://${site}/rest/servicedeskapi/assets/workspace`, E.U, E.T);
    return r && r.values && r.values[0] && r.values[0].workspaceId;
  } catch (e) {
    return null;
  }
}

// Build a label-keyed map of the TARGET Assets workspace's schemas + object types.
// `cmdb.object.create` actions carry numeric objectTypeId/schemaId that are LOCAL to
// the source workspace — fixAutomationRules does NOT remap them, so a verbatim copy
// points at the wrong (or a non-existent) target type and create fails with
// "User does not have permission to create rule with this object type." We remap by
// LABEL (schemaLabel + objectTypeLabel), which the action conveniently also stores.
async function targetAssetTypeMap(workspaceId) {
  const base = `https://api.atlassian.com/jsm/assets/workspace/${workspaceId}/v1`;
  const schemas = (await jc.get(`${base}/objectschema/list`, E.U, E.T)).values || [];
  const schemaIdByLabel = {};
  const typeIdByLabel = {}; // "<schemaLabel>::<typeLabel>" -> objectTypeId
  for (const s of schemas) {
    schemaIdByLabel[s.name] = String(s.id);
    const flat = (await jc.get(`${base}/objectschema/${s.id}/objecttypes/flat`, E.U, E.T)) || [];
    for (const ot of flat) typeIdByLabel[`${s.name}::${ot.name}`] = String(ot.id);
  }
  return { schemaIdByLabel, typeIdByLabel };
}

// Remap objectTypeId/schemaId in every cmdb.object.create action of a rule, by label.
// Returns the number of actions changed. Attribute values are referenced by NAME (and
// their {{customfield_*}} values are already remapped by fixAutomationRules), so only
// the two numeric ids need fixing here.
function remapAssetCreateTypes(rule, tgtMap, log, ruleName) {
  let changed = 0;
  const walk = (node) => {
    for (const c of (Array.isArray(node) ? node : node ? [node] : [])) {
      if (c && c.type === "cmdb.object.create" && c.value) {
        const v = c.value;
        const newType = tgtMap.typeIdByLabel[`${v.schemaLabel}::${v.objectTypeLabel}`];
        const newSchema = tgtMap.schemaIdByLabel[v.schemaLabel];
        if (newType) {
          if (String(v.objectTypeId) !== newType) { v.objectTypeId = newType; changed++; }
          if (newSchema) v.schemaId = newSchema;
        } else {
          log(`    [warn] ${ruleName}: target Assets type "${v.schemaLabel}::${v.objectTypeLabel}" not found — leaving objectTypeId as-is`);
        }
      }
      if (c && c.children) walk(c.children);
    }
  };
  walk(rule.components);
  return changed;
}

(async () => {
  const data = JSON.parse(fs.readFileSync(E.FULL_FILE, "utf8"));
  const mappings = JSON.parse(fs.readFileSync(E.MAP_FILE, "utf8"));

  // Auto-discover source/target Assets workspace IDs (override with WS_SRC/WS_TGT).
  let wsSrc = E.WS_SRC, wsTgt = E.WS_TGT;
  if (!wsSrc && E.SRC_SITE) wsSrc = await assetsWorkspaceId(E.SRC_SITE);
  if (!wsTgt) wsTgt = await assetsWorkspaceId(E.TGT_SITE);
  if (wsSrc && wsTgt && wsSrc !== wsTgt) {
    console.log(`Assets workspace remap: ${wsSrc} -> ${wsTgt}`);
  } else if (wsSrc && wsTgt) {
    console.log(`Assets workspace identical (${wsSrc}); no remap needed`);
  } else {
    console.log(`Assets workspace: src=${wsSrc || "?"} tgt=${wsTgt || "?"} (remap skipped)`);
  }

  // Target Assets schema/type catalog for remapping cmdb.object.create object-type ids by label.
  let tgtAssetTypeMap = null;
  if (wsTgt) {
    try {
      tgtAssetTypeMap = await targetAssetTypeMap(wsTgt);
      console.log(`Target Assets catalog: ${Object.keys(tgtAssetTypeMap.schemaIdByLabel).length} schema(s), ${Object.keys(tgtAssetTypeMap.typeIdByLabel).length} object type(s)`);
    } catch (e) {
      console.log(`Target Assets catalog unavailable (${e.message}) — object-type remap skipped`);
    }
  }

  console.log("Fetching existing target rule names ...");
  const existing = await ruleService.getAllRules(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, "jira", true);
  const existingNames = new Set(existing.map((r) => r.name.trim().toLowerCase()));
  console.log(`  ${existing.length} rules already in target`);

  // Determine the rule actor ("Run rule as"). Default = the TARGET's Automation-for-Jira app
  // actor (the "Jira" actor) so rules run with app-level permissions like native rules — NOT
  // the API token's user. APP_ACTOR overrides discovery; ACTOR_OVERRIDE forces a real user.
  const appActor = E.APP_ACTOR || discoverAppActor(existing);
  if (E.ACTOR_OVERRIDE) console.log(`  Rule actor: ACTOR_OVERRIDE user ${E.ACTOR_OVERRIDE} (explicit)`);
  else if (appActor) console.log(`  Rule actor: Automation-for-Jira app ${appActor} (the "Jira" actor)`);
  else console.log(`  Rule actor: keeping SOURCE actor (no app actor found — set APP_ACTOR; cross-site app actors will 400)`);

  // Build plan
  const plan = [];
  for (const rule of data.rules) {
    const { fixed, clean } = fixAndCheck(rule, mappings);
    if (!clean) continue; // only the clean set
    const dup = existingNames.has(rule.name.trim().toLowerCase());
    const email = ruleService.hasEmailAction(rule);
    plan.push({ rule, fixed, name: rule.name.trim(), srcState: rule.state, email, dup });
  }

  const toImport = plan.filter((p) => !p.dup);
  const dups = plan.filter((p) => p.dup);
  const emailRules = toImport.filter((p) => p.email);
  console.log(`\n=== PLAN: clean rules = ${plan.length} | to import = ${toImport.length} | skip (already in target) = ${dups.length} ===`);
  console.log(`Enabled-in-source: ${toImport.filter((p) => p.srcState === "ENABLED").length} | Email-action (import DISABLED): ${emailRules.length}`);
  if (dups.length) console.log(`Skipping duplicates: ${dups.map((p) => p.name).join(" | ")}`);
  if (emailRules.length) console.log(`Email rules (will import DISABLED): ${emailRules.map((p) => p.name).join(" | ")}`);

  if (E.PLAN === "1") {
    console.log("\n--- to import (state | name) ---");
    toImport.forEach((p) => console.log(`  ${p.email ? "DISABLED(email)" : p.srcState.padEnd(8)} ${p.name}`));
    console.log("\nPLAN mode: no writes performed.");
    return;
  }

  const base = `https://${E.TGT_SITE}/gateway/api/automation/public/jira/${E.TGT_CLOUD}`;
  const createUrl = `${base}/rest/v1/rule`;
  const results = { created: [], enabled: [], disabled: [], failed: [] };

  for (let i = 0; i < toImport.length; i++) {
    const p = toImport[i];
    // Assets/CMDB workspaceId is not handled by fixAutomationRules; remap it here.
    if (wsSrc && wsTgt && wsSrc !== wsTgt) {
      p.fixed = JSON.parse(JSON.stringify(p.fixed).split(wsSrc).join(wsTgt));
    }
    // Remap cmdb.object.create object-type/schema ids (local to the source workspace) by label.
    if (tgtAssetTypeMap) {
      const n = remapAssetCreateTypes(p.fixed, tgtAssetTypeMap, (m) => console.log(m), p.name);
      if (n) console.log(`    remapped ${n} asset object-type id(s) for "${p.name}"`);
    }
    const payload = pick(p.fixed, CREATE_FIELDS);
    // Rule actor ("Run rule as"). The SOURCE actor is the source site's Automation-for-Jira app
    // account (557058:<source-uuid>), which is invalid on the target → HTTP 400
    // component.missing.permissions.actor. So we set the actor explicitly:
    //   1. ACTOR_OVERRIDE  -> a specific user account (only if you want actions attributed to a person)
    //   2. else app actor  -> the TARGET's Automation-for-Jira app ("Jira" actor), the correct default
    //   3. else            -> leave source actor (will likely 400 until APP_ACTOR is provided)
    if (E.ACTOR_OVERRIDE) payload.actor = { type: "ACCOUNT_ID", actor: E.ACTOR_OVERRIDE };
    else if (appActor) payload.actor = { type: "ACCOUNT_ID", actor: appActor };
    const desiredState = p.email ? "DISABLED" : p.srcState;
    payload.state = desiredState;
    const tag = `${i + 1}/${toImport.length}`;
    try {
      const res = await jc.post(createUrl, E.U, E.T, { rule: payload, connections: [] });
      const uuid = res.data?.ruleUuid;
      if (!uuid) throw new Error(`no ruleUuid (HTTP ${res.status})`);
      results.created.push(p.name);
      // enforce state to match desired (create may not honor state field)
      if (desiredState === "ENABLED") {
        const ok = await ruleService.enableRule(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, uuid);
        (ok ? results.enabled : results.failed).push(p.name + (ok ? "" : " (enable failed)"));
      } else {
        await ruleService.disableRule(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, uuid);
        results.disabled.push(p.name);
      }
      console.log(`  ${tag} [OK ${desiredState}] ${p.name}  (${uuid})`);
    } catch (err) {
      results.failed.push(`${p.name}: ${err.message}`);
      console.log(`  ${tag} [FAIL] ${p.name}: ${err.message}`);
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`Created: ${results.created.length} | Enabled: ${results.enabled.length} | Disabled: ${results.disabled.length} | Failed: ${results.failed.length}`);
  if (results.failed.length) {
    console.log("Failures:");
    results.failed.forEach((f) => console.log(`  - ${f}`));
  }
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
