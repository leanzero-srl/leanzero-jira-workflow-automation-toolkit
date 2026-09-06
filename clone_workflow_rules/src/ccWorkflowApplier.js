/**
 * Cloud-to-Cloud Applier: `--cloud-to-cloud --apply` (UPDATE-IN-PLACE).
 *
 * Premise: the target instance already has the same workflows (by name) and all entities
 * (fields, statuses, screens, roles…). We do NOT create or restructure workflows — we copy the
 * SOURCE transition rules onto the matching TARGET workflow, translating IDs:
 *   - custom field IDs everywhere (incl. JMWE config JSON + nunjucks),
 *   - structural entity IDs (statuses/screens/roles/…) by name,
 *   - ScriptRunner rules skipped.
 * The target keeps its own status structure / version; only conditions/validators/actions on
 * name-matched transitions are replaced. Validation endpoint is always called before mutating.
 */

const fs = require("fs");
const path = require("path");
const FieldMapper = require("./fieldMapper");
const IdMapper = require("./idMapper");
const { transformTransitionRules } = require("./ccLiteralTransform");

class CcWorkflowApplier {
  constructor(targetClient, options = {}) {
    this.client = targetClient; // TARGET instance client
    this.log = options.log || console.log;
    this.collectDir = options.collectDir;
    this.dryRun = options.dryRun || false;
    this.validateOnly = options.validateOnly || false;
    this.force = options.force || false; // mutate even if validation reports ERRORs
    this.workflowFilter = (options.workflowNames && options.workflowNames.length)
      ? new Set(options.workflowNames)
      : null;
  }

