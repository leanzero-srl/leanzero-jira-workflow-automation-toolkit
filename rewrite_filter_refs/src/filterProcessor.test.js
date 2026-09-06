const { test } = require("node:test");
const assert = require("node:assert/strict");
const FilterProcessor = require("./filterProcessor");

// ─────────────────────────────────────────────────────────────
//  Minimal mocks — plain objects with captured calls.
// ─────────────────────────────────────────────────────────────

function makeCloudClient(overrides = {}) {
  const calls = {
    updateFilter: [],
    setFilterOwner: [],
    getFilter: [],
    addFilterSharePermission: [],
  };
  const fail = (status, msg = "mock failure") => {
    const err = new Error(msg);
    err.statusCode = status;
    return err;
  };
  return {
    calls,
    fail,
    getFilter: async (id) => {
      calls.getFilter.push(id);
      if (overrides.getFilterImpl) return overrides.getFilterImpl(id);
      return {
        id,
        name: "mock",
        jql: "project = FOO",
        owner: { accountId: "owner-A", displayName: "Owner A" },
        sharePermissions: [],
        editPermissions: [],
      };
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
  };
}

function makePlanManager(initialEntry) {
  const plan = { filters: { "10000": { ...initialEntry } } };
  const calls = { updateFilterEntry: [], updateFilterStatus: [] };
  return {
    plan,
    calls,
    updateFilterEntry(id, partial) {
      calls.updateFilterEntry.push({ id, partial });
      Object.assign(plan.filters[id], partial);
    },
    updateFilterStatus(id, status, error = null) {
      calls.updateFilterStatus.push({ id, status, error });
      plan.filters[id].status = status;
      plan.filters[id].error = error;
    },
    savePlan() { /* noop */ },
    saveMasterIndex() { /* noop */ },
  };
}

function baseEntry(overrides = {}) {
  return {
    status: "pending",
    name: "mock-filter",
    originalOwner: { accountId: "owner-A", displayName: "Owner A" },
    originalSharePermissions: [],
    originalEditPermissions: [],
    ownerSwapped: false,
    ownerRestored: false,
    jqlUpdated: false,
    permissionsAdded: false,
    executionPhase: "idle",
    lastStepError: null,
    originalJql: "project = FOO",
    rewrittenJql: "project = FOO AND status = Open",
    description: "",
    refs: [],
    sanitizerChanges: [],
    aqlReplacements: [],
    aqlUnresolved: [],
    error: null,
    updatedAt: null,
    ...overrides,
  };
}

function makeProcessor(mockClient, mockPm, options = {}) {
  return new FilterProcessor({
    cloudClient: mockClient,
    dcClient: null,
    mapper: null,
    planManager: mockPm,
    reportWriter: null,
    options: {
      currentAccountId: "migration-user",
      ownerSwap: true,
      shareOrgAdmins: true,
      orgAdminsGroup: { groupId: "g-org-admins", name: "org-admins" },
      ...options,
    },
    log: () => {},
  });
}

// ─────────────────────────────────────────────────────────────
//  Permissions payload construction
// ─────────────────────────────────────────────────────────────

test("shareOrgAdmins=false → PUT body omits sharePermissions/editPermissions entirely", async () => {
  // Simulates the bug we just fixed: if original was [] and we weren't
  // merging, we were sending [] which WIPES all shares.
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry({
    originalSharePermissions: [{ type: "project", project: { id: "1" } }],
    originalEditPermissions: [{ type: "group", group: { name: "jira-devs" } }],
  }));
  const proc = makeProcessor(client, pm, {
    shareOrgAdmins: false,
    orgAdminsGroup: null,
  });

  await proc._executeOne("10000", pm.plan.filters["10000"]);

  assert.equal(client.calls.updateFilter.length, 1);
  const body = client.calls.updateFilter[0].body;
  assert.equal(
    body.sharePermissions,
    undefined,
    "sharePermissions must be omitted (otherwise Cloud replaces with [])",
  );
  assert.equal(
    body.editPermissions,
    undefined,
    "editPermissions must be omitted",
  );
});

