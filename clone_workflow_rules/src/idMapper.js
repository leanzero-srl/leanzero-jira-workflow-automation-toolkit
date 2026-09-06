/**
 * ID Mapper: resolves source-instance entity IDs to target-instance IDs for the
 * entity types the workflow transformer needs to rewrite.
 *
 * Strategy mirrors FieldMapper:
 *   1. Source-side "collect" step stashed { sourceId: { name, ...context } } per bucket
 *      into id_mapping.json.
 *   2. Here on the target side, we index the target catalog by name and resolve.
 *   3. An optional id_overrides.json wins over auto-resolution — that's the
 *      operator's curation hook for cases where name-matching fails or is ambiguous.
 *
 * Supported buckets:
 *   statuses       — by exact name
 *   issueTypes     — by exact name
 *   screens        — by exact name (names may not be unique; we warn on duplicates)
 *   events         — by exact name
 *   projectRoles   — by exact name
 *   priorities     — by exact name
 *   resolutions    — by exact name
 *   linkTypes      — by exact name
 *   securityLevels — by (schemeName, levelName) composite
 *   groups         — by exact groupName -> groupId (post-GDPR)
 *   workflowSchemes — by exact name (apply-only; for scheme re-association)
 *
 * Unsupported / skipped:
 *   users (accountId) — flagged as warnings only; user provisioning is out of scope.
 */

class IdMapper {
  constructor(client, log) {
    this.client = client;
    this.log = log || console.log;
    this._targetIndex = null; // lazily populated
  }

  async _loadTargetCatalogs() {
    if (this._targetIndex) return this._targetIndex;

    this.log(`  [IdMapper] Loading target catalogs...`);
    const idx = {
      statuses: new Map(),       // name -> { id, statusCategory }
      issueTypes: new Map(),     // name -> { id, hierarchyLevel }
      screens: new Map(),        // name -> [{ id, description }]  (array: names can collide)
      events: new Map(),         // name -> { id }
      projectRoles: new Map(),   // name -> { id }
      priorities: new Map(),     // name -> { id }
      resolutions: new Map(),    // name -> { id }
      linkTypes: new Map(),      // name -> { id, inward, outward }
      securityLevels: new Map(), // `${schemeName}::${levelName}` -> { id, schemeId }
      workflowSchemes: new Map(),// name -> { id }
    };

    const [
      statuses,
      issueTypes,
      screens,
      events,
      roles,
      priorities,
      resolutions,
      linkTypes,
      schemes,
      workflowSchemes,
    ] = await Promise.all([
      safe(() => this.client.getAllStatuses(), this.log, "statuses"),
      safe(() => this.client.getAllIssueTypes(), this.log, "issueTypes"),
      safe(() => this.client.getAllScreens(), this.log, "screens"),
      safe(() => this.client.getAllEvents(), this.log, "events"),
      safe(() => this.client.getAllProjectRoles(), this.log, "projectRoles"),
      safe(() => this.client.getAllPriorities(), this.log, "priorities"),
      safe(() => this.client.getAllResolutions(), this.log, "resolutions"),
      safe(() => this.client.getAllIssueLinkTypes(), this.log, "linkTypes"),
      safe(() => this.client.getAllSecuritySchemes(), this.log, "securitySchemes"),
      safe(() => this.client.getAllWorkflowSchemes(), this.log, "workflowSchemes"),
    ]);

    for (const s of statuses || []) {
      if (s.name) {
        idx.statuses.set(s.name, {
          id: String(s.id),
          statusCategory: s.statusCategory,
        });
      }
    }
    for (const it of issueTypes || []) {
      if (it.name) {
        idx.issueTypes.set(it.name, {
          id: String(it.id),
          hierarchyLevel: it.hierarchyLevel,
        });
      }
    }
    for (const sc of screens || []) {
      if (!sc.name) continue;
      const bucket = idx.screens.get(sc.name) || [];
      bucket.push({ id: String(sc.id), description: sc.description });
      idx.screens.set(sc.name, bucket);
    }
    for (const e of events || []) {
      if (e.name) idx.events.set(e.name, { id: String(e.id) });
    }
    for (const r of roles || []) {
      if (r.name) idx.projectRoles.set(r.name, { id: String(r.id) });
    }
    for (const p of priorities || []) {
      if (p.name) idx.priorities.set(p.name, { id: String(p.id) });
    }
    for (const r of resolutions || []) {
      if (r.name) idx.resolutions.set(r.name, { id: String(r.id) });
    }
    for (const lt of linkTypes || []) {
      if (lt.name) {
        idx.linkTypes.set(lt.name, {
          id: String(lt.id),
          inward: lt.inward,
          outward: lt.outward,
        });
      }
    }
    // Security levels need a secondary fetch per scheme.
    for (const scheme of schemes || []) {
      let detail;
      try {
        detail = await this.client.getSecuritySchemeById(scheme.id);
      } catch (err) {
        this.log(`  [IdMapper] WARNING: could not load security scheme ${scheme.id}: ${err.message}`);
        continue;
      }
      const schemeName = scheme.name || detail?.name;
      for (const level of detail?.levels || []) {
        if (!level.name) continue;
        idx.securityLevels.set(`${schemeName}::${level.name}`, {
          id: String(level.id),
          schemeId: String(scheme.id),
        });
      }
    }
    for (const ws of workflowSchemes || []) {
      if (ws.name) idx.workflowSchemes.set(ws.name, { id: String(ws.id) });
    }

    this.log(
      `  [IdMapper] Indexed: ${idx.statuses.size} statuses, ${idx.issueTypes.size} issue types, ` +
      `${idx.screens.size} screens, ${idx.events.size} events, ${idx.projectRoles.size} roles, ` +
      `${idx.priorities.size} priorities, ${idx.resolutions.size} resolutions, ` +
      `${idx.linkTypes.size} link types, ${idx.securityLevels.size} security levels, ` +
      `${idx.workflowSchemes.size} workflow schemes`,
    );

    this._targetIndex = idx;
    return idx;
  }

