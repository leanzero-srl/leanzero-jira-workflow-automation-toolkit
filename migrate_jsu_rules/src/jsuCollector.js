const fs = require("fs");
const path = require("path");

const { buildInventory, inventoryToConversionPlan } = require("./jsuInventory");
const { parseWorkflowXmlDir } = require("./dcWorkflowXmlParser");
const { safeFilename, isoNow } = require("./utils");
const {
  buildSignatureRecord,
  renderInstanceTxt,
} = require("./instanceSignature");

class JsuCollector {
  constructor(dcClient, cloudClient, config, { log, collectDir, xmlDir = null }) {
    this.dc = dcClient;
    this.cloud = cloudClient;
    this.config = config || {};
    this.log = log;
    this.collectDir = collectDir;
    this.xmlDir = xmlDir;
    this._ensureDir(collectDir);
    this._ensureDir(path.join(collectDir, "dc_workflows"));
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _writeJson(name, data) {
    const filePath = path.join(this.collectDir, name);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    this.log.info(`Wrote ${name}`);
  }

  async run() {
    this.log.info(`Collect phase starting; output dir: ${this.collectDir}`);

    let dcWorkflows;
    let workflowNames;
    const fetchErrors = [];

    if (this.xmlDir) {
      this.log.info(`Source: XML files in ${this.xmlDir}`);
      dcWorkflows = this._loadFromXmlDir(fetchErrors);
      workflowNames = dcWorkflows.map((w) => w.name);
    } else {
      const selection = this.config.workflowSelection || {};
      workflowNames = await this._resolveWorkflowNames(selection);
      if (workflowNames.length === 0) {
        throw new Error(
          "No workflow names resolved. Provide workflowSelection.workflowNames or .projectKeys or .allWorkflows in config — OR use --xml-dir to read workflows from exported XML files.",
        );
      }
      this.log.info(`Will collect ${workflowNames.length} workflow(s) from DC REST`);
      dcWorkflows = await this._fetchFromDcRest(workflowNames, fetchErrors);
    }

    if (dcWorkflows.length === 0) {
      throw new Error("No workflows were successfully loaded. See logs for details.");
    }

    const perRuleOverrides = this.config.perRuleOverrides || {};
    const inventory = buildInventory(dcWorkflows, { perRuleOverrides });
    this._writeJson("jsu_rule_inventory.json", {
      generatedAt: isoNow(),
      source: this.xmlDir ? `xml-dir:${this.xmlDir}` : `dc-rest:${this.dc ? this.dc.baseUrl : "unknown"}`,
      workflowCount: dcWorkflows.length,
      ...inventory,
    });

    const plan = inventoryToConversionPlan(inventory);
    this._writeJson("conversion_plan.json", plan);

    // DC field catalog → field_mapping.json. The applier reads this and uses
    // FieldMapper to translate DC custom field IDs to Cloud IDs by name match.
    // Limited to the fields actually referenced by the harvested JSU rules so
    // the file stays small and human-reviewable.
    await this._writeFieldMapping(dcWorkflows);

    // DC status catalog → dc_status_catalog.json. Used by the applier's status
    // remapping to translate DC status IDs (numeric, e.g. "5,6") to their
    // Cloud counterparts via name match.
    await this._writeDcStatusCatalog();

    // Pre-check target Cloud: which workflows exist on Cloud by the same name?
    // INFORMATIONAL ONLY — the apply phase always re-fetches each Cloud
    // workflow live, takes a fresh fingerprint snapshot, and uses that for
    // dedup. Never relies on the contents of this file. Stamping the
    // checkedAt timestamp makes it obvious how stale the data is.
    const cloudCheck = await this._preCheckCloud(workflowNames);
    cloudCheck.checkedAt = isoNow();
    cloudCheck._note =
      "Snapshot of Cloud workflow presence at collect time. Apply phase " +
      "re-fetches each workflow live and uses a fresh fingerprint snapshot " +
      "for dedup; do NOT consult this file as a source of truth at apply.";
    this._writeJson("cloud_target_workflows.json", cloudCheck);

    // === Instance signature stamp ============================================
    // Bind every artifact in this collect dir to the (DC, Cloud, XML) tuple
    // it was built from. Apply will refuse to operate on a collect dir whose
    // signature doesn't match the currently-configured (DC, Cloud) pair —
    // the safety net that prevents writing one tenant's converted rules to
    // another tenant. See src/instanceSignature.js for the contract.
    const instanceSignature = buildSignatureRecord(this.config, {
      xmlDir: this.xmlDir,
    });
    this.log.info(
      `Instance signature: fp=${instanceSignature.fingerprint} ` +
      `dc="${instanceSignature.dcBaseUrl || "(none)"}" ` +
      `cloud="${instanceSignature.cloudBaseUrl}"`,
    );
    // INSTANCE.txt — human-readable banner; stays even if metadata.json is
    // hand-edited or accidentally truncated, so an operator glancing at the
    // dir always knows which tenants it belongs to.
    fs.writeFileSync(
      path.join(this.collectDir, "INSTANCE.txt"),
      renderInstanceTxt(instanceSignature),
    );

    this._writeJson("metadata.json", {
      generatedAt: isoNow(),
      source: this.xmlDir ? `xml-dir:${this.xmlDir}` : `dc-rest:${this.dc ? this.dc.baseUrl : "unknown"}`,
      cloudBaseUrl: this.cloud ? this.cloud.baseUrl : null,
      // Stable {dcBaseUrl, cloudBaseUrl, xmlDir, fingerprint, capturedAt}
      // record consumed by the applier's mismatch detection.
      instanceSignature,
      workflowNames,
      dcWorkflowCount: dcWorkflows.length,
      cloudWorkflowsFound: cloudCheck.foundCount,
      cloudWorkflowsMissing: cloudCheck.missing,
      jmweEnabled: this.config.jmwe ? !!this.config.jmwe.enabled : true,
      fetchErrors,
      stats: inventory.stats,
    });

    this._writeConversionPlanExample();
    this.log.info(
      `Collect complete. ${inventory.stats.totalJsuRules} JSU rules across ${dcWorkflows.length} workflow(s).`,
    );
    if (inventory.stats.unknownShortNames.length > 0) {
      this.log.warn(
        `Encountered ${inventory.stats.unknownShortNames.length} unknown JSU shortName(s) not in catalog: ${inventory.stats.unknownShortNames.join(", ")}`,
      );
    }
    if (cloudCheck.missing.length > 0) {
      this.log.warn(
        `${cloudCheck.missing.length} workflow(s) not found on Cloud (target): ${cloudCheck.missing.join(", ")}`,
      );
    }

    return {
      collectDir: this.collectDir,
      inventory,
      conversionPlan: plan,
      cloudCheck,
    };
  }

  _loadFromXmlDir(fetchErrors) {
    let parseResult;
    try {
      parseResult = parseWorkflowXmlDir(this.xmlDir);
    } catch (err) {
      throw new Error(`Failed to read XML dir ${this.xmlDir}: ${err.message}`);
    }
    const { parsed, errors: parseErrors } = parseResult;
    for (const { file, error } of parseErrors) {
      this.log.error(`Failed to parse ${file}: ${error}`);
      fetchErrors.push({ file, reason: error });
    }
    if (parsed.length === 0) {
      throw new Error(
        `No parseable .xml files found in ${this.xmlDir}. Export workflow XMLs from Jira DC admin UI (Workflows → <workflow> → "View as Text" → save XML) into this folder.`,
      );
    }

    // Detect duplicate workflow names BEFORE we write anything — silent
    // overwrite at scale is the kind of bug that surfaces only after a
    // botched apply. We disambiguate by appending the source filename so
    // every workflow makes it into the inventory under a unique key.
    const nameToFiles = new Map();
    for (const { file, workflow } of parsed) {
      const arr = nameToFiles.get(workflow.name) || [];
      arr.push(file);
      nameToFiles.set(workflow.name, arr);
    }
    const duplicateNames = [...nameToFiles.entries()].filter(([, files]) => files.length > 1);
    if (duplicateNames.length > 0) {
      for (const [name, files] of duplicateNames) {
        this.log.warn(
          `Duplicate workflow name "${name}" appears in ${files.length} files: ${files.join(", ")}. ` +
            `Disambiguating by appending the filename stem to each — review the resulting workflow names before --apply.`,
        );
      }
      const nameOccurrence = new Map();
      for (const item of parsed) {
        const original = item.workflow.name;
        const occ = (nameOccurrence.get(original) || 0) + 1;
        nameOccurrence.set(original, occ);
        if (nameToFiles.get(original).length > 1) {
          const stem = path.basename(item.file, path.extname(item.file));
          item.workflow.name = `${original} [${stem}]`;
        }
      }
    }

    const out = [];
    for (const { file, workflow } of parsed) {
      try {
        this._writeJson(`dc_workflows/${safeFilename(workflow.name)}.json`, workflow);
        out.push(workflow);
        this.log.info(
          `  parsed ${file} as workflow "${workflow.name}" (${workflow.transitions.length} transitions)`,
        );
      } catch (err) {
        this.log.error(`Failed to normalize ${file}: ${err.message}`);
        fetchErrors.push({ file, reason: err.message });
      }
    }
    return out;
  }

  async _fetchFromDcRest(workflowNames, fetchErrors) {
    const out = [];
    for (const name of workflowNames) {
      try {
        const wf = await this.dc.getWorkflowByName(name);
        if (!wf) {
          this.log.warn(`DC workflow "${name}" not found — skipping`);
          fetchErrors.push({ name, reason: "not_found" });
          continue;
        }
        if (!Array.isArray(wf.transitions)) {
          this.log.warn(
            `DC REST returned summary-only for "${name}" (no transitions). Jira DC REST does not expose workflow rule bodies; switch to --xml-dir with exported XMLs.`,
          );
          fetchErrors.push({ name, reason: "dc_rest_summary_only" });
          continue;
        }
        const resolvedName = (wf && wf.name) || (wf && wf.id && wf.id.name) || name;
        out.push(wf);
        this._writeJson(`dc_workflows/${safeFilename(resolvedName)}.json`, wf);
      } catch (err) {
        this.log.error(`DC fetch failed for "${name}": ${err.message}`);
        fetchErrors.push({ name, reason: err.message });
      }
    }
    return out;
  }

  async _resolveWorkflowNames(selection) {
    const names = new Set();
    const explicit = Array.isArray(selection.workflowNames) ? selection.workflowNames : [];
    explicit.forEach((n) => names.add(n));

    const projectKeys = Array.isArray(selection.projectKeys) ? selection.projectKeys : [];
    for (const key of projectKeys) {
      try {
        const scheme = await this.dc.getWorkflowSchemeForProject(key);
        if (!scheme) {
          this.log.warn(`No workflow scheme returned for project ${key}`);
          continue;
        }
        if (scheme.defaultWorkflow) names.add(scheme.defaultWorkflow);
        const mapping = scheme.issueTypeMappings || {};
        for (const wfName of Object.values(mapping)) {
          if (wfName) names.add(wfName);
        }
      } catch (err) {
        this.log.error(`Scheme lookup failed for project ${key}: ${err.message}`);
      }
    }

    if (selection.allWorkflows) {
      try {
        const all = await this.dc.getAllWorkflows();
        if (Array.isArray(all)) {
          for (const w of all) {
            if (w && w.name) names.add(w.name);
          }
        }
      } catch (err) {
        this.log.error(`GET /rest/api/2/workflow failed: ${err.message}`);
      }
    }

    return [...names];
  }

  /**
   * Scan all parsed workflows for any `customfield_NNNN` ID referenced inside
   * JSU rule configurations (also handles `@@`-separated lists). Returns the
   * set of unique IDs encountered.
   */
  _collectReferencedFieldIds(dcWorkflows) {
    const ids = new Set();
    const fieldRegex = /customfield_\d+/g;
    const visit = (val) => {
      if (val == null) return;
      if (Array.isArray(val)) return val.forEach(visit);
      if (typeof val === "object") return Object.values(val).forEach(visit);
      if (typeof val === "string") {
        const matches = val.match(fieldRegex);
        if (matches) matches.forEach((m) => ids.add(m));
      }
    };
    for (const wf of dcWorkflows) {
      for (const t of wf.transitions || []) {
        visit(t.rules);
      }
    }
    return ids;
  }

  async _writeFieldMapping(dcWorkflows) {
    const referenced = this._collectReferencedFieldIds(dcWorkflows);
    this.log.info(`Custom field IDs referenced in JSU rules: ${referenced.size}`);

    if (!this.dc) {
      this.log.warn(
        `No DC connection — writing field_mapping.json with empty names. ` +
        `Apply phase will leave field IDs unmapped (DC IDs sent to Cloud as-is). ` +
        `Provide config.fieldMappingFile pointing to a manually-built {dcId: dcName} JSON ` +
        `if you want name-based remapping without DC access.`,
      );
      const out = {};
      for (const id of referenced) out[id] = null;
      this._writeJson("field_mapping.json", out);
      return;
    }

    let allFields;
    try {
      allFields = await this.dc.getAllFields();
    } catch (err) {
      this.log.error(`Failed to fetch DC field catalog: ${err.message}`);
      const out = {};
      for (const id of referenced) out[id] = null;
      this._writeJson("field_mapping.json", out);
      return;
    }

    // Build {id → name} for ALL DC custom fields (full catalog, not just referenced).
    // Persisting the full catalog makes the file more useful for re-runs against
    // additional workflows without re-fetching DC.
    const fullCatalog = {};
    for (const f of allFields || []) {
      if (f && f.id && f.name) fullCatalog[f.id] = f.name;
    }
    this._writeJson("dc_field_catalog.json", fullCatalog);
    this.log.info(`DC field catalog written: ${Object.keys(fullCatalog).length} fields`);

    // The applier-facing file: only fields referenced by harvested rules.
    const out = {};
    for (const id of referenced) {
      out[id] = fullCatalog[id] || null;
      if (!fullCatalog[id]) {
        this.log.warn(`Referenced field "${id}" not found in DC catalog`);
      }
    }
    this._writeJson("field_mapping.json", out);
    const named = Object.values(out).filter(Boolean).length;
    this.log.info(`Field mapping seeded with ${named}/${referenced.size} resolved DC names`);
  }

  async _writeDcStatusCatalog() {
    if (!this.dc) {
      this.log.warn(
        `No DC connection — skipping dc_status_catalog.json. Status IDs will go through to Cloud as-is at apply time (likely WRONG since DC and Cloud have different status IDs).`,
      );
      return;
    }
    try {
      const statuses = await this.dc.makeRequest("GET", "/rest/api/2/status");
      // Persist {id: name} so the applier can resolve Cloud counterparts by name.
      const out = {};
      for (const s of statuses || []) {
        if (s && s.id != null) out[String(s.id)] = s.name || "";
      }
      this._writeJson("dc_status_catalog.json", out);
      this.log.info(`DC status catalog written: ${Object.keys(out).length} statuses`);
    } catch (err) {
      this.log.warn(`Failed to fetch DC status catalog: ${err.message}`);
    }
  }

  async _preCheckCloud(workflowNames) {
    const out = { requested: workflowNames, found: [], missing: [], foundCount: 0 };
    if (!this.cloud) {
      this.log.warn("No Cloud client configured; skipping cloud pre-check");
      return out;
    }
    // Apply `config.workflowNameOverrides` so the pre-check looks up each DC
    // name under the operator-declared Cloud equivalent. Without this, DC's
    // XML mangling (`:` and `/` → `_`) makes the pre-check report dozens of
    // false "missing" entries that --apply would actually find via the same
    // overrides at fetch time.
    const overrides = (this.config && this.config.workflowNameOverrides) || {};
    const lookupNames = workflowNames.map((n) => overrides[n] || n);
    const lookupToDc = new Map();
    for (let i = 0; i < workflowNames.length; i++) {
      lookupToDc.set(lookupNames[i], workflowNames[i]);
    }
    // Cloud's POST /rest/api/3/workflows returns 404 for the WHOLE request when
    // ANY name is missing on the tenant — fall back to per-name on any error.
    let workflows = null;
    try {
      workflows = await this.cloud.getWorkflowsByNames(lookupNames);
    } catch (err) {
      this.log.warn(
        `Cloud bulk pre-check failed (${err.message}); ` +
        `falling back to per-name lookups (slower but tolerant of names that don't exist).`,
      );
      workflows = await this._preCheckCloudPerName(lookupNames);
    }
    const byLookupName = new Map();
    for (const wf of workflows || []) {
      const n = wf && wf.name;
      if (n) byLookupName.set(n, wf);
    }
    for (let i = 0; i < workflowNames.length; i++) {
      const dcName = workflowNames[i];
      const lookupName = lookupNames[i];
      if (byLookupName.has(lookupName)) {
        const wf = byLookupName.get(lookupName);
        out.found.push({
          name: dcName,
          cloudName: lookupName !== dcName ? lookupName : undefined,
          id: wf.id,
          version: wf.version,
          transitionCount: Array.isArray(wf.transitions) ? wf.transitions.length : 0,
        });
      } else {
        out.missing.push(dcName);
      }
    }
    out.foundCount = out.found.length;
    return out;
  }

  /**
   * Per-name fallback for _preCheckCloud. Sends one workflow name per POST so
   * a single missing name doesn't 404 the whole batch. Treats per-name 404 as
   * "not found, skip" — same shape as the apply path's _fetchCloudWorkflow.
   * Returns the collected list of workflows that DID resolve.
   */
  async _preCheckCloudPerName(workflowNames) {
    const collected = [];
    let i = 0;
    for (const name of workflowNames) {
      i++;
      try {
        const r = await this.cloud.makeRequest("POST", "/rest/api/3/workflows", {
          workflowNames: [name],
        });
        const wf = (r && r.workflows || []).find((w) => w && w.name === name);
        if (wf) collected.push(wf);
      } catch {
        // Per-name 404 / error — skip silently; the caller's missing[] list
        // captures the absence.
      }
      if (i % 50 === 0) this.log.info(`  per-name pre-check progress: ${i}/${workflowNames.length}`);
    }
    return collected;
  }

  _writeConversionPlanExample() {
    const example = {
      _help: {
        purpose: "Reference showing every supported strategy. Not loaded at apply time.",
      },
      rows: [
        {
          workflowName: "ExampleWorkflow",
          transitionName: "Start Progress",
          ruleCategory: "validator",
          dcType: "com.googlecode.jira-suite-utilities:fields-required-validator",
          shortName: "fields-required-validator",
          strategy: "native",
          confidence: "high",
          nativeRuleKey: "system:validate-field-value",
          notes: "fieldRequired ruleType; mapped via jsuNativeMappers.fieldsRequiredValidator",
        },
        {
          workflowName: "ExampleWorkflow",
          transitionName: "Close Issue",
          ruleCategory: "postFunction",
          dcType: "com.googlecode.jira-suite-utilities:send-custom-email",
          shortName: "send-custom-email",
          strategy: "jmwe",
          confidence: "medium",
          jmweModuleKey: "SendEmailFunction",
          notes: "value schema must be validated via --validate-only",
        },
        {
          workflowName: "ExampleWorkflow",
          transitionName: "Any",
          ruleCategory: "condition",
          dcType: "com.googlecode.jira-suite-utilities:no-operation-condition",
          shortName: "no-operation-condition",
          strategy: "skip",
          confidence: "high",
          notes: "Safe to drop",
        },
        {
          workflowName: "ExampleWorkflow",
          transitionName: "Resolve",
          ruleCategory: "postFunction",
          dcType: "com.googlecode.jira-suite-utilities:set-field-value-automatically",
          shortName: "set-field-value-automatically",
          strategy: "manual-review",
          confidence: "none",
          notes: "Flagged for human decision",
        },
      ],
    };
    this._writeJson("conversion_plan_example.json", example);
  }
}

module.exports = JsuCollector;
