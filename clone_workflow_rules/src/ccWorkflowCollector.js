/**
 * Cloud-to-Cloud Collector: `--cloud-to-cloud --collect`.
 *
 * Reads workflows from a SOURCE Jira Cloud instance using the NEW-format bulk read
 * endpoint (POST /rest/api/3/workflows, via client.getWorkflowsEnvelopeByNames). That
 * endpoint returns every transition with `conditions` / `validators` / `actions` already
 * in `{ ruleKey, parameters }` form — the EXACT shape the write endpoints consume. So a
 * cloud->cloud copy can preserve every rule verbatim and only translate IDs at apply time;
 * there is NO old->new rule-type mapping (the biggest risk in the legacy --collect path).
 *
 * Output: ONE cohesive, self-contained bundle file `cc_bundle_<ts>.json` containing every
 * workflow verbatim plus the field/status/entity catalogs needed for translation on apply.
 *
 * Entity-reference scanning reuses the tuned referenceScanner + WorkflowCollector.resolveIdCatalog
 * via a thin new->old shape adapter, so the EMBEDDED_KEY_HINTS table is reused for free.
 */

const fs = require("fs");
const path = require("path");
const { extractCustomFieldIds } = require("./workflowTransformer");
const { scanMany } = require("./referenceScanner");
const WorkflowCollector = require("./workflowCollector");

// A ScriptRunner rule, in any of its Cloud guises (connect/forge), carries the
// vendor key "com.onresolve...groovyrunner". We only COUNT these at collect time;
// the applier skips them. "onresolve" is the cheapest reliable discriminator.
const SCRIPTRUNNER_RE = /onresolve|groovyrunner/i;

class CcWorkflowCollector {
  constructor(client, options = {}) {
    this.client = client;
    this.log = options.log || console.log;
    this.collectDir = options.collectDir;
    this.projectKeys = options.projectKeys || [];
    this.workflowNames = options.workflowNames || [];
    this.allWorkflows = options.allWorkflows || false;
  }

