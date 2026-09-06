const { test } = require("node:test");
const assert = require("node:assert/strict");
const PermissionsOnlyProcessor = require("./permissionsOnlyProcessor");

function makeClient(overrides = {}) {
  const calls = {
    searchAllFilters: [],
    getFilter: [],
    setFilterOwner: [],
    updateFilter: [],
    addFilterSharePermission: [],
  };
  return {
    calls,
    searchAllFilters: async (opts) => {
      calls.searchAllFilters.push(opts);
      return overrides.filters || [];
    },
    getFilter: async (id) => {
      calls.getFilter.push(id);
      return overrides.getFilterImpl ? overrides.getFilterImpl(id) : null;
    },
    setFilterOwner: async (id, accountId) => {
      calls.setFilterOwner.push({ id, accountId });
      if (overrides.setFilterOwnerImpl) return overrides.setFilterOwnerImpl(id, accountId);
      return null;
    },
    updateFilter: async (id, body) => {
      calls.updateFilter.push({ id, body });
      if (overrides.updateFilterImpl) return overrides.updateFilterImpl(id, body);
      return {};
    },
    addFilterSharePermission: async (id, body) => {
      calls.addFilterSharePermission.push({ id, body });
      if (overrides.addFilterSharePermissionImpl) {
        return overrides.addFilterSharePermissionImpl(id, body);
      }
      return {};
    },
    getStats: () => ({ requestCount: 0, errorCount: 0, rateLimitCount: 0 }),
  };
}

function makePm(initial = {}) {
  const plan = { filters: { ...initial } };
  return {
    plan,
    masterIndex: { stats: {} },
    createMasterIndex() {},
    createPlan(runId, filtersMap) {
      plan.filters = filtersMap;
      return { planFile: "/tmp/test_plan.json" };
    },
    saveMasterIndex() {},
    savePlan() {},
    loadMasterIndex() { return this.masterIndex; },
    async loadPlan() { return plan; },
    getFiltersToProcess() {
      return Object.entries(plan.filters).filter(([, e]) => e.status === "pending");
    },
    updateFilterEntry(id, partial) { Object.assign(plan.filters[id], partial); },
    updateFilterStatus(id, status, error = null) {
      plan.filters[id].status = status;
      plan.filters[id].error = error;
    },
  };
}

const ORG_GROUP = { groupId: "g-org-admins", name: "org-admins" };

// ─── BUILD PHASE ───────────────────────────────────────────────

test("buildPlan classifies each filter by what it needs", async () => {
  const filters = [
    // already has both → no_change
    { id: "1", name: "A", jql: "project=X",
      owner: { accountId: "u1", displayName: "User1" },
      sharePermissions: [{ type: "group", group: { groupId: "g-org-admins", name: "org-admins" } }],
      editPermissions:  [{ type: "group", group: { groupId: "g-org-admins", name: "org-admins" } }],
    },
    // needs both
    { id: "2", name: "B", jql: "project=Y",
      owner: { accountId: "u1", displayName: "User1" },
      sharePermissions: [], editPermissions: [] },
    // needs share only
    { id: "3", name: "C", jql: "",
      owner: null,
      sharePermissions: [],
      editPermissions: [{ type: "group", group: { groupId: "g-org-admins", name: "org-admins" } }] },
    // needs edit only
    { id: "4", name: "D", jql: "",
      owner: null,
      sharePermissions: [{ type: "group", group: { groupId: "g-org-admins", name: "org-admins" } }],
      editPermissions: [] },
  ];
  const client = makeClient({ filters });
  const pm = makePm();
  const p = new PermissionsOnlyProcessor({
    cloudClient: client,
    planManager: pm,
    options: { orgAdminsGroup: ORG_GROUP },
    log: () => {},
  });

  await p.buildPlan("rid-1");

  assert.equal(pm.plan.filters["1"].status, "no_change");
  assert.equal(pm.plan.filters["2"].status, "pending");
  assert.equal(pm.plan.filters["3"].status, "pending");
  assert.equal(pm.plan.filters["4"].status, "pending");
  assert.equal(p.getStats().alreadyHasBoth, 1);
  assert.equal(p.getStats().needsBoth, 1);
  assert.equal(p.getStats().needsShare, 1);
  assert.equal(p.getStats().needsEdit, 1);
});

