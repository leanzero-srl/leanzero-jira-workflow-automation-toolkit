/**
 * Cloud-to-Cloud literal rule transform (PURE — no API calls).
 *
 * Input rules are already in new-format `{ ruleKey, parameters }` (read from the source via
 * POST /rest/api/3/workflows). For a cloud->cloud literal copy we keep `ruleKey` VERBATIM and
 * only translate IDs inside `parameters`:
 *   - custom field IDs (customfield_NNN) EVERYWHERE: plain params, CSV params, the stringified
 *     JMWE `config` JSON, and nunjucks templates (issue.fields.customfield_NNN -> ["Name"]);
 *   - structural entity IDs (statuses/screens/roles/...) inside `config` and top-level params.
 * ScriptRunner rules are skipped entirely. Per-rule `id` is stripped (target regenerates).
 */

const { translateConfigFieldIds } = require("./configFieldTranslator");
const { remapEmbeddedIdsInConfig, remapEmbeddedIdsInValue } = require("./workflowTransformer");

const SCRIPTRUNNER_RE = /onresolve|groovyrunner/i;
// "Email This Issue" (ETI) by META-INF/Appfire. Unlike JMWE (fully inline config), ETI stores
// saved email templates in its OWN app backend, referenced from the workflow rule by a numeric
// `emailTemplate` id. That id is instance-specific and does NOT transfer via the workflow API,
// so a template-based ETI rule clones structurally but its body won't resolve on the target
// unless the template exists there. We translate field refs (handled by the generic passes),
// optionally remap the template id via an operator map, and report every ETI rule.
const ETI_APPKEY_RE = /metainf\.jira\.plugin\.emailissue/i;

function isScriptRunnerRule(rule) {
  if (!rule) return false;
  const key = rule.ruleKey || "";
  const appKey = (rule.parameters && rule.parameters.appKey) || "";
  return SCRIPTRUNNER_RE.test(key) || SCRIPTRUNNER_RE.test(appKey);
}

function isEtiRule(rule) {
  const appKey = (rule && rule.parameters && rule.parameters.appKey) || "";
  return ETI_APPKEY_RE.test(appKey);
}

/**
 * ETI-specific handling on an already-field-translated rule: remap the saved-template id
 * (`config.emailTemplate`) via ctx.etiTemplateMap when provided, and record a report entry so the
 * operator can see exactly which ETI templates each rule needs on the target. Mutates out.parameters.config.
 */
function handleEti(out, ctx) {
  if (!out || typeof (out.parameters || {}).config !== "string") return;
  let cfg;
  try { cfg = JSON.parse(out.parameters.config); } catch { return; }

  const srcTemplate = cfg.emailTemplate;
  const templateBased = !!srcTemplate && srcTemplate !== 0;
  const map = ctx.etiTemplateMap || {};
  let mappedTemplate = null;
  if (templateBased && Object.prototype.hasOwnProperty.call(map, String(srcTemplate))) {
    mappedTemplate = map[String(srcTemplate)];
    cfg.emailTemplate = mappedTemplate;
    out.parameters.config = JSON.stringify(cfg);
  } else if (templateBased) {
    (ctx.warnings || []).push(
      `ETI rule references saved email template ${srcTemplate} which has no target mapping — ` +
      `the email body will not resolve on the target unless that template exists there ` +
      `(provision it in Email This Issue, then add a cc_eti_template_map.json entry).`,
    );
  }

  if (ctx.etiReport) {
    ctx.etiReport.push({
      workflowName: ctx.location && ctx.location.workflowName,
      transitionName: ctx.location && ctx.location.transitionName,
      name: cfg.name,
      mode: templateBased ? "saved-template" : "inline-body",
      sourceTemplateId: templateBased ? srcTemplate : null,
      mappedTemplateId: mappedTemplate,
      needsTargetTemplate: templateBased && mappedTemplate == null,
      recipients: {
        to: cfg.emailIssueTo || "",
        cc: cfg.emailIssueCc || "",
        bcc: cfg.emailIssueBcc || "",
      },
    });
  }
}

function clone(o) {
  return o == null ? o : JSON.parse(JSON.stringify(o));
}

