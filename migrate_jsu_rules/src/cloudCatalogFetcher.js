/**
 * Live Cloud catalog fetcher.
 *
 * Centralizes every catalog the applier and the sanitizer need to validate
 * IDs against the authoritative current state of Cloud:
 *
 *   - fields           customfield_NNN existence + display names
 *   - statuses         status IDs + names (global + project-scoped)
 *   - roles            project role IDs + names
 *   - permissions      Cloud permission key catalog
 *   - groups           lazy: name → {groupId, name}
 *   - users            lazy: accountId batches → {accountId → displayName}
 *   - workflowCapabilities  per-workflow valid system:* / connect:* ruleKeys
 *   - assets           JSM Insight/Assets workspace + schemas/types/attrs
 *                      (Iteration 3; Iteration 1 leaves this null)
 *
 * Why centralize: the applier currently fetches fields and statuses inline in
 * `_loadCloudFieldCatalog` and `_buildStatusRemapping`. Iteration 2 of the
 * sanitize plan refactors those to call this fetcher so v2 fingerprints have
 * a single coherent catalog snapshot rather than two ad-hoc maps.
 *
 * Iteration 1 scope: enough catalog to drive sanitize's audit (fields,
 * statuses, roles, permissions, groups-by-name, users-by-accountId,
 * workflow capabilities, project workflow-scheme lookup for
 * `--exclude-projects`). Assets stays stubbed.
 */

const TAG = "[CatalogFetcher]";

class CloudCatalogFetcher {
  constructor(cloudClient, log) {
    this.cloud = cloudClient;
    this.log = log || console;
    this._cache = {
      fields: null,
      statuses: null,
      roles: null,
      permissions: null,
      workflowCapabilities: null, // tenant-wide capabilities (no workflowId)
      perWorkflowCapabilities: new Map(), // workflowId → Set<ruleKey>
      groupsByName: new Map(), // name(lower) → {groupId, name} | null
      usersByAccountId: new Map(), // accountId → {displayName, active} | null
      excludedWorkflowNames: null, // Set<workflowName>
    };
  }

  /**
   * Fetch the full catalog bundle in one call. Tenant-wide queries fire in
   * parallel; per-resource lazy lookups (groups, users) stay deferred.
   *
   * @param {object} [opts]
   * @param {string|null} [opts.workspaceId] - JSM Assets workspace UUID for
   *   Iteration 3. When null/undefined, the assets catalog is skipped and
   *   `assets` is set to null (sanitizer surfaces that as "unavailable").
   */
  async fetchAll(_opts = {}) {
    // _opts.workspaceId is reserved for the Iteration 3 Assets bundle; the
    // Iteration 1 fetcher leaves `assets: null` and ignores the parameter.
    const [fields, statuses, roles, permissions] = await Promise.all([
      this._fetchFields(),
      this._fetchStatuses(),
      this._fetchRoles(),
      this._fetchPermissions(),
    ]);
    // /workflows/capabilities requires either workflowId or project+issuetype
    // — there's no tenant-wide query. Iteration 2's matcher seeds the phantom
    // allowlist per-workflow lazily via `capabilitiesForWorkflow(id)`.
    const capabilities = { ruleKeys: new Set(), appKeys: new Set() };

    return {
      fields,
      statuses,
      roles,
      permissions,
      workflowCapabilities: capabilities,
      groups: {
        // Lazy resolver: only hits Cloud for names we ask about. The audit
        // calls this once per distinct group name across all walked rules,
        // so the Cloud-side cost stays linear in DC's group breadth, not
        // workflow size.
        resolveByName: (name) => this._resolveGroupByName(name),
        cache: this._cache.groupsByName,
      },
      users: {
        resolveByAccountIds: (ids, capacity) => this._resolveUsers(ids, capacity),
        cache: this._cache.usersByAccountId,
      },
      assets: null, // Iteration 3 will populate via fetchAssetsCatalog().
      // Per-workflow capability lookup: union the tenant-wide ruleKeys with
      // anything specific to the workflow. Used by the v2 phantom allowlist
      // to extend dynamically.
      capabilitiesForWorkflow: (workflowId) => this._fetchWorkflowCapabilities(workflowId),
    };
  }