test("shareOrgAdmins=true + empty originals → PUT body has only edit + share via POST", async () => {
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" }, // no swap
  }));
  const proc = makeProcessor(client, pm);

  await proc._executeOne("10000", pm.plan.filters["10000"]);

  const body = client.calls.updateFilter[0].body;
  // sharePermissions are deliberately omitted from the PUT body — PUT
  // silently fails to persist them AND validates them, causing 400s for
  // pre-existing shares the caller can't re-grant. Shares go via POST.
  assert.equal(body.sharePermissions, undefined);
  // editPermissions ARE persisted by PUT, so org-admins is merged here.
  assert.deepEqual(body.editPermissions, [
    { type: "group", group: { groupId: "g-org-admins" } },
  ]);
  // org-admins share added via POST after the PUT.
  assert.equal(client.calls.addFilterSharePermission.length, 1);
  assert.equal(client.calls.addFilterSharePermission[0].body.groupId, "g-org-admins");
});

test("shareOrgAdmins=true + existing entries → PUT edit merged, share POST added", async () => {
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalSharePermissions: [
      { id: 99, type: "project", project: { id: "1", name: "X", key: "X" } },
    ],
    originalEditPermissions: [
      { id: 100, type: "group", group: { groupId: "g-dev", name: "jira-devs" } },
    ],
  }));
  const proc = makeProcessor(client, pm);

  await proc._executeOne("10000", pm.plan.filters["10000"]);

  const body = client.calls.updateFilter[0].body;
  // No sharePermissions in PUT body (validated would fail or silently no-op)
  assert.equal(body.sharePermissions, undefined);
  // Edit list IS merged into PUT body (PUT persists editPermissions correctly)
  assert.equal(body.editPermissions.length, 2);
  assert.equal(body.editPermissions[0].group.groupId, "g-dev");
  assert.equal(body.editPermissions[1].group.groupId, "g-org-admins");
  // Share entry added via separate POST
  assert.equal(client.calls.addFilterSharePermission.length, 1);
});

test("idempotent — org-admins already in share → no POST issued, edit still merged", async () => {
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalSharePermissions: [
      { type: "group", group: { groupId: "g-org-admins", name: "org-admins" } },
    ],
    originalEditPermissions: [
      { type: "group", group: { groupId: "g-org-admins", name: "org-admins" } },
    ],
  }));
  const proc = makeProcessor(client, pm);
  await proc._executeOne("10000", pm.plan.filters["10000"]);

  const body = client.calls.updateFilter[0].body;
  // No share in PUT body (always omitted now)
  assert.equal(body.sharePermissions, undefined);
  // Edit list contains org-admins exactly once (idempotent merge)
  assert.equal(body.editPermissions.length, 1);
  // No POST issued — org-admins already in the original share list
  assert.equal(client.calls.addFilterSharePermission.length, 0);
});

// ─────────────────────────────────────────────────────────────
//  Step-3 idempotency on resume
// ─────────────────────────────────────────────────────────────

test("resume with jqlUpdated=true → no PUT is issued, restore still runs", async () => {
  // Prior partial run succeeded at step 3 but step 4 (restore) failed.
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry({
    jqlUpdated: true,
    ownerSwapped: true,
    ownerRestored: false,
    executionPhase: "owner_restoring",
    status: "failed",
  }));
  const proc = makeProcessor(client, pm);

  await proc._executeOne("10000", pm.plan.filters["10000"]);

  assert.equal(
    client.calls.updateFilter.length,
    0,
    "updateFilter should NOT be called a second time",
  );
  assert.equal(
    client.calls.setFilterOwner.length,
    1,
    "restore PUT to original owner should fire",
  );
  assert.equal(client.calls.setFilterOwner[0].accountId, "owner-A");
  assert.equal(pm.plan.filters["10000"].ownerRestored, true);
  assert.equal(pm.plan.filters["10000"].executionPhase, "done");
});

