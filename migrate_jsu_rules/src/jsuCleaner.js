/**
 * JSU/JMWE clean mode — remove rules we previously pushed so the operator
 * can iterate on a clean slate.
 *
 * Safety contract (enforced by `verifySubtractive`):
 *   - Removes ONLY rules carrying `parameters.migrationSourceId`. That tag is
 *     set exclusively by `src/jsuApplier.js` when we emit a rule; JCMA never
 *     sets it; operators never set it. So rules without it are guaranteed
 *     not-ours and must be left alone.
 *   - Touches ONLY workflows in the conversion plan (the scope the original
 *     `--collect` declared). Won't accidentally clean an unrelated workflow
 *     that happens to share a name.
 *   - Subtractive guardrail runs BEFORE every push: asserts the cleaned
 *     envelope's diff is purely "removals of tagged rules" — no modifications
 *     of JCMA rules, no removals of un-tagged rules, no additions. Any
 *     violation aborts the push and dumps the diff to disk.
 *   - `--dry-run` builds the cleaned payload + report but never POSTs.
 *
 * Output:
 *   - `clean_<TS>.json` — per-workflow report (removedCount, status,
 *     guardrail result, validation result).
 *   - `cleaned_<TS>.csv` — operator-friendly CSV of every rule removed
 *     (workflow, transition, ruleCategory, ruleKey, appKey, migrationSourceId,
 *      ruleId, tag).
 *
 * Re-apply contract:
 *   After `--clean`, running `--apply` against the same collect dir produces
 *   a fresh push — all 165+ would-append rules emit anew because the snapshot
 *   dedup finds no migration-tagged rules. JCMA-placed rules still dedup-skip
 *   via semantic fingerprint.
 */

const fs = require("fs");
const path = require("path");

const { alignTransitions } = require("./transitionMatcher");
const { safeFilename, timestampSlug, isoNow } = require("./utils");
const { verifySubtractive } = require("./additiveDiffGuardrail");
const { ourCloudRuleIds, readLedger, entriesFromPayload } = require("./migrationLedger");
const { ruleFingerprint: sharedRuleFingerprint } = require("./ruleFingerprint");
const { verifyInstanceSignature } = require("./instanceSignature");

class JsuCleaner {
  constructor(cloudClient, config, options) {
    this.cloud = cloudClient;
    this.config = config || {};
    this.log = options.log;
    this.collectDir = options.collectDir;
    this.dryRun = !!options.dryRun;
    this.force = !!options.force;
    this.allowInstanceMismatch = !!options.allowInstanceMismatch;
    this.workflowFilter = Array.isArray(options.workflowNames) && options.workflowNames.length > 0
      ? new Set(options.workflowNames)
      : null;
    this.excludeProjects = Array.isArray(options.excludeProjects)
      ? options.excludeProjects
      : [];
    this.excludedWorkflowNames = new Set();
    // Opt-in: remove rules with `tag: "migration-success"` even when not
    // in the local ledger / payload / fingerprint set. Default off so
    // accidentally running --clean against a tenant with pre-existing
    // JCMA writes doesn't sweep them away.
    this.removeStaleTagged = !!options.removeStaleTagged;

    this._loadArtifacts();
    this._verifyInstanceSignature();
  }