/**
 * Transform one new-format rule. Returns { ruleKey, parameters } with translated IDs and no
 * `id`, or null if the rule is ScriptRunner (recorded in ctx.skipped) and should be dropped.
 *
 * @param {object} rule  { ruleKey, parameters, id }
 * @param {object} ctx   { fieldRemapping, cloudFieldNames, idRemapping, warnings, skipped, location }
 */
function transformRule(rule, ctx) {
  if (isScriptRunnerRule(rule)) {
    ctx.skipped.push({ ...ctx.location, ruleKey: rule.ruleKey });
    return null;
  }

  // Copy the rule VERBATIM (ruleKey, rule-level id, and parameters — including parameters.id),
  // then translate only the IDs inside parameters. Connect/JMWE rules REQUIRE parameters.id —
  // stripping it makes /workflows/update/validation 500. The source's ids validate fine on the
  // target (verified), so a literal copy keeps them.
  const out = clone(rule);
  let params = out.parameters || {};

  // 1. Field-ID translation across EVERY string (incl. the stringified `config` blob and
  //    nunjucks bodies). Pure ID swap: customfield_<src> -> customfield_<tgt> wherever it
  //    appears — `issue.fields.customfield_NNN` in nunjucks, CSV params, JSON config —
  //    preserving the source expression structure. Non-destructive (returns a new tree).
  params = translateConfigFieldIds(params, ctx.fieldRemapping || {});

  // 2. Structural entity-ID remap INSIDE the stringified JMWE config (parse -> walk -> serialize).
  if (typeof params.config === "string") {
    params.config = remapEmbeddedIdsInValue(params.config, ctx.idRemapping || {}, ctx.warnings || []);
  }

  // 3. Structural entity-ID remap on the top-level parameters object (statusId, screenId, roleId…).
  remapEmbeddedIdsInConfig(params, ctx.idRemapping || {}, ctx.warnings || []);

  out.parameters = params;

  // 4. ETI ("Email This Issue") app-specific: remap saved-template id + report.
  if (isEtiRule(out)) handleEti(out, ctx);

  return out;
}

/**
 * Transform a new-format conditions tree. Leaves are `{ ruleKey, parameters }`; groups are
 * `{ operation, conditionGroups[], conditions[] }`. Drops ScriptRunner leaves and prunes any
 * group left empty. Returns the transformed node, or null if the whole node is now empty.
 */
function transformConditionsTree(node, ctx) {
  if (!node) return null;
  if (node.ruleKey) return transformRule(node, ctx); // leaf (may be null)

  const conditions = [];
  for (const c of node.conditions || []) {
    const t = transformConditionsTree(c, ctx);
    if (t) conditions.push(t);
  }
  const conditionGroups = [];
  for (const g of node.conditionGroups || []) {
    const t = transformConditionsTree(g, ctx);
    if (t) conditionGroups.push(t);
  }
  if (conditions.length === 0 && conditionGroups.length === 0) return null;
  return { operation: node.operation || "ALL", conditionGroups, conditions };
}

/**
 * Produce the translated rule set for one transition: { conditions?, validators, actions }.
 * `conditions` is omitted when the source transition had none (or all were dropped).
 */
function transformTransitionRules(sourceTransition, ctx) {
  const out = {};

  // Omit `conditions` entirely when there are none. The read response omits the key for
  // rule-less transitions, and INITIAL transitions REJECT any conditions object (even empty)
  // with CONDITIONS_UNSUPPORTED_ON_INITIAL_TRANSITION. `conditions` is null here when empty;
  // the applier deletes the key on the target transition in that case.
  out.conditions = transformConditionsTree(sourceTransition.conditions, ctx);

  out.validators = [];
  for (const v of sourceTransition.validators || []) {
    const t = transformRule(v, ctx);
    if (t) out.validators.push(t);
  }

  out.actions = [];
  for (const a of sourceTransition.actions || []) {
    const t = transformRule(a, ctx);
    if (t) out.actions.push(t);
  }

  return out;
}

module.exports = {
  transformRule,
  transformConditionsTree,
  transformTransitionRules,
  isScriptRunnerRule,
  isEtiRule,
};
