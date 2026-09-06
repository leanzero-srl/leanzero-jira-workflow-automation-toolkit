/**
 * Build a single XLSX workbook that surfaces every artifact a human operator
 * needs to review after a `--apply` run. Created at the END of `JsuApplier.run()`.
 *
 * The workbook is the operator's one-stop checklist: every category that
 * "needs manual attention" lives on its own filtered sheet so a triage pass
 * is a tab-by-tab walkthrough rather than archeology across a dozen JSON
 * files. The Summary tab links the others by row counts.
 *
 * Sheets (created only if non-empty, except Summary + Run Info, which always
 * render):
 *
 *   1. Summary                     — counts per category + apply mode
 *   2. Run Info                    — apply-run metadata (timestamps, flags,
 *                                     dedup contract reminder, per-workflow
 *                                     live-snapshot stamps)
 *   3. Manual Review (Plan)        — plan rows with strategy=manual-review
 *   4. Mapper Failed               — strategy ∈ {native, jmwe} but mapper
 *                                     returned null (unresolved fields, no
 *                                     mapper, etc.)
 *   5. Unresolved Cloud Transition — DC plan rows whose Cloud transition
 *                                     could not be matched (rules effectively
 *                                     dropped)
 *   6. Workflows Missing on Cloud  — workflows in plan that don't exist on
 *                                     Cloud target
 *   7. Workflow Apply Status       — per-workflow status (applied,
 *                                     blocked_by_validation, error, ...)
 *   8. Validation Errors           — ERROR-level entries from per-workflow
 *                                     validation responses
 *   9. Validation Warnings         — WARNING-level entries (informational)
 *  10. Field Catalog Gaps          — DC customfields with no Cloud match
 *  11. Status Catalog Gaps         — DC statuses with no Cloud match
 *  12. Disabled Connect Rules      — Connect rules left disabled in payloads
 *                                     (Groovy translation incomplete; need
 *                                     human edit)
 *  13. Unknown JSU shortNames      — JSU types not in the catalog (auto
 *                                     manual-review until catalog updated)
 *  14. Already on Cloud (Dedup Audit) — rules deduped against the live
 *                                     pre-snapshot. NOT a manual-review
 *                                     concern; included for transparency.
 *  15. Duplicate Plan Rows        — multiple plan rows producing the same
 *                                     converted rule (in-run dedup).
 *
 * The workbook never throws on missing artifacts — every read is defensive.
 * Failure to write should not block the apply run.
 */

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const { timestampSlug, safeFilename } = require("./utils");

// === styling helpers =====================================================

const HEADER_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F2937" }, // slate-800
};
const HEADER_FONT = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
const HEADER_BORDER = {
  bottom: { style: "thin", color: { argb: "FF111827" } },
};

const SECTION_TITLE_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF111827" },
};
const SECTION_TITLE_FONT = { bold: true, color: { argb: "FFFFFFFF" }, size: 13 };

const SUMMARY_OK_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFD1FAE5" }, // emerald-100
};
const SUMMARY_WARN_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFEF3C7" }, // amber-100
};
const SUMMARY_BAD_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFEE2E2" }, // rose-100
};

function applyHeaderRow(sheet, columns) {
  sheet.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width || 24,
  }));
  const header = sheet.getRow(1);
  header.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.border = HEADER_BORDER;
    cell.alignment = { vertical: "middle", horizontal: "left", wrapText: false };
  });
  header.height = 22;
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  if (columns.length > 0) {
    const lastCol = String.fromCharCode(64 + columns.length); // A..Z (sheets stay <26 cols)
    if (columns.length <= 26) {
      sheet.autoFilter = `A1:${lastCol}1`;
    }
  }
}

/**
 * Add a "section divider" row inside an otherwise homogeneous sheet (used by
 * the Summary tab to visually group counters).
 */
function addSectionDividerRow(sheet, label, colSpan) {
  const row = sheet.addRow([label]);
  row.font = SECTION_TITLE_FONT;
  row.fill = SECTION_TITLE_FILL;
  row.height = 22;
  row.alignment = { vertical: "middle", horizontal: "left" };
  // Merge across all data columns for visual continuity.
  if (colSpan > 1) {
    sheet.mergeCells(row.number, 1, row.number, colSpan);
  }
  // Force the merged region to inherit the fill so stripes look clean.
  for (let c = 1; c <= colSpan; c++) {
    const cell = row.getCell(c);
    cell.fill = SECTION_TITLE_FILL;
    cell.font = SECTION_TITLE_FONT;
  }
}

// === artifact readers ====================================================

function safeReadJson(p, fallback = null) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, "utf8");
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function listFilesByPrefix(dir, prefix) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Recursively walk a Cloud workflow's transitions and yield Connect rules
 * that are still disabled OR carry blocking `problems[]` markers — i.e. JMWE
 * rules left disabled by CMA where our apply-time translator wasn't able to
 * fully convert the Groovy to Nunjucks/Jira-Expression.
 */