// ─────────────────────────────────────────────────────────────
//  Owner-swap flow
// ─────────────────────────────────────────────────────────────

test("happy path — swap → update → restore", async () => {
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry());
  const proc = makeProcessor(client, pm);

  const result = await proc._executeOne("10000", pm.plan.filters["10000"]);

  assert.equal(result.success, true);
  assert.equal(client.calls.setFilterOwner.length, 2, "2 owner PUTs: swap + restore");
  assert.equal(client.calls.setFilterOwner[0].accountId, "migration-user");
  assert.equal(client.calls.setFilterOwner[1].accountId, "owner-A");
  assert.equal(client.calls.updateFilter.length, 1);
  const entry = pm.plan.filters["10000"];
  assert.equal(entry.ownerSwapped, true);
  assert.equal(entry.ownerRestored, true);
  assert.equal(entry.jqlUpdated, true);
  assert.equal(entry.executionPhase, "done");
});

test("already-owner — no swap, no restore", async () => {
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
  }));
  const proc = makeProcessor(client, pm);

  await proc._executeOne("10000", pm.plan.filters["10000"]);

  assert.equal(client.calls.setFilterOwner.length, 0);
  assert.equal(client.calls.updateFilter.length, 1);
  assert.equal(pm.plan.filters["10000"].ownerSwapped, false);
});

test("update fails → owner restore still fires → overall failed", async () => {
  const client = makeCloudClient({
    updateFilterImpl: async () => {
      const e = new Error("bad jql");
      e.statusCode = 400;
      throw e;
    },
  });
  const pm = makePlanManager(baseEntry());
  const proc = makeProcessor(client, pm);

  const result = await proc._executeOne("10000", pm.plan.filters["10000"]);

  assert.equal(result.success, false);
  assert.match(result.error, /bad_request/);
  assert.equal(client.calls.setFilterOwner.length, 2, "swap + restore both fire");
  const entry = pm.plan.filters["10000"];
  assert.equal(entry.ownerSwapped, true);
  assert.equal(entry.ownerRestored, true, "restore succeeded even though update failed");
  assert.equal(entry.jqlUpdated, false);
  // executionPhase after step-5 branch on failed update should be "failed"
  assert.equal(entry.executionPhase, "failed");
});

test("update fails AND restore fails → orphaned owner swap recorded", async () => {
  let callIdx = 0;
  const client = makeCloudClient({
    updateFilterImpl: async () => {
      const e = new Error("bad jql");
      e.statusCode = 400;
      throw e;
    },
    setFilterOwnerImpl: async () => {
      // Swap succeeds (call 0), restore fails (call 1).
      if (callIdx++ === 0) return null;
      const e = new Error("API down");
      e.statusCode = 500;
      throw e;
    },
  });
  const pm = makePlanManager(baseEntry());
  const proc = makeProcessor(client, pm);

  await proc._executeOne("10000", pm.plan.filters["10000"]);

  const entry = pm.plan.filters["10000"];
  assert.equal(entry.ownerSwapped, true);
  assert.equal(entry.ownerRestored, false, "restore failure leaves us orphaned");
  assert.equal(proc.stats.ownerRestoreFailures, 1);
  assert.equal(entry.executionPhase, "failed");
});

test("owner swap itself fails → no update attempted, no restore needed", async () => {
  const client = makeCloudClient({
    setFilterOwnerImpl: async () => {
      const e = new Error("cannot change owner");
      e.statusCode = 403;
      throw e;
    },
  });
  const pm = makePlanManager(baseEntry());
  const proc = makeProcessor(client, pm);

  const result = await proc._executeOne("10000", pm.plan.filters["10000"]);

  assert.equal(result.success, false);
  assert.match(result.error, /owner_swap_failed/);
  assert.equal(client.calls.updateFilter.length, 0, "no update if we couldn't take ownership");
  assert.equal(proc.stats.ownerSwapFailures, 1);
});

