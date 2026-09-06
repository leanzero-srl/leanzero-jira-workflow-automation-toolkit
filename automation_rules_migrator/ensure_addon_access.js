#!/usr/bin/env node
/**
 * Ensure every project's PERMISSION SCHEME grants the add-on project role
 * (atlassian-addons-project-access) the permissions automation/app actors need.
 *
 * WHY: Connect/Forge apps (Automation for Jira, JMWE, Assets, Email This Issue…)
 * act on issues through the **atlassian-addons-project-access** project role. If a
 * project's permission scheme does NOT grant that role the issue-action
 * permissions, app/automation actions fail there (the same shape as
 * component.missing.permissions.actor). This step normalises every project scheme
 * so the add-on role can BROWSE/EDIT/COMMENT/TRANSITION/ASSIGN/LINK/CREATE.
 *
 * Idempotent: skips permissions already granted to the role; dedupes by scheme id
 * (schemes are often shared across projects). Resolves the role id PER PROJECT by
 * name (ids are not stable across sites). DRY=1 prints the plan only.
 *
 * Env:
 *   U, T          target creds (email + API token; jiraClient auto-detects base64)
 *   TGT_SITE      target site, e.g. your-sandbox.atlassian.net
 *   PROJECTS      optional CSV of project keys/ids to limit to (default: all)
 *   ROLE_NAME     add-on role name (default: atlassian-addons-project-access)
 *   PERMS         optional CSV of permission keys to ensure (default: the set below)
 *   DRY=1         plan only, no writes
 */
const jc = require("./src/api/jiraClient");
const E = process.env;

const ROLE_NAME = E.ROLE_NAME || "atlassian-addons-project-access";
const PERMS = (E.PERMS
  ? E.PERMS.split(",").map((s) => s.trim()).filter(Boolean)
  : [
      "BROWSE_PROJECTS",
      "CREATE_ISSUES",
      "EDIT_ISSUES",
      "ADD_COMMENTS",
      "TRANSITION_ISSUES",
      "ASSIGN_ISSUES",
      "LINK_ISSUES",
      "RESOLVE_ISSUES",
      "CLOSE_ISSUES",
      "SCHEDULE_ISSUES",
    ]);

async function getAllProjects(base) {
  const out = [];
  let startAt = 0;
  for (;;) {
    const d = await jc.get(`${base}/rest/api/3/project/search`, E.U, E.T, {
      startAt,
      maxResults: 50,
    });
    const v = (d && d.values) || [];
    out.push(...v);
    if (v.length < 50) break;
    startAt += v.length;
  }
  return out;
}

(async () => {
  for (const k of ["U", "T", "TGT_SITE"]) if (!E[k]) throw new Error(`Missing env ${k}`);
  const base = `https://${E.TGT_SITE}`;
  let projects = await getAllProjects(base);
  if (E.PROJECTS) {
    const want = new Set(E.PROJECTS.split(",").map((s) => s.trim().toLowerCase()));
    projects = projects.filter((p) => want.has(String(p.id)) || want.has(String(p.key).toLowerCase()));
  }
  console.log(
    `Ensuring role "${ROLE_NAME}" has [${PERMS.join(", ")}] in ${projects.length} project scheme(s)${E.DRY === "1" ? " [DRY]" : ""}`,
  );

  const doneSchemes = new Set();
  const res = { granted: [], already: [], noRole: [], failed: [] };
  for (const p of projects) {
    let scheme, roles;
    try {
      scheme = await jc.get(`${base}/rest/api/3/project/${p.id}/permissionscheme?expand=permissions`, E.U, E.T);
      roles = await jc.get(`${base}/rest/api/3/project/${p.id}/role`, E.U, E.T);
    } catch (e) {
      res.failed.push(`${p.key}: ${e.message}`);
      continue;
    }
    if (doneSchemes.has(scheme.id)) continue; // shared scheme already handled
    doneSchemes.add(scheme.id);

    const roleUrl = roles[ROLE_NAME];
    if (!roleUrl) {
      res.noRole.push(p.key);
      continue;
    }
    const roleId = String(roleUrl.split("/").pop());
    const has = (perm) =>
      (scheme.permissions || []).some(
        (x) =>
          x.permission === perm &&
          x.holder &&
          x.holder.type === "projectRole" &&
          String(x.holder.parameter || x.holder.value) === roleId,
      );
    for (const perm of PERMS) {
      if (has(perm)) {
        res.already.push(`${p.key}:${perm}`);
        continue;
      }
      if (E.DRY === "1") {
        res.granted.push(`${p.key}:${perm} (would grant)`);
        continue;
      }
      try {
        await jc.post(`${base}/rest/api/3/permissionscheme/${scheme.id}/permission`, E.U, E.T, {
          holder: { type: "projectRole", parameter: roleId },
          permission: perm,
        });
        res.granted.push(`${p.key}:${perm}`);
      } catch (e) {
        res.failed.push(`${p.key}:${perm}: ${e.message}`);
      }
    }
  }

  console.log(
    `\nDONE: granted=${res.granted.length} already-present=${res.already.length} no-${ROLE_NAME}-role=${res.noRole.length} failed=${res.failed.length}`,
  );
  if (res.granted.length) console.log(`  granted: ${res.granted.join(", ")}`);
  if (res.noRole.length) console.log(`  no role: ${res.noRole.join(", ")}`);
  if (res.failed.length) { console.log("  failed:"); res.failed.forEach((f) => console.log(`    - ${f}`)); }
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
