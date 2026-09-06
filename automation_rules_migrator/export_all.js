#!/usr/bin/env node

/**
 * Non-interactive FULL export of all automation rules from a Cloud instance.
 *
 * Why this exists: the built-in `generate-json` path calls ruleService.getAllRules,
 * which only hits /rest/v1/rule/summary — that returns rule SUMMARIES (uuid, name,
 * state, scope) with NO trigger/components. Summaries cannot be recreated in the
 * target. This script additionally fetches each rule's full body via
 * GET /rest/v1/rule/{uuid} (ruleService.getRuleByUuid), which returns
 * {rule, connections}. We write the flat `rule` objects (with `connections`
 * attached) in the {"cloud": true, "rules": [...]} format consumed by fix-json /
 * import-json. fixAutomationRules reads ruleScopeARIs/trigger/components on each
 * flat rule, so the flat shape is exactly what the downstream pipeline expects.
 *
 * Credentials come from env vars so the token never lands in argv:
 *   AJ_USER  Jira email
 *   AJ_TOKEN Jira API token (raw, not base64)
 *   AJ_SITE  site domain, e.g. your-sandbox.atlassian.net
 *   AJ_CLOUD Cloud ID
 */

const fs = require("fs").promises;
const path = require("path");
const projectService = require("./src/services/projectService");
const ruleService = require("./src/services/ruleService");

const CONCURRENCY = 5;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

(async () => {
  const username = process.env.AJ_USER;
  const apiToken = process.env.AJ_TOKEN;
  const siteUrl = process.env.AJ_SITE;
  const cloudId = process.env.AJ_CLOUD;

  if (!username || !apiToken || !siteUrl || !cloudId) {
    throw new Error("Missing AJ_USER / AJ_TOKEN / AJ_SITE / AJ_CLOUD env vars");
  }

  console.log(`Fetching all projects from ${siteUrl} ...`);
  const allProjects = await projectService.getProjectIds(
    username,
    apiToken,
    siteUrl,
  );
  console.log(`  ${allProjects.length} projects`);

  console.log("Fetching rule summaries ...");
  const summaries = await ruleService.getAllRules(
    username,
    apiToken,
    siteUrl,
    cloudId,
    "jira",
    true,
  );
  // Keep only rules in scope of the discovered projects (+ global rules).
  const { filteredRules: scopedSummaries } =
    projectService.filterAutomationRules(summaries, allProjects);
  console.log(
    `  ${summaries.length} total summaries, ${scopedSummaries.length} in scope`,
  );

  console.log(
    `Fetching full bodies for ${scopedSummaries.length} rules (concurrency ${CONCURRENCY}) ...`,
  );
  let done = 0;
  const failures = [];
  const fullRules = await mapWithConcurrency(
    scopedSummaries,
    CONCURRENCY,
    async (summary) => {
      const uuid = summary.uuid || summary.id;
      try {
        const resp = await ruleService.getRuleByUuid(
          username,
          apiToken,
          siteUrl,
          cloudId,
          uuid,
        );
        const rule = resp.rule || resp;
        // Preserve connections (connected-app auth refs) alongside the rule.
        rule.connections = resp.connections || [];
        done++;
        if (done % 10 === 0 || done === scopedSummaries.length) {
          console.log(`  ${done}/${scopedSummaries.length}`);
        }
        return rule;
      } catch (e) {
        failures.push({ uuid, name: summary.name, error: e.message });
        return null;
      }
    },
  );

  const rules = fullRules.filter(Boolean);

  const domain = siteUrl.replace(".atlassian.net", "").replace("https://", "");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").split("T")[0];
  const filename = `automation_rules_FULL_${domain}_${timestamp}.json`;
  const outputPath = path.join(process.cwd(), filename);

  await fs.writeFile(
    outputPath,
    JSON.stringify({ cloud: true, rules }, null, 2),
    "utf8",
  );

  // Breakdown
  let global = 0;
  let enabled = 0;
  let withTrigger = 0;
  let withComponents = 0;
  let withConnections = 0;
  for (const r of rules) {
    const scoped = (r.ruleScopeARIs || []).some((a) => a.includes("project/"));
    if (!scoped) global++;
    if (r.state === "ENABLED") enabled++;
    if (r.trigger) withTrigger++;
    if (Array.isArray(r.components) && r.components.length) withComponents++;
    if (Array.isArray(r.connections) && r.connections.length) withConnections++;
  }

  console.log(`\nWrote ${rules.length} full rules -> ${filename}`);
  console.log(`  ${enabled} enabled / ${rules.length - enabled} disabled`);
  console.log(`  ${global} global / ${rules.length - global} project-scoped`);
  console.log(`  ${withTrigger} have a trigger, ${withComponents} have components`);
  console.log(`  ${withConnections} have non-empty connections`);
  if (failures.length) {
    console.log(`\n⚠️  ${failures.length} rules FAILED to fetch full body:`);
    failures.forEach((f) => console.log(`  - ${f.name} (${f.uuid}): ${f.error}`));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
