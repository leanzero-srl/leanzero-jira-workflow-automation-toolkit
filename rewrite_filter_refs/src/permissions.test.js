const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  mergePermissions,
  isGroupMatch,
  stripForWrite,
  sanitizePermissionsForWrite,
  parseDeniedGroupsFromError,
  dropDeniedGroupsFromPermissions,
} = require("./permissions");

const orgAdmins = { groupId: "g-001", name: "org-admins" };

test("merge adds org-admins to empty list", () => {
  const m = mergePermissions([], orgAdmins);
  assert.equal(m.length, 1);
  assert.equal(m[0].type, "group");
  assert.equal(m[0].group.groupId, "g-001");
});

test("merge preserves existing entries byte-for-byte", () => {
  const existing = [
    { type: "project", project: { id: "10000" } },
    { type: "group", group: { groupId: "g-dev", name: "jira-developers" } },
  ];
  const m = mergePermissions(existing, orgAdmins);
  assert.equal(m.length, 3);
  assert.deepEqual(m[0], existing[0]);
  assert.deepEqual(m[1], existing[1]);
});

test("merge is idempotent — re-running adds no duplicate", () => {
  const existing = [
    { type: "group", group: { groupId: "g-001", name: "org-admins" } },
  ];
  const m = mergePermissions(existing, orgAdmins);
  assert.equal(m.length, 1);
});

test("merge matches by name if groupId absent on existing entry", () => {
  const existing = [
    { type: "group", group: { name: "org-admins" } },
  ];
  const m = mergePermissions(existing, orgAdmins);
  assert.equal(m.length, 1);
});

test("isGroupMatch — groupId wins over name", () => {
  const entry = {
    type: "group",
    group: { groupId: "g-001", name: "different-display" },
  };
  assert.ok(isGroupMatch(entry, { groupId: "g-001", name: "other" }));
});

test("stripForWrite preserves required fields only", () => {
  const existing = [
    {
      id: 10000,
      type: "group",
      group: {
        groupId: "g-dev",
        name: "jira-developers",
        self: "https://host/...",
      },
    },
    {
      id: 10001,
      type: "project",
      project: { id: "10000", name: "Test", key: "TST" },
      role: { id: "10010", name: "Developer" },
    },
  ];
  const out = stripForWrite(existing);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, "group");
  assert.equal(out[0].group.groupId, "g-dev");
  assert.equal(out[0].group.self, undefined);
  assert.equal(out[1].type, "project");
  assert.equal(out[1].project.id, "10000");
  assert.equal(out[1].project.name, undefined);
  assert.equal(out[1].role.id, "10010");
});

test("merge null groupRef no-ops", () => {
  const existing = [{ type: "global" }];
  const m = mergePermissions(existing, null);
  assert.deepEqual(m, existing);
});

test("merge with groupRef that lacks groupId uses name-only form", () => {
  const m = mergePermissions([], { name: "org-admins" });
  assert.equal(m.length, 1);
  assert.equal(m[0].group.name, "org-admins");
  assert.equal(m[0].group.groupId, undefined);
});

// ─── sanitizePermissionsForWrite ────────────────────────────────

test("sanitize drops 'loggedin' alias-mapped to 'authenticated'", () => {
  const r = sanitizePermissionsForWrite([{ type: "loggedin" }]);
  assert.equal(r.sanitized.length, 1);
  assert.equal(r.sanitized[0].type, "authenticated");
  assert.equal(r.dropped.length, 0);
});

test("sanitize drops 'project-unknown' (unknown type)", () => {
  const r = sanitizePermissionsForWrite([
    { type: "project-unknown" },
    { type: "group", group: { groupId: "g1" } },
  ]);
  assert.equal(r.sanitized.length, 1);
  assert.equal(r.sanitized[0].type, "group");
  assert.equal(r.dropped.length, 1);
  assert.match(r.dropped[0].reason, /invalid_type/);
});