test("buildPlan detects org-admins entry by groupId OR name", async () => {
  const filters = [
    // matched by groupId only
    { id: "1", name: "A", jql: "",
      sharePermissions: [{ type: "group", group: { groupId: "g-org-admins" } }],
      editPermissions:  [{ type: "group", group: { groupId: "g-org-admins" } }] },
    // matched by name only
    { id: "2", name: "B", jql: "",
      sharePermissions: [{ type: "group", group: { name: "org-admins" } }],
      editPermissions:  [{ type: "group", group: { name: "org-admins" } }] },
  ];
  const pm = makePm();
  const p = new PermissionsOnlyProcessor({
    cloudClient: makeClient({ filters }),
    planManager: pm,
    options: { orgAdminsGroup: ORG_GROUP },
    log: () => {},
  });
  await p.buildPlan("rid-2");
  assert.equal(pm.plan.filters["1"].status, "no_change");
  assert.equal(pm.plan.filters["2"].status, "no_change");
});

test("buildPlan rejects with helpful error when orgAdminsGroup is not configured", async () => {
  const p = new PermissionsOnlyProcessor({
    cloudClient: makeClient(),
    planManager: makePm(),
    options: {},
    log: () => {},
  });
  await assert.rejects(p.buildPlan("rid-3"), /orgAdminsGroup/);
});

// ─── EXECUTE PHASE ──────────────────────────────────────────────

function makeProcessor(pendingEntries, clientOverrides = {}) {
  const pm = makePm(pendingEntries);
  const client = makeClient(clientOverrides);
  const p = new PermissionsOnlyProcessor({
    cloudClient: client,
    planManager: pm,
    options: {
      orgAdminsGroup: ORG_GROUP,
      currentAccountId: "migration-user",
    },
    log: () => {},
  });
  return { client, pm, p };
}

test("execute: missing-both → owner-swap, PUT(edit), POST(share), restore", async () => {
  const { client, pm, p } = makeProcessor({
    "100": {
      status: "pending",
      name: "Filter 100",
      originalOwner: { accountId: "owner-A" },
      originalSharePermissions: [],
      originalEditPermissions: [],
      hasShareOrgAdmins: false,
      hasEditOrgAdmins: false,
      ownerSwapped: false,
      ownerRestored: false,
      editPut: false,
      sharePosted: false,
      executionPhase: "idle",
      originalJql: "project = X",
      expectedLiveJql: "project = X",
    },
  });

  await p.executePlan();

  assert.equal(client.calls.setFilterOwner.length, 2, "swap + restore");
  assert.equal(client.calls.setFilterOwner[0].accountId, "migration-user");
  assert.equal(client.calls.setFilterOwner[1].accountId, "owner-A");
  assert.equal(client.calls.updateFilter.length, 1, "one PUT for edit");
  assert.equal(client.calls.updateFilter[0].body.editPermissions[0].group.groupId, "g-org-admins");
  assert.equal(client.calls.addFilterSharePermission.length, 1, "one POST for share");
  assert.equal(pm.plan.filters["100"].status, "completed");
});

test("execute: missing-share-only → no PUT, only POST", async () => {
  const { client, pm, p } = makeProcessor({
    "200": {
      status: "pending",
      name: "Filter 200",
      originalOwner: { accountId: "owner-B" },
      originalSharePermissions: [],
      originalEditPermissions: [
        { type: "group", group: { groupId: "g-org-admins", name: "org-admins" } },
      ],
      hasShareOrgAdmins: false,
      hasEditOrgAdmins: true,
      ownerSwapped: false,
      ownerRestored: false,
      editPut: false,
      sharePosted: false,
      executionPhase: "idle",
      originalJql: "",
    },
  });
  await p.executePlan();
  assert.equal(client.calls.updateFilter.length, 0, "PUT must not fire — edit is already correct");
  assert.equal(client.calls.addFilterSharePermission.length, 1, "POST fires for share");
  assert.equal(pm.plan.filters["200"].status, "completed");
});

