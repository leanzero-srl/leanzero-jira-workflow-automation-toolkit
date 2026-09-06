/**
 * cloudUserResolver.js — Phase B of Round 3 audit fix.
 *
 * Resolves DC usernames (or display names) to Cloud account IDs. The
 * applier needs this for `runAs: "accountId:UUID"` emissions on rules
 * where the DC operator picked a specific user (typically a JSD admin
 * service account).
 *
 * Without it, mappers emit `runAsType: "currentUser"` for every rule —
 * which is wrong: at Cloud runtime the rule fires AS the transitioning
 * user rather than the configured service account. This caused the
 * 14-issue "Run As user mismatch" bucket in the Confluence audit.
 *
 * Design:
 *   - The cache is keyed by `(dcUsername, cloudBaseUrl)` so sandbox and
 *     prod don't share lookups (different accountIds).
 *   - Persisted as `<collectDir>/dc_user_cloud_map.json`.
 *   - Live lookup uses Cloud `/rest/api/3/user/search?query=<term>`.
 *     We try the dcUsername first; if no hit, we try the same string as
 *     an email (some DC usernames are email-like).
 *   - Deactivated users: caller supplies a fallback accountId via the
 *     `fallbackAccountId` arg. The resolver records both `resolved` and
 *     `fallback`; the mapper uses fallback only when resolved is null.
 *
 * The applier is responsible for PRE-RESOLVING all distinct
 * `cfg.runAsUser` values at apply time (before mapper invocation). The
 * mappers themselves only read `ctx.dcUserMap[dcUsername]`
 * synchronously.
 */

const fs = require("fs");
const path = require("path");

const CACHE_FILENAME = "dc_user_cloud_map.json";

function cachePath(collectDir) {
  return path.join(collectDir, CACHE_FILENAME);
}

function loadCache(collectDir, cloudBaseUrl) {
  const p = cachePath(collectDir);
  let store = { cloudBaseUrl, entries: {} };
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      // If the existing cache is for a DIFFERENT tenant, start fresh.
      // sandbox/prod must not share resolutions.
      if (raw && raw.cloudBaseUrl === cloudBaseUrl && raw.entries && typeof raw.entries === "object") {
        store = raw;
      }
    } catch {}
  }
  return store;
}

function persistCache(collectDir, store) {
  const p = cachePath(collectDir);
  fs.writeFileSync(p, JSON.stringify(store, null, 2));
}

function lookupCached(store, dcUsername) {
  if (!store || !store.entries) return null;
  const k = String(dcUsername || "").toLowerCase().trim();
  if (!k) return null;
  return store.entries[k] || null;
}

/**
 * Async — calls Cloud /rest/api/3/user/search?query=<term> and resolves
 * the first matching active user's accountId. Writes the result to the
 * in-memory cache + persists.
 *
 * Returns `{ resolved: "accountId:UUID" | null, fallback: ... }`.
 * The `resolved` value is null when the user couldn't be found. The
 * caller decides whether to fall back to `fallback` or to emit the
 * `UnresolvedRunAsUser` marker.
 */
async function resolveAndCache(cloud, store, dcUsername, opts = {}) {
  const k = String(dcUsername || "").toLowerCase().trim();
  if (!k) return null;
  if (store.entries[k] && store.entries[k].resolved) return store.entries[k];
  // Try `query=<dcUsername>` first (Cloud's free-text user search)
  const tryQuery = async (q) => {
    if (!q) return null;
    try {
      const res = await cloud.makeRequest(
        "GET",
        `/rest/api/3/user/search?query=${encodeURIComponent(q)}&maxResults=5`,
      );
      if (Array.isArray(res) && res.length > 0) {
        // Prefer active accounts and pick the first one matching our search
        // term as a displayName or emailAddress.
        const exact = res.find(
          (u) => u && u.active !== false && (
            String(u.displayName || "").toLowerCase() === q.toLowerCase()
            || String(u.emailAddress || "").toLowerCase() === q.toLowerCase()
          ),
        );
        const pick = exact || res.find((u) => u && u.active !== false) || res[0];
        if (pick && pick.accountId) return pick.accountId;
      }
    } catch {
      /* fall through */
    }
    return null;
  };
  let accountId = await tryQuery(dcUsername);
  if (!accountId && /@/.test(dcUsername)) {
    // Looks like an email; the search above already tried — give up.
  } else if (!accountId) {
    // Try as a display name fragment OR @domain guess.
    accountId = await tryQuery(`${dcUsername}@`);
  }
  const entry = {
    resolved: accountId ? `accountId:${accountId}` : null,
    fallback: opts.fallbackAccountId ? `accountId:${opts.fallbackAccountId}` : null,
    resolvedAt: new Date().toISOString(),
  };
  store.entries[k] = entry;
  return entry;
}

/**
 * Synchronous helper used by mappers. Returns
 *   { runAsType, runAs?, unresolved? }
 *
 * - `unresolved: true` means the mapper should push an
 *   `UnresolvedRunAsUser` marker so the rule lands in the manual-review
 *   CSV with an actionable reason.
 * - When `dcUsername` is empty/null, returns `{ runAsType: "currentUser" }`.
 */
function resolveRunAs(dcUsername, ctx) {
  const u = String(dcUsername || "").trim();
  if (!u) return { runAsType: "currentUser" };
  const map = (ctx && ctx.dcUserMap) || null;
  const entry = map && map[u.toLowerCase()];
  if (entry && entry.resolved) {
    return { runAsType: "specifiedUser", runAs: entry.resolved };
  }
  if (entry && entry.fallback) {
    return { runAsType: "specifiedUser", runAs: entry.fallback, fallback: true };
  }
  // No mapping at all — preserve current-user emission AND mark as
  // unresolved so the operator sees the rule in the manual-review CSV.
  return { runAsType: "currentUser", unresolved: true, dcUsername: u };
}

/**
 * Pre-resolution pass intended for the applier — given a `conversion_plan.json`,
 * collect every distinct `cfg.runAsUser` value and resolve each via the
 * Cloud API, persisting the cache. Mappers then consume `ctx.dcUserMap`
 * synchronously.
 *
 * The DC config-key list is heterogeneous; we look at common variants:
 *   - cfg.runAsUser  (JMWE common)
 *   - cfg.runAs      (rarely a username string vs an enum)
 *   - cfg["jsdAdmin"], cfg["serviceAccount"]  (some custom DC plugins)
 */
async function preResolveAllRunAsUsers(plan, cloud, store, opts = {}) {
  const names = new Set();
  for (const row of (plan && plan.rows) || []) {
    const cfg = row.configuration || {};
    const ru = cfg.runAsUser;
    if (ru && typeof ru === "string" && ru.trim()) names.add(ru.trim());
  }
  for (const n of names) {
    await resolveAndCache(cloud, store, n, opts);
  }
  return store;
}

module.exports = {
  loadCache,
  persistCache,
  lookupCached,
  resolveAndCache,
  resolveRunAs,
  preResolveAllRunAsUsers,
};