test("sanitize drops user entry missing accountId", () => {
  const r = sanitizePermissionsForWrite([
    { type: "user", user: {} },
    { type: "user", user: { accountId: "abc" } },
  ]);
  assert.equal(r.sanitized.length, 1);
  assert.deepEqual(r.sanitized[0], { type: "user", user: { accountId: "abc" } });
  assert.equal(r.dropped[0].reason, "user_missing_accountId");
});

test("sanitize drops group entry with neither groupId nor name", () => {
  const r = sanitizePermissionsForWrite([
    { type: "group", group: {} },
    { type: "group", group: { name: "ok" } },
  ]);
  assert.equal(r.sanitized.length, 1);
  assert.equal(r.dropped.length, 1);
});

test("sanitize preserves project share with role", () => {
  const r = sanitizePermissionsForWrite([
    {
      type: "project",
      project: { id: "10000", name: "Foo", key: "FOO" },
      role: { id: "10010", name: "Devs" },
    },
  ]);
  assert.equal(r.sanitized.length, 1);
  assert.deepEqual(r.sanitized[0], {
    type: "project",
    project: { id: "10000" },
    role: { id: "10010" },
  });
});

test("sanitize preserves global / authenticated entries", () => {
  const r = sanitizePermissionsForWrite([
    { type: "global" },
    { type: "authenticated" },
  ]);
  assert.equal(r.sanitized.length, 2);
});

test("sanitize tolerates non-array / null input", () => {
  const r = sanitizePermissionsForWrite(null);
  assert.deepEqual(r.sanitized, []);
  assert.deepEqual(r.dropped, []);
});

test("sanitize matches type case-insensitively (canonicalizes case)", () => {
  const r = sanitizePermissionsForWrite([
    { type: "GROUP", group: { groupId: "g1" } },
    { type: "User", user: { accountId: "u1" } },
  ]);
  assert.equal(r.sanitized.length, 2);
  assert.equal(r.sanitized[0].type, "group");
  assert.equal(r.sanitized[1].type, "user");
});

// ─── parseDeniedGroupsFromError ────────────────────────────────

test("parseDeniedGroups extracts group names from share-denial error body", () => {
  const body = JSON.stringify({
    errorMessages: ["Invalid type given..."],
    errors: {
      shares_delegated:
        "The user 'X' does not have permission to share with Group: 'Manage Sprints'.",
      edit_permissions:
        "You do not have permission to share with Group: 'Manage Sprints'.",
    },
  });
  const groups = parseDeniedGroupsFromError(body);
  assert.deepEqual(groups, ["Manage Sprints"]);
});

test("parseDeniedGroups deduplicates and handles multiple groups", () => {
  const body =
    "permission to share with Group: 'jira-users'. permission to share with Group: 'Acme Support'. permission to share with Group: 'jira-users' again.";
  const groups = parseDeniedGroupsFromError(body);
  assert.deepEqual(groups.sort(), ["Acme Support", "jira-users"].sort());
});

test("parseDeniedGroups returns [] for body with no group errors", () => {
  assert.deepEqual(parseDeniedGroupsFromError(""), []);
  assert.deepEqual(parseDeniedGroupsFromError(null), []);
  assert.deepEqual(parseDeniedGroupsFromError("{}"), []);
});

// ─── dropDeniedGroupsFromPermissions ────────────────────────────

test("dropDeniedGroups removes only matching group entries (case-insensitive name match)", () => {
  const list = [
    { type: "group", group: { name: "jira-users" } },
    { type: "group", group: { groupId: "g1", name: "Manage Sprints" } },
    { type: "user", user: { accountId: "u1" } },
    { type: "global" },
  ];
  const r = dropDeniedGroupsFromPermissions(list, ["JIRA-USERS"]);
  assert.equal(r.kept.length, 3);
  assert.equal(r.removed.length, 1);
  assert.equal(r.removed[0].group.name, "jira-users");
});

test("dropDeniedGroups returns input unchanged when denied list empty", () => {
  const list = [{ type: "group", group: { name: "x" } }];
  const r = dropDeniedGroupsFromPermissions(list, []);
  assert.deepEqual(r.kept, list);
  assert.deepEqual(r.removed, []);
});