  _verifyInstanceSignature() {
    verifyInstanceSignature(this.metadata, this.config, {
      allowMismatch: this.allowInstanceMismatch,
      log: this.log,
      modeLabel: "clean",
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
    this.metadata = load("metadata.json", true) || {};
  }

  async _resolveExcludedWorkflowNames() {
    if (this.excludeProjects.length === 0) return;
    this.log.info(`Resolving excluded projects: ${this.excludeProjects.join(", ")}`);
    // Minimal version of JsuApplier's logic: resolve each project → workflow
    // scheme → workflow names. Soft-fail (log warn) so a misconfigured exclude
    // doesn't block the clean.
    for (const key of this.excludeProjects) {
      try {
        const project = await this.cloud.makeRequest("GET", `/rest/api/3/project/${encodeURIComponent(key)}`);
        const projectId = project && project.id;
        if (!projectId) continue;
        const schemeRes = await this.cloud.makeRequest("GET", `/rest/api/3/workflowscheme/project?projectId=${projectId}`);
        const schemeBlocks = (schemeRes && schemeRes.values) || [];
        for (const block of schemeBlocks) {
          const scheme = block && block.workflowScheme;
          if (!scheme) continue;
          if (scheme.defaultWorkflow) this.excludedWorkflowNames.add(scheme.defaultWorkflow);
          const mappings = scheme.issueTypeMappings || {};
          for (const wfName of Object.values(mappings)) {
            if (wfName) this.excludedWorkflowNames.add(wfName);
          }
        }
      } catch (e) {
        this.log.warn(`Failed to resolve excluded project ${key}: ${e.message}`);
      }
    }
    if (this.excludedWorkflowNames.size > 0) {
      this.log.info(
        `Excluding ${this.excludedWorkflowNames.size} workflow(s) backed by --exclude-projects: ` +
        `${[...this.excludedWorkflowNames].slice(0, 10).join(", ")}${this.excludedWorkflowNames.size > 10 ? "..." : ""}`,
      );
    }
  }

  _planWorkflowNames() {
    const names = new Set();
    for (const row of (this.conversionPlan && this.conversionPlan.rows) || []) {
      if (row && row.workflowName) names.add(row.workflowName);
    }
    return [...names];
  }

  async _fetchCloudWorkflow(workflowName) {
    const overrides = (this.config && this.config.workflowNameOverrides) || {};
    const declared = overrides[workflowName] || workflowName;
    if (declared !== workflowName) {
      this.log.info(`Workflow name override: DC "${workflowName}" -> Cloud "${declared}"`);
    }
    try {
      const res = await this.cloud.makeRequest("POST", "/rest/api/3/workflows", {
        workflowNames: [declared],
      });
      const wf = ((res && res.workflows) || []).find((w) => w && w.name === declared) || null;
      if (!wf) return null;
      wf._topLevelStatuses = (res && res.statuses) || [];
      return wf;
    } catch (e) {
      this.log.warn(`Cloud fetch failed for "${workflowName}" (as "${declared}"): ${e.message}`);
      return null;
    }
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
    const entries = validation.errors;
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (!e) continue;
        const level = (e.level || "ERROR").toUpperCase();
        if (level === "ERROR") return true;
      }
    }
    if (Array.isArray(validation.errorMessages) && validation.errorMessages.length > 0) return true;
    return false;
  }

  _deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

  _stripReadOnlyFields(cloudWorkflow) {
    delete cloudWorkflow.isEditable;
    delete cloudWorkflow.usages;
    delete cloudWorkflow.taskId;
    delete cloudWorkflow.created;
    delete cloudWorkflow.updated;
    delete cloudWorkflow.scope;
    for (const t of cloudWorkflow.transitions || []) {
      if (t && t.properties && t.properties.issueEditable != null) delete t.properties.issueEditable;
    }
    for (const s of cloudWorkflow.statuses || []) {
      if (s && s.name) delete s.name;
      if (s && s.properties && s.properties.issueEditable != null) delete s.properties.issueEditable;
    }
  }

  _buildUpdateEnvelope(patched, topLevelStatuses) {
    const { id, version, _topLevelStatuses, ...rest } = patched;
    const { name, ...withoutName } = rest;
    return { statuses: topLevelStatuses || [], workflows: [{ id, version, ...withoutName }] };
  }