test("execute: missing-edit-only → only PUT, no POST", async () => {
  const { client, pm, p } = makeProcessor({
    "300": {
      status: "pending",
      name: "Filter 300",
      originalOwner: { accountId: "migration-user" }, // no swap needed
      originalSharePermissions: [
        { type: "group", group: { groupId: "g-org-admins", name: "org-admins" } },
      ],
      originalEditPermissions: [],
      hasShareOrgAdmins: true,
      hasEditOrgAdmins: false,
      ownerSwapped: false,
      ownerRestored: false,
      editPut: false,
      sharePosted: false,
      executionPhase: "idle",
    },
  });
  await p.executePlan();
  assert.equal(client.calls.setFilterOwner.length, 0, "no swap — current user already owns");
  assert.equal(client.calls.updateFilter.length, 1);
  assert.equal(client.calls.addFilterSharePermission.length, 0, "POST must not fire — share is already correct");
  assert.equal(pm.plan.filters["300"].status, "completed");
});

test("execute: PUT failure → POST not attempted, owner-restore still runs", async () => {
  const { client, pm, p } = makeProcessor({
    "400": {
      status: "pending",
      name: "Filter 400",
      originalOwner: { accountId: "owner-D" },
      originalSharePermissions: [],
      originalEditPermissions: [],
      hasShareOrgAdmins: false,
      hasEditOrgAdmins: false,
      ownerSwapped: false,
      ownerRestored: false,
      editPut: false,
      sharePosted: false,
      executionPhase: "idle",
    },
  }, {
    updateFilterImpl: async () => { const e = new Error("nope"); e.statusCode = 400; throw e; },
  });
  await p.executePlan();
  assert.equal(client.calls.updateFilter.length, 1);
  assert.equal(client.calls.addFilterSharePermission.length, 0, "POST must not fire after PUT failure");
  assert.equal(client.calls.setFilterOwner.length, 2, "swap + restore still run");
  assert.equal(pm.plan.filters["400"].status, "failed");
});

test("execute: POST failure → run marked failed but owner restored", async () => {
  const { client, pm, p } = makeProcessor({
    "500": {
      status: "pending",
      name: "Filter 500",
      originalOwner: { accountId: "owner-E" },
      originalSharePermissions: [],
      originalEditPermissions: [],
      hasShareOrgAdmins: false,
      hasEditOrgAdmins: false,
      ownerSwapped: false,
      ownerRestored: false,
      editPut: false,
      sharePosted: false,
      executionPhase: "idle",
    },
  }, {
    addFilterSharePermissionImpl: async () => { const e = new Error("forbidden"); e.statusCode = 403; throw e; },
  });
  await p.executePlan();
  assert.equal(client.calls.updateFilter.length, 1);
  assert.equal(client.calls.addFilterSharePermission.length, 1);
  assert.equal(client.calls.setFilterOwner.length, 2, "restore still ran");
  assert.equal(pm.plan.filters["500"].status, "failed");
  assert.match(String(pm.plan.filters["500"].error || ""), /share_post_failed/);
});

test("execute: no-change entries are not in toProcess (skipped)", async () => {
  const { client, p } = makeProcessor({
    "600": {
      status: "no_change",
      name: "Filter 600",
      originalOwner: { accountId: "owner-F" },
      hasShareOrgAdmins: true,
      hasEditOrgAdmins: true,
    },
  });
  await p.executePlan();
  assert.equal(client.calls.setFilterOwner.length, 0);
  assert.equal(client.calls.updateFilter.length, 0);
  assert.equal(client.calls.addFilterSharePermission.length, 0);
});

test("execute: dry-run does not call any mutating endpoint", async () => {
  const pm = makePm({
    "700": {
      status: "pending",
      name: "GRP1",
      originalOwner: { accountId: "u" },
      originalSharePermissions: [],
      originalEditPermissions: [],
      hasShareOrgAdmins: false,
      hasEditOrgAdmins: false,
    },
  });
  const client = makeClient();
  const p = new PermissionsOnlyProcessor({
    cloudClient: client,
    planManager: pm,
    options: {
      orgAdminsGroup: ORG_GROUP,
      currentAccountId: "migration-user",
      dryRun: true,
    },
    log: () => {},
  });
  await p.executePlan();
  assert.equal(client.calls.setFilterOwner.length, 0);
  assert.equal(client.calls.updateFilter.length, 0);
  assert.equal(client.calls.addFilterSharePermission.length, 0);
});
