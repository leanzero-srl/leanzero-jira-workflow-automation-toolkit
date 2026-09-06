#!/usr/bin/env node
/**
 * Add the RUNNING account to every group that existing Cloud filters are shared
 * with, so the org-admins share-add during `rewrite_filter_refs.js` isn't rejected.
 *
 * WHY: Cloud validates a filter's WHOLE share set whenever you change its
 * permissions. If a filter is also shared with a group the caller cannot share
 * with (e.g. `Reporting Group`, `jira-servicedesk-users`), the org-admins POST is
 * rejected ("You do not have permission to share with Group: 'X'"). Being a
 * member of those groups removes the restriction. Run this once before the apply.
 *
 * NOTE: this is a self-grant of group membership — review the DRY list first.
 * It does NOT touch `loggedin`/`authenticated` shares (those aren't groups).
 *
 * Env:
 *   CLOUD_BASE_URL, CLOUD_API_TOKEN   (token = base64 of email:api_token)
 *   ONLY      optional CSV of group names to limit to
 *   DRY=1     list the groups + would-add, do not modify membership
 */
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const CloudJiraClient = require("../src/cloudJiraClient");

const E = process.env;

(async () => {
  for (const k of ["CLOUD_BASE_URL", "CLOUD_API_TOKEN"])
    if (!E[k]) throw new Error(`Missing env ${k}`);
  const client = new CloudJiraClient(E.CLOUD_BASE_URL, E.CLOUD_API_TOKEN, console.log);
  const me = await client.getCurrentUser();
  console.log(`Running account: ${me.emailAddress || me.displayName} (${me.accountId})`);

  // Collect distinct groups across all filters' share permissions.
  const filters = await client.searchAllFilters({
    expand: "sharePermissions",
    limit: 0,
  });
  const groups = new Map(); // groupId|name -> {groupId, name}
  for (const f of filters) {
    for (const p of f.sharePermissions || []) {
      if (p && p.type === "group" && p.group) {
        const key = p.group.groupId || p.group.name;
        if (key) groups.set(key, { groupId: p.group.groupId || null, name: p.group.name || null });
      }
    }
  }
  let list = [...groups.values()];
  if (E.ONLY) {
    const want = new Set(E.ONLY.split(",").map((s) => s.trim().toLowerCase()));
    list = list.filter((g) => g.name && want.has(g.name.toLowerCase()));
  }
  console.log(`\nGroups used in filter shares: ${list.length}${E.DRY === "1" ? " [DRY]" : ""}`);

  const res = { added: [], already: [], failed: [] };
  for (const g of list) {
    let gid = g.groupId;
    if (!gid && g.name) {
      const picked = await client.pickGroup(g.name);
      gid = picked && picked.groupId;
    }
    if (!gid) {
      res.failed.push(`${g.name || "?"}: could not resolve groupId`);
      continue;
    }
    if (E.DRY === "1") {
      res.added.push(`${g.name || gid} (would add)`);
      continue;
    }
    try {
      await client.addUserToGroup(gid, me.accountId);
      res.added.push(g.name || gid);
    } catch (e) {
      const msg = String(e.responseBody || e.message || "");
      if (/already a member|400/i.test(msg)) res.already.push(g.name || gid);
      else res.failed.push(`${g.name || gid}: ${msg.slice(0, 120)}`);
    }
  }

  console.log(`\nDONE: added=${res.added.length} already=${res.already.length} failed=${res.failed.length}`);
  if (res.added.length) console.log(`  added:   ${res.added.join(", ")}`);
  if (res.already.length) console.log(`  already: ${res.already.join(", ")}`);
  if (res.failed.length) { console.log("  failed:"); res.failed.forEach((f) => console.log(`    - ${f}`)); }
})().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
