const fs = require("fs");
const path = require("path");

const {
  alignTransitions,
  indexCloudTransitions,
  resolveCloudTransition,
} = require("./transitionMatcher");
const { hasNativeMapper, convertToNative } = require("./jsuNativeMappers");
const { hasJmweMapper, convertToJmwe } = require("./jsuJmweMappers");
const { JMWE_APP_KEY_DEFAULT } = require("./jsuRuleCatalog");
const { uuidv4, hashParams, safeFilename, timestampSlug, isoNow } = require("./utils");
const FieldMapper = require("../../clone_workflow_rules/src/fieldMapper");
const {
  ruleFingerprint: sharedRuleFingerprint,
  connectRuleFingerprint: sharedConnectRuleFingerprint,
  collectRuleFps: sharedCollectRuleFps,
  migrationFingerprint: sharedMigrationFingerprint,
} = require("./ruleFingerprint");
const writeManualReviewWorkbook = require("./manualReviewExcelWriter");
const { writeUnmappedCsv } = require("./unmappedCsvWriter");
const { verifyAdditive } = require("./additiveDiffGuardrail");
const { readLedger, appendLedger } = require("./migrationLedger");
const { verifyInstanceSignature } = require("./instanceSignature");

/**
 * Phase 2: apply the conversion plan against the Cloud target.
 *
 *   - Re-fetch each target Cloud workflow live (for a fresh {id, version}).
 *   - Align transitions with the DC inventory by name.
 *   - For each plan row (grouped by workflow), build a converted rule and append
 *     it to the matching Cloud transition's validators / actions / conditions.
 *   - Idempotency: skip appending if a rule with the same ruleKey + normalized
 *     parameters hash already exists on that transition.
 *   - Build the /workflows/update body and either:
 *       • POST to /workflows/update/validation when --validate-only,
 *       • save the payload to disk when --dry-run,
 *       • POST to /workflows/update otherwise.
 */
class JsuApplier {
  constructor(cloudClient, config, options) {
    this.cloud = cloudClient;
    this.config = config || {};
    this.log = options.log;
    this.collectDir = options.collectDir;
    this.validateOnly = !!options.validateOnly;
    this.dryRun = !!options.dryRun;
    this.force = !!options.force;
    this.ignoreErrors = !!options.ignoreErrors;
    this.disableJmwe = !!options.disableJmwe;
    // When the collect dir's stamped instance signature doesn't match the
    // currently-configured (DC, Cloud) pair, refuse to apply unless this
    // override is explicitly passed. Catches the catastrophic case of
    // re-using yesterday's plan against a fresh tenant pair tomorrow.
    this.allowInstanceMismatch = !!options.allowInstanceMismatch;
    this.workflowFilter = Array.isArray(options.workflowNames) && options.workflowNames.length > 0
      ? new Set(options.workflowNames)
      : null;
    // Workflows backing any of these project keys must never be touched —
    // resolved via Cloud workflow scheme lookup at run() time. Recommended
    // pair on this tenant: ["BUILD","SD"] (manually reviewed; out of scope
    // for any automated re-push).
    this.excludeProjects = Array.isArray(options.excludeProjects)
      ? options.excludeProjects
      : [];
    this.excludedWorkflowNames = new Set(); // populated in run() before processing
    // --runas-fallback CLI: Cloud accountId to substitute when a DC username
    // can't be resolved on Cloud. See _preResolveRunAsUsers.
    this.runasFallback = options.runasFallback || null;
    // Reserved for Iteration 2; the v2 fingerprint engine threads
    // status/role/group/asset name normalization through ruleFingerprint.
    this.matcherV2 = !!options.matcherV2;
    this.jmweAppKey = (config && config.jmwe && config.jmwe.appKey) || JMWE_APP_KEY_DEFAULT;

    this._loadArtifacts();
    this._verifyInstanceSignature();
  }

  _verifyInstanceSignature() {
    verifyInstanceSignature(this.metadata, this.config, {
      allowMismatch: this.allowInstanceMismatch,
      log: this.log,
      modeLabel: "apply",
    });
  }

  _loadArtifacts() {
    const load = (name, optional) => {
      const p = path.join(this.collectDir, name);
      if (!fs.existsSync(p)) {
        if (optional) return null;
        throw new Error(`Missing required file: ${p}`);
      }
      return JSON.parse(fs.readFileSync(p, "utf8"));
    };
    this.inventory = load("jsu_rule_inventory.json");
    this.conversionPlan = load("conversion_plan.json");
    this.targetLookup = load("cloud_target_workflows.json");
    this.metadata = load("metadata.json", true) || {};

    // Field mapping precedence:
    //   1. config.fieldMappingFile — user-supplied {dcId: dcName} JSON
    //   2. <collectDir>/field_mapping.json — written by the collector from DC's catalog
    //   3. empty (identity-mapping; DC IDs sent to Cloud as-is — usually wrong)
    let dcNameMap = {};
    const fieldMappingFile = this.config.fieldMappingFile;
    if (fieldMappingFile && fs.existsSync(fieldMappingFile)) {
      dcNameMap = JSON.parse(fs.readFileSync(fieldMappingFile, "utf8"));
    } else {
      const collected = path.join(this.collectDir, "field_mapping.json");
      if (fs.existsSync(collected)) {
        dcNameMap = JSON.parse(fs.readFileSync(collected, "utf8"));
      }
    }
    this.dcFieldNames = dcNameMap;
    // The actual {dcId: cloudId} map is built lazily in run(), once the cloud
    // client has resolved each name. Identity-fall-through if no DC names.
    this.fieldRemapping = {};

    const idOverridesFile = this.config.idOverridesFile;
    if (idOverridesFile && fs.existsSync(idOverridesFile)) {
      this.idRemapping = JSON.parse(fs.readFileSync(idOverridesFile, "utf8"));
    } else {
      this.idRemapping = {};
    }
  }

  async _buildFieldRemapping() {
    const named = Object.entries(this.dcFieldNames || {}).filter(([, name]) => !!name);
    if (named.length === 0) {
      this.log.warn(
        "No DC field name catalog available; field IDs will be sent to Cloud as-is " +
          "(likely WRONG since DC and Cloud have different customfield IDs).",
      );
      return;
    }
    this.log.info(`Resolving ${named.length} DC field name(s) on Cloud target...`);
    const mapper = new FieldMapper(this.cloud, (m) => this.log.info(m));
    const sourceMap = Object.fromEntries(named);
    this.fieldRemapping = await mapper.buildMapping(sourceMap);

    // === Patch D (2026-05-10): operator-curated overrides for ambiguous fields ===
    // FieldMapper.searchExactField returns the first Cloud field whose name
    // matches exactly. When two Cloud fields share a name (e.g. "Category"
    // existing as both a select and a JWM-category), the pick is the first
    // result the API happens to return — non-deterministic from the operator's
    // POV. To fix that case, the operator can drop a JSON file of explicit
    // {dcFieldId: cloudFieldId} picks into either:
    //   1. <collectDir>/field_id_overrides.json   (collect-dir scoped, preferred)
    //   2. config.fieldIdOverridesFile             (global, set in config.json)
    // and we apply it AFTER FieldMapper, before persisting. Overriding to
    // `null` is allowed and tells the applier "leave this field unmapped".
    const overrides = this._loadFieldIdOverrides();
    let overrideHits = 0;
    for (const [dcId, cloudId] of Object.entries(overrides)) {
      if (!Object.prototype.hasOwnProperty.call(this.fieldRemapping, dcId)) {
        // Operator-supplied override for a field we never harvested — log
        // and ignore rather than silently inserting noise into the map.
        this.log.warn(
          `Field-ID override for ${dcId} ignored: not referenced by any harvested rule`,
        );
        continue;
      }
      const before = this.fieldRemapping[dcId];
      if (before === cloudId) continue;
      this.log.info(
        `Field-ID override applied: ${dcId} ("${this.dcFieldNames[dcId]}") ${before} → ${cloudId}`,
      );
      this.fieldRemapping[dcId] = cloudId;
      overrideHits++;
    }
    if (overrideHits > 0) {
      this.log.info(`Field-ID overrides applied: ${overrideHits}`);
    }

    // Persist the resolved map for audit + re-runs.
    fs.writeFileSync(
      path.join(this.collectDir, "field_remapping_resolved.json"),
      JSON.stringify(this.fieldRemapping, null, 2),
    );
  }

