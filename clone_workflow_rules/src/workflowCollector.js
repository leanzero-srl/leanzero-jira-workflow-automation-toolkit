/**
 * Workflow Collector: --collect mode.
 *
 * Fetches workflows, field mappings, scheme info, and statuses from a source instance.
 * Saves everything to a self-contained directory of JSON files.
 */

const fs = require("fs");
const path = require("path");
const { extractCustomFieldIds, hasJmweRules, hasScriptRunnerRules } = require("./workflowTransformer");
const { scanMany } = require("./referenceScanner");

class WorkflowCollector {
  constructor(client, options = {}) {
    this.client = client;
    this.log = options.log || console.log;
    this.collectDir = options.collectDir;
    this.projectKeys = options.projectKeys || [];
    this.workflowNames = options.workflowNames || [];
    this.allWorkflows = options.allWorkflows || false;
    this.exportScriptRunnerScaffold = options.exportScriptRunnerScaffold || false;
  }

  async run() {
    const startTime = Date.now();

    // Ensure collect directory exists
    const workflowsDir = path.join(this.collectDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });

    this.log(`\nCOLLECT MODE`);
    this.log(`Output directory: ${this.collectDir}`);
    this.log(`${"=".repeat(60)}\n`);

    // ── Step 1: Discover workflows via project schemes ──
    const schemeData = [];
    const discoveredWorkflowNames = new Set();

    if (this.projectKeys.length > 0) {
      this.log(`Resolving workflow schemes for ${this.projectKeys.length} project(s)...`);

      for (const key of this.projectKeys) {
        const project = await this.client.getProjectByKey(key);
        if (!project) {
          this.log(`  WARNING: Project ${key} not found, skipping`);
          continue;
        }

        const scheme = await this.client.getWorkflowSchemeForProject(project.id);
        if (!scheme) {
          this.log(`  WARNING: No workflow scheme found for ${key}, skipping`);
          continue;
        }

        this.log(`  ${key} -> scheme: "${scheme.name}" (ID: ${scheme.id})`);

        const entry = {
          projectKey: key,
          projectId: project.id,
          schemeId: scheme.id,
          schemeName: scheme.name,
          defaultWorkflow: scheme.defaultWorkflow || "jira",
          issueTypeMappings: scheme.issueTypeMappings || {},
        };
        schemeData.push(entry);

        // Collect all workflow names from this scheme
        if (scheme.defaultWorkflow) {
          discoveredWorkflowNames.add(scheme.defaultWorkflow);
        }
        if (scheme.issueTypeMappings) {
          for (const wfName of Object.values(scheme.issueTypeMappings)) {
            discoveredWorkflowNames.add(wfName);
          }
        }
      }
    }

    // Add any explicitly specified workflow names
    for (const name of this.workflowNames) {
      discoveredWorkflowNames.add(name);
    }

    // --all-workflows: enumerate every workflow on the instance.
    if (this.allWorkflows) {
      this.log(`\nEnumerating all workflows on the instance (paginated)...`);
      try {
        const all = await this.client.getAllWorkflows();
        for (const wf of all) {
          const name = wf.id ? wf.id.name : wf.name;
          if (name) discoveredWorkflowNames.add(name);
        }
        this.log(`  Found ${all.length} workflows via /workflow/search`);
      } catch (err) {
        this.log(`  ERROR enumerating workflows: ${err.message}`);
        throw err;
      }
    }

    const allWorkflowNames = [...discoveredWorkflowNames];
    this.log(`\nTotal unique workflows to collect: ${allWorkflowNames.length}`);

    // ── Step 2: Fetch each workflow ──
    this.log(`\nFetching workflow definitions...`);
    const collectedWorkflows = [];
    const allCustomFieldIds = new Set();
    let jmweCount = 0;
    let srCount = 0;