function collectDisabledConnectRules(workflow, workflowName) {
  const out = [];
  if (!workflow || !Array.isArray(workflow.transitions)) return out;
  const isConnect = (r) => typeof (r && r.ruleKey) === "string" && r.ruleKey.startsWith("connect:");
  const isDisabled = (r) => {
    const d = (r.parameters || {}).disabled;
    return d === true || d === "true";
  };
  const moduleOf = (r) => {
    const ak = (r.parameters || {}).appKey || r.ruleKey.slice("connect:".length);
    return ak.includes("__") ? ak.slice(ak.lastIndexOf("__") + 2) : ak;
  };
  const collectFromArray = (arr, ruleCategory, transitionName, transitionId) => {
    if (!Array.isArray(arr)) return;
    for (const r of arr) {
      if (!isConnect(r)) continue;
      const cfgStr = (r.parameters && (r.parameters.config || r.parameters.value)) || "";
      let problems = [];
      try {
        const cfg = JSON.parse(cfgStr);
        if (cfg && Array.isArray(cfg.problems)) problems = cfg.problems;
      } catch {
        // Unparseable config — fall through with no problems[] info.
      }
      const blockingProblemTypes = problems.filter((p) =>
        p &&
        typeof p.type === "string" &&
        (p.type === "GroovyScriptToNunjucks" ||
          p.type === "GroovyTemplateToNunjucks" ||
          p.type === "GroovyScriptToJiraExpression"),
      );
      if (isDisabled(r) || blockingProblemTypes.length > 0) {
        out.push({
          workflowName,
          transitionName: transitionName || "(unnamed)",
          transitionId: transitionId == null ? "" : String(transitionId),
          ruleCategory,
          ruleKey: r.ruleKey,
          appKey: (r.parameters || {}).appKey || "",
          module: moduleOf(r),
          disabled: isDisabled(r),
          problemTypes: blockingProblemTypes.map((p) => p.type).join(", "),
          problemLocations: blockingProblemTypes
            .flatMap((p) => (Array.isArray(p.location) ? p.location : []))
            .join(", "),
          tag: (r.parameters || {}).tag || "",
        });
      }
    }
  };
  const walkConditions = (node, transitionName, transitionId) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.conditions)) {
      collectFromArray(node.conditions, "condition", transitionName, transitionId);
    }
    for (const child of node.conditionGroups || []) walkConditions(child, transitionName, transitionId);
  };
  for (const t of workflow.transitions) {
    if (!t) continue;
    collectFromArray(t.actions, "postFunction", t.name, t.id);
    collectFromArray(t.validators, "validator", t.name, t.id);
    if (t.conditions) walkConditions(t.conditions, t.name, t.id);
  }
  return out;
}

/**
 * Walk a validation response object and pull each ERROR/WARNING entry out as
 * a flat row. The validation API mixes shapes between versions; cover the
 * top-level `errors[]` array, the per-rule `ruleUpdateErrors`, and the
 * `updateResults[].errors` form.
 */
function flattenValidationEntries(workflowName, validation) {
  const rows = [];
  if (!validation || typeof validation !== "object") return rows;
  if (validation._error) {
    rows.push({
      workflowName,
      level: "ERROR",
      code: "VALIDATION_REQUEST_FAILED",
      message: validation._error,
      ruleId: "",
      transitionId: "",
      path: "",
    });
  }
  const pushEntry = (e, levelDefault = "ERROR") => {
    if (!e) return;
    const level = (e.level || levelDefault).toUpperCase();
    rows.push({
      workflowName,
      level,
      code: e.code || e.errorCode || "",
      message: e.message || e.errorMessage || (e.text || ""),
      ruleId: (e.elementReference && e.elementReference.ruleId) || e.ruleId || "",
      transitionId:
        (e.elementReference && (e.elementReference.transitionId || e.elementReference.transitionReference)) ||
        e.transitionId ||
        "",
      path: e.path || (e.elementReference && e.elementReference.path) || "",
    });
  };
  if (Array.isArray(validation.errors)) {
    for (const e of validation.errors) pushEntry(e);
  }
  if (Array.isArray(validation.errorMessages)) {
    for (const m of validation.errorMessages) {
      pushEntry({ level: "ERROR", message: m });
    }
  }
  if (validation.ruleUpdateErrors && typeof validation.ruleUpdateErrors === "object") {
    for (const [ruleId, msgs] of Object.entries(validation.ruleUpdateErrors)) {
      const arr = Array.isArray(msgs) ? msgs : [msgs];
      for (const m of arr) pushEntry({ level: "ERROR", message: String(m), ruleId });
    }
  }
  const results = validation.updateResults || validation.validationResults;
  if (Array.isArray(results)) {
    for (const r of results) {
      if (Array.isArray(r.errors)) for (const e of r.errors) pushEntry(e);
      if (Array.isArray(r.warnings)) for (const e of r.warnings) pushEntry(e, "WARNING");
      if (r.ruleUpdateErrors && typeof r.ruleUpdateErrors === "object") {
        for (const [ruleId, msgs] of Object.entries(r.ruleUpdateErrors)) {
          const arr = Array.isArray(msgs) ? msgs : [msgs];
          for (const m of arr) pushEntry({ level: "ERROR", message: String(m), ruleId });
        }
      }
    }
  }
  return rows;
}

function summarizeConfiguration(cfg) {
  if (!cfg || typeof cfg !== "object") return "";
  // Compact preview for the Excel cell. Cap length so the row stays usable.
  try {
    const s = JSON.stringify(cfg);
    return s.length > 220 ? s.slice(0, 217) + "..." : s;
  } catch {
    return String(cfg).slice(0, 220);
  }
}