// ─────────────────────────────────────────────────────────────
//  --swap-only-on-403 flow
// ─────────────────────────────────────────────────────────────

test("swap-only-on-403 — first PUT 403 → swap → retry PUT → success", async () => {
  let putCount = 0;
  const client = makeCloudClient({
    updateFilterImpl: async () => {
      if (putCount++ === 0) {
        const e = new Error("forbidden");
        e.statusCode = 403;
        throw e;
      }
      return {};
    },
  });
  const pm = makePlanManager(baseEntry());
  const proc = makeProcessor(client, pm, { swapOnlyOn403: true });

  const result = await proc._executeOne("10000", pm.plan.filters["10000"]);

  assert.equal(result.success, true);
  assert.equal(client.calls.updateFilter.length, 2, "first PUT (fails 403), then retry after swap");
  assert.equal(client.calls.setFilterOwner.length, 2, "swap (after 403) + restore");
  assert.equal(pm.plan.filters["10000"].ownerSwapped, true);
  assert.equal(pm.plan.filters["10000"].ownerRestored, true);
});

// ─────────────────────────────────────────────────────────────
//  Live fetch on missing originals (v1 plan resume)
// ─────────────────────────────────────────────────────────────

test("v1 plan resume — missing originalOwner triggers live fetch", async () => {
  const client = makeCloudClient({
    getFilterImpl: async () => ({
      id: "10000",
      jql: "project = FOO",
      owner: { accountId: "live-owner", displayName: "Live" },
      sharePermissions: [{ type: "global" }],
      editPermissions: [],
    }),
  });
  const entry = baseEntry();
  delete entry.originalOwner;
  delete entry.originalSharePermissions;
  delete entry.originalEditPermissions;
  const pm = makePlanManager(entry);
  const proc = makeProcessor(client, pm);

  await proc._executeOne("10000", pm.plan.filters["10000"]);

  assert.equal(client.calls.getFilter.length, 1, "live fetch happened");
  const after = pm.plan.filters["10000"];
  assert.equal(after.originalOwner.accountId, "live-owner");
  assert.deepEqual(after.originalSharePermissions, [{ type: "global" }]);
});

// ─────────────────────────────────────────────────────────────
//  v2.1: permission sanitizer + denied-group retry
// ─────────────────────────────────────────────────────────────

test("permissions sanitize: 'loggedin' + specific share → drop broad, keep specific + org-admins", async () => {
  // Cloud rejects `authenticated` (formerly `loggedin`) when combined with
  // user/group/project shares. Mixed input → drop the broad entry, keep the
  // specifics, merge org-admins.
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalSharePermissions: [
      { type: "loggedin" }, // would alias to authenticated → dropped (mixed)
      { type: "project-unknown" }, // invalid type → dropped by sanitizer
      { type: "group", group: { groupId: "g-keep", name: "keepme" } },
    ],
    originalEditPermissions: [
      { type: "user", user: {} }, // dropped: missing accountId
    ],
  }));
  const proc = makeProcessor(client, pm);

  await proc._executeOne("10000", pm.plan.filters["10000"]);

  const body = client.calls.updateFilter[0].body;
  // PUT body never carries sharePermissions anymore (see filterProcessor
  // buildBody comment). Share entries go via POST.
  assert.equal(body.sharePermissions, undefined);
  // Edit list: user-without-accountId dropped → empty list + merge org-admins
  assert.equal(body.editPermissions.length, 1);
  assert.equal(body.editPermissions[0].group.groupId, "g-org-admins");
  assert.ok(proc.stats.shareEntriesDropped >= 2);
  // Share-POST adds org-admins to share permissions
  assert.equal(client.calls.addFilterSharePermission.length, 1);
});