  async run() {
    const startTime = Date.now();
    const bundle = this._loadBundle();
    this.log(`\nCLOUD-TO-CLOUD APPLY (update-in-place)`);
    this.log(`Source (bundle): ${bundle.sourceUrl}`);
    this.log(`Target (.env/--target-url): ${this.client.baseUrl}`);
    this.log(`Mode: ${this.dryRun ? "DRY-RUN (no API calls)" : this.validateOnly ? "VALIDATE-ONLY (no mutation)" : "APPLY"}`);
    this.log(`${"=".repeat(60)}\n`);
    if (bundle.sourceUrl === this.client.baseUrl) {
      this.log(`WARNING: target URL equals the bundle source URL — this would rewrite the source in place.`);
    }

    // ── Build field remapping (exact-name; cloud→cloud has no "(migrated)" suffix) ──
    // Optional cc_field_overrides.json forces { sourceFieldId: targetFieldId } for cases
    // exact-name matching can't resolve (renamed/migrated fields, name-divergent twins).
    const fieldOverrides = this._loadFieldOverrides();
    const fieldMapper = new FieldMapper(this.client, this.log, { preferMigrated: false, overrides: fieldOverrides });
    const fieldRemapping = await fieldMapper.buildMapping(bundle.fieldCatalog || {});

    // ── Build entity-ID remapping (statuses/screens/roles/… by name) ──
    const overrides = this._loadOverrides();
    const idMapper = new IdMapper(this.client, this.log);
    const idRemapping = await idMapper.buildRemapping(bundle.entityCatalog || {}, overrides);
    // Literal-copy semantic: only TRANSLATE entity IDs we confidently resolved on the target.
    // Unresolved IDs (null) must PASS THROUGH unchanged — never be dropped, because dropping
    // empties rule params (e.g. groupIds) and produces "blocks transition for everyone" errors.
    // Groups in particular are org-level in Atlassian Cloud and usually share IDs across sibling
    // sites, so passing the source ID through is correct. Pruning nulls makes remapScalarId
    // return the source ID for absent keys (= pass-through). The full map is kept for the report.
    const translationMap = pruneNulls(idRemapping);

    // Optional ETI (Email This Issue) saved-template id map: { "<sourceTemplateId>": <targetTemplateId> }.
    const etiTemplateMap = this._loadEtiTemplateMap();

    // ── Decide which workflows to update (must exist on target by exact name) ──
    this.log(`\nEnumerating target workflows...`);
    const targetAll = await this.client.getAllWorkflows();
    const targetNames = new Set(targetAll.map((w) => (w.id ? w.id.name : w.name)).filter(Boolean));
    let sourceWorkflows = bundle.workflows || [];
    if (this.workflowFilter) sourceWorkflows = sourceWorkflows.filter((w) => this.workflowFilter.has(w.name));
    const toUpdate = sourceWorkflows.filter((w) => targetNames.has(w.name));
    const missingOnTarget = sourceWorkflows.filter((w) => !targetNames.has(w.name)).map((w) => w.name);
    this.log(`  ${toUpdate.length} workflow(s) to update; ${missingOnTarget.length} not on target (skipped)`);
    if (missingOnTarget.length) this.log(`  skipped: ${missingOnTarget.join(", ")}`);

    // ── Process each workflow ──
    const results = [];
    const skippedScriptRunner = [];
    const etiReport = [];
    const allWarnings = [];

    for (const sourceWf of toUpdate) {
      const name = sourceWf.name;
      this.log(`\n[${name}]`);
      try {
        const targetWf = await this._fetchTargetWorkflow(name);
        if (!targetWf) {
          this.log(`  WARNING: could not re-read target workflow; skipping`);
          results.push({ name, status: "skipped", reason: "target re-read failed" });
          continue;
        }
        if (targetWf.isEditable === false) {
          this.log(`  SKIP: system workflow is not editable via the API`);
          results.push({ name, status: "skipped", reason: "non-editable system workflow" });
          continue;
        }

        const ctx = {
          fieldRemapping,
          idRemapping: translationMap,
          etiTemplateMap,
          etiReport,
          warnings: [],
          skipped: skippedScriptRunner,
          location: { workflowName: name },
        };

        const { patched, matched, unmatchedTargetTransitions, unmatchedSourceTransitions } =
          this._applyRulesToTarget(sourceWf, targetWf, ctx);
        if (ctx.warnings.length) allWarnings.push(...ctx.warnings.map((w) => `[${name}] ${w}`));

        this._stripReadOnlyFields(patched);
        const envelope = this._buildUpdateEnvelope(patched, patched._topLevelStatuses || []);

        const payloadPath = path.join(this.collectDir, `cc_update_payload_${safe(name)}.json`);
        fs.writeFileSync(payloadPath, JSON.stringify(envelope, null, 2));

        const base = {
          name,
          transitionsMatched: matched,
          unmatchedTargetTransitions,
          unmatchedSourceTransitions,
          payload: `cc_update_payload_${safe(name)}.json`,
        };

        if (this.dryRun) {
          this.log(`  DRY-RUN: payload saved (${matched} transition(s) matched). No API call.`);
          results.push({ ...base, status: "dry-run" });
          continue;
        }

        const validation = await this._callValidate(envelope);
        fs.writeFileSync(
          path.join(this.collectDir, `cc_validation_${safe(name)}.json`),
          JSON.stringify(validation, null, 2),
        );
        const hasErrors = this._validationHasErrors(validation);
        this.log(`  Validation: ${hasErrors ? "ERRORS" : "clean"} (${matched} transition(s) matched)`);

        if (this.validateOnly) {
          results.push({ ...base, status: hasErrors ? "validation-errors" : "validated", validationHasErrors: hasErrors });
          continue;
        }
        if (hasErrors && !this.force) {
          this.log(`  Skipping mutation due to validation errors (use --force to override). See cc_validation_${safe(name)}.json`);
          results.push({ ...base, status: "validation-errors", validationHasErrors: true });
          continue;
        }

        await this.client.updateWorkflowsBulk(envelope);
        this.log(`  UPDATED on target`);
        results.push({ ...base, status: "updated" });
      } catch (err) {
        this.log(`  ERROR: ${err.message}`);
        results.push({ name, status: "error", error: err.message });
      }
    }

    // ── Report ──
    const report = {
      ranAt: new Date().toISOString(),
      sourceUrl: bundle.sourceUrl,
      targetUrl: this.client.baseUrl,
      mode: this.dryRun ? "dry-run" : this.validateOnly ? "validate-only" : "apply",
      counts: {
        toUpdate: toUpdate.length,
        missingOnTarget: missingOnTarget.length,
        updated: results.filter((r) => r.status === "updated").length,
        validated: results.filter((r) => r.status === "validated").length,
        validationErrors: results.filter((r) => r.status === "validation-errors").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        errors: results.filter((r) => r.status === "error").length,
        scriptRunnerRulesSkipped: skippedScriptRunner.length,
      },
      missingOnTarget,
      fieldRemapping,
      idRemappingStats: idRemapping._stats || {},
      skippedScriptRunner,
      warnings: allWarnings,
      results,
    };
    const reportPath = path.join(this.collectDir, `cc_apply_${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    // ── ETI (Email This Issue) report: which rules need which saved templates on the target ──
    const etiTemplateBased = etiReport.filter((e) => e.mode === "saved-template");
    const etiNeedsTemplate = etiTemplateBased.filter((e) => e.needsTargetTemplate);
    const distinctNeeded = [...new Set(etiNeedsTemplate.map((e) => e.sourceTemplateId))].sort((a, b) => a - b);
    const etiReportDoc = {
      ranAt: new Date().toISOString(),
      note: "Email This Issue (ETI) stores saved email templates in its OWN app backend, keyed by a numeric id that is NOT carried by the Jira workflow API. Rules with mode 'saved-template' need that template to exist on the target ETI; map source->target ids in cc_eti_template_map.json and re-apply, or the email body won't resolve.",
      summary: {
        etiRules: etiReport.length,
        savedTemplate: etiTemplateBased.length,
        inlineBody: etiReport.length - etiTemplateBased.length,
        unmappedTemplateRules: etiNeedsTemplate.length,
        sourceTemplateIdsNeedingTargetTemplate: distinctNeeded,
      },
      rules: etiReport,
    };
    const etiPath = path.join(this.collectDir, `cc_eti_report_${Date.now()}.json`);
    fs.writeFileSync(etiPath, JSON.stringify(etiReportDoc, null, 2));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const api = this.client.getStats();
    this.log(`\n${"=".repeat(60)}`);
    this.log(`CLOUD-TO-CLOUD APPLY COMPLETE (${report.mode})`);
    this.log(`${"=".repeat(60)}`);
    this.log(`  Workflows updated:     ${report.counts.updated}`);
    this.log(`  Validated (no mutate): ${report.counts.validated}`);
    this.log(`  Validation errors:     ${report.counts.validationErrors}`);
    this.log(`  Skipped (non-editable):${report.counts.skipped}`);
    this.log(`  Errors:                ${report.counts.errors}`);
    this.log(`  Not on target:         ${report.counts.missingOnTarget}`);
    this.log(`  ScriptRunner skipped:  ${report.counts.scriptRunnerRulesSkipped}`);
    this.log(`  ETI rules:             ${etiReport.length} (${etiTemplateBased.length} saved-template, ${etiReport.length - etiTemplateBased.length} inline)`);
    if (etiNeedsTemplate.length) {
      this.log(`    ⚠ ${etiNeedsTemplate.length} ETI rule(s) reference ${distinctNeeded.length} source template id(s) with NO target mapping: ${distinctNeeded.join(", ")}`);
      this.log(`      Their email body won't resolve on target until those templates exist there. See ${etiPath}`);
    }
    this.log(`  Report:                ${reportPath}`);
    this.log(`  API requests:          ${api.requestCount} (${api.errorCount} errors, ${api.rateLimitCount} rate limits)`);
    this.log(`  Elapsed:               ${elapsed}s`);
    return report;
  }

