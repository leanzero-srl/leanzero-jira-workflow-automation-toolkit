/**
 * Workflow Applier: --apply mode.
 *
 * Loads collected JSONs, transforms workflows, and creates them on the target instance.
 * Optionally assigns workflows to schemes and publishes drafts.
 */

const fs = require("fs");
const path = require("path");
const {
  transformWorkflow,
  buildBulkCreatePayload,
  buildBulkUpdatePayload,
} = require("./workflowTransformer");
const FieldMapper = require("./fieldMapper");
const IdMapper = require("./idMapper");

class WorkflowApplier {
  constructor(client, options = {}) {
    this.client = client;
    this.log = options.log || console.log;
    this.collectDir = options.collectDir;
    this.nameSuffix = options.nameSuffix || "_v2";
    this.assignSchemes = options.assignSchemes || false;
    this.publish = options.publish || false;
    this.dryRun = options.dryRun || false;
    this.useLegacyApi = options.useLegacyApi || false;
    this.validateOnly = options.validateOnly || false;
    this.updateMode = options.updateMode || false;
    this.sourceUrlOverride = options.sourceUrl || null;

    if (this.updateMode && this.useLegacyApi) {
      throw new Error(
        "--update and --use-legacy-api are mutually exclusive. Update mode requires " +
        "the new unified workflow API.",
      );
    }
    if (this.updateMode && this.assignSchemes) {
      // Updates happen in place, so scheme assignment is a no-op. Log once rather
      // than silently ignore.
      this.log = options.log || console.log;
      this.log(
        "NOTE: --assign-schemes is ignored when --update is set (workflows are updated " +
        "in place, scheme mappings already point at them).",
      );
      this.assignSchemes = false;
    }
  }