test("permissions sanitize: 'loggedin'-only original → preserved, no merge", async () => {
  // When the filter's only share is `loggedin`/`authenticated`, we leave it
  // alone (PUT body omits sharePermissions → Cloud preserves the broad
  // semantic). Merging org-admins would conflict with Cloud's "broad must be
  // alone" rule.
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalSharePermissions: [{ type: "loggedin" }],
    originalEditPermissions: [{ type: "global" }],
  }));
  const proc = makeProcessor(client, pm);

  await proc._executeOne("10000", pm.plan.filters["10000"]);

  const body = client.calls.updateFilter[0].body;
  assert.equal(body.sharePermissions, undefined, "broad-only → preserved (PUT omits field)");
  assert.equal(body.editPermissions, undefined, "global-only → preserved");
});

test("denied-group 400 → drop matching groups → retry succeeds", async () => {
  let putCount = 0;
  const client = makeCloudClient({
    updateFilterImpl: async () => {
      if (putCount++ === 0) {
        const e = new Error(
          'HTTP 400: PUT - {"errorMessages":["Invalid type given..."],"errors":{"shares_delegated":"The user X does not have permission to share with Group: \'Manage Sprints\'.","edit_permissions":"You do not have permission to share with Group: \'Manage Sprints\'."}}',
        );
        e.statusCode = 400;
        e.responseBody = e.message;
        throw e;
      }
      return {};
    },
  });
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalSharePermissions: [
      { type: "group", group: { name: "Manage Sprints" } },
      { type: "group", group: { name: "Sample Group", groupId: "g-sane" } },
    ],
    originalEditPermissions: [
      { type: "group", group: { name: "Manage Sprints" } },
    ],
  }));
  const proc = makeProcessor(client, pm);

  const result = await proc._executeOne("10000", pm.plan.filters["10000"]);

  assert.equal(result.success, true);
  assert.equal(client.calls.updateFilter.length, 2, "initial PUT + retry");
  // The retry body must NOT contain the denied group in editPermissions
  // (sharePermissions are no longer in the PUT body — they go via POST).
  const retryBody = client.calls.updateFilter[1].body;
  assert.equal(retryBody.sharePermissions, undefined);
  const allEditNames = (retryBody.editPermissions || []).map(
    (p) => (p.group && p.group.name) || (p.group && p.group.groupId) || p.type,
  );
  assert.ok(!allEditNames.includes("Manage Sprints"));
  assert.equal(proc.stats.deniedGroupRetries, 1);
  assert.equal(proc.stats.deniedGroupRetrySuccesses, 1);
  assert.deepEqual(
    pm.plan.filters["10000"].shareGroupsRemovedOnRetry,
    ["Manage Sprints"],
  );
});

test("denied-group retry that still fails → overall failure", async () => {
  const client = makeCloudClient({
    updateFilterImpl: async () => {
      const e = new Error(
        '{"errors":{"shares":"permission to share with Group: \'X\'."}}',
      );
      e.statusCode = 400;
      e.responseBody = e.message;
      throw e;
    },
  });
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalSharePermissions: [{ type: "group", group: { name: "X" } }],
    originalEditPermissions: [],
  }));
  const proc = makeProcessor(client, pm);

  const result = await proc._executeOne("10000", pm.plan.filters["10000"]);
  assert.equal(result.success, false);
  // The retry attempted but the second call also fails — so 2 PUTs
  assert.equal(client.calls.updateFilter.length, 2);
});

// ─────────────────────────────────────────────────────────────
//  --avoid-overwrite: skip when Cloud's current JQL differs
//  from what we expect to find there (would-be clobber)
// ─────────────────────────────────────────────────────────────

test("avoidOverwrite=true + Cloud JQL matches expectedLiveJql → proceeds with PUT", async () => {
  const client = makeCloudClient({
    getFilterImpl: async () => ({
      id: "10000",
      name: "mock",
      jql: "project = FOO AND status = Open",
      owner: { accountId: "migration-user", displayName: "Me" },
      sharePermissions: [],
      editPermissions: [],
    }),
  });
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    // refresh_plan would set this — the JQL we expect Cloud to currently hold.
    expectedLiveJql: "project = FOO AND status = Open",
    rewrittenJql: "project = FOO AND status = Open AND priority = High",
  }));
  const proc = makeProcessor(client, pm, { avoidOverwrite: true });

  const result = await proc._executeOne("10000", pm.plan.filters["10000"]);
  assert.equal(result.success, true);
  assert.equal(client.calls.updateFilter.length, 1, "PUT should fire");
  // _executeOne doesn't set status=completed itself — that's executePlan's
  // job. Just confirm we didn't get tagged as externally_modified.
  assert.notEqual(pm.plan.filters["10000"].lastStepError, "externally_modified");
});

