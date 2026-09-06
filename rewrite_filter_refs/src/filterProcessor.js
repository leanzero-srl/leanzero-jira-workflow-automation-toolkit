const {
  extractFilterIds,
  rewriteJql,
  rewriteAqlFunctionBodies,
} = require("./jqlRewriter");
const { rewriteAql } = require("./aqlRewriter");
const { sanitizeJql } = require("./jqlSanitizer");
const { rewriteAssetFieldRefs } = require("./assetFieldRewriter");
const { rewriteTrafficLightFields } = require("./trafficLightFieldRewriter");
const { rewritePriorityValues } = require("./priorityRewriter");
const { cleanOrderBy } = require("./orderByCleaner");
const { stripBrokenFunctions, cleanupJql } = require("./brokenFunctionStripper");
const {
  detectMissingProjects,
  pruneMissingProjectsFromInLists,
} = require("./projectValidator");
const {
  parseMissingFieldValues,
  stripMissingValues,
} = require("./jqlValueStripper");
const { swapOwner, restoreOwner } = require("./ownerSwap");
const {
  mergeSharePermissions,
  mergeEditPermissions,
  stripForWrite,
  sanitizePermissionsForWrite,
  parseDeniedGroupsFromError,
  dropDeniedGroupsFromPermissions,
} = require("./permissions");

// Orchestrates Phase 1 (buildPlan) and Phase 2 (executePlan) with a four-pass
// rewrite pipeline (filter-ref → asset-ref → sanitize) and a six-step
// resumable state machine per filter (pre-fetch → owner-swap → update →
// owner-restore → finalize).

class FilterProcessor {
  constructor({
    cloudClient,
    dcClient,
    mapper,
    planManager,
    reportWriter,
    options = {},
    log,
  }) {
    this.cloudClient = cloudClient;
    this.dcClient = dcClient;
    this.mapper = mapper;
    this.planManager = planManager;
    this.reportWriter = reportWriter;
    this.log = log || console.log;

    this.dryRun = options.dryRun || false;
    this.limit = options.limit || 0;
    this.concurrency = options.concurrency || 5;
    this.retryFailed = options.retryFailed || false;
    this.idFile = options.idFile || null;
    this.namePrefix = options.namePrefix || null;
    this.skipNotOwned = options.skipNotOwned || false;
    this.verifyName = options.verifyName || false;
    // --avoid-overwrite: pre-GET each filter and compare live JQL against the
    // expectedLiveJql captured at refresh time. If they differ, skip — someone
    // modified the filter on Cloud and we'd clobber their change.
    this.avoidOverwrite = options.avoidOverwrite || false;
    this.currentAccountId = options.currentAccountId || null;

    // v2 additions
    this.ownerSwap = options.ownerSwap !== false; // default on
    this.swapOnlyOn403 = options.swapOnlyOn403 || false;
    // After swapping owner to do the JQL edit, restore the original owner (default).
    // Set restoreOwner:false (--no-owner-restore) to LEAVE each filter owned by the
    // running account. Required if you want the org-admins share to PERSIST: Cloud
    // drops an org-admins share whenever the filter's owner is not itself
    // org-admins-capable, so restoring a non-admin owner silently reverts the share.
    this.restoreOwner = options.restoreOwner !== false; // default on
    this.shareOrgAdmins = options.shareOrgAdmins !== false; // default on
    this.orgAdminsGroup = options.orgAdminsGroup || null;
    this.rewriteAssets = options.rewriteAssets !== false; // default on
    this.assetMaps = options.assetMaps || {
      dcKeyToCloudKey: new Map(),
      dcObjectIdToCloudObjectId: new Map(),
    };
    this.sanitize = options.sanitize !== false; // default on
    this.sanitizerOptions = options.sanitizerOptions || {};

    // v2.2: direct Asset-field references (outside aqlFunction) +
    // ORDER BY clean-up for Asset fields. assetFieldNames is a Set of
    // normalized (lowercased, NFC-normalized) Cloud asset custom-field names.
    this.assetFieldRewrite = options.assetFieldRewrite !== false; // default on
    this.orderByClean = options.orderByClean !== false; // default on
    this.assetFieldNames = options.assetFieldNames || new Set();
    // Forge traffic-light status fields need `.Label` appended to value
    // comparisons (e.g. `"Team Priority" = "Important"` →
    // `"Team Priority.Label" = "Important"`) because the stored value
    // is an object {shape, label}, and the plain field name returns 0 rows.
    this.trafficLightRewrite = options.trafficLightRewrite !== false; // default on
    this.trafficLightFieldNames = options.trafficLightFieldNames || new Set();

    // v2.3: priority name rewrites. Cloud preserves priority IDs across JCMA
    // but operators may rename priorities by hand in the UI post-migration.
    // priorityNameMap is keyed by normalized (NFC+lc+trim) DC name; values
    // are the current Cloud display names. Identities are filtered out at
    // build time so any entry implies a rewrite.
    this.priorityRewrite = options.priorityRewrite !== false; // default on
    this.priorityNameMap = options.priorityNameMap || null; // Map<string,string> | null

    // v2.1: post-mortem mitigations for the failure classes uncovered in
    // the first production-scale dry run.
    this.stripBrokenFunctions = options.stripBrokenFunctions || false;
    this.brokenFunctionList = options.brokenFunctionList || null;
    this.knownProjectsLc = options.knownProjectsLc || null; // Set<string>|null
    this.skipMissingProjects = options.skipMissingProjects || false;
    this.stripMissingProjects = options.stripMissingProjects || false;
    // Reactive value-strip options. The IN-list drop is always-on (safe);
    // the equality-form drop is destructive (changes filter semantics) so
    // it's gated behind an explicit opt-in flag.
    this.stripEqualityMisses = options.stripEqualityMisses || false;

    this.stats = {
      totalCloudFilters: 0,
      filtersWithRefs: 0,
      filtersNoRefs: 0,
      refsTotal: 0,
      refsResolvedOk: 0,
      refsDcDeleted: 0,
      refsCloudNotFound: 0,
      refsCollision: 0,
      aqlRewrites: 0,
      sanitizerHits: 0,
      cfRemaps: 0,
      assetFieldRewrites: 0,
      filtersWithAssetFieldRewrites: 0,
      trafficLightLabelAppended: 0,
      filtersWithTrafficLightLabel: 0,
      orderByStrippedTotal: 0,
      filtersWithOrderByStripped: 0,
      brokenFunctionsStripped: 0,
      filtersWithBrokenFunctions: 0,
      filtersWithMissingProjects: 0,
      missingProjectTokensStripped: 0,
      filtersSkippedMissingProject: 0,
      filtersUpdated: 0,
      filtersFailed: 0,
      filtersSkipped: 0,
      ownerSwapFailures: 0,
      ownerRestoreFailures: 0,
      permissionsFailures: 0,
      sharePermissionsAdded: 0,
      sharePermissionAddFailures: 0,
      skippedExternallyModified: 0,
      shareEntriesDropped: 0,
      deniedGroupRetries: 0,
      deniedGroupRetrySuccesses: 0,
      valueStripRetries: 0,
      valueStripRetrySuccesses: 0,
      valueStripDroppedTotal: 0,
      valueStripEqualityBlocked: 0,
      valueStripEqualityStripped: 0,
      priorityRewrites: 0,
      filtersWithPriorityRewrites: 0,
    };
  }

