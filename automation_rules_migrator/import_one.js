#!/usr/bin/env node

/**
 * Validate the cloud-to-cloud import path with ONE rule end-to-end:
 *   1. generate source→target mappings (projects/issue-types/fields/statuses/users…)
 *   2. fix IDs in the chosen rule, REPORT any field that did not map
 *   3. POST it to the target (spec-correct wrapped {rule, connections} payload)
 *   4. if the source rule was ENABLED, enable it in the target
 *   5. read it back to confirm it landed with its components intact
 *
 * Env vars:
 *   SRC_USER/SRC_TOKEN/SRC_SITE/SRC_CLOUD  source instance
 *   TGT_USER/TGT_TOKEN/TGT_SITE/TGT_CLOUD  target instance
 *   FULL_FILE  path to the FULL export json
 *   RULE_NAME  exact name of the rule to import
 *   DO_IMPORT  "1" to actually write to target (else dry-run: stops after the mapping report)
 */

const fs = require("fs");
const jiraClient = require("./src/api/jiraClient");
const ruleService = require("./src/services/ruleService");
const mappingService = require("./src/services/mappingService");

const E = process.env;
const RULE_NAME = E.RULE_NAME;
const FULL_FILE = E.FULL_FILE;

// Only these fields are valid on CreateRulePayload (openapi RuleWriteRequest.rule).
const CREATE_FIELDS = [
  "actor",
  "authorAccountId",
  "canOtherRuleTrigger",
  "collaborators",
  "components",
  "description",
  "labels",
  "name",
  "notifyOnError",
  "ruleScopeARIs",
  "state",
  "trigger",
  "writeAccessType",
];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// Scan a fixed rule for IDs that still reference the SOURCE instance.
function residualSourceRefs(rule, srcCloud) {
  const blob = JSON.stringify(rule);
  const hits = [];
  if (blob.includes(srcCloud)) hits.push(`source cloudId ${srcCloud} still present`);
  return hits;
}

(async () => {
  for (const v of [
    "SRC_USER","SRC_TOKEN","SRC_SITE","SRC_CLOUD",
    "TGT_USER","TGT_TOKEN","TGT_SITE","TGT_CLOUD","FULL_FILE","RULE_NAME",
  ]) {
    if (!E[v]) throw new Error(`Missing env ${v}`);
  }

  const data = JSON.parse(fs.readFileSync(FULL_FILE, "utf8"));
  const original = data.rules.find((r) => r.name === RULE_NAME);
  if (!original) throw new Error(`Rule not found in export: "${RULE_NAME}"`);
  const sourceState = original.state;
  console.log(`\n=== Rule: "${RULE_NAME}" (source state: ${sourceState}) ===`);
  console.log(
    `trigger ${original.trigger?.type} | ${original.components?.length} components | scope ${JSON.stringify(original.ruleScopeARIs)}`,
  );

  let mappings;
  if (E.MAP_FILE && fs.existsSync(E.MAP_FILE)) {
    console.log(`\n--- Loading cached mappings from ${E.MAP_FILE} ---`);
    mappings = JSON.parse(fs.readFileSync(E.MAP_FILE, "utf8"));
  } else {
    console.log("\n--- Generating source→target mappings ---");
    mappings = await mappingService.generateMappings(
      E.SRC_USER, E.SRC_TOKEN, E.SRC_SITE,
      E.TGT_USER, E.TGT_TOKEN, E.TGT_SITE,
    );
  }

  console.log("\n--- Fixing IDs (watch for UNMAPPED below) ---");
  const clone = JSON.parse(JSON.stringify(original));
  delete clone.connections; // not part of the rule body
  const fixedResult = mappingService.fixAutomationRules(
    [clone], mappings, E.TGT_CLOUD, undefined, /*isCloudSource*/ true, /*filterUnmapped*/ false,
  );
  const fixed = fixedResult.rules[0];

  const residual = residualSourceRefs(fixed, E.SRC_CLOUD);
  console.log("\n--- Residual source-ref scan ---");
  console.log(residual.length ? residual.map((h) => "  ⚠️ " + h).join("\n") : "  ✓ no source cloudId left in rule body");

  // Build the create payload: only valid CreateRulePayload fields.
  const payload = pick(fixed, CREATE_FIELDS);
  const dropped = Object.keys(fixed).filter((k) => !CREATE_FIELDS.includes(k));
  console.log(`\n--- Payload built (dropped non-create fields: ${dropped.join(", ") || "none"}) ---`);
  console.log(`payload keys: ${Object.keys(payload).join(", ")}`);

  if (E.DO_IMPORT !== "1") {
    console.log("\nDRY-RUN (DO_IMPORT!=1): stopping before write. Review mapping report above.");
    return;
  }

  // ---- Create in target (spec-correct wrapped form) ----
  const base = `https://${E.TGT_SITE}/gateway/api/automation/public/jira/${E.TGT_CLOUD}`;
  const createUrl = `${base}/rest/v1/rule`;
  console.log("\n--- POST (wrapped {rule, connections}) ---");
  let ruleUuid;
  try {
    const res = await jiraClient.post(createUrl, E.TGT_USER, E.TGT_TOKEN, {
      rule: payload,
      connections: [],
    });
    console.log(`  HTTP ${res.status} -> ${JSON.stringify(res.data)}`);
    ruleUuid = res.data?.ruleUuid;
  } catch (err) {
    console.log(`  WRAPPED FAILED: ${err.message}`);
    console.log("  retrying BARE (rule object only) ...");
    const res = await jiraClient.post(createUrl, E.TGT_USER, E.TGT_TOKEN, payload);
    console.log(`  HTTP ${res.status} -> ${JSON.stringify(res.data)}`);
    ruleUuid = res.data?.ruleUuid;
  }
  if (!ruleUuid) throw new Error("No ruleUuid returned from create");
  console.log(`  ✓ created ruleUuid: ${ruleUuid}`);

  // ---- Enable if source was enabled ----
  if (sourceState === "ENABLED") {
    console.log("\n--- Enabling (source was ENABLED) ---");
    const ok = await ruleService.enableRule(E.TGT_USER, E.TGT_TOKEN, E.TGT_SITE, E.TGT_CLOUD, ruleUuid);
    console.log(`  enable -> ${ok ? "OK" : "FAILED"}`);
  } else {
    console.log(`\n--- Source was ${sourceState}; leaving as created ---`);
  }

  // ---- Read back ----
  console.log("\n--- Verify (read back from target) ---");
  const back = await ruleService.getRuleByUuid(E.TGT_USER, E.TGT_TOKEN, E.TGT_SITE, E.TGT_CLOUD, ruleUuid);
  const br = back.rule || back;
  console.log(`  name: ${br.name} | state: ${br.state} | components: ${(br.components||[]).length} | trigger: ${br.trigger?.type}`);
  console.log(`  scope: ${JSON.stringify(br.ruleScopeARIs)}`);
})().catch((e) => {
  console.error("\nFATAL:", e.message);
  process.exit(1);
});