// === main entry ==========================================================

async function writeManualReviewWorkbook({ collectDir, applier, report, log }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "migrate_jsu_rules_dc_to_cloud";
  wb.lastModifiedBy = "migrate_jsu_rules_dc_to_cloud";
  wb.created = new Date();
  wb.modified = new Date();
  wb.title = "JSU DC→Cloud manual-review summary";

  // ---- artifact bundle (defensive reads) ---------------------------------
  const inventory = applier.inventory || safeReadJson(path.join(collectDir, "jsu_rule_inventory.json"));
  const conversionPlan =
    applier.conversionPlan || safeReadJson(path.join(collectDir, "conversion_plan.json"));
  const metadata = safeReadJson(path.join(collectDir, "metadata.json"), {});
  const cloudTarget = safeReadJson(path.join(collectDir, "cloud_target_workflows.json"), {});
  const dcFieldNames = applier.dcFieldNames || safeReadJson(path.join(collectDir, "field_mapping.json"), {});
  const fieldRemapping =
    applier.fieldRemapping ||
    safeReadJson(path.join(collectDir, "field_remapping_resolved.json"), {});
  const dcStatusCatalog = safeReadJson(path.join(collectDir, "dc_status_catalog.json"), {});
  const statusRemapping =
    applier.statusRemapping ||
    safeReadJson(path.join(collectDir, "status_remapping_resolved.json"), {});

  const planRows = (conversionPlan && conversionPlan.rows) || [];
  const reportWorkflows = (report && report.workflows) || [];
  const unmappedRules = (report && report.unmappedRules) || [];
  const alreadyOnCloud = (report && report.alreadyOnCloud) || [];

  // ---- partition unmappedRules by reason ---------------------------------
  // The reason strings are produced by jsuApplier — keep these prefixes in
  // sync if jsuApplier's classification ever changes.
  const planManualReview = [];
  const mapperFailed = [];
  const unresolvedTransition = [];
  const duplicatePlanRows = [];
  const macroIncompatible = [];
  const statusUnresolvedRows = [];
  for (const r of unmappedRules) {
    const reason = (r && r.reason) || "";
    if (reason === "manual-review") {
      planManualReview.push(r);
    } else if (reason.startsWith("JSU runtime macro has no Cloud equivalent")) {
      macroIncompatible.push(r);
    } else if (reason.startsWith("status(es) could not be resolved")) {
      statusUnresolvedRows.push(r);
    } else if (
      reason.startsWith("field(s) could not be resolved") ||
      reason.startsWith("mapper produced no output") ||
      reason.startsWith("no native mapper") ||
      reason.startsWith("no jmwe mapper") ||
      reason.startsWith("no manual-review mapper")
    ) {
      mapperFailed.push(r);
    } else if (
      reason.startsWith("no matching Cloud transition") ||
      reason.startsWith("ambiguous") ||
      reason.startsWith("no matching ")
    ) {
      unresolvedTransition.push(r);
    } else if (reason.startsWith("duplicate-plan-row")) {
      duplicatePlanRows.push(r);
    } else if (reason.startsWith("idempotent-skip")) {
      // Pre-existing reason string emitted by older runs / deeper dedup
      // passes — already covered by the explicit alreadyOnCloud bucket, so
      // these legacy lines roll into the audit sheet too.
      alreadyOnCloud.push({
        ...r,
        reason: "idempotent-skip (legacy)",
      });
    } else {
      // Unknown reason — fall into mapperFailed so it stays visible.
      mapperFailed.push(r);
    }
  }

  // Workflows missing on Cloud — union of sources:
  //   * collect-time pre-check (cloud_target_workflows.json.missing)
  //   * apply-time per-workflow status === skipped_not_on_cloud
  //   * apply-time error encountered before processing
  const missingNamesSet = new Set();
  for (const n of (cloudTarget && cloudTarget.missing) || []) missingNamesSet.add(n);
  for (const w of reportWorkflows) {
    if (w && w.status === "skipped_not_on_cloud") missingNamesSet.add(w.workflowName);
  }
  const workflowsMissingOnCloud = [...missingNamesSet];

  // ---- validation entries (per-workflow) ---------------------------------
  const validationFiles = listFilesByPrefix(collectDir, "validation_");
  const validationErrors = [];
  const validationWarnings = [];
  for (const f of validationFiles) {
    const v = safeReadJson(f);
    if (!v) continue;
    // Workflow name embedded in filename: validation_<safeFilename>.json.
    // Best-effort recovery — use the basename stem with the prefix stripped.
    const stem = path.basename(f, ".json").replace(/^validation_/, "");
    const wfName = (() => {
      // Try to map back to a workflow name we've seen in the report.
      for (const w of reportWorkflows) {
        if (safeFilename(w.workflowName) === stem) return w.workflowName;
      }
      return stem;
    })();
    for (const e of flattenValidationEntries(wfName, v)) {
      if (e.level === "WARNING") validationWarnings.push(e);
      else validationErrors.push(e);
    }
  }

  // ---- field & status catalog gaps --------------------------------------
  const fieldGaps = [];
  // dcFieldNames: {dcId: dcName | null}. null means: referenced by JSU rules
  // but couldn't be resolved to a DC name. Either the DC catalog wasn't
  // available at collect-time, or the DC field has been deleted.
  for (const [dcId, dcName] of Object.entries(dcFieldNames || {})) {
    if (!dcName) {
      fieldGaps.push({
        dcId,
        dcName: "",
        cloudId: "",
        reason:
          "no DC name resolved (DC catalog unavailable at collect, or field deleted on DC)",
      });
      continue;
    }
    const cloudId = (fieldRemapping || {})[dcId];
    if (!cloudId) {
      fieldGaps.push({
        dcId,
        dcName,
        cloudId: "",
        reason: "no Cloud field with this name (rule referencing it likely failed to map)",
      });
    }
  }
  const statusGaps = [];
  for (const [dcId, dcName] of Object.entries(dcStatusCatalog || {})) {
    if (!Object.prototype.hasOwnProperty.call(statusRemapping || {}, dcId)) {
      // Many DC statuses aren't referenced at all — only flag when a rule
      // currently in the plan uses this status. Heuristic: scan plan rows'
      // configurations for the DC status id. (Skipped here for performance —
      // include all unresolved statuses and let the operator filter.)
      statusGaps.push({
        dcId,
        dcName,
        reason: "no Cloud status with this name (only matters if a JSU rule references it)",
      });
    } else if (!(statusRemapping || {})[dcId]) {
      statusGaps.push({
        dcId,
        dcName,
        reason: "Cloud match attempted, returned empty",
      });
    }
  }

  // ---- disabled connect rules in update payloads -------------------------
  const disabledConnectRules = [];
  for (const w of reportWorkflows) {
    if (!w || !w.workflowName) continue;
    const safe = safeFilename(w.workflowName);
    const payload = safeReadJson(path.join(collectDir, `update_payload_${safe}.json`));
    if (!payload || !Array.isArray(payload.workflows)) continue;
    for (const wf of payload.workflows) {
      // The payload omits `name`; re-attach for context in the sheet.
      const annotated = { ...wf, name: w.workflowName };
      disabledConnectRules.push(...collectDisabledConnectRules(annotated, w.workflowName));
    }
  }

  // ---- unknown JSU shortNames -------------------------------------------
  const unknownShortNames = (inventory && inventory.stats && inventory.stats.unknownShortNames) || [];

  // ---- plan strategy distribution (for Summary) -------------------------
  const planStratCounts = {
    native: 0,
    jmwe: 0,
    skip: 0,
    "manual-review": 0,
  };
  for (const r of planRows) {
    const s = r.strategy || r.defaultStrategy || "manual-review";
    if (planStratCounts[s] === undefined) planStratCounts[s] = 0;
    planStratCounts[s] += 1;
  }

  // ---- per-workflow status summary --------------------------------------
  const statusCounts = {};
  let totalAppended = 0;
  for (const w of reportWorkflows) {
    const s = w.status || "unknown";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
    if (Array.isArray(w.appended)) totalAppended += w.appended.length;
  }

  // === SHEET 1: Summary ==================================================
  {
    const sheet = wb.addWorksheet("Summary", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    applyHeaderRow(sheet, [
      { header: "Category", key: "category", width: 52 },
      { header: "Count", key: "count", width: 12 },
      { header: "Action", key: "action", width: 80 },
    ]);

    const addRow = (category, count, action, severity) => {
      const row = sheet.addRow({ category, count, action });
      row.alignment = { vertical: "middle", wrapText: true };
      const fill =
        severity === "ok"
          ? SUMMARY_OK_FILL
          : severity === "warn"
          ? SUMMARY_WARN_FILL
          : severity === "bad"
          ? SUMMARY_BAD_FILL
          : null;
      if (fill) {
        row.eachCell((cell) => {
          cell.fill = fill;
        });
      }
    };

    addSectionDividerRow(sheet, "Run", 3);
    addRow(
      "Apply mode",
      "",
      report.validateOnly ? "validate-only" : report.dryRun ? "dry-run" : "apply",
      "ok",
    );
    addRow("Cloud base URL", "", report.cloudBaseUrl || "", "ok");
    addRow("Apply generated at", "", report.generatedAt || "", "ok");
    addRow("Workflows processed", reportWorkflows.length, "", "ok");
    addRow("Workflows applied successfully", statusCounts.applied || 0, "", statusCounts.applied ? "ok" : "warn");
    addRow(
      "Workflows blocked / errored / skipped",
      (statusCounts.error || 0) +
        (statusCounts.blocked_by_validation || 0) +
        (statusCounts.skipped_not_on_cloud || 0),
      "See 'Workflow Apply Status' tab",
      (statusCounts.error || 0) +
        (statusCounts.blocked_by_validation || 0) +
        (statusCounts.skipped_not_on_cloud || 0) >
        0
        ? "bad"
        : "ok",
    );
    addRow("Total rules appended", totalAppended, "", "ok");

    addSectionDividerRow(sheet, "Plan distribution", 3);
    addRow("Plan rows: native strategy", planStratCounts.native || 0, "", "ok");
    addRow("Plan rows: jmwe strategy", planStratCounts.jmwe || 0, "", "ok");
    addRow("Plan rows: skip strategy", planStratCounts.skip || 0, "", "ok");
    addRow(
      "Plan rows: manual-review strategy",
      planStratCounts["manual-review"] || 0,
      "Convert each manually in Cloud (see 'Manual Review (Plan)' tab)",
      planStratCounts["manual-review"] > 0 ? "warn" : "ok",
    );

    addSectionDividerRow(sheet, "Manual attention required", 3);
    addRow(
      "Manual-review (plan strategy)",
      planManualReview.length,
      "Operator must convert each in Cloud UI",
      planManualReview.length > 0 ? "warn" : "ok",
    );
    addRow(
      "Mapper failed (unresolved fields / no mapper)",
      mapperFailed.length,
      "Inspect each in 'Mapper Failed' tab",
      mapperFailed.length > 0 ? "bad" : "ok",
    );
    addRow(
      "JSU runtime macros (Cloud-incompatible)",
      macroIncompatible.length,
      "JSU %%macros%% have no Cloud native equivalent — re-author each as JMWE/automation. See 'JSU Macros' tab.",
      macroIncompatible.length > 0 ? "warn" : "ok",
    );
    addRow(
      "Status references unresolved",
      statusUnresolvedRows.length,
      "DC status IDs in rule config didn't resolve on Cloud — see 'Unresolved Statuses' tab",
      statusUnresolvedRows.length > 0 ? "warn" : "ok",
    );
    addRow(
      "Unresolved Cloud transition",
      unresolvedTransition.length,
      "Plan row had no Cloud transition match — rule effectively dropped",
      unresolvedTransition.length > 0 ? "bad" : "ok",
    );
    addRow(
      "Workflows missing on Cloud",
      workflowsMissingOnCloud.length,
      "Plan workflows not present on Cloud target",
      workflowsMissingOnCloud.length > 0 ? "bad" : "ok",
    );
    addRow(
      "Validation errors (entries)",
      validationErrors.length,
      "ERROR-level validation entries — block apply if --ignore-errors not set",
      validationErrors.length > 0 ? "bad" : "ok",
    );
    addRow(
      "Validation warnings (entries)",
      validationWarnings.length,
      "Advisory; review in 'Validation Warnings' tab",
      validationWarnings.length > 0 ? "warn" : "ok",
    );
    addRow(
      "Field catalog gaps",
      fieldGaps.length,
      "DC field has no Cloud equivalent by name — rules referencing it can't migrate",
      fieldGaps.length > 0 ? "warn" : "ok",
    );
    addRow(
      "Status catalog gaps",
      statusGaps.length,
      "DC status has no Cloud equivalent by name (matters only if a rule references it)",
      statusGaps.length > 0 ? "warn" : "ok",
    );
    addRow(
      "Disabled Connect rules in payload",
      disabledConnectRules.length,
      "Groovy translation incomplete — translate manually in Cloud UI",
      disabledConnectRules.length > 0 ? "warn" : "ok",
    );
    addRow(
      "Unknown JSU shortNames",
      unknownShortNames.length,
      "JSU types not in catalog — extend src/jsuRuleCatalog.js + add a mapper",
      unknownShortNames.length > 0 ? "warn" : "ok",
    );

    addSectionDividerRow(sheet, "Dedup audit (informational, not manual-review)", 3);
    addRow(
      "Already on Cloud (dedup-skipped)",
      alreadyOnCloud.length,
      "Live snapshot proved these were already on Cloud — appending skipped",
      "ok",
    );
    addRow(
      "Duplicate plan rows (in-run dedup)",
      duplicatePlanRows.length,
      "Multiple plan rows produced the same converted rule — collapsed to one",
      "ok",
    );
  }

  // === SHEET 2: Run Info =================================================
  {
    const sheet = wb.addWorksheet("Run Info", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    applyHeaderRow(sheet, [
      { header: "Field", key: "field", width: 36 },
      { header: "Value", key: "value", width: 96 },
    ]);
    sheet.addRow({ field: "Apply generated at", value: report.generatedAt || "" });
    sheet.addRow({ field: "Cloud base URL", value: report.cloudBaseUrl || "" });
    sheet.addRow({ field: "Mode", value: report.validateOnly ? "validate-only" : report.dryRun ? "dry-run" : "apply" });
    sheet.addRow({ field: "force flag", value: String(!!report.force) });
    sheet.addRow({ field: "Collect dir", value: collectDir });
    sheet.addRow({ field: "Plan generated at", value: (metadata && metadata.generatedAt) || "" });
    sheet.addRow({ field: "Source", value: (metadata && metadata.source) || "" });
    sheet.addRow({ field: "DC workflow count", value: (metadata && metadata.dcWorkflowCount) || 0 });
    sheet.addRow({
      field: "Cloud workflows found at collect",
      value: (metadata && metadata.cloudWorkflowsFound) || 0,
    });
    sheet.addRow({
      field: "Cloud target check 'checkedAt'",
      value: (cloudTarget && cloudTarget.checkedAt) || "(unknown — pre-freshness change)",
    });
    sheet.addRow({});

    sheet.addRow({ field: "DEDUP CONTRACT", value: "" });
    const contract = sheet.lastRow;
    contract.font = { bold: true };
    sheet.addRow({
      field: "",
      value:
        "Apply re-fetches every Cloud workflow live and snapshots fingerprints BEFORE any mutation. " +
        "Plan rows whose converted rule is already in the live snapshot are classified as " +
        "'already-on-cloud' and never appended. Re-runs converge instead of duplicate. " +
        "The collect-time cloud_target_workflows.json is informational only and is never " +
        "consulted at apply time for dedup decisions.",
    });
    const note = sheet.lastRow;
    note.alignment = { wrapText: true, vertical: "top" };
    note.height = 90;
    sheet.addRow({});

    // Per-workflow live snapshot timestamps
    sheet.addRow({ field: "Per-workflow live snapshot taken at", value: "" });
    sheet.lastRow.font = { bold: true };
    for (const w of reportWorkflows) {
      sheet.addRow({
        field: w.workflowName,
        value: w.liveSnapshotAt || "(no snapshot recorded — workflow not on Cloud or processing aborted)",
      });
    }
  }

  // === SHEET 3: Manual Review (Plan) =====================================
  if (planManualReview.length > 0) {
    const sheet = wb.addWorksheet("Manual Review (Plan)");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 38 },
      { header: "Transition", key: "transitionName", width: 28 },
      { header: "Category", key: "ruleCategory", width: 14 },
      { header: "DC Type", key: "dcType", width: 60 },
      { header: "Display Code", key: "shortName", width: 30 },
      { header: "Default Strategy", key: "defaultStrategy", width: 16 },
      { header: "Strategy", key: "strategy", width: 14 },
      { header: "Confidence", key: "confidence", width: 12 },
      { header: "Notes", key: "notes", width: 60 },
      { header: "Configuration (preview)", key: "config", width: 60 },
    ]);
    for (const r of planManualReview) {
      sheet.addRow({
        workflowName: r.workflowName,
        transitionName: r.transitionName || "",
        ruleCategory: r.ruleCategory || "",
        dcType: r.dcType || "",
        shortName: r.shortName || "",
        defaultStrategy: r.defaultStrategy || "",
        strategy: r.strategy || "",
        confidence: r.confidence || "",
        notes: r.notes || "",
        config: summarizeConfiguration(r.configuration),
      });
    }
  }

  // === SHEET 4: Mapper Failed ============================================
  if (mapperFailed.length > 0) {
    const sheet = wb.addWorksheet("Mapper Failed");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 38 },
      { header: "Transition", key: "transitionName", width: 28 },
      { header: "Category", key: "ruleCategory", width: 14 },
      { header: "DC Type", key: "dcType", width: 60 },
      { header: "Display Code", key: "shortName", width: 30 },
      { header: "Strategy", key: "strategy", width: 14 },
      { header: "Reason", key: "reason", width: 70 },
      { header: "Configuration (preview)", key: "config", width: 60 },
    ]);
    for (const r of mapperFailed) {
      sheet.addRow({
        workflowName: r.workflowName,
        transitionName: r.transitionName || "",
        ruleCategory: r.ruleCategory || "",
        dcType: r.dcType || "",
        shortName: r.shortName || "",
        strategy: r.strategy || "",
        reason: r.reason || "",
        config: summarizeConfiguration(r.configuration),
      });
    }
  }

  // === SHEET 4b: JSU Macros (Cloud-incompatible) =========================
  if (macroIncompatible.length > 0) {
    const sheet = wb.addWorksheet("JSU Macros");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 38 },
      { header: "Transition", key: "transitionName", width: 28 },
      { header: "Category", key: "ruleCategory", width: 14 },
      { header: "DC Type", key: "dcType", width: 60 },
      { header: "Display Code", key: "shortName", width: 30 },
      { header: "Macro(s)", key: "macros", width: 40 },
      { header: "Reason", key: "reason", width: 80 },
    ]);
    for (const r of macroIncompatible) {
      // Strip the verbose remediation suffix from the reason for the table
      // cell — the full text is still in the workbook in the DC config column.
      const macros = (r.reason || "")
        .replace(/^JSU runtime macro has no Cloud equivalent: /, "")
        .replace(/\. Replace this rule manually.*$/, "");
      sheet.addRow({
        workflowName: r.workflowName,
        transitionName: r.transitionName || "",
        ruleCategory: r.ruleCategory || "",
        dcType: r.dcType || "",
        shortName: r.shortName || "",
        macros,
        reason: r.reason || "",
      });
    }
  }

  // === SHEET 4c: Unresolved Statuses =====================================
  if (statusUnresolvedRows.length > 0) {
    const sheet = wb.addWorksheet("Unresolved Statuses");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 38 },
      { header: "Transition", key: "transitionName", width: 28 },
      { header: "Category", key: "ruleCategory", width: 14 },
      { header: "Display Code", key: "shortName", width: 30 },
      { header: "Reason", key: "reason", width: 80 },
    ]);
    for (const r of statusUnresolvedRows) {
      sheet.addRow({
        workflowName: r.workflowName,
        transitionName: r.transitionName || "",
        ruleCategory: r.ruleCategory || "",
        shortName: r.shortName || "",
        reason: r.reason || "",
      });
    }
  }

  // === SHEET 5: Unresolved Cloud Transition ==============================
  if (unresolvedTransition.length > 0) {
    const sheet = wb.addWorksheet("Unresolved Cloud Transition");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 38 },
      { header: "DC Transition Name", key: "transitionName", width: 28 },
      { header: "DC Transition ID", key: "transitionId", width: 16 },
      { header: "From Status IDs", key: "from", width: 20 },
      { header: "To Status ID", key: "to", width: 14 },
      { header: "Type", key: "type", width: 14 },
      { header: "Reason", key: "reason", width: 70 },
    ]);
    for (const r of unresolvedTransition) {
      sheet.addRow({
        workflowName: r.workflowName,
        transitionName: r.transitionName || "",
        transitionId: r.transitionId || "",
        from: Array.isArray(r.transitionFromStatusIds) ? r.transitionFromStatusIds.join(", ") : "",
        to: r.transitionToStatusId || "",
        type: r.transitionType || "",
        reason: r.reason || "",
      });
    }
  }

  // === SHEET 6: Workflows Missing on Cloud ===============================
  if (workflowsMissingOnCloud.length > 0) {
    const sheet = wb.addWorksheet("Workflows Missing on Cloud");
    applyHeaderRow(sheet, [
      { header: "Workflow Name", key: "workflowName", width: 60 },
      { header: "Source", key: "source", width: 50 },
      { header: "Notes", key: "notes", width: 60 },
    ]);
    const collectMissing = new Set((cloudTarget && cloudTarget.missing) || []);
    for (const name of workflowsMissingOnCloud) {
      const sources = [];
      if (collectMissing.has(name)) sources.push("collect-time pre-check");
      if (reportWorkflows.find((w) => w.workflowName === name && w.status === "skipped_not_on_cloud")) {
        sources.push("apply-time fetch");
      }
      sheet.addRow({
        workflowName: name,
        source: sources.join("; ") || "(unknown)",
        notes: "Either rename Cloud workflow to match, or set workflowNameOverrides in config.json",
      });
    }
  }

  // === SHEET 7: Workflow Apply Status ====================================
  {
    const sheet = wb.addWorksheet("Workflow Apply Status");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 50 },
      { header: "Status", key: "status", width: 22 },
      { header: "Appended", key: "appended", width: 12 },
      { header: "Already on Cloud", key: "dedup", width: 18 },
      { header: "Manual Review", key: "manualReview", width: 16 },
      { header: "Mapper Failed", key: "mapperFailed", width: 16 },
      { header: "Live snapshot at", key: "liveSnapshotAt", width: 26 },
      { header: "Error", key: "error", width: 60 },
    ]);
    for (const w of reportWorkflows) {
      const wfRows = unmappedRules.filter((r) => r.workflowName === w.workflowName);
      const wfManual = wfRows.filter((r) => (r.reason || "") === "manual-review").length;
      const wfFailed = wfRows.filter((r) => {
        const reason = r.reason || "";
        return (
          reason.startsWith("field(s) could not be resolved") ||
          reason.startsWith("mapper produced no output") ||
          reason.startsWith("no native mapper") ||
          reason.startsWith("no jmwe mapper")
        );
      }).length;
      const wfDedup = alreadyOnCloud.filter((r) => r.workflowName === w.workflowName).length;
      const row = sheet.addRow({
        workflowName: w.workflowName,
        status: w.status || "",
        appended: Array.isArray(w.appended) ? w.appended.length : 0,
        dedup: wfDedup,
        manualReview: wfManual,
        mapperFailed: wfFailed,
        liveSnapshotAt: w.liveSnapshotAt || "",
        error: w.error || "",
      });
      const fillByStatus = {
        applied: SUMMARY_OK_FILL,
        validated: SUMMARY_OK_FILL,
        dry_run: SUMMARY_OK_FILL,
        skipped_not_on_cloud: SUMMARY_BAD_FILL,
        blocked_by_validation: SUMMARY_BAD_FILL,
        error: SUMMARY_BAD_FILL,
      };
      const fill = fillByStatus[w.status];
      if (fill) row.eachCell((c) => (c.fill = fill));
    }
  }

  // === SHEET 8: Validation Errors ========================================
  if (validationErrors.length > 0) {
    const sheet = wb.addWorksheet("Validation Errors");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 50 },
      { header: "Level", key: "level", width: 10 },
      { header: "Code", key: "code", width: 30 },
      { header: "Rule ID", key: "ruleId", width: 40 },
      { header: "Transition ID", key: "transitionId", width: 16 },
      { header: "Path", key: "path", width: 30 },
      { header: "Message", key: "message", width: 80 },
    ]);
    for (const e of validationErrors) sheet.addRow(e);
  }

  // === SHEET 9: Validation Warnings ======================================
  if (validationWarnings.length > 0) {
    const sheet = wb.addWorksheet("Validation Warnings");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 50 },
      { header: "Level", key: "level", width: 10 },
      { header: "Code", key: "code", width: 30 },
      { header: "Rule ID", key: "ruleId", width: 40 },
      { header: "Transition ID", key: "transitionId", width: 16 },
      { header: "Path", key: "path", width: 30 },
      { header: "Message", key: "message", width: 80 },
    ]);
    for (const e of validationWarnings) sheet.addRow(e);
  }

  // === SHEET 10: Field Catalog Gaps ======================================
  if (fieldGaps.length > 0) {
    const sheet = wb.addWorksheet("Field Catalog Gaps");
    applyHeaderRow(sheet, [
      { header: "DC Field ID", key: "dcId", width: 22 },
      { header: "DC Field Name", key: "dcName", width: 40 },
      { header: "Cloud Field ID", key: "cloudId", width: 22 },
      { header: "Reason", key: "reason", width: 80 },
    ]);
    for (const g of fieldGaps) sheet.addRow(g);
  }

  // === SHEET 11: Status Catalog Gaps =====================================
  if (statusGaps.length > 0) {
    const sheet = wb.addWorksheet("Status Catalog Gaps");
    applyHeaderRow(sheet, [
      { header: "DC Status ID", key: "dcId", width: 14 },
      { header: "DC Status Name", key: "dcName", width: 38 },
      { header: "Reason", key: "reason", width: 80 },
    ]);
    for (const g of statusGaps) sheet.addRow(g);
  }

  // === SHEET 12: Disabled Connect Rules ==================================
  if (disabledConnectRules.length > 0) {
    const sheet = wb.addWorksheet("Disabled Connect Rules");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 40 },
      { header: "Transition", key: "transitionName", width: 26 },
      { header: "Transition ID", key: "transitionId", width: 14 },
      { header: "Category", key: "ruleCategory", width: 14 },
      { header: "Module", key: "module", width: 32 },
      { header: "Rule Key", key: "ruleKey", width: 32 },
      { header: "Disabled", key: "disabled", width: 10 },
      { header: "Tag", key: "tag", width: 20 },
      { header: "Problem types", key: "problemTypes", width: 36 },
      { header: "Problem locations", key: "problemLocations", width: 36 },
    ]);
    for (const r of disabledConnectRules) sheet.addRow(r);
  }

  // === SHEET 13: Unknown JSU shortNames ==================================
  if (unknownShortNames.length > 0) {
    const sheet = wb.addWorksheet("Unknown JSU shortNames");
    applyHeaderRow(sheet, [
      { header: "Display Code", key: "shortName", width: 50 },
      { header: "Action", key: "action", width: 80 },
    ]);
    for (const n of unknownShortNames) {
      sheet.addRow({
        shortName: n,
        action:
          "Add to src/jsuRuleCatalog.js (CATALOG + JSU_DC_CLASS_TO_SHORTNAME), then write a mapper in src/jsuNativeMappers.js or src/jsuJmweMappers.js",
      });
    }
  }

  // === SHEET 14: Already on Cloud (Dedup Audit) ==========================
  if (alreadyOnCloud.length > 0) {
    const sheet = wb.addWorksheet("Already on Cloud (Dedup)");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 40 },
      { header: "Transition", key: "transitionName", width: 26 },
      { header: "Transition ID", key: "transitionId", width: 14 },
      { header: "Category", key: "ruleCategory", width: 14 },
      { header: "Display Code", key: "shortName", width: 30 },
      { header: "Cloud Rule Key", key: "ruleKey", width: 36 },
      { header: "Applied to txn ID", key: "appliedToTransitionId", width: 18 },
      { header: "Fingerprint", key: "fingerprint", width: 50 },
      { header: "Reason", key: "reason", width: 36 },
    ]);
    for (const r of alreadyOnCloud) sheet.addRow(r);
  }

  // === SHEET 15: Duplicate Plan Rows =====================================
  if (duplicatePlanRows.length > 0) {
    const sheet = wb.addWorksheet("Duplicate Plan Rows");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 40 },
      { header: "Transition", key: "transitionName", width: 26 },
      { header: "Category", key: "ruleCategory", width: 14 },
      { header: "DC Type", key: "dcType", width: 60 },
      { header: "Display Code", key: "shortName", width: 30 },
      { header: "Reason", key: "reason", width: 80 },
    ]);
    for (const r of duplicatePlanRows) sheet.addRow(r);
  }

  // ---- write ------------------------------------------------------------
  const outPath = path.join(collectDir, `manual_review_${timestampSlug()}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  if (log && typeof log.info === "function") {
    const sheetCount = wb.worksheets.length;
    log.info(`Manual-review workbook: ${sheetCount} sheet(s) -> ${outPath}`);
  }
  return outPath;
}

module.exports = writeManualReviewWorkbook;
// Named exports the sanitize workbook writer reuses so the two workbooks share
// styling + helpers (Iteration 1 of the sanitize plan). Adding helpers here
// rather than copy-paste keeps the visual language consistent — same headers,
// section dividers, and severity colors across both reports.
module.exports.HEADER_FILL = HEADER_FILL;
module.exports.HEADER_FONT = HEADER_FONT;
module.exports.HEADER_BORDER = HEADER_BORDER;
module.exports.SECTION_TITLE_FILL = SECTION_TITLE_FILL;
module.exports.SECTION_TITLE_FONT = SECTION_TITLE_FONT;
module.exports.SUMMARY_OK_FILL = SUMMARY_OK_FILL;
module.exports.SUMMARY_WARN_FILL = SUMMARY_WARN_FILL;
module.exports.SUMMARY_BAD_FILL = SUMMARY_BAD_FILL;
module.exports.applyHeaderRow = applyHeaderRow;
module.exports.addSectionDividerRow = addSectionDividerRow;
module.exports.safeReadJson = safeReadJson;
module.exports.flattenValidationEntries = flattenValidationEntries;
