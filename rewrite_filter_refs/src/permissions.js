// Helpers for the filter share/edit permissions merge.
//
// Cloud's PUT /rest/api/3/filter/{id} replaces sharePermissions and
// editPermissions wholesale. We must pass the full merged list. This module
// resolves the target group once (`org-admins` by default, tenant-overridable)
// and provides idempotent additive merges.
//
// v2.1 additions for post-JCMA cleanup:
//   sanitizePermissionsForWrite — drops permission entries Cloud rejects on
//     PUT (types like `loggedin` (deprecated alias), `project-unknown`, plus
//     entries missing required sub-fields like a deleted user's accountId).
//     This addresses the "Invalid type given. Should be one of [USER, ...]"
//     error class with empty `errors:{}` (~1,200 of last run's failures).
//   parseDeniedGroupsFromError + dropDeniedGroupsFromPermissions — parses
//     "permission to share with Group: 'X'" from a 400 body and returns the
//     list with those groups removed, so the caller can retry the PUT.

// Cloud accepts these on PUT; "loggedin" and "project-unknown" appear in GET
// responses but are rejected on PUT. See:
// https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-filter-sharing/
const VALID_PERMISSION_TYPES = ["user", "group", "project", "projectRole", "global", "authenticated"];
const VALID_TYPES_LC = new Set(VALID_PERMISSION_TYPES.map((t) => t.toLowerCase()));
// Map deprecated/alias types to their canonical PUT-accepted form.
const TYPE_ALIASES_LC = { loggedin: "authenticated" };

async function resolveOrgAdminsGroup(client, { groupName = "org-admins" } = {}) {
  const group = await client.pickGroup(groupName);
  if (!group) {
    throw new Error(
      `Could not resolve group "${groupName}" on Cloud. Either the group does not exist or the calling user cannot see it. Pass --no-share-org-admins to skip, or --org-admins-group <name> to override.`,
    );
  }
  return { groupId: group.groupId, name: group.name };
}

function isGroupMatch(entry, groupRef) {
  if (!entry || entry.type !== "group") return false;
  const g = entry.group || {};
  if (groupRef.groupId && g.groupId === groupRef.groupId) return true;
  if (groupRef.name && g.name === groupRef.name) return true;
  return false;
}

function mergePermissions(existing, groupRef) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  if (!groupRef) return list;
  if (list.some((e) => isGroupMatch(e, groupRef))) return list;
  const entry = {
    type: "group",
    group: groupRef.groupId
      ? { groupId: groupRef.groupId }
      : { name: groupRef.name },
  };
  list.push(entry);
  return list;
}

const mergeSharePermissions = mergePermissions;
const mergeEditPermissions = mergePermissions;

// Strip server-assigned fields so the merged list round-trips cleanly through
// PUT /filter/{id}. Cloud accepts (and ignores) extra fields, but it is
// simpler to omit permissionIds on writes.
function stripForWrite(permissions) {
  if (!Array.isArray(permissions)) return [];
  return permissions.map((p) => {
    const out = { type: p.type };
    if (p.group) {
      out.group = p.group.groupId
        ? { groupId: p.group.groupId }
        : { name: p.group.name };
    }
    if (p.project) out.project = { id: p.project.id };
    if (p.role) out.role = { id: p.role.id };
    if (p.user) out.user = { accountId: p.user.accountId };
    return out;
  });
}

/**
 * Drops entries Cloud rejects on PUT (invalid type, missing required
 * sub-fields). Maps `loggedin` → `authenticated`. Returns the cleaned list
 * plus a list of dropped entries with reasons so the caller can log them.
 *
 * @param {Array} permissions
 * @returns {{ sanitized: Array, dropped: Array<{entry: any, reason: string}> }}
 */