  /**
   * Build a complete source->target remapping.
   *
   * @param {object} sourceCatalog - id_mapping.json shape:
   *   {
   *     statuses:    { "10001": { name, statusCategory } },
   *     issueTypes:  { "10100": { name, hierarchyLevel } },
   *     screens:     { "10200": { name } },
   *     events:      { "1":     { name } },
   *     projectRoles:{ "10002": { name } },
   *     priorities:  { "1":     { name } },
   *     resolutions: { "10000": { name } },
   *     linkTypes:   { "10003": { name, inward, outward } },
   *     securityLevels: { "10500": { name, schemeName } },
   *     groups:      { "abcd-1234": { name } }    // groupId -> name
   *   }
   * @param {object} overrides - optional { bucket: { sourceId: targetId } } curation map.
   * @returns {object} per-bucket { sourceId: targetId } (null if unresolved).
   */
  async buildRemapping(sourceCatalog, overrides = {}) {
    const idx = await this._loadTargetCatalogs();

    const remapping = {
      statuses: {},
      issueTypes: {},
      screens: {},
      events: {},
      projectRoles: {},
      priorities: {},
      resolutions: {},
      linkTypes: {},
      securityLevels: {},
      groups: {},
    };
    const stats = {};

    for (const bucket of Object.keys(remapping)) {
      const sourceEntries = sourceCatalog[bucket] || {};
      const overrideMap = overrides[bucket] || {};
      let resolved = 0;
      let forced = 0;
      let unresolved = 0;

      for (const [sourceId, info] of Object.entries(sourceEntries)) {
        // 1. Explicit override wins.
        if (
          Object.prototype.hasOwnProperty.call(overrideMap, sourceId) &&
          overrideMap[sourceId] !== undefined
        ) {
          remapping[bucket][sourceId] = overrideMap[sourceId] === null
            ? null
            : String(overrideMap[sourceId]);
          forced++;
          continue;
        }

        // 2. Auto-resolve by name.
        const resolvedId = this._resolveFromIndex(bucket, info, idx);
        remapping[bucket][sourceId] = resolvedId;
        if (resolvedId) {
          resolved++;
          if (resolvedId !== sourceId) {
            this.log(
              `  [IdMapper] ${bucket}: ${sourceId} ("${info?.name || "?"}") -> ${resolvedId}`,
            );
          }
        } else {
          unresolved++;
          this.log(
            `  [IdMapper] WARNING ${bucket}: ${sourceId} ("${info?.name || "?"}") not found on target`,
          );
        }
      }

      stats[bucket] = { resolved, forced, unresolved, total: resolved + forced + unresolved };
    }

    // Stash computed stats on the return object for the caller's report.
    Object.defineProperty(remapping, "_stats", { value: stats, enumerable: false });
    return remapping;
  }

  _resolveFromIndex(bucket, info, idx) {
    if (!info || !info.name) return null;

    switch (bucket) {
      case "statuses": {
        const hit = idx.statuses.get(info.name);
        return hit ? hit.id : null;
      }
      case "issueTypes": {
        const hit = idx.issueTypes.get(info.name);
        return hit ? hit.id : null;
      }
      case "screens": {
        const hits = idx.screens.get(info.name);
        if (!hits || hits.length === 0) return null;
        if (hits.length > 1) {
          this.log(
            `  [IdMapper] WARNING screens: "${info.name}" matches ${hits.length} screens on target — picking first. Add an override to disambiguate.`,
          );
        }
        return hits[0].id;
      }
      case "events": {
        const hit = idx.events.get(info.name);
        return hit ? hit.id : null;
      }
      case "projectRoles": {
        const hit = idx.projectRoles.get(info.name);
        return hit ? hit.id : null;
      }
      case "priorities": {
        const hit = idx.priorities.get(info.name);
        return hit ? hit.id : null;
      }
      case "resolutions": {
        const hit = idx.resolutions.get(info.name);
        return hit ? hit.id : null;
      }
      case "linkTypes": {
        const hit = idx.linkTypes.get(info.name);
        return hit ? hit.id : null;
      }
      case "securityLevels": {
        if (!info.schemeName) {
          this.log(
            `  [IdMapper] WARNING securityLevels: "${info.name}" has no schemeName — cannot resolve unambiguously. Add an override.`,
          );
          return null;
        }
        const key = `${info.schemeName}::${info.name}`;
        const hit = idx.securityLevels.get(key);
        return hit ? hit.id : null;
      }
      case "groups": {
        // For groups, we resolve groupName -> target groupId via /group/bulk.
        // This is synchronous against a Map we didn't pre-populate (groups can be large),
        // so we defer to an async lookup path; callers that need groups should invoke
        // resolveGroupByName() directly. Here we leave unresolved; it will be filled later.
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * Resolve a single group by name on the target (async — not part of the pre-indexed catalog).
   */
  async resolveGroupByName(groupName) {
    try {
      const groups = await this.client.getGroupsByName(groupName);
      const exact = groups.find((g) => g.name === groupName);
      return exact ? exact.groupId : null;
    } catch (err) {
      this.log(`  [IdMapper] Error resolving group "${groupName}": ${err.message}`);
      return null;
    }
  }
}

async function safe(fn, log, label) {
  try {
    return await fn();
  } catch (err) {
    log(`  [IdMapper] WARNING: could not load ${label} catalog: ${err.message}`);
    return [];
  }
}

module.exports = IdMapper;