test("avoidOverwrite=true + Cloud JQL differs from expectedLiveJql → skips with externally_modified", async () => {
  const client = makeCloudClient({
    getFilterImpl: async () => ({
      id: "10000",
      name: "mock",
      jql: "project = FOO AND assignee = bob", // user manually changed this
      owner: { accountId: "migration-user", displayName: "Me" },
      sharePermissions: [],
      editPermissions: [],
    }),
  });
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    expectedLiveJql: "project = FOO AND status = Open",
    rewrittenJql: "project = FOO AND status = Open AND priority = High",
  }));
  const proc = makeProcessor(client, pm, { avoidOverwrite: true });

  const result = await proc._executeOne("10000", pm.plan.filters["10000"]);
  assert.equal(result.success, false);
  assert.equal(result.error, "externally_modified");
  assert.equal(client.calls.updateFilter.length, 0, "PUT must NOT fire");
  assert.equal(pm.plan.filters["10000"].status, "skipped");
  assert.equal(pm.plan.filters["10000"].error, "externally_modified");
  // The entry should record the live JQL for audit
  assert.equal(
    pm.plan.filters["10000"].liveJqlAtCheck,
    "project = FOO AND assignee = bob",
  );
});

test("avoidOverwrite=true + entry has no expectedLiveJql → falls back to originalJql", async () => {
  // Simulates a never-refreshed entry where expectedLiveJql wasn't set.
  // Should fall back to originalJql.
  const client = makeCloudClient({
    getFilterImpl: async () => ({
      id: "10000",
      name: "mock",
      jql: "project = FOO", // matches originalJql
      owner: { accountId: "migration-user", displayName: "Me" },
      sharePermissions: [],
      editPermissions: [],
    }),
  });
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalJql: "project = FOO",
    rewrittenJql: "project = FOO AND status = Open",
    // expectedLiveJql intentionally omitted
  }));
  const proc = makeProcessor(client, pm, { avoidOverwrite: true });

  const result = await proc._executeOne("10000", pm.plan.filters["10000"]);
  assert.equal(result.success, true, "should proceed because originalJql matches live");
  assert.equal(client.calls.updateFilter.length, 1);
});

test("avoidOverwrite=false → no extra GET, no comparison, PUT proceeds", async () => {
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    expectedLiveJql: "should-not-be-checked",
  }));
  const proc = makeProcessor(client, pm, { avoidOverwrite: false });

  await proc._executeOne("10000", pm.plan.filters["10000"]);
  // No pre-fetch because originalOwner is already set and verify-name/avoid-overwrite are off.
  assert.equal(client.calls.getFilter.length, 0);
  assert.equal(client.calls.updateFilter.length, 1);
});

// ─────────────────────────────────────────────────────────────
//  Fix A — POST /filter/{id}/permission to add share entry
//  (PUT silently drops sharePermissions on Cloud)
// ─────────────────────────────────────────────────────────────

test("share-POST fires after successful PUT and original share lacked org-admins", async () => {
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalSharePermissions: [{ type: "project", project: { id: "10100" } }],
    originalEditPermissions: [],
  }));
  const proc = makeProcessor(client, pm);

  const result = await proc._executeOne("10000", pm.plan.filters["10000"]);
  assert.equal(result.success, true);
  assert.equal(client.calls.updateFilter.length, 1, "PUT should fire");
  assert.equal(client.calls.addFilterSharePermission.length, 1, "POST share should fire");
  const { body } = client.calls.addFilterSharePermission[0];
  assert.equal(body.type, "group");
  assert.equal(body.groupId, "g-org-admins");
  assert.equal(pm.plan.filters["10000"].sharePermissionPosted, true);
});