function sanitizePermissionsForWrite(permissions) {
  if (!Array.isArray(permissions)) return { sanitized: [], dropped: [] };
  const sanitized = [];
  const dropped = [];
  for (const e of permissions) {
    if (!e || typeof e !== "object") {
      dropped.push({ entry: e, reason: "not_an_object" });
      continue;
    }
    const rawType = String(e.type || "").trim();
    const rawTypeLc = rawType.toLowerCase();
    const aliasedLc = TYPE_ALIASES_LC[rawTypeLc] || rawTypeLc;
    if (!VALID_TYPES_LC.has(aliasedLc)) {
      dropped.push({ entry: e, reason: `invalid_type:${rawType || "(empty)"}` });
      continue;
    }
    // Canonicalize case to the PUT-accepted spelling.
    const canonicalType = VALID_PERMISSION_TYPES.find(
      (t) => t.toLowerCase() === aliasedLc,
    );

    const out = { type: canonicalType };
    if (canonicalType === "user") {
      const accountId = e.user && e.user.accountId;
      if (!accountId) {
        dropped.push({ entry: e, reason: "user_missing_accountId" });
        continue;
      }
      out.user = { accountId };
    } else if (canonicalType === "group") {
      const g = e.group || {};
      if (!g.groupId && !g.name) {
        dropped.push({ entry: e, reason: "group_missing_id_and_name" });
        continue;
      }
      // Keep both groupId AND name so the denied-group retry path can match
      // by name (Cloud's error body identifies offenders by name only).
      // stripForWrite picks just one for the PUT body.
      out.group = {};
      if (g.groupId) out.group.groupId = g.groupId;
      if (g.name) out.group.name = g.name;
    } else if (canonicalType === "project") {
      const projId = e.project && e.project.id;
      if (!projId) {
        dropped.push({ entry: e, reason: "project_missing_id" });
        continue;
      }
      out.project = { id: projId };
      // role is optional for project shares — pass through if present and valid
      if (e.role && e.role.id) out.role = { id: e.role.id };
    } else if (canonicalType === "projectRole") {
      const projId = e.project && e.project.id;
      const roleId = e.role && e.role.id;
      if (!projId || !roleId) {
        dropped.push({ entry: e, reason: "projectRole_missing_project_or_role_id" });
        continue;
      }
      out.project = { id: projId };
      out.role = { id: roleId };
    }
    // global / authenticated need no sub-fields
    sanitized.push(out);
  }
  return { sanitized, dropped };
}

/**
 * Extracts group names from a Cloud filter PUT 400 body, looking for the
 * pattern "permission to share with Group: 'X'" that Cloud uses for
 * shares_delegated, shares, and edit_permissions error subfields.
 *
 * @param {string|object} errorBody
 * @returns {string[]} unique group names in original case
 */
function parseDeniedGroupsFromError(errorBody) {
  if (errorBody == null) return [];
  const text = typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody);
  const out = new Set();
  const re = /permission to share with Group:\s*['"]([^'"]+)['"]/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return Array.from(out);
}

/**
 * Extracts user identifiers from "permission to share with User: 'X'".
 * @param {string|object} errorBody
 * @returns {string[]}
 */
function parseDeniedUsersFromError(errorBody) {
  if (errorBody == null) return [];
  const text = typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody);
  const out = new Set();
  const re = /permission to share with User:\s*['"]([^'"]+)['"]/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return Array.from(out);
}

/**
 * Returns a copy of `permissions` with any group entry whose name (or
 * groupId, if used) appears in `deniedGroupNames` removed. Match is
 * case-insensitive on name; groupId is compared exactly.
 *
 * @param {Array} permissions
 * @param {string[]} deniedGroupNames
 * @returns {{ kept: Array, removed: Array }}
 */
function dropDeniedGroupsFromPermissions(permissions, deniedGroupNames) {
  if (!Array.isArray(permissions) || !deniedGroupNames || deniedGroupNames.length === 0) {
    return { kept: Array.isArray(permissions) ? permissions.slice() : [], removed: [] };
  }
  const denied = new Set(deniedGroupNames.map((n) => String(n).toLowerCase()));
  const kept = [];
  const removed = [];
  for (const e of permissions) {
    const name =
      e && e.type === "group" && e.group ? String(e.group.name || "").toLowerCase() : "";
    if (name && denied.has(name)) {
      removed.push(e);
    } else {
      kept.push(e);
    }
  }
  return { kept, removed };
}

module.exports = {
  resolveOrgAdminsGroup,
  mergePermissions,
  mergeSharePermissions,
  mergeEditPermissions,
  stripForWrite,
  isGroupMatch,
  sanitizePermissionsForWrite,
  parseDeniedGroupsFromError,
  parseDeniedUsersFromError,
  dropDeniedGroupsFromPermissions,
  VALID_PERMISSION_TYPES,
};