  /**
   * Resolve which workflow names are "off-limits" for this run because they
   * back at least one project the operator passed in `--exclude-projects`.
   *
   * Built from project → workflow scheme → defaultWorkflow + every issuetype
   * mapping. Returns an empty Set when the input is empty.
   *
   * Cached per fetcher instance so the same Set is reused for sanitize,
   * apply, and any audit pass running in the same process.
   */
  async resolveExcludedWorkflowNames(excludeProjectKeys) {
    if (!Array.isArray(excludeProjectKeys) || excludeProjectKeys.length === 0) {
      return new Set();
    }
    if (this._cache.excludedWorkflowNames) return this._cache.excludedWorkflowNames;

    const out = new Set();
    for (const key of excludeProjectKeys) {
      try {
        const project = await this.cloud.getProjectByKey(key);
        if (!project) {
          this.log.warn(
            `${TAG} --exclude-projects: Cloud has no project with key "${key}" — ignoring`,
          );
          continue;
        }
        // Returns the scheme summary (id, name) for the project.
        const scheme = await this.cloud.getWorkflowSchemeForProject(project.id);
        if (!scheme || !scheme.id) {
          this.log.warn(
            `${TAG} --exclude-projects: project "${key}" has no workflow scheme — ignoring`,
          );
          continue;
        }
        // Fetch the full scheme so we can read defaultWorkflow + issueTypeMappings.
        const full = await this.cloud.makeRequest(
          "GET",
          `/rest/api/3/workflowscheme/${encodeURIComponent(scheme.id)}`,
        );
        const names = this._collectSchemeWorkflowNames(full);
        for (const n of names) out.add(n);
        // Count distinct CLOUD names (pre variant-expansion) so the log line
        // reflects what an operator would see in the Cloud UI.
        const canonical = new Set();
        if (full && full.defaultWorkflow) canonical.add(full.defaultWorkflow);
        const itm = full && full.issueTypeMappings;
        if (itm && typeof itm === "object" && !Array.isArray(itm)) {
          for (const v of Object.values(itm)) {
            if (typeof v === "string" && v) canonical.add(v);
          }
        }
        if (Array.isArray(itm)) {
          for (const m of itm) {
            if (m && typeof m.workflow === "string" && m.workflow) canonical.add(m.workflow);
          }
        }
        this.log.info(
          `${TAG} --exclude-projects: "${key}" (scheme "${scheme.name || scheme.id}") protects ${canonical.size} workflow(s): ${[...canonical].map((n) => JSON.stringify(n)).join(", ")}`,
        );
      } catch (e) {
        this.log.warn(
          `${TAG} --exclude-projects: failed to resolve project "${key}" (${e.message}) — ignoring`,
        );
      }
    }
    this._cache.excludedWorkflowNames = out;
    return out;
  }

