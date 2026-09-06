/**
 * Unit tests for cloudUserResolver.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  loadCache,
  persistCache,
  lookupCached,
  resolveAndCache,
  resolveRunAs,
} = require("./cloudUserResolver");

let _passed = 0;
let _failed = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    _passed++;
  } catch (e) {
    console.log(`FAIL ${name} - ${e.message}`);
    _failed++;
  }
}

async function ta(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
    _passed++;
  } catch (e) {
    console.log(`FAIL ${name} - ${e.message}`);
    _failed++;
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cur-test-"));

t("loadCache: returns blank store when file missing", () => {
  const s = loadCache(TMP, "https://x.atlassian.net");
  assert.deepStrictEqual(s.entries, {});
  assert.strictEqual(s.cloudBaseUrl, "https://x.atlassian.net");
});

t("loadCache: rejects cache for different cloud baseUrl", () => {
  const p = path.join(TMP, "dc_user_cloud_map.json");
  fs.writeFileSync(p, JSON.stringify({ cloudBaseUrl: "https://OTHER.atlassian.net", entries: { foo: { resolved: "x" } } }));
  const s = loadCache(TMP, "https://x.atlassian.net");
  assert.deepStrictEqual(s.entries, {}); // fresh — wrong tenant
  fs.unlinkSync(p);
});

t("lookupCached: case-insensitive on dcUsername", () => {
  const store = { entries: { admin: { resolved: "accountId:abc" } } };
  assert.deepStrictEqual(lookupCached(store, "ADMIN"), { resolved: "accountId:abc" });
  assert.strictEqual(lookupCached(store, "missing"), null);
});

t("resolveRunAs: empty dcUsername → currentUser", () => {
  assert.deepStrictEqual(resolveRunAs("", {}), { runAsType: "currentUser" });
  assert.deepStrictEqual(resolveRunAs(null, { dcUserMap: {} }), { runAsType: "currentUser" });
});

t("resolveRunAs: cached resolved → specifiedUser+runAs", () => {
  const ctx = { dcUserMap: { atlas: { resolved: "accountId:abc-123" } } };
  assert.deepStrictEqual(
    resolveRunAs("atlas", ctx),
    { runAsType: "specifiedUser", runAs: "accountId:abc-123" },
  );
});

t("resolveRunAs: cached fallback only → specifiedUser+fallback flag", () => {
  const ctx = { dcUserMap: { svc: { resolved: null, fallback: "accountId:fall-1" } } };
  const r = resolveRunAs("svc", ctx);
  assert.strictEqual(r.runAsType, "specifiedUser");
  assert.strictEqual(r.runAs, "accountId:fall-1");
  assert.strictEqual(r.fallback, true);
});

t("resolveRunAs: no cache entry → unresolved marker", () => {
  const ctx = { dcUserMap: {} };
  const r = resolveRunAs("nobody", ctx);
  assert.strictEqual(r.runAsType, "currentUser");
  assert.strictEqual(r.unresolved, true);
  assert.strictEqual(r.dcUsername, "nobody");
});

t("resolveRunAs: no ctx.dcUserMap at all → unresolved", () => {
  const r = resolveRunAs("admin", {});
  assert.strictEqual(r.unresolved, true);
});

(async () => {
  await ta("resolveAndCache: hits Cloud and caches accountId", async () => {
    const calls = [];
    const fakeCloud = {
      async makeRequest(method, url) {
        calls.push({ method, url });
        return [{ accountId: "acc-xyz", displayName: "Test User", active: true }];
      },
    };
    const store = { cloudBaseUrl: "x", entries: {} };
    const entry = await resolveAndCache(fakeCloud, store, "Test User");
    assert.strictEqual(entry.resolved, "accountId:acc-xyz");
    assert.ok(calls[0].url.includes("query=Test%20User"));
    assert.ok(store.entries["test user"]); // case-folded key
  });

  await ta("resolveAndCache: returns existing entry without re-calling", async () => {
    let calls = 0;
    const fakeCloud = { async makeRequest() { calls++; return []; } };
    const store = { cloudBaseUrl: "x", entries: { admin: { resolved: "accountId:abc" } } };
    const e = await resolveAndCache(fakeCloud, store, "admin");
    assert.strictEqual(calls, 0);
    assert.strictEqual(e.resolved, "accountId:abc");
  });

  await ta("resolveAndCache: empty Cloud result → resolved=null, persists fallback", async () => {
    const fakeCloud = { async makeRequest() { return []; } };
    const store = { cloudBaseUrl: "x", entries: {} };
    const entry = await resolveAndCache(fakeCloud, store, "nobody", { fallbackAccountId: "fall-1" });
    assert.strictEqual(entry.resolved, null);
    assert.strictEqual(entry.fallback, "accountId:fall-1");
  });

  await ta("resolveAndCache: prefers active user matching displayName exactly", async () => {
    const fakeCloud = {
      async makeRequest() {
        return [
          { accountId: "deactivated-id", active: false, displayName: "Atlas" },
          { accountId: "other-id", active: true, displayName: "Atlas Other" },
          { accountId: "exact-id", active: true, displayName: "Atlas" },
        ];
      },
    };
    const store = { cloudBaseUrl: "x", entries: {} };
    const entry = await resolveAndCache(fakeCloud, store, "Atlas");
    assert.strictEqual(entry.resolved, "accountId:exact-id");
  });

  // Cleanup
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${_passed} passed, ${_failed} failed`);
  if (_failed > 0) process.exit(1);
})();
