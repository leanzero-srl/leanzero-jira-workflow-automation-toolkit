#!/usr/bin/env node
/**
 * Ensure the automation rule ACTOR can act on every (JSM) project on the target.
 *
 * WHY: importing automation rules fails with
 *   400 component.missing.permissions.actor  ("EDIT_ISSUES / TRANSITION_ISSUES /
 *   ADD_COMMENTS / BROWSE_PROJECTS (Spaces <projectId>)")
 * when the rule's actor (see ACTOR_OVERRIDE in import_clean.js) is not a JSM AGENT
 * on the project the rule touches. Being a Jira/site admin is NOT sufficient and
 * GET /rest/api/3/mypermissions can misleadingly report havePermission=true — the
 * automation engine gates agent actions on real "Service Desk Team" (agent) role
 * membership. This script adds the actor to that role on each project, which is
 * what unblocks the import. (No new agent seat is consumed if the account already
 * holds a JSM agent licence elsewhere.)
 *
 * Idempotent: skips projects where the actor is already in the role, and skips
 * projects that have no "Service Desk Team" role (non-JSM).
 *
 * Env:
 *   U, T          target creds (email + API token; jiraClient auto-detects base64)
 *   TGT_SITE      target site, e.g. your-sandbox.atlassian.net
 *   ACTOR         accountId to grant (the same value you pass as ACTOR_OVERRIDE)
 *   PROJECTS      optional CSV of project keys/ids to limit to (default: all)
 *   ROLE_NAME     optional role name (default: "Service Desk Team")
 *   DRY=1         print the plan only, do not write
 */
const jc = require("./src/api/jiraClient");
const E = process.env;

const ROLE_NAME = E.ROLE_NAME || "Service Desk Team";

async function getAllProjects(base) {
  const out = [];
  let startAt = 0;
  for (;;) {
    const data = await jc.get(`${base}/rest/api/3/project/search`, E.U, E.T, {
      startAt,
      maxResults: 50,
    });
    const vals = (data && data.values) || [];
    out.push(...vals);
    if (vals.length < 50) break;
    startAt += vals.length;
  }
  return out;
}

(async () => {
  for (const k of ["U", "T", "TGT_SITE", "ACTOR"]) {
    if (!E[k]) throw new Error(`Missing env ${k}`);
  }
  const base = `https://${E.TGT_SITE}`;
  let projects = await getAllProjects(base);
  if (E.PROJECTS) {
    const want = new Set(E.PROJECTS.split(",").map((s) => s.trim().toLowerCase()));
    projects = projects.filter(
      (p) => want.has(String(p.id)) || want.has(String(p.key).toLowerCase()),
    );
  }
  console.log(
    `Ensuring actor ${E.ACTOR} is in "${ROLE_NAME}" on ${projects.length} project(s) of ${E.TGT_SITE}${E.DRY === "1" ? " [DRY]" : ""}`,
  );

  const res = { added: [], already: [], noRole: [], failed: [] };
  for (const p of projects) {
    let roles;
    try {
      roles = await jc.get(`${base}/rest/api/3/project/${p.id}/role`, E.U, E.T);
    } catch (e) {
      res.failed.push(`${p.key}: role list ${e.message}`);
      continue;
    }
    const roleUrl = roles[ROLE_NAME];
    if (!roleUrl) {
      res.noRole.push(p.key);
      continue;
    }
    const roleId = roleUrl.split("/").pop();
    try {
      const role = await jc.get(roleUrl, E.U, E.T);
      const present = (role.actors || []).some(
        (a) => a.actorUser && a.actorUser.accountId === E.ACTOR,
      );
      if (present) {
        res.already.push(p.key);
        continue;
      }
      if (E.DRY === "1") {
        res.added.push(`${p.key} (would add)`);
        continue;
      }
      await jc.post(
        `${base}/rest/api/3/project/${p.id}/role/${roleId}`,
        E.U,
        E.T,
        { user: [E.ACTOR] },
      );
      res.added.push(p.key);
    } catch (e) {
      res.failed.push(`${p.key}: ${e.message}`);
    }
  }

  console.log(
    `\nDONE: added=${res.added.length} already=${res.already.length} no-${ROLE_NAME}-role=${res.noRole.length} failed=${res.failed.length}`,
  );
  if (res.added.length) console.log(`  added:   ${res.added.join(", ")}`);
  if (res.already.length) console.log(`  already: ${res.already.join(", ")}`);
  if (res.noRole.length) console.log(`  no role: ${res.noRole.join(", ")}`);
  if (res.failed.length) {
    console.log("  failed:");
    res.failed.forEach((f) => console.log(`    - ${f}`));
  }
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
