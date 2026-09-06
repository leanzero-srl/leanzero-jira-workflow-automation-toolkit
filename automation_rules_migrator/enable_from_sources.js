#!/usr/bin/env node
/**
 * Enable prod automation rules to match SOURCE intent = (ENABLED in sandbox) UNION
 * (ENABLED in Datacenter). Enable-only: never disables a rule, never touches a rule
 * that neither source says to enable. Email-sending rules are NOT auto-enabled (they
 * would notify real users) — they are listed for explicit review unless ENABLE_EMAIL=1.
 *
 * Env:
 *   U, T                 target (prod) creds (email + raw token)
 *   TGT_SITE, TGT_CLOUD  prod site + cloudId
 *   SANDBOX_FULL         path to sandbox FULL export (name -> state + email detection)
 *   DC_RULES             path to DC cb-automation rule dump (JSON array, name+state)
 *   ENABLE_EMAIL=1       also enable email-action rules (default: skip + list)
 *   DRY=1                preview only
 */
const fs = require("fs");
const ruleService = require("./src/services/ruleService");
const E = process.env;

const norm = (s) => String(s || "").trim();
const stateOf = (r) => r.state || (r.enabled ? "ENABLED" : "DISABLED");

(async () => {
  const sandbox = JSON.parse(fs.readFileSync(E.SANDBOX_FULL, "utf8")).rules || [];
  const dc = JSON.parse(fs.readFileSync(E.DC_RULES, "utf8"));
  const sbState = new Map(sandbox.map((r) => [norm(r.name), stateOf(r)]));
  const sbEmail = new Map(sandbox.map((r) => [norm(r.name), ruleService.hasEmailAction(r)]));
  const dcState = new Map(dc.map((r) => [norm(r.name), stateOf(r)]));

  const prod = await ruleService.getAllRules(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, "jira", false);
  console.log(`prod rules: ${prod.length} | sandbox: ${sandbox.length} | DC: ${dc.length}`);

  const toEnable = [], emailHeld = [], alreadyOn = [], notDesired = [];
  for (const r of prod) {
    const name = norm(r.name);
    const cur = stateOf(r);
    const wantSb = sbState.get(name) === "ENABLED";
    const wantDc = dcState.get(name) === "ENABLED";
    const want = wantSb || wantDc;
    if (!want) { notDesired.push(name); continue; }
    if (cur === "ENABLED") { alreadyOn.push(name); continue; }
    const reason = [wantSb ? "sandbox" : null, wantDc ? "DC" : null].filter(Boolean).join("+");
    if (sbEmail.get(name) && E.ENABLE_EMAIL !== "1") { emailHeld.push({ name, reason, uuid: r.uuid }); continue; }
    toEnable.push({ name, reason, uuid: r.uuid });
  }

  console.log(`\nTO ENABLE (non-email): ${toEnable.length}`);
  for (const x of toEnable) console.log(`  + [${x.reason}] ${x.name}`);
  console.log(`\nEMAIL rules held back (need ENABLE_EMAIL=1 / manual): ${emailHeld.length}`);
  for (const x of emailHeld) console.log(`  ~ [${x.reason}] ${x.name}`);
  console.log(`\nalready enabled: ${alreadyOn.length} | not desired by either source: ${notDesired.length}`);

  if (E.DRY === "1") { console.log("\nDRY: no changes."); return; }

  let ok = 0, fail = 0;
  for (const x of toEnable) {
    const r = await ruleService.enableRule(E.U, E.T, E.TGT_SITE, E.TGT_CLOUD, x.uuid);
    if (r) ok++; else { fail++; console.log(`  FAIL enable: ${x.name}`); }
  }
  console.log(`\nDONE — enabled ${ok}, failed ${fail}, email-held ${emailHeld.length}`);
})().catch((e) => { console.error("FATAL", e.stack || e.message); process.exit(1); });