  async run() {
    const startTime = Date.now();

    this.log(`\nAPPLY MODE${this.dryRun ? " (DRY RUN)" : ""}`);
    this.log(`Source data: ${this.collectDir}`);
    this.log(`${"=".repeat(60)}\n`);

    // ── Step 1: Load collected data ──
    this.log("Loading collected data...");
    const metadata = this.loadJson("metadata.json");
    const fieldMapping = this.loadJson("field_mapping.json");
    const schemeData = this.loadJson("workflow_schemes.json");

    const sourceUrl = this.sourceUrlOverride || metadata.sourceUrl;
    const targetUrl = this.client.baseUrl;

    this.log(`  Source URL: ${sourceUrl}`);
    this.log(`  Target URL: ${targetUrl}`);
    this.log(`  Workflows to process: ${metadata.workflows.length}`);
    this.log(`  Name suffix: "${this.nameSuffix}"`);

    // ── Step 2: Build field remapping ──
    this.log("\nBuilding field remapping...");
    const fieldMapper = new FieldMapper(this.client, this.log);
    const fieldRemapping = await fieldMapper.buildMapping(fieldMapping);

    // Save computed remapping for audit
    const remapFile = path.join(
      this.collectDir,
      `field_remapping_${Date.now()}.json`,
    );
    fs.writeFileSync(remapFile, JSON.stringify(fieldRemapping, null, 2));
    this.log(`  Saved remapping to: ${remapFile}`);

    // ── Step 2b: Build cross-instance ID remapping (statuses, issue types, etc.) ──
    this.log("\nBuilding cross-instance ID remapping...");
    const idCatalog = this.loadOptionalJson("id_mapping.json");
    if (!idCatalog) {
      this.log(
        "  NOTE: id_mapping.json not found in collect dir. Status/issue-type/screen/event " +
        "IDs will be passed through as-is — this is only safe when source and target are " +
        "the same instance. Re-run --collect with the latest script to generate it.",
      );
    }
    const overrides = this.loadOptionalJson("id_overrides.json") || {};
    delete overrides._help; // strip the human-readable help key if present

    const idMapper = new IdMapper(this.client, this.log);
    const idRemapping = idCatalog
      ? await idMapper.buildRemapping(idCatalog, overrides)
      : emptyRemapping();

    // Save the computed remapping for audit.
    const idRemapFile = path.join(
      this.collectDir,
      `id_remapping_${Date.now()}.json`,
    );
    fs.writeFileSync(idRemapFile, JSON.stringify(idRemapping, null, 2));
    this.log(`  Saved ID remapping to: ${idRemapFile}`);
    if (idRemapping._stats) {
      for (const [bucket, s] of Object.entries(idRemapping._stats)) {
        if (s.total > 0) {
          this.log(
            `    ${bucket}: ${s.resolved} resolved, ${s.forced} overridden, ${s.unresolved} unresolved`,
          );
        }
      }
    }

    if (this.useLegacyApi) {
      this.log(
        "\nWARNING: --use-legacy-api is set. POST /rest/api/3/workflow/ was retired on " +
        "2026-02-01 and is expected to fail. Use the default (new bulk API) unless you " +
        "have a specific reason to force the legacy endpoint.",
      );
    }

    // ── Step 3: Fetch target statuses (required for new API; always do it unless
    // we're explicitly running against the legacy endpoint). targetStatusMap is
    // keyed by TARGET status ID — callers that need to index by a source status
    // ID must translate first via idRemapping.statuses.
    let targetStatusMap = {};
    if (!this.useLegacyApi) {
      this.log("\nFetching target statuses for new API format...");
      try {
        const statuses = await this.client.getAllStatuses();
        for (const s of statuses) {
          targetStatusMap[String(s.id)] = {
            id: String(s.id),
            name: s.name,
            statusCategory: s.statusCategory,
          };
        }
        this.log(`  Found ${Object.keys(targetStatusMap).length} statuses on target`);
      } catch (err) {
        this.log(`  ERROR fetching statuses: ${err.message}`);
        throw new Error("Cannot resolve target statuses for the new API path");
      }
    }

    // ── Step 3b: Bulk-lookup target workflow IDs + versions (update mode only) ──
    // The update endpoint is keyed by workflow UUID + version (optimistic concurrency),
    // not by name. We batch-lookup every collected workflow by its original name to
    // capture the target's {id, version} pairs up front.
    let targetWorkflowByName = new Map();
    if (this.updateMode) {
      this.log("\nLooking up target workflow IDs for update...");
      const names = metadata.workflows.map((w) => w.name);
      try {
        const found = await this.client.getWorkflowsByNames(names);
        for (const wf of found) {
          if (wf && wf.name) {
            targetWorkflowByName.set(wf.name, { id: wf.id, version: wf.version });
          }
        }
        const missing = names.filter((n) => !targetWorkflowByName.has(n));
        this.log(
          `  Resolved ${targetWorkflowByName.size}/${names.length} workflows on target`,
        );
        if (missing.length > 0) {
          this.log(
            `  ${missing.length} workflow(s) NOT present on target (will be skipped):`,
          );
          for (const m of missing.slice(0, 10)) this.log(`    - "${m}"`);
          if (missing.length > 10) this.log(`    ... +${missing.length - 10} more`);
        }
      } catch (err) {
        this.log(`  ERROR looking up target workflows: ${err.message}`);
        throw new Error(
          "Cannot resolve target workflow IDs for update. Check target API access.",
        );
      }
    }

    // ── Step 4: Transform and create/update workflows ──
    this.log("\nProcessing workflows...\n");

    const results = [];
    const allSkippedSR = [];
    const workflowNameMap = {}; // oldName -> newName for scheme assignment

    for (const wfEntry of metadata.workflows) {
      const wfPath = path.join(this.collectDir, wfEntry.file);
      if (!fs.existsSync(wfPath)) {
        this.log(`  SKIP: "${wfEntry.name}" - file not found: ${wfEntry.file}`);
        results.push({ name: wfEntry.name, status: "skipped", reason: "file not found" });
        continue;
      }

      const rawWorkflow = JSON.parse(fs.readFileSync(wfPath, "utf8"));

      this.log(`  Processing: "${wfEntry.name}"...`);

      // Transform
      const { payload, skippedScriptRunnerRules, warnings } = transformWorkflow(
        rawWorkflow,
        {
          nameSuffix: this.nameSuffix,
          fieldRemapping,
          idRemapping,
          sourceUrl,
          targetUrl,
          log: this.log,
        },
      );

      allSkippedSR.push(...skippedScriptRunnerRules);
      if (warnings.length > 0) {
        for (const w of warnings) {
          this.log(`    WARNING: ${w}`);
        }
      }
      if (skippedScriptRunnerRules.length > 0) {
        this.log(
          `    Skipped ${skippedScriptRunnerRules.length} ScriptRunner rule(s) - use --export-scriptrunner-scaffold during collect`,
        );
      }

      workflowNameMap[wfEntry.name] = payload.name;

      if (this.dryRun) {
        // Save transformed payload for inspection
        const dryRunDir = path.join(this.collectDir, "dry_run");
        fs.mkdirSync(dryRunDir, { recursive: true });
        const safeName = payload.name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const outFile = path.join(dryRunDir, `${safeName}.json`);
        fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
        this.log(`    DRY RUN: Payload saved to ${outFile}`);
        results.push({ name: wfEntry.name, newName: payload.name, status: "dry_run" });
        continue;
      }

      // --update path: look up target info now; skip if not found.
      let targetInfo = null;
      if (this.updateMode) {
        targetInfo = targetWorkflowByName.get(wfEntry.name) || null;
        if (!targetInfo) {
          this.log(`    SKIP: "${wfEntry.name}" not present on target — nothing to update`);
          results.push({
            name: wfEntry.name,
            status: "skipped",
            reason: "missing on target",
          });
          continue;
        }
      } else {
        // Create path: skip if a workflow with the new name already exists.
        try {
          const existing = await this.client.getWorkflowByName(payload.name);
          if (existing) {
            this.log(`    SKIP: "${payload.name}" already exists on target`);
            results.push({
              name: wfEntry.name,
              newName: payload.name,
              status: "skipped",
              reason: "already exists",
            });
            continue;
          }
        } catch {
          // 404 or error checking - proceed with creation
        }
      }

      try {
        if (this.useLegacyApi) {
          await this.client.createWorkflow(payload);
          this.log(`    CREATED (legacy): "${payload.name}"`);
          results.push({ name: wfEntry.name, newName: payload.name, status: "created" });
          continue;
        }

        // Build payload for create or update.
        const safe = (this.updateMode ? wfEntry.name : payload.name)
          .replace(/[^a-zA-Z0-9_-]/g, "_");
        const bulkPayload = this.updateMode
          ? buildBulkUpdatePayload(payload, targetInfo, targetStatusMap, {
              statusRemapping: idRemapping.statuses || {},
            })
          : buildBulkCreatePayload(payload, targetStatusMap, {
              statusRemapping: idRemapping.statuses || {},
            });
        const payloadFile = path.join(
          this.collectDir,
          `${this.updateMode ? "update" : "bulk"}_payload_${safe}.json`,
        );
        fs.writeFileSync(payloadFile, JSON.stringify(bulkPayload, null, 2));

        if (this.validateOnly) {
          const validation = this.updateMode
            ? await this.client.validateUpdateWorkflowsBulk(bulkPayload)
            : await this.client.validateCreateWorkflowsBulk(bulkPayload);
          const errors = (validation && validation.errors) || [];
          const warns = (validation && validation.warnings) || [];
          const summaryFile = path.join(this.collectDir, `validation_${safe}.json`);
          fs.writeFileSync(summaryFile, JSON.stringify(validation, null, 2));

          if (errors.length === 0 && warns.length === 0) {
            this.log(`    VALIDATED OK: "${wfEntry.name}"`);
          } else {
            this.log(
              `    VALIDATION ISSUES for "${wfEntry.name}": ` +
              `${errors.length} error(s), ${warns.length} warning(s) — see ${summaryFile}`,
            );
            for (const e of errors.slice(0, 5)) {
              this.log(`      ERROR: ${typeof e === "string" ? e : JSON.stringify(e)}`);
            }
            if (errors.length > 5) this.log(`      ... +${errors.length - 5} more`);
          }
          results.push({
            name: wfEntry.name,
            newName: payload.name,
            status: errors.length === 0 ? "validated_ok" : "validation_errors",
            errorCount: errors.length,
            warningCount: warns.length,
            validationFile: summaryFile,
          });
        } else if (this.updateMode) {
          const resp = await this.client.updateWorkflowsBulk(bulkPayload);
          const respErrors = (resp && resp.errors) || [];
          if (respErrors.length > 0) {
            this.log(`    UPDATED with errors: "${wfEntry.name}" (${respErrors.length})`);
            for (const e of respErrors.slice(0, 3)) {
              this.log(`      ERROR: ${typeof e === "string" ? e : JSON.stringify(e)}`);
            }
            results.push({
              name: wfEntry.name,
              status: "update_errors",
              errors: respErrors,
            });
          } else {
            this.log(`    UPDATED: "${wfEntry.name}"`);
            results.push({ name: wfEntry.name, status: "updated" });
          }
        } else {
          await this.client.createWorkflowsBulk(bulkPayload);
          this.log(`    CREATED: "${payload.name}"`);
          results.push({ name: wfEntry.name, newName: payload.name, status: "created" });
        }
      } catch (err) {
        this.log(`    FAILED: ${err.message}`);
        if (
          this.useLegacyApi &&
          (err.statusCode === 404 || err.statusCode === 410 || err.statusCode === 405)
        ) {
          this.log(
            `    HINT: Legacy API appears to be gone (${err.statusCode}). Drop --use-legacy-api.`,
          );
        }
        results.push({
          name: wfEntry.name,
          newName: payload.name,
          status: "failed",
          error: err.message,
        });
      }
    }

    // ── Step 5: Assign to workflow schemes ──
    const schemeResults = [];
    if (this.assignSchemes && !this.dryRun && schemeData.length > 0) {
      this.log("\nAssigning workflows to schemes...\n");
      await this.assignWorkflowsToSchemes(
        schemeData,
        workflowNameMap,
        schemeResults,
        idRemapping.issueTypes || {},
      );
    }

    // ── Step 6: Publish scheme drafts ──
    if (this.publish && !this.dryRun && schemeResults.some((r) => r.modified)) {
      this.log("\nPublishing workflow scheme drafts...\n");
      await this.publishSchemes(schemeResults);
    }

    // ── Step 7: Save execution report ──
    const report = {
      executedAt: new Date().toISOString(),
      dryRun: this.dryRun,
      validateOnly: this.validateOnly,
      updateMode: this.updateMode,
      useLegacyApi: this.useLegacyApi,
      sourceUrl,
      targetUrl,
      nameSuffix: this.nameSuffix,
      workflowResults: results,
      schemeResults,
      skippedScriptRunnerRules: allSkippedSR,
    };
    const reportFile = path.join(this.collectDir, `apply_${Date.now()}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

    // ── Final report ──
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const stats = this.client.getStats();
    const created = results.filter((r) => r.status === "created").length;
    const updated = results.filter((r) => r.status === "updated").length;
    const updateErr = results.filter((r) => r.status === "update_errors").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const validatedOk = results.filter((r) => r.status === "validated_ok").length;
    const validationErr = results.filter((r) => r.status === "validation_errors").length;

    const mode = this.dryRun
      ? "(DRY RUN) "
      : this.validateOnly
        ? "(VALIDATE ONLY) "
        : this.updateMode
          ? "(UPDATE) "
          : "";
    this.log(`\n${"=".repeat(60)}`);
    this.log(`APPLY ${mode}COMPLETE`);
    this.log(`${"=".repeat(60)}`);
    this.log(`  Workflows processed: ${results.length}`);
    if (this.updateMode) {
      this.log(`    Updated: ${updated}`);
      this.log(`    Update errors: ${updateErr}`);
    } else {
      this.log(`    Created: ${created}`);
    }
    if (this.validateOnly) {
      this.log(`    Validated OK: ${validatedOk}`);
      this.log(`    Validation errors: ${validationErr}`);
    }
    this.log(`    Failed: ${failed}`);
    this.log(`    Skipped: ${skipped}`);
    if (allSkippedSR.length > 0) {
      this.log(`  ScriptRunner rules skipped: ${allSkippedSR.length}`);
      this.log(`    (Use --export-scriptrunner-scaffold during collect for SMS deployment)`);
    }
    if (schemeResults.length > 0) {
      const schemesModified = schemeResults.filter((r) => r.modified).length;
      this.log(`  Schemes updated: ${schemesModified}/${schemeResults.length}`);
    }
    this.log(`  API requests: ${stats.requestCount} (${stats.errorCount} errors, ${stats.rateLimitCount} rate limits)`);
    this.log(`  Report: ${reportFile}`);
    this.log(`  Elapsed: ${elapsed}s`);

    return report;
  }

  async assignWorkflowsToSchemes(
    schemeData,
    workflowNameMap,
    schemeResults,
    issueTypeRemapping = {},
  ) {
    // Group by scheme to avoid duplicate updates. Note: scheme IDs here are from the
    // SOURCE instance — this path only works when the target still carries the same
    // schemeId, which is true for the "clone within the same Cloud org" case but not
    // for cross-org moves. Target lookup by scheme name is a separate enhancement.
    const schemeMap = new Map();
    for (const entry of schemeData) {
      if (!schemeMap.has(entry.schemeId)) {
        schemeMap.set(entry.schemeId, entry);
      }
    }

    for (const [schemeId, entry] of schemeMap) {
      this.log(`  Scheme: "${entry.schemeName}" (ID: ${schemeId})`);
      let modified = false;

      // Update default workflow if it was cloned
      if (workflowNameMap[entry.defaultWorkflow]) {
        const newDefault = workflowNameMap[entry.defaultWorkflow];
        try {
          await this.client.updateWorkflowSchemeDefault(schemeId, newDefault);
          this.log(`    Default: "${entry.defaultWorkflow}" -> "${newDefault}"`);
          modified = true;
        } catch (err) {
          this.log(`    FAILED to update default: ${err.message}`);
        }
      }

      // Update issue type mappings — translate both the KEY (issue type ID) and the
      // VALUE (workflow name) through the respective remappings.
      if (entry.issueTypeMappings && Object.keys(entry.issueTypeMappings).length > 0) {
        const updatedMappings = {};
        let hasChanges = false;
        const droppedIssueTypes = [];

        for (const [sourceItId, wfName] of Object.entries(entry.issueTypeMappings)) {
          const targetItId = this._translateId(sourceItId, issueTypeRemapping);
          if (targetItId === null) {
            droppedIssueTypes.push(sourceItId);
            hasChanges = true; // dropping is a change
            continue;
          }
          if (targetItId !== sourceItId) hasChanges = true;

          const newWfName = workflowNameMap[wfName] || wfName;
          if (newWfName !== wfName) hasChanges = true;
          updatedMappings[targetItId] = newWfName;
        }

        if (droppedIssueTypes.length > 0) {
          this.log(
            `    WARNING: dropped ${droppedIssueTypes.length} issue type mapping(s) ` +
            `with no target equivalent: ${droppedIssueTypes.join(", ")}`,
          );
        }

        if (hasChanges) {
          try {
            const currentDefault = workflowNameMap[entry.defaultWorkflow] || entry.defaultWorkflow;
            await this.client.updateWorkflowScheme(schemeId, {
              name: entry.schemeName,
              defaultWorkflow: currentDefault,
              issueTypeMappings: updatedMappings,
            });
            this.log(`    Issue type mappings updated`);
            modified = true;
          } catch (err) {
            this.log(`    FAILED to update mappings: ${err.message}`);
          }
        }
      }

      schemeResults.push({
        schemeId,
        schemeName: entry.schemeName,
        modified,
      });
    }
  }

  /**
   * Resolve a source ID against a remapping bucket.
   * Returns:
   *   - the target ID if mapped to a concrete value
   *   - null if explicitly mapped to null (drop)
   *   - the sourceId unchanged if the remapping has no entry (pass-through)
   */
  _translateId(sourceId, bucket) {
    if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, sourceId)) {
      return sourceId;
    }
    const mapped = bucket[sourceId];
    return mapped === null ? null : String(mapped);
  }

  async publishSchemes(schemeResults) {
    for (const result of schemeResults) {
      if (!result.modified) continue;

      this.log(`  Publishing: "${result.schemeName}" (ID: ${result.schemeId})...`);
      try {
        const resp = await this.client.publishWorkflowSchemeDraft(result.schemeId);
        if (resp && resp.self) {
          await this.client.pollTask(resp.self, 10000, 300000);
        }
        this.log(`    Published successfully`);
        result.published = true;
      } catch (err) {
        this.log(`    FAILED to publish: ${err.message}`);
        result.published = false;
        result.publishError = err.message;
      }
    }
  }

  loadJson(filename) {
    const filePath = path.join(this.collectDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required file not found: ${filePath}`);
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  loadOptionalJson(filename) {
    const filePath = path.join(this.collectDir, filename);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
}

function emptyRemapping() {
  return {
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
}

module.exports = WorkflowApplier;