    for (const wfName of allWorkflowNames) {
      this.log(`  Fetching: "${wfName}"...`);
      try {
        const workflow = await this.client.getWorkflowByName(wfName);
        if (!workflow) {
          this.log(`    WARNING: Workflow "${wfName}" not found`);
          continue;
        }

        // Save raw workflow JSON
        const safeName = wfName.replace(/[^a-zA-Z0-9_-]/g, "_");
        const filePath = path.join(workflowsDir, `${safeName}.json`);
        fs.writeFileSync(filePath, JSON.stringify(workflow, null, 2));
        collectedWorkflows.push({ name: wfName, file: `workflows/${safeName}.json` });

        // Detect rule types
        const hasJmwe = hasJmweRules(workflow);
        const hasSR = hasScriptRunnerRules(workflow);
        const markers = [];
        if (hasJmwe) { markers.push("JMWE"); jmweCount++; }
        if (hasSR) { markers.push("ScriptRunner"); srCount++; }
        this.log(`    Saved (${markers.length > 0 ? markers.join(", ") : "standard rules"})`);

        // Extract custom field references
        const cfIds = extractCustomFieldIds(workflow);
        for (const id of cfIds) {
          allCustomFieldIds.add(id);
        }
      } catch (err) {
        this.log(`    ERROR: ${err.message}`);
      }
    }

    // ── Step 3: Resolve custom field names ──
    const fieldMapping = {};
    if (allCustomFieldIds.size > 0) {
      this.log(`\nResolving ${allCustomFieldIds.size} custom field name(s)...`);
      for (const cfId of allCustomFieldIds) {
        try {
          const field = await this.client.getFieldById(cfId);
          if (field) {
            fieldMapping[cfId] = field.name;
            this.log(`  ${cfId} -> "${field.name}"`);
          } else {
            fieldMapping[cfId] = null;
            this.log(`  ${cfId} -> NOT FOUND`);
          }
        } catch (err) {
          fieldMapping[cfId] = null;
          this.log(`  ${cfId} -> ERROR: ${err.message}`);
        }
      }
    }

    // ── Step 4: Fetch all statuses ──
    this.log(`\nFetching statuses...`);
    let statusMap = {};
    try {
      const allStatuses = await this.client.getAllStatuses();
      for (const s of allStatuses) {
        statusMap[s.id] = {
          id: s.id,
          name: s.name,
          statusCategory: s.statusCategory,
        };
      }
      this.log(`  Found ${Object.keys(statusMap).length} statuses`);
    } catch (err) {
      this.log(`  WARNING: Could not fetch statuses: ${err.message}`);
      this.log(`  Falling back to extracting statuses from workflows...`);
      // Fallback: extract from collected workflows
      for (const wf of collectedWorkflows) {
        const wfData = JSON.parse(
          fs.readFileSync(path.join(this.collectDir, wf.file), "utf8"),
        );
        if (wfData.statuses) {
          for (const s of wfData.statuses) {
            if (s.id && !statusMap[s.id]) {
              statusMap[s.id] = {
                id: s.id,
                name: s.name || `Status ${s.id}`,
                statusCategory: s.statusCategory || "UNDEFINED",
              };
            }
          }
        }
      }
    }

    // ── Step 4b: Resolve referenced entity IDs (for cross-instance remapping) ──
    this.log(`\nScanning workflows for cross-instance entity references...`);
    const rawWorkflows = collectedWorkflows.map((wf) =>
      JSON.parse(fs.readFileSync(path.join(this.collectDir, wf.file), "utf8")),
    );
    const refs = scanMany(rawWorkflows);

    // Seed issue-type references from workflow schemes (keys of issueTypeMappings).
    // These never appear inside workflow JSONs, so the scanner alone misses them.
    for (const scheme of schemeData) {
      for (const itId of Object.keys(scheme.issueTypeMappings || {})) {
        refs.embedded.issueTypes.push(String(itId));
      }
    }
    // Dedupe the issue-types bucket in case some were also referenced by rules.
    refs.embedded.issueTypes = [...new Set(refs.embedded.issueTypes)].sort();

    // Build event-name hints from FireIssueEventFunction.event (the only place custom
    // event names can be sourced, since /rest/api/3/events doesn't return them).
    const eventNameHints = this._extractEventNameHints(rawWorkflows);

    const idCatalog = await this.resolveIdCatalog(refs, statusMap, eventNameHints);