  _collectSchemeWorkflowNames(scheme) {
    const out = new Set();
    if (!scheme) return out;
    const add = (n) => {
      if (typeof n !== "string" || !n) return;
      // Add the Cloud canonical name.
      out.add(n);
      // CRITICAL: the conversion plan stores DC workflow names harvested from
      // XML filenames, and DC's XML export substitutes `_` for `:` and `/` in
      // filenames. So a workflow Cloud calls "Build: Story WF v1.0" appears
      // in the plan as "Build_ Story WF v1.0". `audit_oneforone.js` resolves
      // this at fetch time; the exclusion filter has to do the inverse at
      // membership-check time. We forward-generate every DC variant a plan
      // entry could carry, so `excludedWorkflowNames.has(planRow.workflowName)`
      // matches even when the names differ by these substitutions.
      out.add(n.replace(/: /g, "_ "));
      out.add(n.replace(/:/g, "_"));
      out.add(n.replace(/\/ /g, "_ "));
      out.add(n.replace(/\//g, "_"));
    };
    if (scheme.defaultWorkflow) add(scheme.defaultWorkflow);
    // Two shapes seen in v3 responses: object {issueTypeId: workflowName} or
    // array [{issueType, workflow}]. Cover both.
    if (scheme.issueTypeMappings && typeof scheme.issueTypeMappings === "object") {
      for (const v of Object.values(scheme.issueTypeMappings)) {
        if (typeof v === "string") add(v);
      }
    }
    if (Array.isArray(scheme.issueTypeMappings)) {
      for (const m of scheme.issueTypeMappings) {
        if (m && typeof m.workflow === "string") add(m.workflow);
      }
    }
    // Some scheme responses use `originalDefaultWorkflow` after a draft edit.
    if (scheme.originalDefaultWorkflow) add(scheme.originalDefaultWorkflow);
    return out;
  }

  async _fetchFields() {
    if (this._cache.fields) return this._cache.fields;
    let raw = [];
    try {
      raw = await this.cloud.makeRequest("GET", "/rest/api/3/field");
    } catch (e) {
      this.log.warn(`${TAG} field catalog fetch failed: ${e.message}`);
      raw = [];
    }
    const byId = new Map();
    const byName = new Map();
    const customFieldIds = new Set();
    for (const f of raw || []) {
      if (!f || !f.id) continue;
      byId.set(f.id, f);
      if (f.name) {
        const key = f.name.trim().toLowerCase();
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(f);
      }
      if (typeof f.id === "string" && f.id.startsWith("customfield_")) {
        customFieldIds.add(f.id);
      }
    }
    this._cache.fields = { byId, byName, customFieldIds, raw };
    this.log.info(
      `${TAG} fields: ${byId.size} total, ${customFieldIds.size} customfield_*`,
    );
    return this._cache.fields;
  }

  async _fetchStatuses() {
    if (this._cache.statuses) return this._cache.statuses;
    let list = [];
    try {
      // Prefer /statuses/search (paginated, name-indexed); fall back to legacy
      // /status (returns full array but is approaching deprecation).
      list = await this.cloud.getAllStatuses();
    } catch (e) {
      this.log.warn(`${TAG} /statuses/search failed (${e.message}); trying /status`);
      try {
        list = await this.cloud.makeRequest("GET", "/rest/api/3/status");
      } catch (e2) {
        this.log.warn(`${TAG} /status also failed (${e2.message}) — empty status catalog`);
        list = [];
      }
    }
    const byId = new Map();
    const byNameLower = new Map();
    for (const s of list || []) {
      if (!s || !s.id) continue;
      byId.set(String(s.id), s);
      if (s.name) {
        const key = String(s.name).trim().toLowerCase();
        const existing = byNameLower.get(key);
        const isGlobal = !s.scope || s.scope.type === "GLOBAL";
        // Prefer GLOBAL-scope statuses when names collide (matches the
        // applier's existing behavior in _buildStatusRemapping).
        if (!existing || (isGlobal && existing._scopePref !== "global")) {
          byNameLower.set(key, { ...s, _scopePref: isGlobal ? "global" : "project" });
        }
      }
    }
    this._cache.statuses = { byId, byNameLower, raw: list };
    this.log.info(`${TAG} statuses: ${byId.size}`);
    return this._cache.statuses;
  }

  async _fetchRoles() {
    if (this._cache.roles) return this._cache.roles;
    let list = [];
    try {
      list = await this.cloud.getAllProjectRoles();
    } catch (e) {
      this.log.warn(`${TAG} role catalog fetch failed: ${e.message}`);
      list = [];
    }
    const byId = new Map();
    const byNameLower = new Map();
    for (const r of list || []) {
      if (!r || !r.id) continue;
      byId.set(String(r.id), r);
      if (r.name) byNameLower.set(String(r.name).trim().toLowerCase(), r);
    }
    this._cache.roles = { byId, byNameLower, raw: list };
    this.log.info(`${TAG} roles: ${byId.size}`);
    return this._cache.roles;
  }

  async _fetchPermissions() {
    if (this._cache.permissions) return this._cache.permissions;
    const keys = new Set();
    try {
      const res = await this.cloud.makeRequest("GET", "/rest/api/3/permissions");
      // v3 returns `{permissions: {KEY: {...}, ...}}` (object form).
      const perms = (res && res.permissions) || {};
      for (const k of Object.keys(perms)) keys.add(k);
    } catch (e) {
      this.log.warn(`${TAG} permission catalog fetch failed: ${e.message}`);
    }
    this._cache.permissions = { keys };
    this.log.info(`${TAG} permission keys: ${keys.size}`);
    return this._cache.permissions;
  }

  /**
   * Fetch the workflow capabilities ruleKeys. Called once for tenant-wide
   * (`workflowId=null`), and lazily per workflow when v2 dynamic
   * phantom-allowlist seeding is enabled.
   */
  async _fetchWorkflowCapabilities(workflowId) {
    if (workflowId == null) {
      if (this._cache.workflowCapabilities) return this._cache.workflowCapabilities;
    } else {
      const hit = this._cache.perWorkflowCapabilities.get(String(workflowId));
      if (hit) return hit;
    }
    const ruleKeys = new Set();
    let appKeys = new Set();
    try {
      const res = await this.cloud.getWorkflowCapabilities(workflowId);
      // /workflows/capabilities returns: { systemRules: [{ruleKey}], connectRules: [{ruleKey, appKey}], ... }
      for (const key of ["systemRules", "connectRules", "forgeRules"]) {
        const arr = (res && res[key]) || [];
        for (const r of arr) {
          if (r && r.ruleKey) ruleKeys.add(r.ruleKey);
          if (r && r.appKey) appKeys.add(r.appKey);
        }
      }
    } catch (e) {
      this.log.warn(
        `${TAG} workflow capabilities fetch failed (workflowId=${workflowId || "all"}): ${e.message}`,
      );
    }
    const out = { ruleKeys, appKeys };
    if (workflowId == null) {
      this._cache.workflowCapabilities = out;
    } else {
      this._cache.perWorkflowCapabilities.set(String(workflowId), out);
    }
    return out;
  }

  async _resolveGroupByName(name) {
    if (!name) return null;
    const key = String(name).trim().toLowerCase();
    if (this._cache.groupsByName.has(key)) {
      return this._cache.groupsByName.get(key);
    }
    let resolved = null;
    try {
      const matches = await this.cloud.getGroupsByName(name);
      // /group/bulk does fuzzy matching; only accept exact (case-insensitive) hits.
      for (const g of matches) {
        if (g && typeof g.name === "string" && g.name.toLowerCase() === key) {
          resolved = { groupId: g.groupId || g.id || null, name: g.name };
          break;
        }
      }
    } catch (e) {
      this.log.warn(`${TAG} group lookup for "${name}" failed: ${e.message}`);
    }
    this._cache.groupsByName.set(key, resolved);
    return resolved;
  }

  /**
   * Resolve account IDs in batches of 100 (the documented limit). Caps the
   * total IDs visited per fetcher instance at `capacity` (default 500) to
   * avoid runaway audit cost on workflows that reference hundreds of users.
   * Returns a Map<accountId, {displayName, active}|null>; IDs above the cap
   * are recorded as `{ _overCap: true }` so the sanitizer can surface them
   * separately.
   */
  async _resolveUsers(accountIds, capacity = 500) {
    const out = new Map();
    if (!Array.isArray(accountIds) || accountIds.length === 0) return out;
    const distinct = [...new Set(accountIds.filter(Boolean))];
    for (let i = 0; i < distinct.length; i++) {
      const id = distinct[i];
      if (this._cache.usersByAccountId.has(id)) {
        out.set(id, this._cache.usersByAccountId.get(id));
        continue;
      }
      // Lookup in batches starting from this position; chunk size 100.
      if (this._cache.usersByAccountId.size >= capacity) {
        out.set(id, { _overCap: true });
        this._cache.usersByAccountId.set(id, { _overCap: true });
        continue;
      }
      const chunk = distinct.slice(i, i + 100);
      try {
        // /user/bulk takes ?accountId=A&accountId=B ... pattern.
        const params = new URLSearchParams();
        for (const a of chunk) params.append("accountId", a);
        const res = await this.cloud.makeRequest(
          "GET",
          `/rest/api/3/user/bulk?${params.toString()}`,
        );
        const values = (res && res.values) || [];
        for (const u of values) {
          if (!u || !u.accountId) continue;
          const entry = { displayName: u.displayName || "", active: !!u.active };
          this._cache.usersByAccountId.set(u.accountId, entry);
        }
        for (const a of chunk) {
          if (!this._cache.usersByAccountId.has(a)) {
            // accountId not returned → unknown
            this._cache.usersByAccountId.set(a, null);
          }
          out.set(a, this._cache.usersByAccountId.get(a));
        }
        i += chunk.length - 1; // -1 because the loop will i++
      } catch (e) {
        this.log.warn(`${TAG} /user/bulk failed for chunk: ${e.message}`);
        for (const a of chunk) {
          this._cache.usersByAccountId.set(a, null);
          out.set(a, null);
        }
        i += chunk.length - 1;
      }
    }
    return out;
  }
}

module.exports = CloudCatalogFetcher;