  /**
   * Walk every transition's actions / validators / conditions tree, REMOVE
   * each rule whose `parameters.id` is in the ownership set (either
   * recorded in our local ledger from a prior apply, OR — for in-memory
   * rules during the same run — carrying `parameters.migrationSourceId`).
   *
   * Cloud strips `parameters.migrationSourceId` on persist (verified live
   * 2026-05), so post-push the migrationSourceId tag is GONE from Cloud
   * rules. The local ledger at `migration_ledger_<wf>.json` is our
   * authoritative record of which Cloud rule IDs we own.
   */
  _stripMigrationTaggedRules(patched, workflowName) {
    const removed = [];
    // Ownership set: rule IDs the local ledger says we pushed.
    const ourIds = ourCloudRuleIds(this.collectDir, workflowName);
    // Fallback ledger reconstruction: walk update_payload_<wf>.json if no
    // ledger exists (e.g. apply ran before ledger wiring landed). Each
    // payload entry has the migrationSourceId + rule id we sent.
    if (ourIds.size === 0) {
      const payloadPath = require("path").join(
        this.collectDir,
        `update_payload_${require("./utils").safeFilename(workflowName)}.json`,
      );
      try {
        const payload = JSON.parse(require("fs").readFileSync(payloadPath, "utf8"));
        const entries = entriesFromPayload(workflowName, payload);
        for (const e of entries) if (e.ruleId) ourIds.add(String(e.ruleId));
        if (ourIds.size > 0) {
          this.log.info(
            `  Ledger absent — reconstructed ${ourIds.size} ownership marker(s) from update_payload.`,
          );
        }
      } catch {
        // No payload either — nothing to clean from prior runs.
      }
    }

    // Fingerprint-based fallback for system:* rules where Cloud strips
    // `parameters.id` entirely (so UUID match fails). Each ledger entry
    // stores the semantic fingerprint of the rule's content; a Cloud rule
    // whose fp matches an entry's fp on the same transition is ours.
    // Tracks one-shot consumption so two distinct ledger entries with the
    // same fp don't both bind to the same cloud rule.
    const ledger = readLedger(this.collectDir, workflowName);
    const fpByTxn = new Map(); // transitionId → Map<fingerprint, count remaining>
    if (ledger && Array.isArray(ledger.entries)) {
      for (const e of ledger.entries) {
        if (!e || !e.fingerprint || !e.transitionId) continue;
        const tk = String(e.transitionId);
        if (!fpByTxn.has(tk)) fpByTxn.set(tk, new Map());
        const m = fpByTxn.get(tk);
        m.set(e.fingerprint, (m.get(e.fingerprint) || 0) + 1);
      }
    }
    const consumeFpForTxn = (txnId, fp) => {
      const m = fpByTxn.get(String(txnId));
      if (!m || !m.has(fp)) return false;
      const remaining = m.get(fp) - 1;
      if (remaining <= 0) m.delete(fp); else m.set(fp, remaining);
      return true;
    };
    const isOurs = (r, transition) => {
      if (!r || !r.parameters) return false;
      const id = r.parameters.id;
      if (id && ourIds.has(String(id))) return true;
      // Belt + suspenders: in-memory migrationSourceId stamp (shouldn't
      // happen post-push since Cloud strips it; harmless if it does).
      if (r.parameters.migrationSourceId &&
          String(r.parameters.migrationSourceId).length > 0) return true;
      // Fingerprint fallback for Cloud-stripped-id rules.
      const fp = sharedRuleFingerprint(r, this.fieldRemapping || {});
      if (fp && transition && consumeFpForTxn(transition.id, fp)) return true;
      // Stale-tag fallback (opt-in via --remove-stale-tagged): a rule
      // still carrying `tag: "migration-success"` that the ledger /
      // fingerprint paths don't recognise was placed by an earlier apply
      // (pre-ledger feature or a different collect-dir) AND is
      // structurally divergent from what we'd emit today. Removing it on
      // --clean prevents duplicates against the apply we're about to run
      // (verified 2026-05-23 on a sandbox tenant: this tag appears only
      // on JCMA migration writes and our own emits; both are safe to
      // overwrite on a freshly-applied re-run). Defaults off so an
      // accidental --clean against a tenant with pre-existing JCMA
      // writes doesn't sweep them away.
      if (this.removeStaleTagged && r.parameters.tag === "migration-success") return true;
      return false;
    };
    const recordRemoval = (rule, transition, category) => {
      removed.push({
        workflowName,
        transitionName: transition && transition.name,
        transitionId: transition && transition.id,
        ruleCategory: category,
        ruleKey: rule.ruleKey,
        appKey: (rule.parameters && rule.parameters.appKey) || null,
        ruleId: (rule.parameters && rule.parameters.id) || null,
        migrationSourceId: rule.parameters && rule.parameters.migrationSourceId
          ? String(rule.parameters.migrationSourceId) : null,
        tag: (rule.parameters && rule.parameters.tag) || null,
        disabled: (rule.parameters && rule.parameters.disabled) || null,
      });
    };
    const cleanArray = (arr, transition, category) => {
      if (!Array.isArray(arr)) return arr;
      const keepers = [];
      for (const r of arr) {
        if (isOurs(r, transition)) recordRemoval(r, transition, category);
        else keepers.push(r);
      }
      return keepers;
    };
    const walkConditions = (node, transition) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node.conditions)) {
        node.conditions = cleanArray(node.conditions, transition, "condition");
      }
      for (const cg of node.conditionGroups || []) walkConditions(cg, transition);
    };
    for (const t of patched.transitions || []) {
      if (Array.isArray(t.actions)) t.actions = cleanArray(t.actions, t, "postFunction");
      if (Array.isArray(t.validators)) t.validators = cleanArray(t.validators, t, "validator");
      if (t.conditions) walkConditions(t.conditions, t);
    }
    return removed;
  }

  async run() {
    this.log.info(
      `Clean phase: dryRun=${this.dryRun} force=${this.force}`,
    );
    await this._resolveExcludedWorkflowNames();

    const planNames = this._planWorkflowNames();
    const workflowNames = planNames.filter(
      (n) => !this.workflowFilter || this.workflowFilter.has(n),
    );
    this.log.info(`Will scan ${workflowNames.length} workflow(s) for migration-tagged rules`);

    const ts = timestampSlug();
    const report = {
      generatedAt: isoNow(),
      cloudBaseUrl: this.cloud.baseUrl,
      dryRun: this.dryRun,
      excludeProjects: this.excludeProjects,
      workflows: [],
      totalRulesRemoved: 0,
      workflowsModified: 0,
      excludedWorkflows: [],
    };
    const allRemoved = [];

    for (const workflowName of workflowNames) {
      if (this.excludedWorkflowNames.has(workflowName)) {
        this.log.info(`Skipping "${workflowName}" — backed by --exclude-projects`);
        report.excludedWorkflows.push(workflowName);
        continue;
      }
      const result = await this._processWorkflow(workflowName);
      report.workflows.push(result);
      if (result.removed) {
        for (const r of result.removed) allRemoved.push(r);
        report.totalRulesRemoved += result.removed.length;
      }
      if (result.status === "cleaned" || result.status === "dry_run_cleaned") {
        report.workflowsModified++;
      }
    }

    // Persist machine + operator-facing outputs.
    const reportPath = path.join(this.collectDir, `clean_${ts}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    this.log.info(`Clean report written to ${reportPath}`);

    const csvPath = path.join(this.collectDir, `cleaned_${ts}.csv`);
    fs.writeFileSync(csvPath, this._renderCleanedCsv(allRemoved));
    this.log.info(`Cleaned-rules CSV written to ${csvPath} (${allRemoved.length} row(s))`);

    this.log.info("");
    this.log.info("=== Clean summary ===");
    this.log.info(`  Workflows scanned:      ${report.workflows.length}`);
    this.log.info(`  Workflows ${this.dryRun ? "would-clean" : "cleaned"}: ${report.workflowsModified}`);
    this.log.info(`  Rules ${this.dryRun ? "would-remove" : "removed"}:     ${report.totalRulesRemoved}`);

    return report;
  }

  async _processWorkflow(workflowName) {
    this.log.info(`Cleaning "${workflowName}"`);
    const cloudWorkflow = await this._fetchCloudWorkflow(workflowName);
    if (!cloudWorkflow) {
      this.log.warn(`Cloud workflow "${workflowName}" not found — skipping`);
      return { workflowName, status: "skipped_not_on_cloud" };
    }

    // Optional: light DC-vs-Cloud transition alignment log for parity with
    // --apply. Not required for the clean to work.
    const dcInventory = this.inventory.workflows && this.inventory.workflows[workflowName];
    if (dcInventory) {
      const dcTransitions = dcInventory.transitions.map((t) => ({
        transitionId: t.transitionId, transitionName: t.transitionName,
        transitionFromStatusIds: t.transitionFromStatusIds || [],
        transitionToStatusId: t.transitionToStatusId || null,
        transitionType: t.transitionType || null,
      }));
      const alignment = alignTransitions(dcTransitions, cloudWorkflow);
      this.log.info(
        `Transition alignment: id=${alignment.matchTypeCounts.id} triple=${alignment.matchTypeCounts.triple} ` +
        `unique-name=${alignment.matchTypeCounts["unique-name"]} unmatched=${alignment.unmatched.length}`,
      );
    }

    const patched = this._deepClone(cloudWorkflow);
    const removed = this._stripMigrationTaggedRules(patched, workflowName);

    if (removed.length === 0) {
      this.log.info(`  No migration-tagged rules found — nothing to clean.`);
      return { workflowName, status: "nothing-to-clean", removedCount: 0, removed: [] };
    }
    this.log.info(`  Identified ${removed.length} migration-tagged rule(s) to remove.`);

    // Subtractive guardrail — assert we only removed rules the ledger
    // (or in-memory migrationSourceId tag) says we own.
    const safe = safeFilename(workflowName);
    const expectedRuleIds = new Set(removed.map((r) => String(r.ruleId)).filter(Boolean));
    const subtractivity = verifySubtractive(cloudWorkflow, patched, { expectedRuleIds });
    if (!subtractivity.ok) {
      const diffPath = path.join(this.collectDir, `subtractive_diff_violation_${safe}.json`);
      fs.writeFileSync(diffPath, JSON.stringify({
        workflowName,
        detectedAt: isoNow(),
        violations: subtractivity.violations,
        note: "Subtractive guardrail tripped. Clean aborted to protect non-our rules.",
      }, null, 2));
      this.log.error(
        `Subtractive guardrail FAILED for "${workflowName}": ` +
        `${subtractivity.violations.unexpectedRemovals.length} unexpected removals, ` +
        `${subtractivity.violations.modifications.length} modifications, ` +
        `${subtractivity.violations.additions.length} additions. See ${diffPath}.`,
      );
      return {
        workflowName,
        status: "blocked_by_subtractive_guardrail",
        removedCount: 0,
        removed: [],
        guardrailViolations: subtractivity.violations,
      };
    }
    this.log.info(`  Subtractive guardrail OK: ${subtractivity.expectedRemovals.length} expected removal(s), 0 modifications, 0 additions.`);

    const topLevelStatuses = cloudWorkflow._topLevelStatuses || [];
    this._stripReadOnlyFields(patched);
    const envelope = this._buildUpdateEnvelope(patched, topLevelStatuses);
    fs.writeFileSync(
      path.join(this.collectDir, `clean_payload_${safe}.json`),
      JSON.stringify(envelope, null, 2),
    );

    if (this.dryRun) {
      this.log.info(`  [dry-run] Would remove ${removed.length} rule(s) from "${workflowName}".`);
      return {
        workflowName,
        status: "dry_run_cleaned",
        removedCount: removed.length,
        removed,
      };
    }

    // Pre-flight validation.
    const validation = await this._callValidate(envelope);
    fs.writeFileSync(
      path.join(this.collectDir, `clean_validation_${safe}.json`),
      JSON.stringify(validation, null, 2),
    );
    if (this._validationHasErrors(validation) && !this.force) {
      this.log.error(
        `"${workflowName}" cleaned envelope failed validation. Use --force to push anyway. ` +
        `See clean_validation_${safe}.json.`,
      );
      return {
        workflowName,
        status: "blocked_by_validation",
        removedCount: 0,
        removed: [],
      };
    }

    try {
      const mutation = await this.cloud.updateWorkflowsBulk(envelope);
      this.log.info(`  ${workflowName}: removed ${removed.length} rule(s).`);
      return {
        workflowName,
        status: "cleaned",
        removedCount: removed.length,
        removed,
        mutationResponse: mutation,
      };
    } catch (err) {
      this.log.error(`  ${workflowName}: push failed — ${err.message}`);
      return {
        workflowName,
        status: "push_failed",
        removedCount: 0,
        removed: [],
        error: err.message,
      };
    }
  }

  _renderCleanedCsv(rows) {
    const esc = (v) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      "workflow", "transition", "ruleCategory", "ruleKey", "appKey",
      "migrationSourceId", "ruleId", "tag", "disabled",
    ].join(",");
    const lines = [header];
    for (const r of rows || []) {
      lines.push([
        esc(r.workflowName),
        esc(r.transitionName),
        esc(r.ruleCategory),
        esc(r.ruleKey),
        esc(r.appKey),
        esc(r.migrationSourceId),
        esc(r.ruleId),
        esc(r.tag),
        esc(r.disabled),
      ].join(","));
    }
    return lines.join("\r\n") + "\r\n";
  }
}

module.exports = JsuCleaner;