    // Save both the resolved catalog and a skeleton overrides file for operator curation.
    fs.writeFileSync(
      path.join(this.collectDir, "id_mapping.json"),
      JSON.stringify(idCatalog, null, 2),
    );
    const overridesPath = path.join(this.collectDir, "id_overrides.json.example");
    if (!fs.existsSync(overridesPath)) {
      fs.writeFileSync(
        overridesPath,
        JSON.stringify(this.buildOverridesSkeleton(idCatalog), null, 2),
      );
    }

    // ── Step 5: Save metadata files ──
    this.log(`\nSaving metadata files...`);

    // metadata.json
    const metadata = {
      sourceUrl: this.client.baseUrl,
      collectedAt: new Date().toISOString(),
      projectKeys: this.projectKeys,
      workflowNames: allWorkflowNames,
      workflows: collectedWorkflows,
      stats: {
        totalWorkflows: collectedWorkflows.length,
        workflowsWithJmwe: jmweCount,
        workflowsWithScriptRunner: srCount,
        customFieldsReferenced: Object.keys(fieldMapping).length,
      },
      scriptVersion: "1.0.0",
    };
    fs.writeFileSync(
      path.join(this.collectDir, "metadata.json"),
      JSON.stringify(metadata, null, 2),
    );

    // field_mapping.json
    fs.writeFileSync(
      path.join(this.collectDir, "field_mapping.json"),
      JSON.stringify(fieldMapping, null, 2),
    );

    // workflow_schemes.json
    fs.writeFileSync(
      path.join(this.collectDir, "workflow_schemes.json"),
      JSON.stringify(schemeData, null, 2),
    );

    // statuses.json
    fs.writeFileSync(
      path.join(this.collectDir, "statuses.json"),
      JSON.stringify(statusMap, null, 2),
    );

    // ── Step 6: ScriptRunner scaffold (optional) ──
    if (this.exportScriptRunnerScaffold && srCount > 0) {
      this.log(`\nGenerating ScriptRunner SMS scaffold...`);
      const ScriptRunnerExporter = require("./scriptRunnerExporter");
      const exporter = new ScriptRunnerExporter(this.collectDir, this.log);
      await exporter.generate(collectedWorkflows);
    }

    // ── Report ──
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const stats = this.client.getStats();

    this.log(`\n${"=".repeat(60)}`);
    this.log(`COLLECT COMPLETE`);
    this.log(`${"=".repeat(60)}`);
    this.log(`  Workflows collected: ${collectedWorkflows.length}`);
    this.log(`    With JMWE rules: ${jmweCount}`);
    this.log(`    With ScriptRunner rules: ${srCount}`);
    this.log(`  Custom fields mapped: ${Object.keys(fieldMapping).length}`);
    this.log(`  Statuses recorded: ${Object.keys(statusMap).length}`);
    this.log(`  Workflow schemes: ${schemeData.length}`);
    this.log(`  API requests: ${stats.requestCount} (${stats.errorCount} errors, ${stats.rateLimitCount} rate limits)`);
    this.log(`  Output: ${this.collectDir}`);
    this.log(`  Elapsed: ${elapsed}s`);