  getStats() {
    return { ...this.stats };
  }

  // ─────────────────────────────────────────────────
  //  PHASE 1: BUILD PLAN
  // ─────────────────────────────────────────────────

  async buildPlan(runId) {
    this.log("\nStep 1: Fetching all Cloud filters...");
    let cloudFilters = await this.cloudClient.searchAllFilters({
      expand: "jql,owner,description,sharePermissions,editPermissions",
      limit: this.limit,
    });
    this.log(`  Fetched ${cloudFilters.length} Cloud filter(s)`);

    this.mapper.seedCloudFilters(cloudFilters);

    if (this.idFile) {
      const fs = require("fs");
      const allowed = new Set(
        fs
          .readFileSync(this.idFile, "utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      );
      const before = cloudFilters.length;
      cloudFilters = cloudFilters.filter((f) => allowed.has(String(f.id)));
      this.log(
        `  --id-file: ${cloudFilters.length}/${before} filters match ${this.idFile}`
      );
    }

    if (this.namePrefix) {
      const p = this.namePrefix.toLowerCase();
      const before = cloudFilters.length;
      cloudFilters = cloudFilters.filter((f) =>
        (f.name || "").toLowerCase().startsWith(p)
      );
      this.log(
        `  --name-prefix "${this.namePrefix}": ${cloudFilters.length}/${before} filters match`
      );
    }

    if (this.skipNotOwned && this.currentAccountId) {
      const before = cloudFilters.length;
      cloudFilters = cloudFilters.filter(
        (f) => f.owner && f.owner.accountId === this.currentAccountId
      );
      this.log(
        `  --skip-not-owned: ${cloudFilters.length}/${before} filters owned by current account`
      );
    }

    this.stats.totalCloudFilters = cloudFilters.length;

    this.log("\nStep 2: Parsing JQL and resolving refs...");
    const filtersMap = {};
    let processed = 0;

    let buildErrors = 0;
    for (const filter of cloudFilters) {
      processed++;
      if (processed % 50 === 0) {
        this.log(
          `  Progress: ${processed}/${cloudFilters.length} filters scanned`
        );
      }
      try {
        await this._buildPlanEntry(filter, filtersMap);
      } catch (err) {
        buildErrors++;
        const cid = String((filter && filter.id) || "");
        this.log(
          `  ⚠  buildPlan error on filter ${cid} "${(filter && filter.name) || ""}": ${err.message}`,
        );
        if (cid) {
          filtersMap[cid] = {
            status: "failed",
            name: (filter && filter.name) || "",
            originalJql: (filter && filter.jql) || "",
            rewrittenJql: (filter && filter.jql) || "",
            error: `buildPlan_error: ${err.message}`,
            executionPhase: "failed",
            updatedAt: null,
          };
        }
      }
    }
    this.stats.buildErrors = buildErrors;
    if (buildErrors > 0) {
      this.log(`  ${buildErrors} filter(s) errored during buildPlan and were marked as failed.`);
    }

    // (Per-filter logic lives in _buildPlanEntry below.)

    // Persist
    this.planManager.createMasterIndex(runId);
    const { planFile } = this.planManager.createPlan(runId, filtersMap);

    if (this.planManager.masterIndex) {
      Object.assign(this.planManager.masterIndex.stats, {
        totalCloudFilters: this.stats.totalCloudFilters,
        filtersWithRefs: this.stats.filtersWithRefs,
        filtersNoRefs: this.stats.filtersNoRefs,
        refsTotal: this.stats.refsTotal,
        refsResolvedOk: this.stats.refsResolvedOk,
        refsDcDeleted: this.stats.refsDcDeleted,
        refsCloudNotFound: this.stats.refsCloudNotFound,
        refsCollision: this.stats.refsCollision,
        aqlRewrites: this.stats.aqlRewrites,
        sanitizerHits: this.stats.sanitizerHits,
      });
      this.planManager.saveMasterIndex();
    }

    this.log(`\n  Plan saved: ${planFile}`);
    this.log(`  ${this.planManager.formatStats()}`);
    this.log(
      `  asset rewrites: ${this.stats.aqlRewrites} | sanitizer edits: ${this.stats.sanitizerHits}`,
    );

    this.reportWriter.writeUnresolved(filtersMap);
    this.reportWriter.writeCollisions(filtersMap);
    if (this.stripBrokenFunctions) {
      this.reportWriter.writeStrippedFunctions(filtersMap);
    }
    if (this.knownProjectsLc && this.knownProjectsLc.size > 0) {
      this.reportWriter.writeMissingProjects(filtersMap);
    }
    if (this.assetFieldRewrite && this.assetFieldNames && this.assetFieldNames.size > 0) {
      this.reportWriter.writeAssetFieldRewrites(filtersMap);
    }
    if (this.orderByClean && this.assetFieldNames && this.assetFieldNames.size > 0) {
      this.reportWriter.writeOrderByStripped(filtersMap);
    }
    if (
      this.trafficLightRewrite &&
      this.trafficLightFieldNames &&
      this.trafficLightFieldNames.size > 0
    ) {
      this.reportWriter.writeTrafficLightLabels(filtersMap);
    }
    if (
      this.priorityRewrite &&
      this.priorityNameMap &&
      this.priorityNameMap.size > 0
    ) {
      this.reportWriter.writePriorityRewrites(filtersMap);
    }
  }

  // Single-filter buildPlan logic. Wrapped in try/catch by the caller so
  // one bad filter cannot abort a 13k-filter run.
  async _buildPlanEntry(filter, filtersMap) {
    const cloudId = String(filter.id);
    const name = filter.name || "";
    const jql = filter.jql || "";

    const owner = filter.owner
      ? {
          accountId: filter.owner.accountId,
          displayName: filter.owner.displayName,
        }
      : null;
    const originalSharePermissions = Array.isArray(filter.sharePermissions)
      ? filter.sharePermissions
      : [];
    const originalEditPermissions = Array.isArray(filter.editPermissions)
      ? filter.editPermissions
      : [];

    // Pass 1: filter refs
    const filterRefs = extractFilterIds(jql);
    const refDetails = [];
    const dcToCloudFilterMap = new Map();

    if (filterRefs.length > 0) {
      this.stats.filtersWithRefs++;
      const uniqueDcIds = Array.from(new Set(filterRefs.map((r) => r.id)));
      this.stats.refsTotal += uniqueDcIds.length;

      for (const dcId of uniqueDcIds) {
        const dcName = await this.mapper.resolveDcName(dcId);
        if (dcName == null) {
          refDetails.push({ kind: "filter", dcId, resolution: "dc_deleted" });
          this.stats.refsDcDeleted++;
          continue;
        }
        const cloudRes = await this.mapper.resolveCloudIdByName(dcName);
        if (cloudRes.status === "not_found") {
          refDetails.push({
            kind: "filter",
            dcId,
            dcName,
            resolution: "cloud_not_found",
          });
          this.stats.refsCloudNotFound++;
          continue;
        }
        if (cloudRes.status === "collision") {
          refDetails.push({
            kind: "filter",
            dcId,
            dcName,
            resolution: "collision",
            candidates: cloudRes.candidates,
          });
          this.stats.refsCollision++;
          continue;
        }
        refDetails.push({
          kind: "filter",
          dcId,
          dcName,
          cloudId: cloudRes.cloudId,
          resolution: "ok",
        });
        dcToCloudFilterMap.set(dcId, cloudRes.cloudId);
        this.stats.refsResolvedOk++;
      }
    }

    const jql1 = rewriteJql(jql, dcToCloudFilterMap).rewritten;

    // Pass 2: aqlFunction asset refs
    let jql2 = jql1;
    let aqlReplacements = [];
    let aqlUnresolved = [];
    if (this.rewriteAssets) {
      const aqlFn = (body) => rewriteAql(body, this.assetMaps);
      const r2 = rewriteAqlFunctionBodies(jql1, aqlFn);
      jql2 = r2.rewritten;
      aqlReplacements = r2.replacements || [];
      aqlUnresolved = r2.unresolved || [];
      this.stats.aqlRewrites += aqlReplacements.length;
    }

    // Pass 2b: direct Asset-field references (outside aqlFunction). Converts
    // "Development Team" = 14032 / "CMDB-21171" / ari:cloud:… into
    // "Development Team" = "Platform Squad" (the object name). Only runs when
    // we know which fields are CMDB Asset fields (via the field-map builder).
    let jql2b = jql2;
    let assetFieldReplacements = [];
    let assetFieldUnresolved = [];
    if (
      this.assetFieldRewrite &&
      this.assetFieldNames &&
      this.assetFieldNames.size > 0
    ) {
      const r2b = rewriteAssetFieldRefs(jql2, {
        assetFieldNames: this.assetFieldNames,
        dcKeyToCloudName: this.assetMaps.dcKeyToCloudName || null,
        dcObjectIdToCloudName: this.assetMaps.dcObjectIdToCloudName || null,
        cloudObjectIdToCloudName: this.assetMaps.cloudObjectIdToCloudName || null,
        cloudKeyToCloudName: this.assetMaps.cloudKeyToCloudName || null,
      });
      jql2b = r2b.rewritten;
      assetFieldReplacements = r2b.replacements || [];
      assetFieldUnresolved = r2b.unresolved || [];
      if (assetFieldReplacements.length > 0) {
        this.stats.assetFieldRewrites += assetFieldReplacements.length;
        this.stats.filtersWithAssetFieldRewrites++;
      }
    }

    // Pass 2c: Forge traffic-light fields — append .Label to value-comparison
    // clauses when missing. Without this, "Team Priority" = "Important"
    // parses but returns 0 rows on Cloud because the field stores {shape,
    // label} as an object. Runs before sanitize so the new `.Label` form
    // survives the operator-uppercasing and IN-list quoting passes.
    let jql2c = jql2b;
    let trafficLightChanges = [];
    if (
      this.trafficLightRewrite &&
      this.trafficLightFieldNames &&
      this.trafficLightFieldNames.size > 0
    ) {
      const r2c = rewriteTrafficLightFields(jql2b, {
        trafficLightFieldNames: this.trafficLightFieldNames,
      });
      jql2c = r2c.rewritten || jql2b;
      trafficLightChanges = r2c.replacements || [];
      if (trafficLightChanges.length > 0) {
        this.stats.trafficLightLabelAppended += trafficLightChanges.length;
        this.stats.filtersWithTrafficLightLabel++;
      }
    }

    // Pass 2d: priority value rewrites. Cloud preserves priority IDs across
    // JCMA but the display NAME is mutable (JCMA may transform it, and
    // operators commonly rename priorities by hand in the UI post-migration).
    // We feed in a DC-name → Cloud-name map (built from the two /priority
    // endpoints paired by id) and rewrite the value tokens in priority = / !=
    // / IN / NOT IN clauses. Runs before sanitize so the newly-quoted values
    // survive operator-uppercasing and IN-list quoting passes intact.
    let jql2d = jql2c;
    let priorityReplacements = [];
    if (
      this.priorityRewrite &&
      this.priorityNameMap &&
      this.priorityNameMap.size > 0
    ) {
      const r2d = rewritePriorityValues(jql2c, {
        dcNameToCloudName: this.priorityNameMap,
      });
      jql2d = r2d.rewritten || jql2c;
      priorityReplacements = r2d.replacements || [];
      if (priorityReplacements.length > 0) {
        this.stats.priorityRewrites += priorityReplacements.length;
        this.stats.filtersWithPriorityRewrites++;
      }
    }

    // Pass 3: sanitize
    let jql3 = jql2d;
    let sanitizerChanges = [];
    if (this.sanitize) {
      const r3 = sanitizeJql(jql2d, this.sanitizerOptions);
      jql3 = r3.sanitized || jql2d;
      sanitizerChanges = r3.changes || [];
      this.stats.sanitizerHits += sanitizerChanges.length;
      this.stats.cfRemaps += sanitizerChanges.filter((c) => c.kind === "cf_remap").length;
    }

    // Pass 3b: ORDER BY clean — strip ORDER BY clauses on Asset fields
    // (Cloud explicitly does not support sorting by Assets fields). Other
    // ORDER BY fields are untouched.
    let jql3b = jql3;
    let orderByStripped = [];
    if (
      this.orderByClean &&
      this.assetFieldNames &&
      this.assetFieldNames.size > 0
    ) {
      const r3b = cleanOrderBy(jql3, { assetFieldNames: this.assetFieldNames });
      jql3b = r3b.rewritten || jql3;
      orderByStripped = r3b.stripped || [];
      if (orderByStripped.length > 0) {
        this.stats.orderByStrippedTotal += orderByStripped.length;
        this.stats.filtersWithOrderByStripped++;
      }
    }

    // Pass 4 (opt-in): strip JQL functions Cloud doesn't support
    let jql4 = jql3b;
    let strippedFunctions = [];
    if (this.stripBrokenFunctions) {
      const r4 = stripBrokenFunctions(jql3b, {
        functions: this.brokenFunctionList || undefined,
      });
      jql4 = r4.rewritten || jql3b;
      strippedFunctions = r4.stripped || [];
      if (strippedFunctions.length > 0) {
        this.stats.brokenFunctionsStripped += strippedFunctions.length;
        this.stats.filtersWithBrokenFunctions++;
      }
    }

    // Pass 5: project validation
    let jql5 = jql4;
    let projectStripped = [];
    let missingProjects = [];
    let projectMissEquality = false;
    let projectInListUnfixable = false;
    if (this.knownProjectsLc && this.knownProjectsLc.size > 0) {
      if (this.stripMissingProjects) {
        const r5 = pruneMissingProjectsFromInLists(jql4, this.knownProjectsLc);
        missingProjects = r5.missingValues || [];
        projectMissEquality = r5.hasEqualityMiss;
        if (r5.rewritten == null) {
          projectInListUnfixable = true;
        } else {
          jql5 = r5.rewritten;
          projectStripped = r5.dropped || [];
          this.stats.missingProjectTokensStripped += projectStripped.length;
        }
      } else {
        missingProjects = detectMissingProjects(jql4, this.knownProjectsLc);
        projectMissEquality = missingProjects.length > 0;
      }
      if (missingProjects.length > 0) {
        this.stats.filtersWithMissingProjects++;
      }
    }

    const rewrittenJql = jql5;
    const hasAnyChange =
      rewrittenJql !== jql ||
      aqlReplacements.length > 0 ||
      assetFieldReplacements.length > 0 ||
      trafficLightChanges.length > 0 ||
      priorityReplacements.length > 0 ||
      sanitizerChanges.length > 0 ||
      orderByStripped.length > 0 ||
      strippedFunctions.length > 0 ||
      projectStripped.length > 0;

    let status;
    let skipReason = null;
    const projectsBlockExecution =
      this.skipMissingProjects &&
      (projectMissEquality || projectInListUnfixable);

    if (projectsBlockExecution) {
      status = "skipped";
      skipReason = "project_missing";
      this.stats.filtersSkippedMissingProject++;
    } else if (filterRefs.length === 0 && !hasAnyChange) {
      this.stats.filtersNoRefs++;
      status = "no_change";
    } else {
      const anyRewrite =
        jql1 !== jql ||
        aqlReplacements.length > 0 ||
        assetFieldReplacements.length > 0 ||
        trafficLightChanges.length > 0 ||
        priorityReplacements.length > 0 ||
        sanitizerChanges.length > 0 ||
        orderByStripped.length > 0 ||
        strippedFunctions.length > 0 ||
        projectStripped.length > 0;
      status = anyRewrite ? "pending" : "skipped";
    }

    filtersMap[cloudId] = {
      status,
      name,
      owner,
      originalOwner: owner,
      originalSharePermissions,
      originalEditPermissions,
      ownerSwapped: false,
      ownerRestored: false,
      jqlUpdated: false,
      permissionsAdded: false,
      executionPhase: "idle",
      lastStepError: null,
      currentOwnerAccountId: owner ? owner.accountId : null,
      originalJql: jql,
      rewrittenJql,
      description: filter.description || "",
      refs: refDetails,
      sanitizerChanges,
      aqlReplacements,
      aqlUnresolved,
      assetFieldReplacements,
      assetFieldUnresolved,
      trafficLightChanges,
      priorityReplacements,
      orderByStripped,
      strippedFunctions,
      missingProjects,
      projectStripped,
      skipReason,
      error: skipReason ? `skipped: ${skipReason}` : null,
      updatedAt: null,
    };
  }

  // ─────────────────────────────────────────────────
  //  PHASE 2: EXECUTE PLAN  (6-step state machine)
  // ─────────────────────────────────────────────────

  async executePlan() {
    let toProcess = this.planManager.getFiltersToProcess(this.retryFailed);

    // Allow --id-file to scope EXECUTION (not just build). When supplied at
    // execute time, only filters whose Cloud id is in the file get PUT.
    if (this.idFile) {
      const fs = require("fs");
      const allowed = new Set(
        fs.readFileSync(this.idFile, "utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const before = toProcess.length;
      toProcess = toProcess.filter(([cid]) => allowed.has(cid));
      this.log(
        `  --id-file (execute): ${toProcess.length}/${before} filters match ${this.idFile}`,
      );
    }

    if (toProcess.length === 0) {
      this.log("  No filters to process.");
      return;
    }

    // For "failed" entries that already completed an owner-restore in a prior
    // run, we no longer own the filter. The state-machine flags must be
    // cleared so step 2 re-acquires ownership before retrying the PUT.
    // Don't clear partial-run state where ownership is still ours
    // (ownerSwapped && !ownerRestored).
    if (this.retryFailed) {
      let resetCount = 0;
      for (const [cloudId, data] of toProcess) {
        if (data.status !== "failed") continue;
        if (data.ownerSwapped && data.ownerRestored) {
          // Full prior cycle ran and restored ownership — start over.
          data.ownerSwapped = false;
          data.ownerRestored = false;
          data.jqlUpdated = false;
          data.permissionsAdded = false;
          data.executionPhase = "idle";
          data.lastStepError = null;
          this.planManager.updateFilterEntry(cloudId, {
            ownerSwapped: false,
            ownerRestored: false,
            jqlUpdated: false,
            permissionsAdded: false,
            executionPhase: "idle",
            lastStepError: null,
          });
          resetCount++;
        }
      }
      if (resetCount > 0) {
        this.log(
          `  --retry-failed: reset state on ${resetCount} previously-completed-then-failed filter(s) so owner re-swap fires.`,
        );
      }
    }

    this.log(
      `\n  Executing plan: ${toProcess.length} filter(s) to update (concurrency: ${this.concurrency})...`
    );

    if (this.dryRun) {
      this.log("  *** DRY RUN - No changes will be made ***");
      for (const [cloudId, data] of toProcess) {
        this.log(`\n    [DRY RUN] filter ${cloudId} "${data.name}":`);
        if (this.ownerSwap && this.currentAccountId) {
          const orig = data.originalOwner || data.owner;
          const need = orig && orig.accountId !== this.currentAccountId;
          this.log(
            `      owner: ${orig ? orig.accountId : "?"} → ${this.currentAccountId}${need ? "" : " (already owner, skip swap)"} → restore`,
          );
        }
        if (this.shareOrgAdmins && this.orgAdminsGroup) {
          this.log(
            `      permissions: will add "${this.orgAdminsGroup.name}" (groupId=${this.orgAdminsGroup.groupId || "n/a"}) to share + edit`,
          );
        }
        this.log(`      original JQL:  ${data.originalJql}`);
        this.log(`      rewritten JQL: ${data.rewrittenJql}`);
        if ((data.aqlReplacements || []).length > 0) {
          this.log(
            `      asset rewrites: ${(data.aqlReplacements || []).length}`,
          );
        }
        if ((data.sanitizerChanges || []).length > 0) {
          this.log(
            `      sanitizer edits: ${(data.sanitizerChanges || []).length}`,
          );
        }
        this.stats.filtersUpdated++;
      }
      return;
    }

    const batchSize = this.concurrency * 5;
    const totalBatches = Math.ceil(toProcess.length / batchSize);
    let processed = 0;

    for (let b = 0; b < totalBatches; b++) {
      const batchStart = b * batchSize;
      const batch = toProcess.slice(batchStart, batchStart + batchSize);

      const results = await this._executeBatch(batch, this.concurrency);

      let batchRateLimits = 0;
      for (const [cloudId, result] of results) {
        processed++;
        if (result.success) {
          this.planManager.updateFilterStatus(cloudId, "completed");
          this.stats.filtersUpdated++;
        } else if (
          result.error === "externally_modified" ||
          result.error === "jql_changed_since_plan"
        ) {
          // _executeOne already marked these "skipped" via updateFilterStatus
          // — don't downgrade to "failed" here. Just count + log.
          this.stats.filtersSkipped = (this.stats.filtersSkipped || 0) + 1;
        } else {
          this.planManager.updateFilterStatus(
            cloudId,
            "failed",
            result.error
          );
          this.stats.filtersFailed++;
          if (result.isRateLimit) batchRateLimits++;
          if (this.stats.filtersFailed <= 10 || this.stats.filtersFailed % 50 === 0) {
            this.log(`    FAILED ${cloudId}: ${result.error}`);
          }
        }

        if (processed % 25 === 0) {
          this.log(
            `    Progress: ${processed}/${toProcess.length} (${this.stats.filtersUpdated} updated, ${this.stats.filtersFailed} failed)`
          );
        }
      }

      if (batchRateLimits > 0) {
        const pauseSeconds = Math.min(10 + batchRateLimits * 5, 60);
        this.log(
          `    ${batchRateLimits} rate limit(s) in batch - pausing ${pauseSeconds}s before next batch`
        );
        await new Promise((r) => setTimeout(r, pauseSeconds * 1000));
      }

      if ((b + 1) % 5 === 0) {
        this.planManager.savePlan();
      }
    }

    this.planManager.savePlan();

    if (this.planManager.plan) {
      this.reportWriter.writeRewrites(this.planManager.plan.filters);
      this.reportWriter.writeOrphanedOwnerSwaps(this.planManager.plan.filters);
      this.reportWriter.writeDroppedPermissions(this.planManager.plan.filters);
    }

    this.log(
      `\n  Execution complete: ${this.stats.filtersUpdated} updated, ${this.stats.filtersFailed} failed` +
        (this.stats.ownerRestoreFailures > 0
          ? `  ⚠  ${this.stats.ownerRestoreFailures} orphaned owner swaps — see CSV.`
          : ""),
    );
  }

  // POST org-admins to a filter's share permissions, then VERIFY it actually
  // persisted (re-GET and confirm). Two distinct failure modes are handled:
  //   1) Propagation lag: when the caller was only just added to a group the
  //      filter is also shared with, Cloud accepts the POST but applies it
  //      asynchronously — a bare 2xx does NOT mean it stuck. We retry until it
  //      appears (or the attempts run out).
  //   2) Owner can't sustain the share (the important one): Cloud keeps a
  //      filter's share set consistent with its OWNER's sharing rights. If the
  //      filter is owned by a user who is NOT in org-admins (e.g. after this
  //      tool restores the original owner in step 4), Cloud silently DROPS the
  //      org-admins share again moments after the POST. No number of retries
  //      fixes that — the filter must END owned by an org-admins-capable
  //      account. We surface this as a non-persistent failure so the operator
  //      knows to re-own (see --no-owner-restore handling in the runbook).
  async _addOrgAdminsShareVerified(cloudId, orgGroup, attempts = 3, delayMs = 1500) {
    const postBody = orgGroup.groupId
      ? { type: "group", groupId: orgGroup.groupId }
      : { type: "group", groupname: orgGroup.name };
    const present = (perms) =>
      (perms || []).some(
        (p) =>
          p && p.type === "group" && p.group &&
          ((orgGroup.groupId && p.group.groupId === orgGroup.groupId) ||
            (orgGroup.name && p.group.name === orgGroup.name)),
      );
    let lastErr = "did-not-persist (filter owner likely cannot sustain the org-admins share)";
    for (let i = 0; i < attempts; i++) {
      try {
        await this.cloudClient.addFilterSharePermission(cloudId, postBody);
      } catch (postErr) {
        lastErr = `${postErr.statusCode || "?"}: ${String(
          postErr.responseBody || postErr.message || "",
        ).slice(0, 240)}`;
        // Hard rejections (caller not allowed to share with a group already on
        // the filter, or a 'loggedin'+group conflict) never succeed on retry.
        if (/permission to share with|must not be included/i.test(lastErr)) {
          return { ok: false, error: lastErr };
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      try {
        const perms = await this.cloudClient.getFilterPermissions(cloudId);
        if (present(perms)) return { ok: true };
      } catch {
        /* verify GET failed transiently; retry */
      }
    }
    return { ok: false, error: lastErr };
  }

  async _executeBatch(batch, concurrency) {
    const results = new Map();
    let idx = 0;

    const worker = async () => {
      while (idx < batch.length) {
        const entryIdx = idx++;
        const [cloudId, data] = batch[entryIdx];
        const result = await this._executeOne(cloudId, data);
        results.set(cloudId, result);
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, batch.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }

  /**
   * 6-step state machine for one filter. Idempotent: each step no-ops if its
   * target condition is already met, so --resume can re-enter at any phase.
   */
  async _executeOne(cloudId, data) {
    const pm = this.planManager;

    // Step 1: optional pre-fetch / verify. Always do it the first time we see
    // the filter in phase 2, to capture originalSharePermissions / Edit /
    // Owner. If already captured in plan, skip unless --verify-name or
    // --avoid-overwrite requests a revalidation.
    try {
      const needFetch = this.verifyName || this.avoidOverwrite || !data.originalOwner;
      if (needFetch) {
        const live = await this.cloudClient.getFilter(cloudId);
        if (this.verifyName && (live.jql || "") !== (data.originalJql || "")) {
          pm.updateFilterEntry(cloudId, {
            executionPhase: "done",
            lastStepError: "jql_changed_since_plan",
          });
          pm.updateFilterStatus(cloudId, "skipped", "jql_changed_since_plan");
          return {
            success: false,
            error: "jql_changed_since_plan",
            isRateLimit: false,
          };
        }
        // --avoid-overwrite: compare Cloud's current JQL against what we
        // expect it to be (the prior rewrittenJql if we previously PUT, or
        // the originalJql if we never PUT). A mismatch means someone edited
        // the filter externally — skip rather than clobber their change.
        if (this.avoidOverwrite) {
          const liveJqlRaw = String(live.jql || "").trim();
          // Fallback chain: expectedLiveJql (set by refresh_plan) → originalJql.
          // CRITICAL: empty string is a falsy sentinel — many entries in the
          // existing plan have `expectedLiveJql: ""` (set by older refreshes
          // that didn't compute it). Treat empty same as missing so we don't
          // false-positive an externally_modified on every such entry.
          const elj = data.expectedLiveJql;
          const hasExpected = typeof elj === "string" && elj.trim().length > 0;
          const expectedRaw = String(
            hasExpected ? elj : (data.originalJql || ""),
          ).trim();
          // Compare AFTER sanitize on both sides. Cosmetic differences like
          // `not in` → `NOT IN` and bare → quoted tokens are added by a
          // prior run's sanitize pass and are NOT external edits. Sanitize
          // is idempotent, so running it on both sides converges to the
          // same form unless the underlying clauses really differ.
          const expected = expectedRaw
            ? sanitizeJql(expectedRaw).sanitized.trim()
            : "";
          const liveJql = liveJqlRaw
            ? sanitizeJql(liveJqlRaw).sanitized.trim()
            : "";
          if (expected && liveJql !== expected) {
            this.stats.skippedExternallyModified =
              (this.stats.skippedExternallyModified || 0) + 1;
            pm.updateFilterEntry(cloudId, {
              executionPhase: "done",
              lastStepError: "externally_modified",
              liveJqlAtCheck: liveJqlRaw,
              expectedLiveJqlAtCheck: expectedRaw,
              liveJqlAtCheckSanitized: liveJql,
              expectedLiveJqlAtCheckSanitized: expected,
            });
            pm.updateFilterStatus(cloudId, "skipped", "externally_modified");
            return {
              success: false,
              error: "externally_modified",
              isRateLimit: false,
            };
          }
        }
        if (!data.originalOwner && live.owner) {
          data.originalOwner = {
            accountId: live.owner.accountId,
            displayName: live.owner.displayName,
          };
          pm.updateFilterEntry(cloudId, { originalOwner: data.originalOwner });
        }
        if (!data.originalSharePermissions) {
          data.originalSharePermissions = Array.isArray(live.sharePermissions)
            ? live.sharePermissions
            : [];
          pm.updateFilterEntry(cloudId, {
            originalSharePermissions: data.originalSharePermissions,
          });
        }
        if (!data.originalEditPermissions) {
          data.originalEditPermissions = Array.isArray(live.editPermissions)
            ? live.editPermissions
            : [];
          pm.updateFilterEntry(cloudId, {
            originalEditPermissions: data.originalEditPermissions,
          });
        }
      }
    } catch (err) {
      const errStr = `pre-GET failed: ${err.message}`;
      pm.updateFilterEntry(cloudId, {
        executionPhase: "failed",
        lastStepError: errStr,
      });
      return {
        success: false,
        error: errStr,
        isRateLimit: err.statusCode === 429,
      };
    }

    const originalOwnerId =
      data.originalOwner && data.originalOwner.accountId
        ? data.originalOwner.accountId
        : null;
    const needSwap =
      this.ownerSwap &&
      this.currentAccountId &&
      originalOwnerId &&
      originalOwnerId !== this.currentAccountId;

    // Step 2: owner swap (skippable via --swap-only-on-403)
    const attemptSwap = needSwap && !this.swapOnlyOn403 && !data.ownerSwapped;
    if (attemptSwap) {
      pm.updateFilterEntry(cloudId, { executionPhase: "owner_swapping" });
      try {
        await swapOwner(this.cloudClient, cloudId, this.currentAccountId);
        data.ownerSwapped = true;
        pm.updateFilterEntry(cloudId, {
          ownerSwapped: true,
          currentOwnerAccountId: this.currentAccountId,
          executionPhase: "owner_swapped",
        });
        // Eventual-consistency wait: Cloud's owner-permission cache can take
        // a beat to invalidate after PUT /filter/{id}/owner. PUT /filter/{id}
        // issued immediately after sometimes returns 403 "you don't own this
        // filter" because the cache still has the prior owner. The official
        // docs don't quote a number but in practice a short pause + retry on
        // 403 reliably covers the gap.
        const swapWaitMs = this.ownerSwapWaitMs != null ? this.ownerSwapWaitMs : 1500;
        if (swapWaitMs > 0) {
          await new Promise((r) => setTimeout(r, swapWaitMs));
        }
      } catch (err) {
        this.stats.ownerSwapFailures++;
        const errStr = `owner_swap_failed: ${err.message}`;
        pm.updateFilterEntry(cloudId, {
          executionPhase: "failed",
          lastStepError: errStr,
        });
        return {
          success: false,
          error: errStr,
          isRateLimit: err.statusCode === 429,
        };
      }
    }

    // Step 3: atomic update. Skip the PUT itself if a prior partial run
    // already did it (jqlUpdated=true) — avoids an extra API call and any
    // risk of overwriting a human hand-edit between runs. Fall through to
    // step 4 so the owner can still be restored.
    let updateResult = null;
    if (data.jqlUpdated) {
      pm.updateFilterEntry(cloudId, { executionPhase: "updated" });
      updateResult = { success: true };
    } else {
      pm.updateFilterEntry(cloudId, { executionPhase: "updating" });

      // Build the share/edit lists once; the retry path may further prune them.
      // Sanitize first to drop pre-existing entries Cloud rejects (loggedin
      // alias-mapped to authenticated, project-unknown, malformed entries
      // from JCMA), then merge in org-admins (when enabled), then strip
      // server-only fields for the PUT.
      //
      // Cloud rule: `authenticated` (formerly `loggedin`) and `global` cannot
      // coexist with specific user/group/project shares. So when the original
      // permissions are exclusively broad, we leave them alone (skip the
      // merge by passing undefined → Cloud preserves the original); when the
      // original is mixed or all-specific, we drop the broad entries before
      // merging org-admins.
      const isBroad = (p) => p.type === "authenticated" || p.type === "global";
      const isSpecific = (p) =>
        p.type === "user" ||
        p.type === "group" ||
        p.type === "project" ||
        p.type === "projectRole";
      const reconcile = (sanitized) => {
        const hasBroad = sanitized.some(isBroad);
        const hasSpec = sanitized.some(isSpecific);
        if (hasBroad && !hasSpec) {
          // Broad-only: skip merging org-admins (would conflict with the
          // broad type). Keep the filter's original "everyone" semantics.
          return { merged: undefined, broadOnlyPreserved: true };
        }
        // Drop any broad entries before merging org-admins (which is specific).
        const cleaned = sanitized.filter((p) => !isBroad(p));
        return { merged: cleaned, broadOnlyPreserved: false };
      };

      let shareList;
      let editList;
      let droppedFromShare = [];
      let droppedFromEdit = [];
      let shareBroadOnly = false;
      let editBroadOnly = false;
      if (this.shareOrgAdmins && this.orgAdminsGroup) {
        const ss = sanitizePermissionsForWrite(
          data.originalSharePermissions || [],
        );
        const se = sanitizePermissionsForWrite(
          data.originalEditPermissions || [],
        );
        droppedFromShare = ss.dropped;
        droppedFromEdit = se.dropped;

        const sr = reconcile(ss.sanitized);
        const er = reconcile(se.sanitized);
        shareBroadOnly = sr.broadOnlyPreserved;
        editBroadOnly = er.broadOnlyPreserved;
        shareList = sr.merged
          ? mergeSharePermissions(sr.merged, this.orgAdminsGroup)
          : undefined;
        editList = er.merged
          ? mergeEditPermissions(er.merged, this.orgAdminsGroup)
          : undefined;

        if (droppedFromShare.length || droppedFromEdit.length || shareBroadOnly || editBroadOnly) {
          this.stats.shareEntriesDropped +=
            droppedFromShare.length + droppedFromEdit.length;
          pm.updateFilterEntry(cloudId, {
            sharePermissionsDropped: droppedFromShare,
            editPermissionsDropped: droppedFromEdit,
            shareBroadOnly,
            editBroadOnly,
          });
        }
      }
      // When we are not merging org-admins, omit the permissions fields
      // entirely so Cloud preserves whatever's on the filter. Passing an
      // empty array would WIPE all existing shares (Cloud replaces arrays
      // wholesale).

      // CRITICAL: do NOT include sharePermissions in the PUT body.
      //
      // Cloud's PUT /filter/{id} silently fails to PERSIST sharePermissions
      // updates (see https://community.atlassian.com/t/2189785 — well-known
      // quirk). However, it DOES still validate them: if the body contains
      // a share entry the caller lacks permission to grant (e.g. an existing
      // `share with Group: 'staff'` that we'd be re-asserting verbatim),
      // the whole PUT returns 400 with `errors.shares`. The denied-group
      // retry path partially rescues this, but it's fragile.
      //
      // The clean fix is to never send sharePermissions in the PUT — leave
      // them entirely to POST /filter/{id}/permission (step 3.5 below).
      // editPermissions ARE persisted by PUT, so they stay.
      //
      // `s` is still computed above so the step 3.5 logic can use it for
      // org-admins idempotency and the dropped-permissions audit.
      const buildBody = (_s, e) => ({
        name: data.name,
        jql: data.rewrittenJql,
        description: data.description,
        editPermissions: e ? stripForWrite(e) : undefined,
      });

      // PUT-with-retry wrapper. The owner-swap can take a beat to propagate
      // through Cloud's permission cache; an immediate PUT may 403 even
      // though we just successfully swapped. Retry up to 3 times with
      // exponential backoff on 403/transient errors before giving up.
      //
      // Special case: when `swapOnlyOn403` is on AND we haven't swapped yet,
      // a 403 means "we're not the owner — go swap and retry" (handled by
      // the dedicated swap-on-403 path below). Don't burn retries here.
      const putWithRetry = async (body) => {
        const isDeferredSwapMode = this.swapOnlyOn403 && !data.ownerSwapped;
        const maxAttempts = isDeferredSwapMode ? 1 : 3;
        let lastErr;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            return await this.cloudClient.updateFilter(cloudId, body);
          } catch (err) {
            lastErr = err;
            const status = err.statusCode;
            // Only retry on 403 (likely owner-cache propagation lag) or
            // transient 5xx not already retried by the underlying client.
            // Don't retry 400 (JQL parse / value errors are deterministic).
            const isRetryable = status === 403 || status === 502 || status === 503 || status === 504;
            if (!isRetryable || attempt === maxAttempts) throw err;
            const wait = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
            this.log(
              `    filter ${cloudId} PUT ${status} on attempt ${attempt}/${maxAttempts}, retrying after ${wait}ms`,
            );
            await new Promise((r) => setTimeout(r, wait));
          }
        }
        throw lastErr;
      };

      try {
        await putWithRetry(buildBody(shareList, editList));
        data.jqlUpdated = true;
        data.permissionsAdded = this.shareOrgAdmins && !!this.orgAdminsGroup;
        // Record what Cloud now has — keeps `--avoid-overwrite` accurate
        // on future runs without requiring a separate refresh pass.
        data.expectedLiveJql = data.rewrittenJql;
        pm.updateFilterEntry(cloudId, {
          jqlUpdated: true,
          permissionsAdded: data.permissionsAdded,
          executionPhase: "updated",
          expectedLiveJql: data.rewrittenJql,
        });
        updateResult = { success: true };
      } catch (err) {
      const isRateLimit = err.statusCode === 429;
      let errStr = err.message;

      // 400 with "permission to share with Group: 'X'" — drop those groups
      // and retry once. This rescues the ~441 group-share denial failures
      // from the earlier full-run report.
      if (err.statusCode === 400 && shareList) {
        const denied = parseDeniedGroupsFromError(err.responseBody || err.message);
        if (denied.length > 0) {
          const sDrop = dropDeniedGroupsFromPermissions(shareList, denied);
          const eDrop = dropDeniedGroupsFromPermissions(editList, denied);
          if (sDrop.removed.length > 0 || eDrop.removed.length > 0) {
            this.stats.deniedGroupRetries++;
            pm.updateFilterEntry(cloudId, {
              shareGroupsRemovedOnRetry: denied,
            });
            try {
              await this.cloudClient.updateFilter(
                cloudId,
                buildBody(sDrop.kept, eDrop.kept),
              );
              data.jqlUpdated = true;
              data.permissionsAdded = this.shareOrgAdmins && !!this.orgAdminsGroup;
              pm.updateFilterEntry(cloudId, {
                jqlUpdated: true,
                permissionsAdded: data.permissionsAdded,
                executionPhase: "updated",
              });
              this.stats.deniedGroupRetrySuccesses++;
              updateResult = { success: true };
              // Skip the rest of the catch branch
              // by exiting via a labeled throw is awkward — use a flag.
            } catch (errRetry) {
              err = errRetry;
              errStr = errRetry.message;
            }
          }
        }
      }

      // 400 with "value 'X' does not exist for field 'Y'" — drop the
      // offending value from the IN-list (or flag the equality miss) and
      // retry the PUT once. This rescues filters whose JQL still references
      // per-project values (component, fixVersion, affectedVersion, status,
      // custom-field options) that don't exist on the target tenant.
      // Only fires after the denied-group retry hasn't already succeeded.
      if (
        !(updateResult && updateResult.success) &&
        err.statusCode === 400
      ) {
        const drops = parseMissingFieldValues(
          err.responseBody || err.message,
        );
        if (drops.length > 0) {
          const stripResult = stripMissingValues(
            data.rewrittenJql,
            drops,
            { stripEquality: this.stripEqualityMisses },
          );
          const droppedActual = stripResult.dropped || [];
          const equalityStripped = stripResult.equalityStripped || [];
          const equalityBlocked = (stripResult.equalityMiss || []).length > 0;
          const anyMutation = droppedActual.length > 0 || equalityStripped.length > 0;
          if (anyMutation) {
            // Run cleanupJql so any `field IN ()` left by the strip is
            // collapsed (the brokenFunctionStripper.cleanupJql empty-IN
            // rule already handles this exact pattern).
            const cleanedJql = cleanupJql(stripResult.rewritten);
            if (cleanedJql && cleanedJql !== data.rewrittenJql) {
              const previousJql = data.rewrittenJql;
              data.rewrittenJql = cleanedJql;
              this.stats.valueStripRetries++;
              this.stats.valueStripDroppedTotal += droppedActual.length;
              this.stats.valueStripEqualityStripped += equalityStripped.length;
              pm.updateFilterEntry(cloudId, {
                rewrittenJql: cleanedJql,
                valueStripDropped: droppedActual,
                valueStripEqualityStripped: equalityStripped,
                valueStripJqlBefore: previousJql,
              });
              try {
                await this.cloudClient.updateFilter(
                  cloudId,
                  buildBody(shareList, editList),
                );
                data.jqlUpdated = true;
                data.permissionsAdded =
                  this.shareOrgAdmins && !!this.orgAdminsGroup;
                pm.updateFilterEntry(cloudId, {
                  jqlUpdated: true,
                  permissionsAdded: data.permissionsAdded,
                  executionPhase: "updated",
                });
                this.stats.valueStripRetrySuccesses++;
                updateResult = { success: true };
              } catch (errRetry) {
                err = errRetry;
                errStr = errRetry.message;
              }
            }
          } else if (equalityBlocked) {
            // Equality form ("field = X") cannot be safely stripped without
            // changing the filter's semantics. Record and let the caller
            // see the original 400.
            this.stats.valueStripEqualityBlocked++;
            pm.updateFilterEntry(cloudId, {
              valueStripEqualityMiss: stripResult.equalityMiss,
            });
          }
        }
      }

      if (updateResult && updateResult.success) {
        // The denied-group / value-strip retry succeeded; nothing more to do.
      } else if (err.statusCode === 403) {
        errStr = `permission_denied: ${errStr}`;
        // --swap-only-on-403: retry with a swap + re-PUT
        if (
          this.swapOnlyOn403 &&
          needSwap &&
          !data.ownerSwapped &&
          !this.currentAccountId
        ) {
          // defensive: current account missing → cannot attempt swap
          errStr = `permission_denied (no currentAccountId to swap): ${err.message}`;
        } else if (
          this.swapOnlyOn403 &&
          needSwap &&
          !data.ownerSwapped &&
          this.currentAccountId
        ) {
          try {
            await swapOwner(this.cloudClient, cloudId, this.currentAccountId);
            data.ownerSwapped = true;
            pm.updateFilterEntry(cloudId, {
              ownerSwapped: true,
              currentOwnerAccountId: this.currentAccountId,
              executionPhase: "updating",
            });
            await this.cloudClient.updateFilter(
              cloudId,
              buildBody(shareList, editList),
            );
            data.jqlUpdated = true;
            data.permissionsAdded = this.shareOrgAdmins && !!this.orgAdminsGroup;
            pm.updateFilterEntry(cloudId, {
              jqlUpdated: true,
              permissionsAdded: data.permissionsAdded,
              executionPhase: "updated",
            });
            updateResult = { success: true };
          } catch (err2) {
            errStr = `permission_denied after swap: ${err2.message}`;
            updateResult = {
              success: false,
              error: errStr,
              isRateLimit: err2.statusCode === 429,
            };
          }
        } else {
          updateResult = { success: false, error: errStr, isRateLimit };
        }
      } else if (err.statusCode === 400) {
        errStr = `bad_request: ${errStr}`;
        updateResult = { success: false, error: errStr, isRateLimit };
      } else if (err.statusCode === 404) {
        errStr = `not_found: ${errStr}`;
        updateResult = { success: false, error: errStr, isRateLimit };
      } else {
        updateResult = { success: false, error: errStr, isRateLimit };
      }
      if (!updateResult.success) {
        this.stats.permissionsFailures++;
        pm.updateFilterEntry(cloudId, {
          executionPhase: "owner_restoring",
          lastStepError: errStr,
        });
      }
      }
    }

    // Step 3.5: POST org-admins to sharePermissions via the dedicated
    // /filter/{id}/permission endpoint. PUT /filter/{id} silently DROPS
    // sharePermissions changes (returns 200 but doesn't persist), so we must
    // use POST here. editPermissions on PUT IS persisted, so that path stays
    // as-is. See https://community.atlassian.com/forums/Jira-questions/Updating-Share-Permissions-using-PUT-rest-api-2-filter-id-does/qaq-p/2189785
    //
    // Idempotent: skips if org-admins is already in originalSharePermissions
    // or if a prior partial run already POSTed (tracked via sharePermissionPosted).
    // Failures here do NOT fail the overall update — the JQL update may have
    // succeeded; we just record the share-add error for follow-up.
    if (
      this.shareOrgAdmins &&
      this.orgAdminsGroup &&
      updateResult && updateResult.success &&
      !data.sharePermissionPosted
    ) {
      const orgGroup = this.orgAdminsGroup;
      const alreadyInShare = (data.originalSharePermissions || []).some(
        (p) =>
          p &&
          p.type === "group" &&
          p.group &&
          ((orgGroup.groupId && p.group.groupId === orgGroup.groupId) ||
            (orgGroup.name && p.group.name === orgGroup.name)),
      );
      if (alreadyInShare) {
        data.sharePermissionPosted = true;
        pm.updateFilterEntry(cloudId, {
          sharePermissionPosted: true,
          sharePermissionPostSkippedReason: "already_present",
        });
      } else {
        // POST the share AND verify it actually persisted. A bare 2xx is not
        // enough: when the caller was only just added to a group the filter is
        // also shared with, Cloud accepts the POST but drops it asynchronously
        // until group membership propagates (~1-2 min). _addOrgAdminsShareVerified
        // re-reads the permissions and retries until org-admins truly appears.
        const outcome = await this._addOrgAdminsShareVerified(cloudId, orgGroup);
        if (outcome.ok) {
          data.sharePermissionPosted = true;
          this.stats.sharePermissionsAdded =
            (this.stats.sharePermissionsAdded || 0) + 1;
          pm.updateFilterEntry(cloudId, { sharePermissionPosted: true });
        } else {
          this.stats.sharePermissionAddFailures =
            (this.stats.sharePermissionAddFailures || 0) + 1;
          pm.updateFilterEntry(cloudId, {
            sharePermissionPostError: outcome.error,
          });
          // Intentionally do NOT mutate updateResult — JQL update already succeeded.
        }
      }
    }

    // Step 4: owner restore — attempted if we swapped, even on step-3 failure.
    // Skipped entirely when restoreOwner is off (--no-owner-restore): the filter
    // is then left owned by the running account so a freshly-added org-admins
    // share survives (Cloud would otherwise drop it when a non-admin owner is
    // restored). We mark the entry so the report shows the owner was intentionally
    // left changed rather than orphaned by a failure.
    if (!this.restoreOwner && data.ownerSwapped) {
      pm.updateFilterEntry(cloudId, {
        ownerRestored: false,
        ownerLeftAsRunner: true,
        currentOwnerAccountId: this.currentAccountId,
        executionPhase: updateResult && updateResult.success ? "done" : "failed",
      });
    } else if (
      this.ownerSwap &&
      this.restoreOwner &&
      data.ownerSwapped &&
      !data.ownerRestored &&
      originalOwnerId
    ) {
      pm.updateFilterEntry(cloudId, { executionPhase: "owner_restoring" });
      try {
        await restoreOwner(this.cloudClient, cloudId, originalOwnerId);
        data.ownerRestored = true;
        pm.updateFilterEntry(cloudId, {
          ownerRestored: true,
          currentOwnerAccountId: originalOwnerId,
          executionPhase: updateResult && updateResult.success ? "done" : "failed",
        });
      } catch (err) {
        this.stats.ownerRestoreFailures++;
        const errStr = `owner_restore_failed: ${err.message}`;
        pm.updateFilterEntry(cloudId, {
          executionPhase: "failed",
          lastStepError: errStr,
        });
        if (updateResult && updateResult.success) {
          // Update succeeded but restore failed → still flag overall as a
          // failure worthy of ops attention.
          updateResult = { success: false, error: errStr, isRateLimit: false };
        }
      }
    } else if (updateResult && updateResult.success) {
      pm.updateFilterEntry(cloudId, { executionPhase: "done" });
    } else {
      pm.updateFilterEntry(cloudId, { executionPhase: "failed" });
    }

    return updateResult || { success: false, error: "unknown", isRateLimit: false };
  }
}

module.exports = FilterProcessor;