test("share-POST is skipped when org-admins is already in originalSharePermissions", async () => {
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalSharePermissions: [
      { type: "group", group: { groupId: "g-org-admins", name: "org-admins" } },
    ],
    originalEditPermissions: [],
  }));
  const proc = makeProcessor(client, pm);

  await proc._executeOne("10000", pm.plan.filters["10000"]);
  assert.equal(client.calls.addFilterSharePermission.length, 0, "POST should be skipped");
  assert.equal(pm.plan.filters["10000"].sharePermissionPosted, true);
  assert.equal(pm.plan.filters["10000"].sharePermissionPostSkippedReason, "already_present");
});

test("share-POST is NOT issued when PUT failed", async () => {
  const client = makeCloudClient({
    updateFilterImpl: async () => { const e = new Error("nope"); e.statusCode = 500; throw e; },
  });
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalSharePermissions: [],
    originalEditPermissions: [],
  }));
  const proc = makeProcessor(client, pm);

  const result = await proc._executeOne("10000", pm.plan.filters["10000"]);
  assert.equal(result.success, false);
  assert.equal(client.calls.addFilterSharePermission.length, 0,
    "POST share must NOT fire when PUT failed");
});

test("share-POST failure is logged but does NOT fail the overall update", async () => {
  const client = makeCloudClient({
    addFilterSharePermissionImpl: async () => {
      const e = new Error("forbidden");
      e.statusCode = 403;
      e.responseBody = '{"errorMessages":["share permission denied"]}';
      throw e;
    },
  });
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalSharePermissions: [],
    originalEditPermissions: [],
  }));
  const proc = makeProcessor(client, pm);

  const result = await proc._executeOne("10000", pm.plan.filters["10000"]);
  assert.equal(result.success, true, "JQL update succeeded; share POST failure must not regress it");
  assert.equal(client.calls.addFilterSharePermission.length, 1);
  assert.ok(
    pm.plan.filters["10000"].sharePermissionPostError &&
      pm.plan.filters["10000"].sharePermissionPostError.includes("403"),
    "the failure reason is recorded",
  );
  assert.equal(pm.plan.filters["10000"].sharePermissionPosted, undefined);
});

test("share-POST is skipped if sharePermissionPosted was already true (resume safety)", async () => {
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalSharePermissions: [],
    originalEditPermissions: [],
    sharePermissionPosted: true, // a prior partial run already POSTed it
  }));
  const proc = makeProcessor(client, pm);

  await proc._executeOne("10000", pm.plan.filters["10000"]);
  assert.equal(client.calls.addFilterSharePermission.length, 0, "POST must not double-fire");
});

test("share-POST honors groupname fallback when groupId is unavailable", async () => {
  const client = makeCloudClient();
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalSharePermissions: [],
    originalEditPermissions: [],
  }));
  const proc = makeProcessor(client, pm, {
    orgAdminsGroup: { name: "org-admins" }, // no groupId
  });

  await proc._executeOne("10000", pm.plan.filters["10000"]);
  const { body } = client.calls.addFilterSharePermission[0];
  assert.equal(body.type, "group");
  assert.equal(body.groupname, "org-admins");
});

test("share-POST detects org-admins by name when entry uses name only", async () => {
  const client = makeCloudClient();
  // originalSharePermissions has org-admins by name only (no groupId).
  // shouldn't POST again.
  const pm = makePlanManager(baseEntry({
    originalOwner: { accountId: "migration-user", displayName: "Me" },
    originalSharePermissions: [
      { type: "group", group: { name: "org-admins" } },
    ],
    originalEditPermissions: [],
  }));
  const proc = makeProcessor(client, pm);

  await proc._executeOne("10000", pm.plan.filters["10000"]);
  assert.equal(client.calls.addFilterSharePermission.length, 0,
    "POST should be skipped because org-admins is already present by name");
});