    return metadata;
  }

  /**
   * Resolve source-instance entity catalogs for every ID referenced by the workflows.
   *
   * For each bucket we return a { sourceId: { name, ...context } } map. `null` values
   * mean "referenced but could not resolve on source" — usually a stale ID in the
   * workflow that we'll propagate as a warning through to --apply.
   */
  async resolveIdCatalog(refs, statusMap, eventNameHints = {}) {
    // Statuses: prefer statusMap already fetched in Step 4; fall back to source name scan.
    const statuses = {};
    for (const id of refs.structural.statuses.concat(refs.embedded.statuses)) {
      if (statuses[id] !== undefined) continue;
      const hit = statusMap[id];
      if (hit) {
        statuses[id] = { name: hit.name, statusCategory: hit.statusCategory };
      } else {
        statuses[id] = { name: null };
        this.log(`  [id-catalog] statuses: ${id} referenced but not in source status list`);
      }
    }

    // Everything else: fetch the target entity catalog and index by id.
    const issueTypes = await this._resolveBucket(
      "issueTypes",
      refs.embedded.issueTypes,
      () => this.client.getAllIssueTypes(),
      (it) => ({
        name: it.name,
        hierarchyLevel: it.hierarchyLevel,
      }),
    );
    const screens = await this._resolveBucket(
      "screens",
      [...refs.structural.screens, ...refs.embedded.screens],
      () => this.client.getAllScreens(),
      (sc) => ({ name: sc.name, description: sc.description }),
    );
    const events = await this._resolveEvents(
      [...refs.structural.events, ...refs.embedded.events],
      eventNameHints,
    );
    const projectRoles = await this._resolveBucket(
      "projectRoles",
      refs.embedded.projectRoles,
      () => this.client.getAllProjectRoles(),
      (r) => ({ name: r.name }),
    );
    const priorities = await this._resolveBucket(
      "priorities",
      refs.embedded.priorities,
      () => this.client.getAllPriorities(),
      (p) => ({ name: p.name }),
    );
    const resolutions = await this._resolveBucket(
      "resolutions",
      refs.embedded.resolutions,
      () => this.client.getAllResolutions(),
      (r) => ({ name: r.name }),
    );
    const linkTypes = await this._resolveBucket(
      "linkTypes",
      refs.embedded.linkTypes,
      () => this.client.getAllIssueLinkTypes(),
      (lt) => ({ name: lt.name, inward: lt.inward, outward: lt.outward }),
    );

    // Security levels: need scheme->levels join.
    const securityLevels = await this._resolveSecurityLevels(refs.embedded.securityLevels);

    // Groups: source-side is authoritative via /group/bulk (keyed by groupId post-GDPR).
    // We only record what was referenced; target resolution happens in --apply.
    const groups = {};
    for (const id of refs.embedded.groups) {
      groups[id] = { name: null };
    }

    return {
      collectedFrom: this.client.baseUrl,
      collectedAt: new Date().toISOString(),
      statuses,
      issueTypes,
      screens,
      events,
      projectRoles,
      priorities,
      resolutions,
      linkTypes,
      securityLevels,
      groups,
      // accountIds and literal groupNames are not auto-resolved; we just pass them
      // through as warnings so the operator can cross-check users/groups on target.
      users: [...refs.embedded.users],
    };
  }

  async _resolveBucket(label, referencedIds, fetchFn, projectFn) {
    const out = {};
    const needed = new Set(referencedIds.map(String));
    if (needed.size === 0) return out;

    this.log(`  [id-catalog] ${label}: resolving ${needed.size} referenced ID(s)`);
    let catalog;
    try {
      catalog = await fetchFn();
    } catch (err) {
      this.log(`  [id-catalog] ${label}: FAILED to fetch catalog: ${err.message}`);
      for (const id of needed) out[id] = { name: null };
      return out;
    }

    const byId = new Map();
    for (const entry of catalog || []) {
      if (entry && entry.id !== undefined) {
        byId.set(String(entry.id), entry);
      }
    }
    for (const id of needed) {
      const hit = byId.get(id);
      if (hit) {
        out[id] = projectFn(hit);
      } else {
        out[id] = { name: null };
        this.log(`  [id-catalog] ${label}: ${id} referenced but not found on source`);
      }
    }
    return out;
  }

  /**
   * Walk workflows and extract event-name hints from FireIssueEventFunction configs.
   * Jira's public /rest/api/3/events endpoint returns only the subset it chooses to
   * expose, which in practice excludes many custom workflow events. Those are only
   * obtainable from the workflow JSON itself, so we harvest any populated .event.name.
   *
   * @param {Array<object>} rawWorkflows
   * @returns {Object.<string, string|null>} map of eventId -> name (or null)
   */
  _extractEventNameHints(rawWorkflows) {
    const hints = {};
    for (const wf of rawWorkflows) {
      for (const t of wf.transitions || []) {
        for (const pf of (t.rules || {}).postFunctions || []) {
          if (
            pf.type &&
            pf.type.includes("FireIssueEventFunction") &&
            pf.configuration &&
            pf.configuration.event
          ) {
            const id = pf.configuration.event.id;
            if (id === undefined || id === null) continue;
            const key = String(id);
            if (hints[key] === undefined || hints[key] === null) {
              hints[key] = pf.configuration.event.name || null;
            }
          }
        }
      }
    }
    return hints;
  }

  /**
   * Resolve referenced event IDs with a name-hint-first strategy:
   *   1. If a hint name is present (from FireIssueEventFunction.event.name), use it.
   *   2. Else query /rest/api/3/events and match by ID.
   *   3. Else record {name: null} so the operator can override.
   */
  async _resolveEvents(referencedIds, hints) {
    const out = {};
    const needed = new Set(referencedIds.map(String));
    if (needed.size === 0) return out;

    this.log(`  [id-catalog] events: resolving ${needed.size} referenced ID(s)`);
    let catalog;
    try {
      catalog = await this.client.getAllEvents();
    } catch (err) {
      this.log(`  [id-catalog] events: FAILED to fetch catalog: ${err.message} — using hints only`);
      catalog = [];
    }
    const byId = new Map();
    for (const e of catalog || []) {
      if (e && e.id !== undefined) byId.set(String(e.id), e);
    }
    for (const id of needed) {
      const hintName = hints[id];
      if (hintName) {
        out[id] = { name: hintName, source: "workflow" };
        continue;
      }
      const hit = byId.get(id);
      if (hit && hit.name) {
        out[id] = { name: hit.name, source: "events-api" };
        continue;
      }
      out[id] = { name: null };
      this.log(`  [id-catalog] events: ${id} referenced but not found on source (custom event — add to id_overrides.json)`);
    }
    return out;
  }

  async _resolveSecurityLevels(referencedIds) {
    const out = {};
    const needed = new Set([...referencedIds].map(String));
    if (needed.size === 0) return out;

    this.log(`  [id-catalog] securityLevels: resolving ${needed.size} referenced ID(s)`);
    let schemes;
    try {
      schemes = await this.client.getAllSecuritySchemes();
    } catch (err) {
      this.log(`  [id-catalog] securityLevels: FAILED to fetch schemes: ${err.message}`);
      for (const id of needed) out[id] = { name: null };
      return out;
    }

    for (const scheme of schemes || []) {
      if (needed.size === 0) break;
      let detail;
      try {
        detail = await this.client.getSecuritySchemeById(scheme.id);
      } catch (err) {
        this.log(`  [id-catalog] securityLevels: scheme ${scheme.id}: ${err.message}`);
        continue;
      }
      for (const level of detail?.levels || []) {
        const id = String(level.id);
        if (needed.has(id)) {
          out[id] = { name: level.name, schemeName: scheme.name, schemeId: String(scheme.id) };
          needed.delete(id);
        }
      }
    }
    for (const id of needed) {
      out[id] = { name: null };
      this.log(`  [id-catalog] securityLevels: ${id} referenced but no matching level found`);
    }
    return out;
  }

  /**
   * Produce a skeleton id_overrides.json that the operator can rename and hand-edit.
   * Only includes IDs that failed source resolution (name: null) — those are the
   * hard cases where auto-resolve won't work on the target either.
   */
  buildOverridesSkeleton(catalog) {
    const skeleton = {};
    const buckets = [
      "statuses", "issueTypes", "screens", "events", "projectRoles",
      "priorities", "resolutions", "linkTypes", "securityLevels", "groups",
    ];
    for (const bucket of buckets) {
      const entries = catalog[bucket] || {};
      const unresolved = Object.entries(entries).filter(([, v]) => !v || !v.name);
      if (unresolved.length === 0) continue;
      skeleton[bucket] = {};
      for (const [sourceId] of unresolved) {
        skeleton[bucket][sourceId] = "<target-id-or-null>";
      }
    }
    skeleton._help = [
      "This file is a SKELETON. Rename to id_overrides.json, hand-edit target IDs,",
      "then re-run --apply. Any entry here wins over auto-resolution by name.",
      "Use null to force a field/value to be stripped from configs.",
    ];
    return skeleton;
  }
}

module.exports = WorkflowCollector;