  async run() {
    const startTime = Date.now();
    fs.mkdirSync(this.collectDir, { recursive: true });

    this.log(`\nCLOUD-TO-CLOUD COLLECT MODE (new-format literal copy)`);
    this.log(`Source: ${this.client.baseUrl}`);
    this.log(`Output directory: ${this.collectDir}`);
    this.log(`${"=".repeat(60)}\n`);

    // ── Step 1: Discover the set of workflow names ──
    const { names, schemeData } = await this._discoverWorkflowNames();
    this.log(`\nTotal unique workflows to collect: ${names.length}`);
    if (names.length === 0) {
      throw new Error("No workflows resolved to collect. Check --project-keys/--workflow-names/--all-workflows.");
    }

    // ── Step 2: Read each workflow in NEW format (verbatim) ──
    this.log(`\nReading workflows via POST /rest/api/3/workflows (new format)...`);
    const envelope = await this.client.getWorkflowsEnvelopeByNames(names);
    const workflows = envelope.workflows || [];
    this.log(`  Retrieved ${workflows.length} workflow definitions`);

    const returnedNames = new Set(workflows.map((w) => w.name));
    const missing = names.filter((n) => !returnedNames.has(n));
    if (missing.length > 0) {
      this.log(`  WARNING: ${missing.length} requested workflow(s) not returned: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? " ..." : ""}`);
    }

    // ── Step 3: Status catalog (from the read envelope + full instance catalog) ──
    const statusCatalog = await this._buildStatusCatalog(envelope.statuses || []);

    // ── Step 4: Field catalog — every customfield_NNN referenced, resolved to its name ──
    const allCustomFieldIds = new Set();
    for (const wf of workflows) {
      for (const id of extractCustomFieldIds(wf)) allCustomFieldIds.add(id);
    }
    this.log(`\nResolving ${allCustomFieldIds.size} custom field name(s)...`);
    const fieldCatalog = {};
    for (const cfId of allCustomFieldIds) {
      try {
        const field = await this.client.getFieldById(cfId);
        fieldCatalog[cfId] = field ? field.name : null;
        if (!field) this.log(`  ${cfId} -> NOT FOUND on source`);
      } catch (err) {
        fieldCatalog[cfId] = null;
        this.log(`  ${cfId} -> ERROR: ${err.message}`);
      }
    }

    // ── Step 5: Entity catalog (statuses/screens/roles/etc. referenced inside rules) ──
    this.log(`\nScanning rules for cross-instance entity references...`);
    const adapted = workflows.map((w) => adaptNewWorkflowToOldShape(w));
    const refs = scanMany(adapted);
    for (const scheme of schemeData) {
      for (const itId of Object.keys(scheme.issueTypeMappings || {})) {
        refs.embedded.issueTypes.push(String(itId));
      }
    }
    refs.embedded.issueTypes = [...new Set(refs.embedded.issueTypes)].sort();

    // statusMap (id -> {name, statusCategory}) feeds status name resolution. Build from the
    // full instance catalog and overlay envelope statuses keyed by statusReference, so it
    // resolves whether statusReference is a legacy numeric id or a UUID.
    const statusMap = {};
    try {
      for (const s of await this.client.getAllStatuses()) {
        statusMap[String(s.id)] = { id: s.id, name: s.name, statusCategory: s.statusCategory };
      }
    } catch (err) {
      this.log(`  WARNING: could not fetch full status catalog: ${err.message}`);
    }
    for (const s of envelope.statuses || []) {
      const entry = { id: s.id, name: s.name, statusCategory: s.statusCategory };
      if (s.id !== undefined) statusMap[String(s.id)] = entry;
      if (s.statusReference !== undefined) statusMap[String(s.statusReference)] = entry;
    }

    // Reuse WorkflowCollector.resolveIdCatalog / buildOverridesSkeleton verbatim.
    const helper = new WorkflowCollector(this.client, { log: this.log, collectDir: this.collectDir });
    const entityCatalog = await helper.resolveIdCatalog(refs, statusMap, {});

    // ── Step 6: Stats (counts + ScriptRunner rules that apply will skip) ──
    const stats = this._computeStats(workflows, fieldCatalog);

    // ── Step 7: Write the single cohesive bundle ──
    const bundle = {
      schema: "cloud-to-cloud-literal/v1",
      sourceUrl: this.client.baseUrl,
      collectedAt: new Date().toISOString(),
      selection: {
        projectKeys: this.projectKeys,
        workflowNames: this.workflowNames,
        allWorkflows: this.allWorkflows,
      },
      stats,
      missingWorkflows: missing,
      fieldCatalog, // source customfield_NNN -> source display name
      statusCatalog, // { byReference, byId, byName }
      entityCatalog, // source id -> {name,...} per bucket (statuses/screens/roles/...)
      workflowSchemes: schemeData,
      workflows, // verbatim new-format workflow objects (the source of truth for apply)
    };

    const bundlePath = path.join(this.collectDir, `cc_bundle_${Date.now()}.json`);
    fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));

    // Optional curation seed for unresolved entity IDs (sits beside the bundle).
    const overridesPath = path.join(this.collectDir, "cc_id_overrides.json.example");
    if (!fs.existsSync(overridesPath)) {
      fs.writeFileSync(overridesPath, JSON.stringify(helper.buildOverridesSkeleton(entityCatalog), null, 2));
    }

    // ── Report ──
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const apiStats = this.client.getStats();
    this.log(`\n${"=".repeat(60)}`);
    this.log(`CLOUD-TO-CLOUD COLLECT COMPLETE`);
    this.log(`${"=".repeat(60)}`);
    this.log(`  Workflows:           ${stats.workflows}`);
    this.log(`  Transitions:         ${stats.transitions}`);
    this.log(`  Rules (cond/val/act): ${stats.rules} (${stats.conditions}/${stats.validators}/${stats.actions})`);
    this.log(`  ScriptRunner rules:  ${stats.scriptRunnerRules} (skipped at apply)`);
    this.log(`  Custom fields:       ${stats.customFields} (${stats.customFieldsUnresolved} unresolved)`);
    this.log(`  Bundle:              ${bundlePath}`);
    this.log(`  API requests:        ${apiStats.requestCount} (${apiStats.errorCount} errors, ${apiStats.rateLimitCount} rate limits)`);
    this.log(`  Elapsed:             ${elapsed}s`);

    return { bundlePath, stats };
  }

  /**
   * Resolve workflow names from project schemes, explicit names, and/or the whole instance.
   * Mirrors WorkflowCollector Step 1. For --all-workflows the legacy /workflow/search is used
   * purely as a NAME enumerator; the bodies are re-read in new format in run().
   */
  async _discoverWorkflowNames() {
    const discovered = new Set();
    const schemeData = [];

    if (this.projectKeys.length > 0) {
      this.log(`Resolving workflow schemes for ${this.projectKeys.length} project(s)...`);
      for (const key of this.projectKeys) {
        const project = await this.client.getProjectByKey(key);
        if (!project) { this.log(`  WARNING: Project ${key} not found, skipping`); continue; }
        const scheme = await this.client.getWorkflowSchemeForProject(project.id);
        if (!scheme) { this.log(`  WARNING: No workflow scheme for ${key}, skipping`); continue; }
        this.log(`  ${key} -> scheme "${scheme.name}" (ID ${scheme.id})`);
        schemeData.push({
          projectKey: key,
          projectId: project.id,
          schemeId: scheme.id,
          schemeName: scheme.name,
          defaultWorkflow: scheme.defaultWorkflow || "jira",
          issueTypeMappings: scheme.issueTypeMappings || {},
        });
        if (scheme.defaultWorkflow) discovered.add(scheme.defaultWorkflow);
        for (const wfName of Object.values(scheme.issueTypeMappings || {})) discovered.add(wfName);
      }
    }

    for (const name of this.workflowNames) discovered.add(name);

    if (this.allWorkflows) {
      this.log(`\nEnumerating all workflows on the instance (paginated)...`);
      const all = await this.client.getAllWorkflows();
      for (const wf of all) {
        const name = wf.id ? wf.id.name : wf.name;
        if (name) discovered.add(name);
      }
      this.log(`  Found ${all.length} workflows via /workflow/search`);
    }

    return { names: [...discovered], schemeData };
  }

  /**
   * Build a status catalog from the read-envelope statuses, indexed three ways so the
   * applier can resolve a source statusReference to a target status by name.
   */
  async _buildStatusCatalog(envelopeStatuses) {
    const byReference = {};
    const byId = {};
    const byName = {};
    for (const s of envelopeStatuses) {
      const entry = {
        id: s.id,
        name: s.name,
        statusCategory: s.statusCategory,
        statusReference: s.statusReference,
      };
      if (s.statusReference !== undefined) byReference[String(s.statusReference)] = entry;
      if (s.id !== undefined) byId[String(s.id)] = entry;
      if (s.name) byName[s.name] = entry;
    }
    this.log(`\nStatus catalog: ${Object.keys(byReference).length} by reference, ${Object.keys(byName).length} by name`);
    return { byReference, byId, byName };
  }

  _computeStats(workflows, fieldCatalog) {
    let transitions = 0, conditions = 0, validators = 0, actions = 0, scriptRunnerRules = 0;
    for (const wf of workflows) {
      for (const t of wf.transitions || []) {
        transitions++;
        eachConditionLeaf(t.conditions, (leaf) => {
          conditions++;
          if (isScriptRunnerRule(leaf)) scriptRunnerRules++;
        });
        for (const v of t.validators || []) {
          validators++;
          if (isScriptRunnerRule(v)) scriptRunnerRules++;
        }
        for (const a of t.actions || []) {
          actions++;
          if (isScriptRunnerRule(a)) scriptRunnerRules++;
        }
      }
    }
    return {
      workflows: workflows.length,
      transitions,
      conditions,
      validators,
      actions,
      rules: conditions + validators + actions,
      scriptRunnerRules,
      customFields: Object.keys(fieldCatalog).length,
      customFieldsUnresolved: Object.values(fieldCatalog).filter((v) => !v).length,
    };
  }
}

