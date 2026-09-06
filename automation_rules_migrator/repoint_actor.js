#!/usr/bin/env node
/**
 * Repoint specific automation rules' ACTOR ("Run rule as") to the target's
 * Automation-for-Jira app account (the "Jira" actor) — changing ONLY the actor,
 * leaving every other field (components, trigger, state, name, ...) verbatim.
 * Env: U, T, TGT_SITE, TGT_CLOUD ; APP_ACTOR=<id> (else auto-discovered) ; DRY=1 to preview.
 */
const ruleService = require("./src/services/ruleService");
const E = process.env;
const CREATE_FIELDS = ["actor", "authorAccountId", "canOtherRuleTrigger", "collaborators", "components", "description", "labels", "name", "notifyOnError", "ruleScopeARIs", "state", "trigger", "writeAccessType"];
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const norm = (s) => String(s || "").trim().toLowerCase();
const APP_PREFIX = "557058:";

// the enabled imported rules to repoint - EDIT THIS LIST for your instance
const TARGET_NAMES = [
  "Example Rule A",
  "Example Rule B",
  "Example Rule C",
  "Example Rule D",
  "Example Rule E",
  "Example Rule F",
  "Example Rule G",
  "Example Rule H",
  "Example Rule I",
].map(norm);

function discoverAppActor(rules) {
  const c = new Map();
  for (const r of rules) { const a = r.actorAccountId; if (typeof a === "string" && a.startsWith(APP_PREFIX)) c.set(a, (c.get(a) || 0) + 1); }
  let best = null, m = -1; for (const [a, n] of c) if (n > m) { best = a; m = n; }
  return best;
}

(async () => {
  const dry = E.DRY === "1";
  const all = await ruleService.getAllRules(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, "jira", true);
  const appActor = E.APP_ACTOR || discoverAppActor(all);
  if (!appActor) throw new Error("could not determine Automation-for-Jira app actor; set APP_ACTOR");
  console.log(`Target "Jira" app actor: ${appActor}  | mode: ${dry ? "DRY" : "APPLY"}\n`);

  const want = all.filter((r) => TARGET_NAMES.includes(norm(r.name)));
  const missing = TARGET_NAMES.filter((n) => !want.some((r) => norm(r.name) === n));
  if (missing.length) console.log(`WARN not found: ${missing.join(" | ")}\n`);

  let ok = 0, skip = 0, fail = 0;
  for (const s of want) {
    const uuid = s.uuid || s.id;
    let full;
    try { const r = await ruleService.getRuleByUuid(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, uuid); full = r.rule || r; }
    catch (e) { fail++; console.log(`  ✗ ${s.name}: read ${e.message}`); continue; }
    const cur = full.actor && (full.actor.actor || full.actor.value);
    if (cur === appActor) { skip++; console.log(`  = ${s.name}: already app actor`); continue; }
    // change ONLY the actor; everything else stays verbatim
    const payload = pick(full, CREATE_FIELDS);
    payload.actor = { type: "ACCOUNT_ID", actor: appActor };
    console.log(`  ${dry ? "[DRY] " : ""}→ ${s.name} [${full.state}]: actor ${cur} -> ${appActor}`);
    if (!dry) {
      const up = await ruleService.updateRule(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, uuid, { rule: payload, connections: [] });
      if (up.success) { ok++; console.log(`       => UPDATED`); }
      else { fail++; console.log(`       => FAIL: ${JSON.stringify(up.error).slice(0, 200)}`); }
    }
  }
  console.log(`\n${dry ? "DRY " : ""}DONE — matched ${want.length}/9${dry ? "" : ` | updated ${ok} | already ${skip} | failed ${fail}`}`);
})().catch((e) => { console.error("FATAL", e.stack || e.message); process.exit(1); });