  /**
   * Copy source transition rules onto a clone of the target workflow, matched by transition name.
   * Target transition structure (to/from/triggers/properties) is preserved; only the
   * conditions/validators/actions are replaced with the translated source rules.
   */
  _applyRulesToTarget(sourceWf, targetWf, ctx) {
    const patched = clone(targetWf); // includes _topLevelStatuses (an enumerable own prop)

    // Index source transitions by name (handle duplicate names by popping on match).
    const srcByName = new Map();
    for (const st of sourceWf.transitions || []) {
      const arr = srcByName.get(st.name) || [];
      arr.push(st);
      srcByName.set(st.name, arr);
    }
    const matchedSourceNames = new Set();

    let matched = 0;
    const unmatchedTargetTransitions = [];
    for (const tt of patched.transitions || []) {
      const arr = srcByName.get(tt.name);
      let st = null;
      if (arr && arr.length) {
        let idx = arr.findIndex((s) => s.type === tt.type);
        if (idx === -1) idx = 0;
        st = arr.splice(idx, 1)[0];
        matchedSourceNames.add(st.name);
      }
      if (!st) {
        unmatchedTargetTransitions.push(tt.name);
        continue;
      }
      ctx.location = { workflowName: sourceWf.name, transitionName: tt.name };
      const rules = transformTransitionRules(st, ctx);
      // Omit conditions when empty (INITIAL transitions reject any conditions object).
      if (rules.conditions) tt.conditions = rules.conditions;
      else delete tt.conditions;
      tt.validators = rules.validators;
      tt.actions = rules.actions;
      matched++;
    }

    const unmatchedSourceTransitions = [];
    for (const [n, arr] of srcByName) {
      if (arr.length) for (let i = 0; i < arr.length; i++) unmatchedSourceTransitions.push(n);
    }
    if (unmatchedTargetTransitions.length) {
      ctx.warnings.push(`target transitions with no source match (left unchanged): ${unmatchedTargetTransitions.join(", ")}`);
    }
    if (unmatchedSourceTransitions.length) {
      ctx.warnings.push(`source transitions with no target match (rules NOT applied): ${unmatchedSourceTransitions.join(", ")}`);
    }

    return { patched, matched, unmatchedTargetTransitions, unmatchedSourceTransitions };
  }