  _loadFieldIdOverrides() {
    const candidates = [
      path.join(this.collectDir, "field_id_overrides.json"),
      this.config && this.config.fieldIdOverridesFile,
    ].filter(Boolean);
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
        // Filter to entries that look like {customfield_NNN: customfield_MMM | null}.
        // Anything else (comments, _help) is silently ignored.
        const out = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (!/^customfield_\d+$/.test(k)) continue;
          if (v !== null && !/^customfield_\d+$/.test(String(v))) continue;
          out[k] = v;
        }
        if (Object.keys(out).length > 0) {
          this.log.info(`Loaded ${Object.keys(out).length} field-ID override(s) from ${p}`);
          return out;
        }
      } catch (e) {
        this.log.warn(`Failed to parse field-ID overrides at ${p}: ${e.message}`);
      }
    }
    return {};
  }

  /**
   * Build {dcStatusId → cloudStatusId} by matching status names, parallel to
   * `_buildFieldRemapping`. The DC catalog comes from
   * `<collectDir>/dc_status_catalog.json` (written by --collect from DC's
   * `/rest/api/2/status`); the Cloud side comes from
   * `GET /rest/api/3/status` resolved here.
   *
   * Status IDs in DC and Cloud are independent number-spaces, so the only
   * stable bridge is the human-visible status name. Persisted alongside the
   * field map for audit and re-run reuse.
   */
  async _buildStatusRemapping() {
    this.statusRemapping = {};
    this.dcStatusCatalog = {};
    const dcCatalogPath = path.join(this.collectDir, "dc_status_catalog.json");
    if (!fs.existsSync(dcCatalogPath)) {
      this.log.warn(
        "No dc_status_catalog.json — status IDs will be sent to Cloud as-is. " +
          "Re-run --collect to populate it.",
      );
      return;
    }
    let dcStatuses;
    try {
      dcStatuses = JSON.parse(fs.readFileSync(dcCatalogPath, "utf8"));
      // Surface the {dcId: dcName} catalog to mappers via ctx.dcStatusCatalog
      // so name-based mappers (JMWE ParentStatusValidator carries
      // `jira.parentstatuses: "Implementation@@..."`) can resolve through.
      this.dcStatusCatalog = dcStatuses || {};
    } catch (e) {
      this.log.warn(`Failed to parse dc_status_catalog.json: ${e.message}`);
      return;
    }
    let cloudStatuses;
    try {
      cloudStatuses = await this.cloud.makeRequest("GET", "/rest/api/3/status");
    } catch (e) {
      this.log.warn(`Failed to fetch Cloud status catalog: ${e.message}`);
      return;
    }
    // Cloud may return multiple statuses with the same name across scopes.
    // Prefer global-scope statuses, then fall back to project-scope.
    const cloudByName = new Map();
    for (const s of cloudStatuses || []) {
      if (!s || !s.id || !s.name) continue;
      const key = s.name.trim().toLowerCase();
      const existing = cloudByName.get(key);
      const isGlobal = !s.scope || s.scope.type === "GLOBAL";
      if (!existing || (isGlobal && existing._scopePref !== "global")) {
        cloudByName.set(key, { ...s, _scopePref: isGlobal ? "global" : "project" });
      }
    }
    let resolved = 0;
    let unresolved = 0;
    for (const [dcId, dcName] of Object.entries(dcStatuses || {})) {
      if (!dcName) { unresolved++; continue; }
      const m = cloudByName.get(String(dcName).trim().toLowerCase());
      if (m && m.id) {
        this.statusRemapping[String(dcId)] = String(m.id);
        resolved++;
      } else {
        unresolved++;
      }
    }
    fs.writeFileSync(
      path.join(this.collectDir, "status_remapping_resolved.json"),
      JSON.stringify(this.statusRemapping, null, 2),
    );
    this.log.info(
      `Status remapping: ${resolved} resolved, ${unresolved} unresolved (no Cloud status with matching name).`,
    );
  }

  /**
   * Build the Cloud project role catalog as `{ roleId: roleName }`. Used by
   * `_collapseNativeJmweRoleDuplicates` to decide when a JMWE expression-
   * condition carrying a role-name array is semantically equivalent to a
   * native `system:restrict-issue-transition` carrying a role-id CSV (in
   * which case the JMWE copy is the duplicate to drop).
   *
   * Failure to fetch is non-fatal — the dedup pass just won't find any
   * matches without it. Surfaced as a WARN so an operator sees it in logs.
   */

  /**
   * Build the set of workflow names that must be skipped because they back
   * at least one project listed in --exclude-projects. Resolved live via
   * Cloud `/project/{key}` → `/workflowscheme/project?projectId=` →
   * `/workflowscheme/<id>` so the protection follows scheme edits without
   * the operator having to re-collect.
   *
   * Lives on the applier to keep the apply path self-contained, but uses
   * the same CloudCatalogFetcher helper as the sanitizer so the two paths
   * stay in lockstep.
   */
  async _resolveExcludedWorkflowNames() {
    if (!this.excludeProjects || this.excludeProjects.length === 0) {
      this.excludedWorkflowNames = new Set();
      return;
    }
    const CloudCatalogFetcher = require("./cloudCatalogFetcher");
    const fetcher = new CloudCatalogFetcher(this.cloud, this.log);
    this.excludedWorkflowNames = await fetcher.resolveExcludedWorkflowNames(
      this.excludeProjects,
    );
    if (this.excludedWorkflowNames.size > 0) {
      this.log.info(
        `--exclude-projects: ${this.excludedWorkflowNames.size} workflow(s) protected from this run`,
      );
    }
  }

  async run() {
    this.log.info(
      `Apply phase: validateOnly=${this.validateOnly} dryRun=${this.dryRun} force=${this.force} disableJmwe=${this.disableJmwe}`,
    );

    await this._buildFieldRemapping();
    await this._buildStatusRemapping();
    await this._loadCloudFieldCatalog();
    await this._resolveExcludedWorkflowNames();
    await this._preResolveRunAsUsers();

    const rowsByWorkflow = this._groupRowsByWorkflow();
    const workflowNames = [...rowsByWorkflow.keys()].filter(
      (n) => !this.workflowFilter || this.workflowFilter.has(n),
    );
    this.log.info(`Will process ${workflowNames.length} workflow(s)`);

    const report = {
      generatedAt: isoNow(),
      cloudBaseUrl: this.cloud.baseUrl,
      validateOnly: this.validateOnly,
      dryRun: this.dryRun,
      force: this.force,
      excludeProjects: this.excludeProjects,
      workflows: [],
      unmappedRules: [],
      // Rows the live Cloud snapshot proved are already present BEFORE we
      // touched anything. These are NOT manual-review concerns — they're the
      // dedup guarantee in action. Surfaced separately so an operator can see
      // that re-runs converge instead of pile up.
      alreadyOnCloud: [],
      // Workflows skipped because they back at least one project listed in
      // --exclude-projects. Surfaced so the operator can confirm the filter
      // took effect (vs. being silently dropped on the floor).
      excludedWorkflows: [],
    };

    for (const workflowName of workflowNames) {
      const rows = rowsByWorkflow.get(workflowName);
      if (this.excludedWorkflowNames.has(workflowName)) {
        this.log.info(
          `Skipping "${workflowName}" — backed by --exclude-projects (${this.excludeProjects.join(", ")})`,
        );
        report.excludedWorkflows.push({
          workflowName,
          projects: this.excludeProjects,
          source: "--exclude-projects (workflow scheme lookup)",
        });
        report.workflows.push({
          workflowName,
          status: "excluded_by_project_filter",
          excludedFor: this.excludeProjects,
        });
        continue;
      }
      try {
        const result = await this._processWorkflow(workflowName, rows);
        report.workflows.push(result);
        if (Array.isArray(result.unmappedRules)) {
          report.unmappedRules.push(...result.unmappedRules);
        }
        if (Array.isArray(result.alreadyOnCloud)) {
          report.alreadyOnCloud.push(...result.alreadyOnCloud);
        }
      } catch (err) {
        this.log.error(`Workflow "${workflowName}" failed: ${err.message}`);
        report.workflows.push({
          workflowName,
          status: "error",
          error: err.message,
        });
      }
    }

    const reportPath = path.join(this.collectDir, `apply_${timestampSlug()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    this.log.info(`Apply report written to ${reportPath}`);

    const unmappedPath = path.join(this.collectDir, "unmapped_rules.json");
    fs.writeFileSync(unmappedPath, JSON.stringify(report.unmappedRules, null, 2));
    this.log.info(`Unmapped rules written to ${unmappedPath}`);

    // Operator-friendly CSV alongside the JSON. One row per unmigrated rule,
    // ready to open in Excel / Google Sheets without any post-processing.
    // Schema documented in src/unmappedCsvWriter.js header.
    const unmappedCsvPath = path.join(
      this.collectDir,
      `unmapped_${timestampSlug()}.csv`,
    );
    try {
      const { rowCount } = writeUnmappedCsv(unmappedCsvPath, report.unmappedRules, {
        workflowNameOverrides: (this.config && this.config.workflowNameOverrides) || {},
      });
      this.log.info(`Unmapped rules CSV written to ${unmappedCsvPath} (${rowCount} row(s))`);
    } catch (e) {
      this.log.warn(`Could not write unmapped CSV: ${e.message}`);
    }

    const alreadyOnCloudPath = path.join(this.collectDir, "already_on_cloud.json");
    fs.writeFileSync(alreadyOnCloudPath, JSON.stringify(report.alreadyOnCloud, null, 2));
    this.log.info(
      `Already-on-Cloud (dedup-skipped) rules written to ${alreadyOnCloudPath} ` +
      `(${report.alreadyOnCloud.length} rule(s) deduplicated against live Cloud snapshot)`,
    );

    // Build the operator-facing manual-review Excel summary at the very end.
    // Aggregates every artifact that flags something for human follow-up:
    // manual-review rows, mapper failures, validation errors, field/status
    // catalog gaps, disabled Connect rules, unknown JSU shortNames, workflows
    // missing on Cloud, and the dedup audit trail. Failure to write the
    // workbook should never block the apply run — surface as a warning only.
    try {
      const xlsxPath = await writeManualReviewWorkbook({
        collectDir: this.collectDir,
        applier: this,
        report,
        log: this.log,
      });
      if (xlsxPath) {
        this.log.info(`Manual-review summary workbook written to ${xlsxPath}`);
      }
    } catch (err) {
      this.log.warn(`Failed to write manual-review Excel workbook: ${err.message}`);
      if (process.env.DEBUG) console.error(err.stack);
    }

    return report;
  }

  _groupRowsByWorkflow() {
    const out = new Map();
    const rows = (this.conversionPlan && this.conversionPlan.rows) || [];
    for (const row of rows) {
      const key = row.workflowName;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push(row);
    }
    return out;
  }

  async _processWorkflow(workflowName, rows) {
    this.log.info(`Processing "${workflowName}" with ${rows.length} plan row(s)`);
    const cloudWorkflow = await this._fetchCloudWorkflow(workflowName);
    if (!cloudWorkflow) {
      this.log.warn(`Cloud workflow "${workflowName}" not found — skipping`);
      return { workflowName, status: "skipped_not_on_cloud" };
    }

    const dcInventory = this.inventory.workflows && this.inventory.workflows[workflowName];
    const dcTransitions = dcInventory
      ? dcInventory.transitions.map((t) => ({
          transitionId: t.transitionId,
          transitionName: t.transitionName,
          transitionFromStatusIds: t.transitionFromStatusIds || [],
          transitionToStatusId: t.transitionToStatusId || null,
          transitionType: t.transitionType || null,
        }))
      : [];
    const alignment = alignTransitions(dcTransitions, cloudWorkflow);
    this.log.info(
      `Transition alignment: id=${alignment.matchTypeCounts.id} ` +
      `triple=${alignment.matchTypeCounts.triple} ` +
      `unique-name=${alignment.matchTypeCounts["unique-name"]} ` +
      `unmatched=${alignment.unmatched.length} ` +
      `cloud-only=${alignment.cloudOnly.length}`,
    );
    if (alignment.unmatched.length > 0) {
      const sample = alignment.unmatched
        .slice(0, 5)
        .map((u) => `"${u.dc.transitionName}"#${u.dc.transitionId}: ${u.reason}`)
        .join("; ");
      const msg = `Unmatched DC transitions (${alignment.unmatched.length}): ${sample}${
        alignment.unmatched.length > 5 ? " ..." : ""
      }`;
      if (this.force) {
        this.log.warn(msg);
      } else {
        throw new Error(`${msg}. Use --force to proceed anyway.`);
      }
    }

    // Build the mapper context EARLY so the pre-snapshot repair passes have
    // access to fieldRemapping / cloudFieldNames / status maps. Mappers and
    // sanitizers depend on these but none of the values are workflow-specific,
    // so building once per workflow is fine. The same `ctx` object is reused
    // for plan-row conversion below.
    const ctx = {
      fieldRemapping: this.fieldRemapping,
      // cloudFieldNames maps cloud field IDs → display names. The Nunjucks
      // translator uses this to emit `issue.fields["Raised By"]` instead
      // of the broken `issue.fields.customfield_10389` (JMWE Cloud's Nunjucks
      // engine resolves custom fields by display name, not ID).
      cloudFieldNames: this.cloudFieldNames || {},
      statusRemapping: this.statusRemapping || {},
      // The DC status catalog ({dcId: dcName}) — needed by mappers that
      // resolve status NAMES (e.g. JMWE ParentStatusValidator's
      // `jira.parentstatuses: "Implementation@@..."`) into Cloud IDs via
      // name match. Loaded into the applier via _buildStatusRemapping.
      dcStatusCatalog: this.dcStatusCatalog || {},
      dcFieldNames: this.dcFieldNames || {},
      idRemapping: this.idRemapping,
      jmweAppKey: this.jmweAppKey,
      // Full DC inventory keyed by workflow name. Mappers that reference
      // OTHER workflows (e.g. BeeCom LinkedTransition with `workflowName-textValue`)
      // use this to resolve transition IDs to transition names.
      dcInventory: this.inventory,
      // Pre-resolved DC-username → Cloud-accountId map (built once per
      // apply by `_preResolveRunAsUsers`). Mappers consume it synchronously
      // via `cloudUserResolver.resolveRunAs`.
      dcUserMap: this.dcUserMap || {},
      warnings: [],
    };

    // === Dedup freshness lock ===
    // Take a fingerprint snapshot of the LIVE Cloud workflow IMMEDIATELY after
    // fetching, BEFORE any of our patches touch it. Two purposes:
    //   1) Provable dedup: every row whose converted rule fingerprint is
    //      already in the snapshot is classified as "already-on-cloud" and
    //      never appended (regardless of how dedup downstream behaves).
    //   2) Auditability: the snapshot is persisted to disk with a fetch
    //      timestamp so an operator can prove this run looked at fresh state.
    //      The collect-time `cloud_target_workflows.json` is a STALE
    //      informational file and is intentionally not consulted for dedup.
    const liveSnapshotAt = isoNow();
    const liveFingerprintsByTxnId = new Map();
    for (const t of cloudWorkflow.transitions || []) {
      if (!t || t.id == null) continue;
      const fps = sharedCollectRuleFps(t, this.fieldRemapping || {});
      liveFingerprintsByTxnId.set(String(t.id), fps);
    }
    // Cross-run dedup: Cloud strips `parameters.migrationSourceId` on
    // persist, so the snapshot's `collectRuleFps` can't see our prior emits
    // by migration id. Bridge via the client-side ledger — for each ledger
    // entry whose ruleId is currently on the transition, synthesize the
    // `migration:<id>` fingerprint into the snapshot Set. Result: the
    // applier's first-tier migrationSourceId dedup works across runs.
    const priorLedger = readLedger(this.collectDir, workflowName);
    if (priorLedger && Array.isArray(priorLedger.entries)) {
      // Index Cloud rule IDs that actually exist on the current transitions
      const cloudRuleIdsByTxn = new Map();
      for (const t of cloudWorkflow.transitions || []) {
        if (!t || t.id == null) continue;
        const ids = new Set();
        const collect = (rule) => {
          const id = rule && rule.parameters && rule.parameters.id;
          if (id) ids.add(String(id));
        };
        for (const a of t.actions || []) collect(a);
        for (const v of t.validators || []) collect(v);
        const walk = (n) => {
          if (!n) return;
          for (const c of n.conditions || []) collect(c);
          for (const cg of n.conditionGroups || []) walk(cg);
        };
        if (t.conditions) walk(t.conditions);
        cloudRuleIdsByTxn.set(String(t.id), ids);
      }
      let injected = 0;
      for (const e of priorLedger.entries) {
        if (!e || !e.migrationSourceId || !e.transitionId || !e.ruleId) continue;
        const txnIds = cloudRuleIdsByTxn.get(String(e.transitionId));
        if (!txnIds || !txnIds.has(String(e.ruleId))) continue;
        const liveSet = liveFingerprintsByTxnId.get(String(e.transitionId));
        if (liveSet) {
          liveSet.add(`migration:${e.migrationSourceId}`);
          injected++;
        }
      }
      if (injected > 0) {
        this.log.info(
          `Snapshot enriched with ${injected} migration:<id> fingerprint(s) from prior-run ledger`,
        );
      }
    }
    // Persist the snapshot inline with the apply artifacts. JSON-stringifying
    // a Set requires conversion to an array first.
    try {
      const snapshotOut = {};
      for (const [txnId, fps] of liveFingerprintsByTxnId) {
        snapshotOut[txnId] = [...fps];
      }
      const snapshotPath = path.join(
        this.collectDir,
        `cloud_pre_existing_fingerprints_${safeFilename(workflowName)}.json`,
      );
      fs.writeFileSync(
        snapshotPath,
        JSON.stringify(
          {
            workflowName,
            cloudWorkflowId: cloudWorkflow.id,
            cloudWorkflowVersion: cloudWorkflow.version,
            liveSnapshotAt,
            transitionFingerprints: snapshotOut,
            note:
              "Live Cloud-side rule fingerprints captured BEFORE any apply " +
              "mutation. Used to prove dedup correctness for this run. Re-runs " +
              "always recompute this snapshot — never rely on collect-time data.",
          },
          null,
          2,
        ),
      );
    } catch (e) {
      this.log.warn(`Failed to persist live snapshot for "${workflowName}": ${e.message}`);
    }

    const patched = this._deepClone(cloudWorkflow);
    // Structural index over the Cloud workflow's transitions. Each plan row
    // resolves to a SINGLE Cloud transition via id parity → (name, type, to,
    // from) triple → unique-name fallback. No more name-only fan-out spray
    // (which used to corrupt unrelated transitions whenever DC had multiple
    // distinct actions sharing a display name like "Reopen", "Fail", "Open").
    const cloudIdx = indexCloudTransitions(patched);

    // `ctx` was built above (pre-snapshot) so the repair passes had access to
    // fieldRemapping / cloudFieldNames. Re-using the same object below.

    const appended = [];
    const skippedByStrategy = { native: 0, jmwe: 0, skip: 0, "manual-review": 0 };
    const unmappedRules = [];
    // Rows the LIVE pre-snapshot proved are already on Cloud. Distinct from
    // `unmappedRules.idempotent-skip` (which conflates live-pre-existing with
    // duplicate-plan-rows); kept in its own bucket so the operator can audit
    // dedup behaviour and the Excel summary can render a dedicated sheet.
    const alreadyOnCloud = [];

    for (const row of rows) {
      const strategy = row.strategy || row.defaultStrategy;
      const effectiveStrategy =
        strategy === "jmwe" && this.disableJmwe ? "manual-review" : strategy;

      if (effectiveStrategy === "skip") {
        skippedByStrategy.skip++;
        continue;
      }
      if (effectiveStrategy === "manual-review") {
        skippedByStrategy["manual-review"]++;
        unmappedRules.push({ workflowName, ...row, reason: "manual-review" });
        continue;
      }

      // Resolve the single Cloud transition this DC plan row should land on.
      // Plan rows produced before the structural-matcher change won't have
      // identity fields — fall back to unique-name resolution by passing only
      // transitionName, which the matcher will reject if the name is ambiguous.
      const resolution = resolveCloudTransition(cloudIdx, {
        transitionId: row.transitionId,
        transitionName: row.transitionName,
        transitionFromStatusIds: row.transitionFromStatusIds || [],
        transitionToStatusId: row.transitionToStatusId,
        transitionType: row.transitionType,
      });
      if (!resolution.transition) {
        unmappedRules.push({
          workflowName,
          ...row,
          reason: resolution.reason || `no matching Cloud transition "${row.transitionName}"`,
        });
        continue;
      }
      const target = resolution.transition;

      let converted = null;
      let mapperFound = false;
      const ruleCtx = { ...ctx, ruleId: uuidv4(), unresolved: new Set() };
      if (effectiveStrategy === "native" && hasNativeMapper(row.shortName)) {
        mapperFound = true;
        converted = convertToNative(row.shortName, row.configuration, ruleCtx);
      } else if (effectiveStrategy === "jmwe" && hasJmweMapper(row.shortName)) {
        mapperFound = true;
        converted = convertToJmwe(row.shortName, row.configuration, ruleCtx);
      }

      // Stamp the deterministic per-DC-rule identity onto every emitted rule.
      // The id was computed at plan-build time (see jsuInventory.js) so the
      // next run with the same DC source produces the same id, even if the
      // mapper output drifts. Cloud strips this from persisted rules so the
      // ledger below is the only post-push survival path — but we still
      // stamp it on the wire so the snapshot dedup catches re-runs WITHIN
      // a single apply (mapper context lifetime).
      //
      // ALSO stamp `parameters.id = ctx.ruleId` if the mapper didn't already
      // set one (native system:* mappers historically didn't — Cloud would
      // generate its own UUID, breaking our ledger's ability to find the
      // rule for --clean). Forcing every emit to carry our UUID makes Cloud
      // preserve it (verified live), so --clean can match by parameters.id.
      if (converted) {
        converted.parameters = converted.parameters || {};
        if (row.migrationSourceId && !converted.parameters.migrationSourceId) {
          converted.parameters.migrationSourceId = String(row.migrationSourceId);
        }
        if (!converted.parameters.id) {
          converted.parameters.id = ruleCtx.ruleId;
        }
      }

      if (!converted) {
        // ctx.unresolved holds three classes of entries that mappers tag:
        //   1. raw `customfield_NNN`  — DC field with no Cloud match
        //   2. `status:NNN`           — DC status with no Cloud match
        //   3. `macro:%%CURRENT_USER%%` etc. — JSU runtime substitutions that
        //                                     have no Cloud equivalent
        // Surface each class with its own reason string so the manual-review
        // workbook can route them to the right sheet.
        const unresolvedAll = [...ruleCtx.unresolved];
        const macroEntries = unresolvedAll.filter((s) => s.startsWith("macro:"));
        const statusEntries = unresolvedAll.filter((s) => s.startsWith("status:"));
        const fieldEntries = unresolvedAll.filter(
          (s) => !s.startsWith("macro:") && !s.startsWith("status:"),
        );
        let reason;
        if (!mapperFound) {
          reason = `no ${effectiveStrategy} mapper for "${row.shortName}"`;
        } else if (macroEntries.length > 0) {
          reason =
            `JSU runtime macro has no Cloud equivalent: ` +
            macroEntries.map((s) => s.replace(/^macro:/, "")).join(", ") +
            `. Replace this rule manually with a JMWE Set-Field-Value rule using ` +
            `a Jira Expression / Nunjucks template, or use a Cloud automation rule.`;
        } else if (fieldEntries.length > 0) {
          reason = `field(s) could not be resolved on Cloud: ${fieldEntries.join(", ")}`;
        } else if (statusEntries.length > 0) {
          reason = `status(es) could not be resolved on Cloud: ${statusEntries.map((s) => s.replace(/^status:/, "")).join(", ")}`;
        } else {
          reason = `mapper produced no output for "${row.shortName}"`;
        }
        unmappedRules.push({ workflowName, ...row, reason });
        continue;
      }

      // Consult the LIVE pre-snapshot first. If the rule already exists on
      // Cloud right now (before any of our writes), classify as
      // already-on-cloud and skip. This is the explicit dedup check; the
      // existing `_appendIfAbsent` second line of defence still runs for
      // safety but no longer carries the dedup contract on its own.
      //
      // For the snapshot test we use the STRICT shared fingerprint
      // (sharedRuleFingerprint), not the applier's lossy fieldRequired bucket
      // — otherwise any pre-existing fieldRequired rule on Cloud would shadow
      // every plan row with strategy=native and ruleType=fieldRequired, even
      // when the plan row required different fields. For fieldRequired
      // specifically we test per-field membership against the live snapshot's
      // expanded fingerprints (collectRuleFps adds one fp per required
      // field). When EVERY field a plan row would require is already required
      // on Cloud, the row is genuinely a no-op and gets the already-on-cloud
      // label; partial overlap stays out of this bucket and falls through to
      // _appendIfAbsent's merge path.
      const liveSet = liveFingerprintsByTxnId.get(String(target.id));
      const strictFp = sharedRuleFingerprint(converted, this.fieldRemapping || {});
      const migFp = sharedMigrationFingerprint(converted);
      let alreadyPresent = false;
      let dedupVia = null;
      // Primary identity check: the migrationSourceId-derived fingerprint. If a
      // prior run pushed a rule with the same identity, the live snapshot's
      // `collectRuleFps` already added `migration:<id>` to its set. This match
      // succeeds even when the semantic fingerprint has drifted (mapper
      // hardening, field-rename, etc.) — the root fix for the re-emit-as-dup
      // loop documented in the 2026-05 root cause analysis.
      if (migFp && liveSet && liveSet.has(migFp)) {
        alreadyPresent = true;
        dedupVia = "migrationSourceId";
      } else if (strictFp && liveSet) {
        if (
          converted.ruleKey === "system:validate-field-value" &&
          (converted.parameters || {}).ruleType === "fieldRequired"
        ) {
          const fieldsCsv = String((converted.parameters || {}).fieldsRequired || "");
          const fields = fieldsCsv.split(",").map((s) => s.trim()).filter(Boolean);
          alreadyPresent =
            fields.length > 0 &&
            fields.every((f) =>
              liveSet.has(`system:validate-field-value|fieldRequired|${f}`),
            );
          if (alreadyPresent) dedupVia = "fieldRequired-per-field";
        } else {
          alreadyPresent = liveSet.has(strictFp);
          if (alreadyPresent) dedupVia = "semantic";
        }
      }
      if (alreadyPresent) {
        alreadyOnCloud.push({
          workflowName,
          transitionName: row.transitionName,
          transitionId: row.transitionId,
          ruleCategory: row.ruleCategory,
          shortName: row.shortName,
          ruleKey: converted.ruleKey,
          appliedToTransitionId: target.id,
          fingerprint: strictFp,
          migrationSourceId: migFp ? migFp.slice("migration:".length) : null,
          dedupVia,
          reason: `already-on-cloud (live snapshot, via ${dedupVia})`,
        });
        continue;
      }

      const appendResult = this._appendIfAbsent(target, row.ruleCategory, converted);
      if (appendResult.added) {
        skippedByStrategy[effectiveStrategy]++;
        const isAutoDisabled =
          converted.parameters && converted.parameters.disabled === "true";
        appended.push({
          transitionName: row.transitionName,
          ruleCategory: row.ruleCategory,
          shortName: row.shortName,
          strategy: effectiveStrategy,
          ruleKey: converted.ruleKey,
          appliedToTransitionId: target.id,
          matchType: resolution.matchType,
          autoDisabled: isAutoDisabled || undefined,
          // Ledger fields — survive Cloud's strip of `parameters.migrationSourceId`
          // because we record them client-side. The ledger is written after a
          // successful mutation (see `appendLedger` below) and used by --clean
          // to find what to remove + by subsequent --apply runs to dedup across
          // runs against rules whose tag is gone post-persist.
          ruleId: (converted.parameters && converted.parameters.id) || null,
          migrationSourceId: row.migrationSourceId || null,
        });
        // Groovy residue auto-disable (#4 in the 2026-05 review). The rule
        // gets pushed to Cloud in `disabled: true` state so it doesn't fire
        // broken in production; the CSV row tells the operator to hand-fix
        // the surviving Groovy in the Cloud UI and re-enable.
        if (isAutoDisabled) {
          const cfg = (() => {
            try { return JSON.parse(converted.parameters.config || "{}"); }
            catch { return {}; }
          })();
          const groovyMarkers = (cfg.problems || [])
            .filter((p) => p && p.type === "GroovyResidue")
            .map((p) => (Array.isArray(p.location) ? p.location.join(" @ ") : ""))
            .filter(Boolean);
          const srMarkers = (cfg.problems || [])
            .filter((p) => p && p.type === "ScriptRunnerApiNotTranslatable")
            .map((p) => (Array.isArray(p.location) ? p.location.join(" @ ") : ""))
            .filter(Boolean);
          // ScriptRunner-API usage is the more actionable categorisation —
          // the operator can't "hand-fix in Cloud UI" because the API
          // doesn't exist. Surface that reason instead of the generic
          // groovy-residue when applicable.
          const reasonText = srMarkers.length > 0
            ? "scriptrunner-api-not-translatable: rule uses ScriptRunner DC-only APIs " +
              "(ComponentAccessor / SearchService / java imports / etc.) that have no " +
              "Jira Cloud equivalent. Hand-rewrite required — either a Forge app or a " +
              "JMWE ScriptedCondition/Validator with a Jira Expression that uses " +
              "REST-API-fetched data. " +
              `Markers: ${srMarkers.slice(0, 3).join(" | ")}`
            : "groovy-residue-auto-disabled: emitted with disabled=true because " +
              "Groovy syntax survived translation. Hand-fix in Cloud UI then re-enable. " +
              (groovyMarkers.length > 0 ? `Markers: ${groovyMarkers.slice(0, 3).join(" | ")}` : "");
          unmappedRules.push({
            workflowName,
            ...row,
            // Auto-disabled rules ARE on Cloud — surface the cloud-side rule
            // UUID so the operator can find them in the Cloud UI / via
            // scripts/inspect_cloud_workflow.js.
            cloudRuleId: (converted.parameters && converted.parameters.id) || null,
            reason: reasonText,
          });
        }
      } else {
        // Categorise the skip per #3 in the 2026-05 review:
        //   - "duplicate-plan-row" — same migrationSourceId already emitted
        //     in this run (e.g. multiple DC FieldsRequiredValidators merging
        //     into one Cloud rule).
        //   - "jcma-already-placed" — semantic / hash match against a rule
        //     that was already on the transition with no migrationSourceId
        //     (JCMA, operator, or a non-this-run write). Distinct from a
        //     within-run duplicate; the operator may need to verify the
        //     pre-existing rule actually matches the DC source's intent.
        const reasonText =
          appendResult.reason === "jcma-already-placed"
            ? `jcma-already-placed: a non-migration-tagged rule with equivalent shape already exists on Cloud (matchedRuleId=${appendResult.matchedRuleId || "?"}). Verify JCMA's translation matches the DC source's intent.`
            : "duplicate-plan-row: equivalent rule already produced earlier in this apply run";
        unmappedRules.push({
          workflowName,
          ...row,
          reason: reasonText,
        });
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // ADDITIVE-ONLY CONTRACT (2026-05 simplification).
    //
    // After plan-row conversion, the patched workflow now contains:
    //   - Every rule JCMA placed on Cloud (untouched).
    //   - Our newly-appended JSU/JMWE conversions for plan rows that weren't
    //     already on Cloud (live-snapshot dedup against existing rule
    //     fingerprints + parameters.migrationSourceId).
    //
    // No prune. No repair. No sanitize. No tail dedup. This script is a
    // pure overlay on JCMA's output. The 12+ prune/repair passes the
    // previous applier ran are all gone; they existed to clean up
    // self-inflicted damage from earlier botched runs (spray, broken
    // Nunjucks, mode normalization, etc.) — every one of those root causes
    // is now fixed in the mapper or fingerprinting layer, so the cleanup
    // passes have nothing to do AND risked touching JCMA's rules.
    //
    // If you need the OLD aggressive cleanup, restore from git history
    // (commit before 2026-05 simplification).
    // ──────────────────────────────────────────────────────────────────

    const topLevelStatuses = cloudWorkflow._topLevelStatuses || [];
    this._stripReadOnlyFields(patched);
    let envelope = this._buildUpdateEnvelope(patched, topLevelStatuses);

    const safe = safeFilename(workflowName);
    fs.writeFileSync(
      path.join(this.collectDir, `update_payload_${safe}.json`),
      JSON.stringify(envelope, null, 2),
    );

    // ──────────────────────────────────────────────────────────────────
    // Additive-diff guardrail (#2 in the 2026-05 review).
    //
    // Final defensive check before validation/mutation: compute the
    // structural diff between `cloudWorkflow` (live, untouched) and
    // `patched` (envelope ready to push). If anything other than pure
    // additions is detected — rules removed, rules modified, transitions
    // disappeared — abort the push, dump the diff to disk, and surface to
    // the operator. The script's additive contract is enforced at runtime
    // here, not just by code-review of `_processWorkflow`.
    //
    // Tag/disabled drift across persists is intentionally NOT flagged
    // (see EPHEMERAL_PARAM_KEYS in additiveDiffGuardrail.js) since JCMA
    // and the Cloud server can legitimately rewrite those.
    // ──────────────────────────────────────────────────────────────────
    const additivity = verifyAdditive(cloudWorkflow, patched);
    if (!additivity.ok) {
      const diffPath = path.join(
        this.collectDir,
        `additive_diff_violation_${safe}.json`,
      );
      fs.writeFileSync(
        diffPath,
        JSON.stringify(
          {
            workflowName,
            detectedAt: isoNow(),
            additions: additivity.additions,
            removed: additivity.removed,
            modified: additivity.modified,
            note:
              "Additive-diff guardrail tripped. Patched envelope is NOT a " +
              "pure additive overlay on the live Cloud workflow. Push aborted " +
              "to protect JCMA-placed rules. Inspect this file and the matching " +
              "update_payload to find the source of the mutation.",
          },
          null,
          2,
        ),
      );
      this.log.error(
        `Additive guardrail FAILED for "${workflowName}": ` +
        `${additivity.removed.length} removal(s), ${additivity.modified.length} modification(s). ` +
        `Push aborted. See ${diffPath}.`,
      );
      return {
        workflowName,
        status: "blocked_by_additive_guardrail",
        liveSnapshotAt,
        appended,
        skippedByStrategy,
        unmappedRules,
        alreadyOnCloud,
        guardrailDiff: { removed: additivity.removed, modified: additivity.modified },
      };
    }
    this.log.info(
      `Additive guardrail OK for "${workflowName}": ${additivity.additions} addition(s), 0 removals, 0 modifications.`,
    );

    // ──────────────────────────────────────────────────────────────────
    // Per-rule validation + auto-strip (#1 in the 2026-05 review).
    //
    // Call /workflows/update/validation on the full envelope. Cloud
    // returns errors per rule via elementReference.ruleId. For every
    // ERROR-level entry attributable to one of OUR appended rules (by
    // parameters.id), strip the rule from `patched`, demote it to
    // unmappedRules with the exact Cloud error, and re-validate the
    // cleaned envelope. Any ERROR remaining after the strip is JCMA's
    // territory (not ours to remove) — the apply blocks as before.
    //
    // Output: `envelope` is overwritten with the cleaned version.
    //         `unmappedRules` gains one entry per rejected rule.
    //         `validation` is the final response (post-strip).
    // ──────────────────────────────────────────────────────────────────
    const stripResult = await this._validateAndStripRejected(
      envelope,
      patched,
      appended,
      unmappedRules,
      workflowName,
      safe,
      topLevelStatuses,
    );
    envelope = stripResult.envelope;
    const validation = stripResult.validation;

    if (this.validateOnly) {
      return {
        workflowName,
        status: "validated",
        liveSnapshotAt,
        appended,
        skippedByStrategy,
        unmappedRules,
        alreadyOnCloud,
        validationHasErrors: this._validationHasErrors(validation),
        rulesStrippedByValidation: stripResult.strippedRuleIds,
      };
    }

    if (this.dryRun) {
      return {
        workflowName,
        status: "dry_run",
        liveSnapshotAt,
        appended,
        skippedByStrategy,
        unmappedRules,
        alreadyOnCloud,
        rulesStrippedByValidation: stripResult.strippedRuleIds,
      };
    }

    if (this._validationHasErrors(validation) && !(this.force && this.ignoreErrors)) {
      this.log.warn(
        `"${workflowName}" still has validation errors after auto-strip — likely ` +
        `attributable to JCMA-placed rules. Apply blocked. Inspect validation_${safe}.json.`,
      );
      return {
        workflowName,
        status: "blocked_by_validation",
        liveSnapshotAt,
        appended,
        skippedByStrategy,
        unmappedRules,
        alreadyOnCloud,
        rulesStrippedByValidation: stripResult.strippedRuleIds,
      };
    }

    try {
      const mutation = await this.cloud.updateWorkflowsBulk(envelope);

      // Write the migration ledger: client-side record of what we pushed so
      // (a) --clean can find our rules by Cloud-preserved ruleId, (b) the
      // next --apply can read this back and dedup against it across runs.
      // Cloud strips `parameters.migrationSourceId`, so this client-side
      // store is the only post-push identity link we have.
      //
      // UUID reconciliation: Cloud preserves the `parameters.id` we send
      // for `connect:*` rules but REGENERATES it for `system:*` rules
      // (verified live 2026-05). For system rules we therefore match our
      // pre-push intent to Cloud's post-push UUID by semantic fingerprint
      // within the same transition. Without this, ~10/152 ledger entries
      // would point at UUIDs no longer on Cloud and `--clean` would miss
      // those system rules.
      try {
        const reconciledIds = this._reconcileCloudUuids(appended, mutation, patched);
        // Also fingerprint each appended rule so --clean can fall back to
        // semantic-fp match when Cloud assigns/strips UUIDs (verified live:
        // system:* rules end up with `id=undefined` on Cloud).
        const fpByPreId = new Map();
        for (const a of appended || []) {
          if (!a || !a.ruleId || !a.appliedToTransitionId) continue;
          const txn = (patched.transitions || []).find((t) => String(t.id) === String(a.appliedToTransitionId));
          if (!txn) continue;
          const findRule = (r) => r && r.parameters && String(r.parameters.id) === String(a.ruleId);
          let preRule = (txn.actions || []).find(findRule) ||
                        (txn.validators || []).find(findRule);
          if (!preRule && txn.conditions) {
            const walk = (n) => {
              if (!n) return null;
              for (const c of n.conditions || []) if (findRule(c)) return c;
              for (const cg of n.conditionGroups || []) { const h = walk(cg); if (h) return h; }
              return null;
            };
            preRule = walk(txn.conditions);
          }
          if (preRule) {
            const fp = sharedRuleFingerprint(preRule, this.fieldRemapping || {});
            if (fp) fpByPreId.set(a.ruleId, fp);
          }
        }
        const ledgerEntries = appended
          .filter((a) => a && a.ruleId && a.migrationSourceId)
          .map((a) => ({
            migrationSourceId: a.migrationSourceId,
            ruleId: reconciledIds.get(a.ruleId) || a.ruleId,
            ruleKey: a.ruleKey,
            transitionId: a.appliedToTransitionId,
            transitionName: a.transitionName,
            ruleCategory: a.ruleCategory,
            shortName: a.shortName,
            // Semantic fingerprint of the rule's content. Used by --clean as
            // a fallback identifier for rules Cloud strips of `parameters.id`
            // (system:* rules), and as a verification key.
            fingerprint: fpByPreId.get(a.ruleId) || null,
            autoDisabled: !!a.autoDisabled,
            pushedAt: isoNow(),
          }));
        if (ledgerEntries.length > 0) {
          const cloudWfName =
            (this.config && this.config.workflowNameOverrides && this.config.workflowNameOverrides[workflowName]) ||
            workflowName;
          const total = appendLedger(
            this.collectDir,
            workflowName,
            cloudWfName,
            this.cloud.baseUrl,
            ledgerEntries,
          );
          this.log.info(
            `Migration ledger updated for "${workflowName}": +${ledgerEntries.length} new entry/entries (total ${total}).`,
          );
        }
      } catch (e) {
        this.log.warn(`Failed to write migration ledger for "${workflowName}": ${e.message}`);
      }

      return {
        workflowName,
        status: "applied",
        liveSnapshotAt,
        appended,
        skippedByStrategy,
        unmappedRules,
        alreadyOnCloud,
        mutationResponse: mutation,
        rulesStrippedByValidation: stripResult.strippedRuleIds,
      };
    } catch (err) {
      if (err.statusCode === 409) {
        this.log.warn(`409 on "${workflowName}" — retrying once after re-fetch`);
        const retryResult = await this._retryAfterConflict(workflowName, rows);
        return retryResult;
      }
      throw err;
    }
  }

  /**
   * Validate the envelope; for every ERROR Cloud attributes to one of OUR
   * appended rules (matched by parameters.id), strip that rule from `patched`
   * and demote it to `unmappedRules`. Re-validate after stripping so the
   * caller sees the final post-strip response.
   *
   * Errors attributable to non-appended rules (JCMA's, operator's) are left
   * alone — they're not ours to remove. If any remain, the caller's existing
   * `_validationHasErrors` check blocks the push.
   *
   * Returns { envelope, validation, strippedRuleIds }.
   */
  async _validateAndStripRejected(envelope, patched, appended, unmappedRules, workflowName, safe, topLevelStatuses) {
    const validation0 = await this._callValidate(envelope);
    fs.writeFileSync(
      path.join(this.collectDir, `validation_${safe}.json`),
      JSON.stringify(validation0, null, 2),
    );
    // Build set of appended rule IDs so we know which errors are ours.
    const appendedRuleIds = new Set();
    for (const t of patched.transitions || []) {
      const visit = (rule) => {
        const id = rule && rule.parameters && rule.parameters.id;
        if (!id) return;
        // Only OUR newly-emitted rules carry migrationSourceId — JCMA's don't.
        if (rule.parameters.migrationSourceId) appendedRuleIds.add(String(id));
      };
      for (const a of t.actions || []) visit(a);
      for (const v of t.validators || []) visit(v);
      const walk = (n) => {
        if (!n) return;
        for (const c of n.conditions || []) visit(c);
        for (const cg of n.conditionGroups || []) walk(cg);
      };
      if (t.conditions) walk(t.conditions);
    }
    // Find ERROR-level entries we can attribute to our appended rules.
    const errorsToStrip = [];
    for (const e of (validation0 && validation0.errors) || []) {
      if (!e) continue;
      const level = (e.level || "ERROR").toUpperCase();
      if (level !== "ERROR") continue;
      const refId = e.elementReference && e.elementReference.ruleId;
      if (refId && appendedRuleIds.has(String(refId))) {
        errorsToStrip.push({ ruleId: String(refId), code: e.code, message: e.message });
      }
    }
    if (errorsToStrip.length === 0) {
      return { envelope, validation: validation0, strippedRuleIds: [] };
    }
    // Strip each rejected rule from `patched` AND from `appended`, then add
    // a clear entry to `unmappedRules` so the CSV captures Cloud's verdict.
    const strippedRuleIds = [];
    for (const err of errorsToStrip) {
      const stripped = this._stripRuleById(patched, err.ruleId);
      if (!stripped) continue;
      strippedRuleIds.push(err.ruleId);
      // Locate the matching appended entry so we can transfer its DC context
      // into the unmapped row.
      const appIdx = appended.findIndex(
        (a) => a && a.ruleKey === stripped.rule.ruleKey &&
               a.appliedToTransitionId != null &&
               String(a.appliedToTransitionId) === String(stripped.transitionId),
      );
      const appEntry = appIdx >= 0 ? appended[appIdx] : null;
      if (appIdx >= 0) appended.splice(appIdx, 1);
      unmappedRules.push({
        workflowName,
        transitionName: appEntry ? appEntry.transitionName : "(stripped)",
        transitionId: stripped.transitionId,
        ruleCategory: stripped.bucket === "actions" ? "postFunction" :
                      stripped.bucket === "validators" ? "validator" : "condition",
        shortName: appEntry ? appEntry.shortName : "(stripped)",
        strategy: appEntry ? appEntry.strategy : "",
        reason:
          `cloud-validation-rejected: ${err.code || "ERROR"} — ${err.message || "no message"}`,
        configuration: undefined,
      });
    }
    this.log.warn(
      `"${workflowName}": stripped ${strippedRuleIds.length} rule(s) Cloud rejected at validation. ` +
      `See unmapped CSV for details.`,
    );
    // Rebuild envelope + re-validate the cleaned state.
    const rebuilt = this._buildUpdateEnvelope(patched, topLevelStatuses);
    const validation1 = await this._callValidate(rebuilt);
    fs.writeFileSync(
      path.join(this.collectDir, `validation_${safe}.json`),
      JSON.stringify(validation1, null, 2),
    );
    // Persist the cleaned payload alongside the original for traceability.
    fs.writeFileSync(
      path.join(this.collectDir, `update_payload_${safe}.json`),
      JSON.stringify(rebuilt, null, 2),
    );
    return { envelope: rebuilt, validation: validation1, strippedRuleIds };
  }

  /**
   * Remove a rule with `parameters.id === ruleId` from anywhere in a patched
   * workflow's transitions (actions, validators, or conditions tree).
   * Returns { rule, transitionId, bucket } on success, null if not found.
   */
  _stripRuleById(patched, ruleId) {
    const target = String(ruleId);
    for (const t of patched.transitions || []) {
      const stripFromArray = (arr, bucket) => {
        if (!Array.isArray(arr)) return null;
        for (let i = 0; i < arr.length; i++) {
          const r = arr[i];
          if (r && r.parameters && String(r.parameters.id) === target) {
            const removed = arr.splice(i, 1)[0];
            return { rule: removed, transitionId: t.id, bucket };
          }
        }
        return null;
      };
      let hit = stripFromArray(t.actions, "actions");
      if (hit) return hit;
      hit = stripFromArray(t.validators, "validators");
      if (hit) return hit;
      const walkConds = (node) => {
        if (!node || typeof node !== "object") return null;
        let h = stripFromArray(node.conditions, "conditions");
        if (h) return h;
        for (const cg of node.conditionGroups || []) {
          h = walkConds(cg);
          if (h) return h;
        }
        return null;
      };
      if (t.conditions) {
        hit = walkConds(t.conditions);
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * Map each pre-push appended rule's UUID to its Cloud-assigned UUID in the
   * mutation response. Cloud preserves UUIDs for `connect:*` rules but
   * regenerates them for `system:*` rules — for the latter we match by
   * (transitionId, ruleKey, semantic fingerprint) within the response.
   *
   * Returns Map<preUuid, cloudUuid>.
   */
  _reconcileCloudUuids(appended, mutation, patched) {
    const out = new Map();
    const mutationWf = (mutation && mutation.workflows && mutation.workflows[0]) || null;
    if (!mutationWf) return out;
    // Index pre-push rules by (transitionId, ruleKey) → list of {preId, fp, appendedEntry}
    const preByTxnKey = new Map();
    for (const a of appended || []) {
      if (!a || !a.ruleId || !a.appliedToTransitionId || !a.ruleKey) continue;
      // Re-locate the actual pre-push rule object in `patched` so we can
      // fingerprint it the same way we'll fingerprint the mutation-response
      // rule. The `appended` array doesn't carry the full rule, only summary
      // fields, so we walk `patched` once.
      const txn = (patched.transitions || []).find((t) => String(t.id) === String(a.appliedToTransitionId));
      if (!txn) continue;
      let preRule = null;
      const visit = (r) => {
        if (preRule) return;
        if (r && r.parameters && String(r.parameters.id) === String(a.ruleId)) preRule = r;
      };
      for (const ax of txn.actions || []) visit(ax);
      for (const vx of txn.validators || []) visit(vx);
      const walk = (n) => { if (!n) return; for (const c of n.conditions || []) visit(c); for (const cg of n.conditionGroups || []) walk(cg); };
      if (txn.conditions) walk(txn.conditions);
      if (!preRule) continue;
      const fp = sharedRuleFingerprint(preRule, this.fieldRemapping || {});
      const key = `${a.appliedToTransitionId}|${a.ruleKey}`;
      if (!preByTxnKey.has(key)) preByTxnKey.set(key, []);
      preByTxnKey.get(key).push({ preId: a.ruleId, fp, ruleKey: a.ruleKey });
    }
    // Walk mutation response: for each rule, look up the pre-push intent
    // with matching (txn, ruleKey, fp). If unique → map.
    const mutationTxns = mutationWf.transitions || [];
    for (const t of mutationTxns) {
      const txnId = String(t.id);
      const visit = (rule) => {
        if (!rule || !rule.parameters || !rule.parameters.id) return;
        const cloudId = String(rule.parameters.id);
        const key = `${txnId}|${rule.ruleKey}`;
        const candidates = preByTxnKey.get(key);
        if (!candidates || candidates.length === 0) return;
        const fp = sharedRuleFingerprint(rule, this.fieldRemapping || {});
        // First-fit by semantic fingerprint. Pop the match so we don't
        // double-bind two different pre-push intents to the same cloud rule.
        const idx = candidates.findIndex((c) => c.fp === fp);
        if (idx >= 0) {
          const matched = candidates[idx];
          if (matched.preId !== cloudId) out.set(matched.preId, cloudId);
          candidates.splice(idx, 1);
        }
      };
      for (const a of t.actions || []) visit(a);
      for (const v of t.validators || []) visit(v);
      const walk = (n) => { if (!n) return; for (const c of n.conditions || []) visit(c); for (const cg of n.conditionGroups || []) walk(cg); };
      if (t.conditions) walk(t.conditions);
    }
    return out;
  }

  _retryAfterConflict(workflowName, rows) {
    this.log.info(`Retrying "${workflowName}" after 409`);
    return this._processWorkflow(workflowName, rows);
  }

  // Populates `this.cloudFieldNames: { cloudFieldId → displayName }` used by
  // the emit-time JMWE config translator so Nunjucks templates resolve to
  // `issue.fields["Display Name"]` rather than `issue.fields.customfield_NNN`.
  // Non-fatal: if Cloud is unreachable, leave the map empty and continue —
  // emitted rules will still be syntactically valid, just without display-name
  // bracket-notation substitution.
  async _loadCloudFieldCatalog() {
    if (this.cloudFieldNames && Object.keys(this.cloudFieldNames).length > 0) return;
    this.cloudFieldNames = {};
    try {
      const fields = await this.cloud.makeRequest("GET", "/rest/api/3/field");
      for (const f of fields || []) {
        if (!f || !f.id) continue;
        if (typeof f.name === "string" && f.name) this.cloudFieldNames[String(f.id)] = f.name;
      }
      this.log.info(`Cloud field catalog: ${Object.keys(this.cloudFieldNames).length} named fields`);
      // Persist for downstream tools (scripts/suggest_field_remap.js etc.)
      // to consume without needing a live Cloud client.
      try {
        const p = require("path").join(this.collectDir, "cloud_field_catalog.json");
        require("fs").writeFileSync(p, JSON.stringify(this.cloudFieldNames, null, 2));
      } catch (e) {
        this.log.warn(`Failed to persist cloud_field_catalog.json: ${e.message}`);
      }
    } catch (e) {
      this.log.warn(
        `Failed to fetch Cloud field catalog: ${e.message}. Emit-time Nunjucks ` +
        `display-name substitution will be skipped (rules remain syntactically valid).`,
      );
    }
  }

  /**
   * Pre-resolves all DC usernames referenced via `cfg.runAsUser` across the
   * plan, caching `<dcUsername> → accountId:UUID` mappings. Mappers later
   * consume `ctx.dcUserMap` synchronously to emit `runAsType: "specifiedUser"`
   * + `runAs: "accountId:UUID"` correctly.
   *
   * Non-fatal: if Cloud is unreachable, leaves the map empty. Mappers fall
   * back to `runAsType: "currentUser"` and push `UnresolvedRunAsUser`
   * markers so the operator gets a targeted CSV reason. Loads/persists at
   * `<collectDir>/dc_user_cloud_map.json` so re-runs reuse resolutions.
   */
  async _preResolveRunAsUsers() {
    const { loadCache, persistCache, preResolveAllRunAsUsers } = require("./cloudUserResolver");
    const cloudBaseUrl = (this.cloud && this.cloud.baseUrl) || "";
    const store = loadCache(this.collectDir, cloudBaseUrl);
    store.cloudBaseUrl = cloudBaseUrl; // refresh stamp
    try {
      const plan = this.conversionPlan || { rows: [] };
      // Strip "accountId:" prefix if supplied (the user may give it either way).
      const fallbackAccountId = this.runasFallback
        ? String(this.runasFallback).replace(/^accountId:/, "")
        : null;
      await preResolveAllRunAsUsers(plan, this.cloud, store, { fallbackAccountId });
      persistCache(this.collectDir, store);
      this.dcUserMap = {};
      for (const [k, v] of Object.entries(store.entries || {})) this.dcUserMap[k] = v;
      const resolvedCount = Object.values(store.entries || {}).filter((e) => e && e.resolved).length;
      const fallbackCount = Object.values(store.entries || {}).filter((e) => e && !e.resolved && e.fallback).length;
      const totalCount = Object.keys(store.entries || {}).length;
      if (totalCount > 0) {
        const suffix = fallbackCount > 0 ? ` (+${fallbackCount} using --runas-fallback)` : "";
        this.log.info(`Run-As user resolver: ${resolvedCount}/${totalCount} dc-usernames resolved${suffix}`);
      }
    } catch (e) {
      this.log.warn(
        `Failed to pre-resolve runAs users: ${e.message}. Mappers will emit ` +
        `runAsType=currentUser with UnresolvedRunAsUser markers.`,
      );
      this.dcUserMap = {};
    }
  }

  /**
   * Walk every system:* rule on the patched workflow; if any of its parameter
   * values reference a `customfield_NNN` ID that isn't in the valid Cloud set,
   * remove the rule entirely. Returns the number pruned.
   *
   * Only system rules are inspected — Connect/Forge rules carry their config
   * in stringified JSON blobs that we don't try to decode.
   *
   * Note: an earlier version also tried to flag rules that referenced a Cloud
   * ID *which the DC catalog also knew about under a different mapping* — the
   * intent being to catch un-translated DC IDs that incidentally exist on
   * Cloud as a different field. That heuristic produces false positives any
   * time DC and Cloud customfield ID number-spaces overlap (e.g. customfield_10220
   * existing on both tenants under unrelated field names), so it was removed.
   */

  /**
   * Fetch the Cloud workflow along with its top-level status catalog.
   *
   * `POST /rest/api/3/workflows` returns both:
   *   { workflows: [{id, version, statuses: [{statusReference, ...}], transitions: [...]}],
   *     statuses: [{id, name, statusCategory, scope, description, ...}] }
   *
   * The existing JiraCloudClient.getWorkflowsByNames only keeps `workflows`.
   * The /workflows/update endpoint REQUIRES the top-level statuses, so we call
   * directly here to get both halves of the response.
   */
  async _fetchCloudWorkflow(workflowName) {
    // DC's XML export sanitises certain characters in workflow names — most
    // commonly `:` and `/` become `_`, so a DC export named "CHG_ Change Task"
    // corresponds to "CHANGE: Change Task" on Cloud. config.workflowNameOverrides
    // lets the operator declare these mappings; we look up the Cloud workflow
    // under the override (when set) and fall back to the original DC name.
    const overrides = (this.config && this.config.workflowNameOverrides) || {};
    const declared = overrides[workflowName] || workflowName;
    if (declared !== workflowName) {
      this.log.info(
        `Workflow name override: DC "${workflowName}" -> Cloud "${declared}"`,
      );
    }
    const tryFetch = async (name) => {
      try {
        const res = await this.cloud.makeRequest("POST", "/rest/api/3/workflows", {
          workflowNames: [name],
        });
        const workflows = (res && res.workflows) || [];
        const wf = workflows.find((w) => w && w.name === name) || null;
        if (!wf) return null;
        wf._topLevelStatuses = (res && res.statuses) || [];
        return wf;
      } catch (e) {
        // 404 / not found — caller will try fuzzy variants.
        return null;
      }
    };
    const initial = await tryFetch(declared);
    if (initial) return initial;

    // Fuzzy fallback. DC strips `:` and `/` to `_`, so the candidates are
    // every name reachable by replacing each `_` (or `_ ` followed by space)
    // with `:` or `/`. We don't enumerate the full power set — most cases use
    // exactly one separator. Try the single-substitution variants in priority
    // order: colon-space first (most common: "Project: name"), then slash.
    const sepCandidates = new Set();
    const addCandidate = (s) => { if (s && s !== declared) sepCandidates.add(s); };
    // Replace every `_ ` (underscore then space) with `: `.
    addCandidate(declared.replace(/_ /g, ": "));
    // Replace every `_` with `:` (no-space variants).
    addCandidate(declared.replace(/_/g, ":"));
    // Replace every `_ ` with `/ `.
    addCandidate(declared.replace(/_ /g, "/ "));
    addCandidate(declared.replace(/_/g, "/"));
    // First underscore only — handles single-token replacements.
    addCandidate(declared.replace(/_/, ":"));
    addCandidate(declared.replace(/_/, "/"));

    for (const cand of sepCandidates) {
      const wf = await tryFetch(cand);
      if (wf) {
        this.log.info(
          `Workflow name fuzzy-resolved: DC "${workflowName}" -> Cloud "${cand}"`,
        );
        return wf;
      }
    }
    return null;
  }

  /**
   * Append a converted rule to the right bucket on `cloudTransition`, unless
   * a semantically-equivalent rule is already there. Strictly READ-ONLY
   * against existing rules — we never remove or modify what's already in the
   * bucket. That's JCMA's territory (or any other admin's / prior run's).
   *
   * Returns true if appended, false if skipped because a duplicate was
   * detected.
   *
   * Dedup precedence (per existing rule in the bucket):
   *   1. migrationSourceId fingerprint. When BOTH rules carry one and they
   *      differ → they came from DIFFERENT DC plan rows by construction; we
   *      keep both. When they MATCH → same DC source, treat as duplicate.
   *      This is the fix for the multi-EmailIssueFunction case where four
   *      distinct DC plan rows on one transition share `subject`+`to` (so
   *      the semantic fingerprint collapses them) but each is a legit emit
   *      keyed by its own migrationSourceId.
   *   2. Semantic identity fingerprint (`_ruleIdentityFingerprint`). For
   *      well-known shapes (system:*, connect:*) this catches equivalents
   *      whose `parameters` differ only in metadata. For
   *      `system:validate-field-value` with ruleType=fieldRequired the
   *      fingerprint is intentionally LOSSY (collapses all fieldRequired
   *      rules into one bucket) because Cloud allows only ONE fieldRequired
   *      per transition.
   *   3. Hash-of-parameters equality as a fallback for shapes the
   *      fingerprint doesn't recognise.
   */
  _appendIfAbsent(cloudTransition, ruleCategory, converted) {
    const bucket = this._bucketForCategory(cloudTransition, ruleCategory);
    if (!bucket) return { added: false, reason: "no-bucket" };

    const newMigFp = sharedMigrationFingerprint(converted);
    const newFp = this._ruleIdentityFingerprint(converted);
    const newHash = hashParams(converted.parameters || {});

    for (const existing of bucket.array) {
      if (!existing) continue;
      const existingMigFp = sharedMigrationFingerprint(existing);
      // Two distinct migration IDs → distinct DC plan rows → keep both.
      if (newMigFp && existingMigFp && newMigFp !== existingMigFp) continue;
      // Same migration ID → same DC plan row already produced → dedup (in-run).
      if (newMigFp && existingMigFp && newMigFp === existingMigFp) {
        return { added: false, reason: "duplicate-plan-row" };
      }
      // Existing rule has no migration ID (JCMA, operator, or older run) —
      // semantic / hash match means our emit would duplicate something
      // already on Cloud that we didn't place. Categorise that as
      // jcma-already-placed so the CSV doesn't lie about its origin.
      if (newFp && this._ruleIdentityFingerprint(existing) === newFp) {
        return { added: false, reason: "jcma-already-placed", matchedRuleId: existing.parameters && existing.parameters.id };
      }
      if (existing.ruleKey === converted.ruleKey &&
          hashParams(existing.parameters || {}) === newHash) {
        return { added: false, reason: "jcma-already-placed", matchedRuleId: existing.parameters && existing.parameters.id };
      }
    }
    bucket.array.push(converted);
    return { added: true };
  }

  /**
   * Remove cross-level duplicates from a transition's conditions tree. A leaf
   * rule that appears at a parent compound AND inside any of its descendant
   * compounds is collapsed to the descendant copy only. This is the common shape
   * of damage from past runs that appended rules to the top-level AND while the
   * "real" version (from CMA migration) was already nested in an ANY/OR group —
   * producing the impossible "field = X AND field = Y AND field = Z" tree.
   *
   * Cloud's tree shape per /workflows/update payload:
   *   { operation: "ALL"|"ANY", conditionGroups: [<nested compound>], conditions: [<leaf>] }
   *
   * Returns the number of rules removed across the tree.
   */

  /**
   * Identity fingerprint for a rule — equal fingerprints mean two rules are
   * "the same" for dedup purposes, regardless of metadata that varies between
   * persists (id, disabled, tag, mode-when-irrelevant). Returns null for shapes
   * we don't know how to fingerprint, in which case the caller should fall back
   * to ruleKey + parameter-hash equality.
   *
   * Centralised here so _pruneCrossLevelDuplicateConditions and the post-apply
   * exact-duplicate sweep agree on what counts as a duplicate.
   */
  _ruleIdentityFingerprint(rule) {
    // Delegate to the shared helper. The applier's old `system:validate-field-value`
    // fingerprint for `fieldRequired` collapsed all rules of that type into a
    // single bucket (only `[k, ruleType]`), which we keep here for the dedup
    // pass — the applier merges multi-field validators on append. The shared
    // helper's strict-bucket fingerprint by `fieldsRequired` is correct for
    // audit/compare purposes; this lossy-bucket variant is what the dedup pass
    // wants. So we only delegate the non-fieldRequired cases.
    if (rule && rule.ruleKey === "system:validate-field-value") {
      const p = rule.parameters || {};
      const ruleType = p.ruleType || "";
      if (ruleType === "fieldRequired") {
        return ["system:validate-field-value", ruleType].join("|");
      }
    }
    return sharedRuleFingerprint(rule, this.fieldRemapping || {});
  }

  /**
   * Semantic fingerprint for a Connect (JMWE / Forge / Atlassian-Connect) rule.
   *
   * Two rules with the same `(ruleKey, appKey, semantic-key)` are treated as
   * the same rule for dedup purposes. The semantic key is module-aware: for
   * known JMWE modules we extract the meaningful slice of the stringified
   * `parameters.config` (or legacy `parameters.value`) — for unknown modules
   * we fall back to a canonical hash of the parsed config with id-shaped
   * keys removed.
   *
   * DC-side field IDs inside `config` are translated through this.fieldRemapping
   * before hashing, so an older copy with raw DC IDs and a newer copy with the
   * same fields remapped to Cloud IDs produce the same fingerprint and the
   * duplicate gets caught.
   */
  _connectRuleFingerprint(rule) {
    return sharedConnectRuleFingerprint(rule, this.fieldRemapping || {});
  }


  /**
   * Collapse JMWE expression-condition rules that duplicate a native
   * `system:restrict-issue-transition` on the same transition. A transition
   * frequently ends up with BOTH (a) a native role-restrict condition with
   * `roleIds: "10100,10101"` AND (b) a JMWE expression-condition whose Jira
   * Expression has the canonical role-membership shape:
   *
   *   user && issue && issue.project &&
   *   user.getProjectRoles(issue.project).some(role =>
   *     ["Developers","Service Desk Team"].includes(role.name))
   *
   * When (b)'s role-name set equals (a)'s role-ids resolved via the project
   * role catalog, the JMWE copy is the duplicate to drop. The native rule is
   * preserved because it's evaluated server-side without a Connect round-trip
   * (faster, no app dependency).
   *
   * Conditions live in `transition.conditions.conditions[]` AND inside any
   * `conditionGroups[].conditions[]`, so we walk the whole tree.
   *
   * Lifted in-pipeline from the previous standalone `cleanup_native_jmwe_role_dups.js`
   * top-level script so re-applies don't re-create the duplicates after each
   * cleanup pass. Returns the count of rules removed.
   */

  /**
   * Collapse rules that share the same `parameters.migrationSourceId` on the
   * same transition. The migrationSourceId is a deterministic hash of the DC
   * plan-row identity (workflow + transition + slot + dcType), stamped on
   * every rule we emit. Two rules with the same id are by definition different
   * persistences of the same logical migration — keep the one with the most
   * up-to-date config (CMA-tagged or modern Groovy accessor) and drop the
   * rest.
   *
   * This is identity-based dedup, complementary to `_pruneExactDuplicates`'s
   * semantic dedup. The semantic pass catches duplicates within a generation
   * of the mapper; this pass catches duplicates across generations (mapper
   * changed → semantic fingerprint drifted → semantic dedup missed → both
   * copies coexist). The migrationSourceId stays stable as long as the DC
   * source row is the same, so it survives mapper hardening.
   *
   * Rules without `migrationSourceId` (legacy emits from before the tag, or
   * native-Jira / CMA-placed rules we don't own) are left alone.
   *
   * Returns the count of rules removed.
   */

  /**
   * For Connect rules whose module is `SetFieldValueFunction`, collapse
   * variants that share `(fieldId, conditionalExecutionScript)` even when
   * the `value` differs. The `value` difference is almost always a DC-ID vs
   * Cloud-ID format mismatch (priority="4" vs priority="10003") left over by
   * an older mapper run; the operational rule is the same.
   *
   * Survivor picked by score:
   *   - +2 if value contains non-digits (Cloud resolves option to text label)
   *   - +1 if rule.parameters.tag === "migration-success"
   *   - +1 if value length > 4 (heuristic: Cloud option names are longer)
   *   - 0  otherwise (raw small integer / DC ID)
   *
   * Returns the new array. The caller's `removed` counter is bumped via the
   * `bumpRemoved` callback.
   */

  /**
   * Walk every transition T on the patched workflow and remove any system:*
   * rule whose identity fingerprint is in the name-keyed spray pool but NOT
   * in T's own (structurally-correct) fingerprint set. This precisely targets
   * residue left over by past runs that sprayed rules onto every same-named
   * Cloud transition.
   *
   * Safety:
   *   - Only rules with a known _ruleIdentityFingerprint shape are touched —
   *     Connect/Forge/JMWE/unknown ruleKeys are left alone.
   *   - A rule is removed only if it MATCHES a fingerprint produced by another
   *     same-named DC transition this run AND does NOT match any fingerprint
   *     this transition is rightfully expected to own. Naturally-existing
   *     Cloud rules unrelated to this migration are unaffected.
   */

  /**
   * Rewrite legacy `connect:<appKey>__<module>` rules in-place into the modern
   * Cloud update-API shape. The required ruleKey depends on the rule's
   * category (where it lives on the transition):
   *
   *   Actions (post-functions):  connect:remote-workflow-function
   *   Validators:                connect:expression-validator
   *   Conditions:                connect:expression-condition
   *
   * Legacy shape (from an older CMA migration / older Connect SDK):
   *   { ruleKey: "connect:com.foo.app__SomeModule",
   *     parameters: { value: "<stringified JSON>", id, disabled, tag } }
   *
   * Modern shape:
   *   { ruleKey: "<category-specific>",
   *     parameters: { appKey: "com.foo.app__SomeModule",
   *                   config: "<same stringified JSON>", id, disabled, tag } }
   *
   * Detection is intentionally narrow: we ONLY rewrite when the ruleKey starts
   * with `connect:` AND the segment after that contains `.` AND `__` (matches
   * the Atlassian Connect addon-key + module-key convention) AND parameters
   * has `value` (the legacy config field name). Cloud's first-party
   * `connect:expression-*` and `connect:remote-workflow-function` keys do not
   * match the dot-and-double-underscore pattern and are left untouched.
   */

  _bucketForCategory(cloudTransition, ruleCategory) {
    if (!cloudTransition) return null;
    if (ruleCategory === "validator") {
      if (!Array.isArray(cloudTransition.validators)) cloudTransition.validators = [];
      return { array: cloudTransition.validators };
    }
    if (ruleCategory === "postFunction") {
      if (!Array.isArray(cloudTransition.actions)) cloudTransition.actions = [];
      return { array: cloudTransition.actions };
    }
    if (ruleCategory === "condition") {
      // Cloud's new-shape conditions tree uses { operation: "ALL"|"ANY",
      // conditionGroups: [...nested compounds], conditions: [...leaves] }.
      // Earlier versions of this code emitted the legacy {nodeType, operator}
      // shape, which Cloud's /workflows/update/validation rejects with a
      // generic 400 ("Invalid request payload"). The bootstrap branch fires
      // when a Cloud transition has no pre-existing conditions tree and we're
      // about to append the first rule.
      if (!cloudTransition.conditions) {
        cloudTransition.conditions = { operation: "ALL", conditionGroups: [], conditions: [] };
      }
      if (!Array.isArray(cloudTransition.conditions.conditions)) {
        // Convert a single leaf into a compound that preserves the leaf.
        const existing = cloudTransition.conditions;
        cloudTransition.conditions = {
          operation: "ALL",
          conditionGroups: [],
          conditions: existing && existing.ruleKey ? [existing] : [],
        };
      }
      return { array: cloudTransition.conditions.conditions };
    }
    return null;
  }

  _deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  _stripReadOnlyFields(cloudWorkflow) {
    delete cloudWorkflow.isEditable;
    delete cloudWorkflow.usages;
    delete cloudWorkflow.taskId;
    delete cloudWorkflow.created;
    delete cloudWorkflow.updated;
    delete cloudWorkflow.scope;
    const transitions = cloudWorkflow.transitions || [];
    for (const t of transitions) {
      if (t && t.properties && t.properties.issueEditable != null) {
        delete t.properties.issueEditable;
      }
    }
    const statuses = cloudWorkflow.statuses || [];
    for (const s of statuses) {
      if (s && s.name) delete s.name;
      if (s && s.properties && s.properties.issueEditable != null) {
        delete s.properties.issueEditable;
      }
    }
  }

  _buildUpdateEnvelope(patched, topLevelStatuses) {
    const { id, version, _topLevelStatuses, ...rest } = patched;
    const { name, ...withoutName } = rest;
    return {
      statuses: topLevelStatuses || [],
      workflows: [
        {
          id,
          version,
          ...withoutName,
        },
      ],
    };
  }

  async _callValidate(envelope) {
    try {
      return await this.cloud.validateUpdateWorkflowsBulk(envelope);
    } catch (err) {
      return { _error: err.message, statusCode: err.statusCode || null };
    }
  }

  _validationHasErrors(validation) {
    if (!validation) return false;
    if (validation._error) return true;
    // Cloud validation responses mix WARNING + ERROR in the same `errors` array.
    // Only ERROR-level entries should block mutation; warnings are advisory.
    const entries = validation.errors;
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (!e) continue;
        const level = (e.level || "ERROR").toUpperCase();
        if (level === "ERROR") return true;
      }
    }
    if (Array.isArray(validation.errorMessages) && validation.errorMessages.length > 0) return true;
    const ruleErr = validation.ruleUpdateErrors;
    if (ruleErr && typeof ruleErr === "object" && Object.keys(ruleErr).length > 0) return true;
    const results = validation.updateResults || validation.validationResults;
    if (Array.isArray(results)) {
      for (const r of results) {
        if (Array.isArray(r.errors)) {
          for (const e of r.errors) {
            const level = (e && e.level ? e.level : "ERROR").toUpperCase();
            if (level === "ERROR") return true;
          }
        }
        if (r.ruleUpdateErrors && Object.keys(r.ruleUpdateErrors).length) return true;
        if (Array.isArray(r.updateErrors) && r.updateErrors.length) return true;
      }
    }
    return false;
  }
}

module.exports = JsuApplier;