// ─────────────────────────────────────────────────
//  NEW-FORMAT RULE WALKING HELPERS (shared shape)
// ─────────────────────────────────────────────────

/**
 * Visit every leaf rule in a new-format conditions tree.
 * The tree is { operation, conditionGroups:[...], conditions:[...] } where leaves carry
 * `ruleKey` and groups carry nested `conditions`/`conditionGroups`.
 */
function eachConditionLeaf(node, cb) {
  if (!node) return;
  if (node.ruleKey) { cb(node); return; }
  for (const c of node.conditions || []) eachConditionLeaf(c, cb);
  for (const g of node.conditionGroups || []) eachConditionLeaf(g, cb);
}

function isScriptRunnerRule(rule) {
  if (!rule) return false;
  const key = rule.ruleKey || "";
  const appKey = (rule.parameters && rule.parameters.appKey) || "";
  return SCRIPTRUNNER_RE.test(key) || SCRIPTRUNNER_RE.test(appKey);
}

/**
 * Adapt a NEW-format workflow into the OLD shape that referenceScanner expects, so we can
 * reuse its tuned EMBEDDED_KEY_HINTS walking. Only the fields the scanner reads are produced:
 *   - workflow.statuses[].id          <- statusReference
 *   - transition.to / transition.from <- toStatusReference / links[].(from|to)StatusReference
 *   - transition.rules.{conditions, validators, postFunctions} with {type, configuration}
 * Each new rule's `parameters` becomes the old `configuration` (the scanner walks arbitrary
 * JSON-looking strings, so a JMWE `parameters.config` blob is scanned automatically).
 */
function adaptNewWorkflowToOldShape(wf) {
  const statuses = (wf.statuses || []).map((s) => ({ id: s.statusReference }));
  const transitions = (wf.transitions || []).map((t) => {
    const from = [];
    for (const link of t.links || []) {
      if (link.fromStatusReference !== undefined) from.push(link.fromStatusReference);
      if (link.toStatusReference !== undefined) from.push(link.toStatusReference);
    }
    return {
      to: t.toStatusReference,
      from,
      rules: {
        conditions: adaptConditionNode(t.conditions),
        validators: (t.validators || []).map(adaptRule),
        postFunctions: (t.actions || []).map(adaptRule),
      },
    };
  });
  return { statuses, transitions };
}

function adaptRule(rule) {
  return { type: rule.ruleKey, configuration: rule.parameters || {} };
}

function adaptConditionNode(node) {
  if (!node) return null;
  if (node.ruleKey) return { configuration: node.parameters || {} };
  const children = [];
  for (const c of node.conditions || []) {
    const a = adaptConditionNode(c);
    if (a) children.push(a);
  }
  for (const g of node.conditionGroups || []) {
    const a = adaptConditionNode(g);
    if (a) children.push(a);
  }
  return { conditions: children };
}

module.exports = CcWorkflowCollector;
module.exports.adaptNewWorkflowToOldShape = adaptNewWorkflowToOldShape;
module.exports.eachConditionLeaf = eachConditionLeaf;
module.exports.isScriptRunnerRule = isScriptRunnerRule;