  async _fetchTargetWorkflow(name) {
    const env = await this.client.getWorkflowsEnvelopeByNames([name]);
    const wf = (env.workflows || []).find((w) => w && w.name === name) || null;
    if (wf) wf._topLevelStatuses = env.statuses || [];
    return wf;
  }

  // Ported verbatim from jsuApplier — proven update-envelope handling.
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
    return {
      statuses: topLevelStatuses || [],
      workflows: [{ id, version, ...withoutName }],
    };
  }

  async _callValidate(envelope) {
    try {
      return await this.client.validateUpdateWorkflowsBulk(envelope);
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
        if ((e.level || "ERROR").toUpperCase() === "ERROR") return true;
      }
    }
    if (Array.isArray(validation.errorMessages) && validation.errorMessages.length > 0) return true;
    return false;
  }

  _loadBundle() {
    if (!this.collectDir || !fs.existsSync(this.collectDir)) {
      throw new Error(`Collect directory not found: ${this.collectDir}`);
    }
    const files = fs.readdirSync(this.collectDir).filter((f) => f.startsWith("cc_bundle_") && f.endsWith(".json"));
    if (files.length === 0) {
      throw new Error(`No cc_bundle_*.json found in ${this.collectDir} (run --cc --collect first)`);
    }
    files.sort(); // timestamped names sort chronologically; last is newest
    const bundlePath = path.join(this.collectDir, files[files.length - 1]);
    this.log(`Loading bundle: ${bundlePath}`);
    return JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  }

  _loadOverrides() {
    const p = path.join(this.collectDir, "cc_id_overrides.json");
    if (fs.existsSync(p)) {
      this.log(`Loading id overrides: ${p}`);
      try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch (e) {
        this.log(`  WARNING: could not parse ${p}: ${e.message}`);
      }
    }
    return {};
  }

  // Optional field-override map: { "<sourceFieldId>": "<targetFieldId>", ... }.
  // Forces a field remapping that exact-name resolution can't produce (e.g. a migrated
  // source field "Team (migrated)" cf_10150 -> target "Team (Legacy)" cf_10238).
  _loadFieldOverrides() {
    const p = path.join(this.collectDir, "cc_field_overrides.json");
    if (fs.existsSync(p)) {
      this.log(`Loading field overrides: ${p}`);
      try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch (e) {
        this.log(`  WARNING: could not parse ${p}: ${e.message}`);
      }
    }
    return {};
  }

  // Optional ETI saved-template id map: { "<sourceTemplateId>": <targetTemplateId>, ... }.
  // Keys are stringified source ids; values are the target ETI template ids the operator created.
  _loadEtiTemplateMap() {
    const p = path.join(this.collectDir, "cc_eti_template_map.json");
    if (fs.existsSync(p)) {
      this.log(`Loading ETI template map: ${p}`);
      try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
      } catch (e) {
        this.log(`  WARNING: could not parse ${p}: ${e.message}`);
      }
    }
    return {};
  }
}

function safe(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Drop null/undefined entries from each bucket so absent keys mean "pass the source ID through
// unchanged" rather than "drop it" (remapScalarId returns the source ID for unknown keys).
function pruneNulls(idRemapping) {
  const out = {};
  for (const bucket of Object.keys(idRemapping || {})) {
    out[bucket] = {};
    for (const [k, v] of Object.entries(idRemapping[bucket] || {})) {
      if (v !== null && v !== undefined) out[bucket][k] = v;
    }
  }
  return out;
}

function clone(o) {
  return o == null ? o : JSON.parse(JSON.stringify(o));
}

module.exports = CcWorkflowApplier;
