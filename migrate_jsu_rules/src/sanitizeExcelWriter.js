/**
 * XLSX workbook writer for `--sanitize` runs.
 *
 * Mirrors the visual language of the manual-review workbook (same headers,
 * section dividers, severity colors) so an operator who knows one knows the
 * other. Reuses the styling constants + helpers exported by
 * `manualReviewExcelWriter.js`.
 *
 * Sheets (rendered only when non-empty, except Summary + Run Info):
 *
 *   1. Summary                       — counters per finding category
 *   2. Run Info                      — workflow filter, signature fp,
 *                                      sanitize mode (audit-only / fix /
 *                                      fix+confirm), assets workspace,
 *                                      excluded projects
 *   3. Excluded By Project Filter    — workflows skipped because they back a
 *                                      project listed in --exclude-projects
 *   4. Workflows Missing on Cloud    — plan workflows with no Cloud match
 *   5. Missing System Rules          — rules the live Cloud workflow lacks
 *                                      vs. the converted plan
 *   6. Invalid Field Refs            — customfield_NNN refs not in Cloud
 *                                      catalog
 *   7. Invalid Status Refs
 *   8. Invalid Role/Group Refs
 *   9. Invalid Permission/Account Refs
 *  10. Invalid Asset Refs            — Iteration 3 (stub renders empty)
 *  11. Asset ID Remapping Suggestions — Iteration 3 (stub renders empty)
 *  12. Matcher Diff                  — Iteration 2 (v1 vs v2 fingerprint
 *                                      drift)
 *  13. Fix Plan                      — Iteration 2.5 (preview of mutations
 *                                      that --fix --confirm would push)
 *
 * Failure to write the workbook is surfaced as a warning only — the JSON
 * report is the machine-readable source of truth.
 */

const path = require("path");
const ExcelJS = require("exceljs");

const { timestampSlug } = require("./utils");
const {
  HEADER_FILL,
  HEADER_FONT,
  SECTION_TITLE_FILL,
  SECTION_TITLE_FONT,
  SUMMARY_OK_FILL,
  SUMMARY_WARN_FILL,
  SUMMARY_BAD_FILL,
  applyHeaderRow,
  addSectionDividerRow,
} = require("./manualReviewExcelWriter");

// Avoid unused-import lints when the constants are imported only for symmetry
// with the apply workbook (the writer intentionally reuses them inline below).
void HEADER_FILL;
void HEADER_FONT;
void SECTION_TITLE_FILL;
void SECTION_TITLE_FONT;

/**
 * Render the sanitize report to disk. Always writes Summary + Run Info; every
 * other sheet only renders when it has rows so the operator's first glance
 * focuses on what actually needs attention.
 */
async function writeSanitizeWorkbook({ collectDir, report, log }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "migrate_jsu_rules_dc_to_cloud (sanitize)";
  wb.lastModifiedBy = "migrate_jsu_rules_dc_to_cloud (sanitize)";
  wb.created = new Date();
  wb.modified = new Date();
  wb.title = "JSU DC→Cloud sanitize report";

  const findings = report.findings || {};
  const missingSystemRules = findings.missingSystemRules || [];
  const invalidFieldRefs = findings.invalidFieldRefs || [];
  const invalidStatusRefs = findings.invalidStatusRefs || [];
  const invalidRoleGroupRefs = findings.invalidRoleGroupRefs || [];
  const invalidPermissionRefs = findings.invalidPermissionRefs || [];
  const invalidAccountRefs = findings.invalidAccountRefs || [];
  const invalidAssetRefs = findings.invalidAssetRefs || []; // Iteration 3
  const assetSuggestions = findings.assetSuggestions || []; // Iteration 3
  const matcherDiff = findings.matcherDiff || []; // Iteration 2
  const fixPlan = findings.fixPlan || []; // Iteration 2.5
  const excludedWorkflows = report.excludedWorkflows || [];
  const workflowsMissingOnCloud = report.workflowsMissingOnCloud || [];

  // === SHEET 1: Summary ==================================================
  {
    const sheet = wb.addWorksheet("Summary", {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    applyHeaderRow(sheet, [
      { header: "Category", key: "category", width: 60 },
      { header: "Count", key: "count", width: 10 },
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
      if (fill) row.eachCell((c) => (c.fill = fill));
    };

    addSectionDividerRow(sheet, "Run", 3);
    addRow("Mode", "", report.mode || "audit-only", "ok");
    addRow("Cloud base URL", "", report.cloudBaseUrl || "", "ok");
    addRow("Generated at", "", report.generatedAt || "", "ok");
    addRow("Workflows audited", report.workflowsAudited || 0, "", "ok");
    addRow(
      "Workflows excluded by --exclude-projects",
      excludedWorkflows.length,
      excludedWorkflows.length > 0 ? "See 'Excluded By Project Filter' tab" : "",
      "ok",
    );
    addRow(
      "Workflows missing on Cloud",
      workflowsMissingOnCloud.length,
      workflowsMissingOnCloud.length > 0
        ? "Plan workflows have no Cloud workflow with the same name"
        : "",
      workflowsMissingOnCloud.length > 0 ? "warn" : "ok",
    );

    addSectionDividerRow(sheet, "Findings — primary deliverable", 3);
    addRow(
      "Missing System Rules (over-dedup victims)",
      missingSystemRules.length,
      missingSystemRules.length > 0
        ? "Plan rows whose converted rule is absent from live Cloud — re-add via --fix --confirm"
        : "All converted rules accounted for on Cloud",
      missingSystemRules.length > 0 ? "bad" : "ok",
    );

    addSectionDividerRow(sheet, "Findings — invalid IDs", 3);
    addRow(
      "Invalid Field Refs",
      invalidFieldRefs.length,
      invalidFieldRefs.length > 0
        ? "Cloud rule references customfield_NNN that doesn't exist — see suggestion column"
        : "",
      invalidFieldRefs.length > 0 ? "bad" : "ok",
    );
    addRow(
      "Invalid Status Refs",
      invalidStatusRefs.length,
      invalidStatusRefs.length > 0
        ? "Status ID in rule param missing from Cloud catalog or out of workflow scope"
        : "",
      invalidStatusRefs.length > 0 ? "bad" : "ok",
    );
    addRow(
      "Invalid Role/Group Refs",
      invalidRoleGroupRefs.length,
      invalidRoleGroupRefs.length > 0
        ? "Role/group ID or name not present in Cloud catalog"
        : "",
      invalidRoleGroupRefs.length > 0 ? "bad" : "ok",
    );
    addRow(
      "Invalid Permission Refs",
      invalidPermissionRefs.length,
      invalidPermissionRefs.length > 0 ? "Permission key unknown to Cloud" : "",
      invalidPermissionRefs.length > 0 ? "bad" : "ok",
    );
    addRow(
      "Invalid Account Refs",
      invalidAccountRefs.length,
      invalidAccountRefs.length > 0
        ? "accountId not resolvable on Cloud (deactivated / wrong tenant / over scan cap)"
        : "",
      invalidAccountRefs.length > 0 ? "warn" : "ok",
    );
    addRow(
      "Invalid Asset Refs",
      invalidAssetRefs.length,
      invalidAssetRefs.length > 0
        ? "Insight/Assets schema/type/attribute not found in Cloud (Iteration 3)"
        : (report.assetsAvailable === false
            ? "Asset audit unavailable: " + (report.assetsUnavailableReason || "no Cloud workspace")
            : ""),
      invalidAssetRefs.length > 0 ? "bad" : "ok",
    );

    addSectionDividerRow(sheet, "Diagnostics (informational)", 3);
    addRow(
      "Matcher Diff entries",
      matcherDiff.length,
      "v1 vs v2 fingerprint drift — review before flipping --apply default",
      "ok",
    );
    addRow(
      "Fix Plan entries",
      fixPlan.length,
      report.fixMode
        ? (report.confirmed
            ? "Pushed during this run — see Fix Plan tab"
            : "Dry-rendered; re-run with --fix --confirm to push")
        : "Pass --fix to populate this preview",
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
    const addInfo = (field, value) => sheet.addRow({ field, value });

    addInfo("Generated at", report.generatedAt || "");
    addInfo("Cloud base URL", report.cloudBaseUrl || "");
    addInfo("Collect dir", collectDir);
    addInfo("Plan generated at", report.planGeneratedAt || "");
    addInfo("Mode", report.mode || "audit-only");
    addInfo("Matcher engine", report.matcher || "v1");
    addInfo("--fix", String(!!report.fixMode));
    addInfo("--confirm", String(!!report.confirmed));
    addInfo(
      "--exclude-projects",
      Array.isArray(report.excludeProjects) && report.excludeProjects.length > 0
        ? report.excludeProjects.join(", ")
        : "(none)",
    );
    addInfo(
      "Assets workspace ID",
      report.assetsWorkspaceId || "(not provided / Iteration 3)",
    );
    addInfo(
      "Assets audit",
      report.assetsAvailable === false
        ? `unavailable: ${report.assetsUnavailableReason || "(unspecified)"}`
        : (report.assetsAvailable === true ? "available" : "(not yet wired)"),
    );

    addInfo("", "");
    addInfo("Plan workflows", String(report.planWorkflowCount || 0));
    addInfo("Workflows audited", String(report.workflowsAudited || 0));
    addInfo("Workflows skipped by exclusion filter", String(excludedWorkflows.length));
    addInfo("Workflows missing on Cloud", String(workflowsMissingOnCloud.length));

    addInfo("", "");
    sheet.addRow({ field: "ABOUT THIS REPORT", value: "" });
    sheet.lastRow.font = { bold: true };
    sheet.addRow({
      field: "",
      value:
        "Sanitize is read-only by default. Findings on Missing System Rules / " +
        "Invalid * Refs are computed by walking the live Cloud workflow and " +
        "validating each ID against the authoritative Cloud catalog (fields, " +
        "statuses, roles, groups, permissions, assets). To re-push the missing " +
        "system rules, re-run with --fix --confirm.",
    });
    sheet.lastRow.alignment = { wrapText: true, vertical: "top" };
    sheet.lastRow.height = 80;
  }

  // === SHEET 3: Excluded By Project Filter ===============================
  if (excludedWorkflows.length > 0) {
    const sheet = wb.addWorksheet("Excluded By Project Filter");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 60 },
      { header: "Excluded for project(s)", key: "projects", width: 32 },
      { header: "Source", key: "source", width: 50 },
    ]);
    for (const r of excludedWorkflows) {
      sheet.addRow({
        workflowName: r.workflowName,
        projects: Array.isArray(r.projects) ? r.projects.join(", ") : (r.project || ""),
        source: r.source || "--exclude-projects (workflow scheme lookup)",
      });
    }
  }

  // === SHEET 4: Workflows Missing on Cloud ==============================
  if (workflowsMissingOnCloud.length > 0) {
    const sheet = wb.addWorksheet("Workflows Missing on Cloud");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 60 },
      { header: "Notes", key: "notes", width: 80 },
    ]);
    for (const n of workflowsMissingOnCloud) {
      sheet.addRow({
        workflowName: n,
        notes: "No Cloud workflow with this name. Either rename Cloud, or add a workflowNameOverrides entry in config.json.",
      });
    }
  }

  // === SHEET 5: Missing System Rules =====================================
  if (missingSystemRules.length > 0) {
    const sheet = wb.addWorksheet("Missing System Rules");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 40 },
      { header: "Cloud Transition", key: "transitionName", width: 28 },
      { header: "Cloud Transition ID", key: "transitionId", width: 16 },
      { header: "Rule Category", key: "ruleCategory", width: 14 },
      { header: "Expected ruleKey", key: "ruleKey", width: 40 },
      { header: "Expected appKey", key: "appKey", width: 40 },
      { header: "DC shortName", key: "shortName", width: 24 },
      { header: "Strategy", key: "strategy", width: 12 },
      { header: "Plan internalId", key: "internalId", width: 36 },
      { header: "Reason", key: "reason", width: 60 },
    ]);
    for (const r of missingSystemRules) {
      sheet.addRow({
        workflowName: r.workflowName,
        transitionName: r.transitionName || "",
        transitionId: r.transitionId == null ? "" : String(r.transitionId),
        ruleCategory: r.ruleCategory || "",
        ruleKey: r.expectedRuleKey || "",
        appKey: r.expectedAppKey || "",
        shortName: r.shortName || "",
        strategy: r.strategy || "",
        internalId: r.internalId || "",
        reason: r.reason || "absent from live Cloud workflow",
      });
    }
  }

  // === SHEET 6: Invalid Field Refs =======================================
  if (invalidFieldRefs.length > 0) {
    const sheet = wb.addWorksheet("Invalid Field Refs");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 40 },
      { header: "Transition", key: "transitionName", width: 28 },
      { header: "Rule Category", key: "ruleCategory", width: 14 },
      { header: "ruleKey", key: "ruleKey", width: 40 },
      { header: "appKey", key: "appKey", width: 40 },
      { header: "Parameter Path", key: "paramPath", width: 30 },
      { header: "Bad Cloud ID", key: "badId", width: 22 },
      { header: "Suggestion", key: "suggestion", width: 40 },
      { header: "Notes", key: "notes", width: 60 },
    ]);
    for (const r of invalidFieldRefs) {
      sheet.addRow({
        workflowName: r.workflowName,
        transitionName: r.transitionName || "",
        ruleCategory: r.ruleCategory || "",
        ruleKey: r.ruleKey || "",
        appKey: r.appKey || "",
        paramPath: r.paramPath || "",
        badId: r.badId || "",
        suggestion: r.suggestion || "",
        notes: r.notes || "",
      });
    }
  }

  // === SHEET 7: Invalid Status Refs ======================================
  if (invalidStatusRefs.length > 0) {
    const sheet = wb.addWorksheet("Invalid Status Refs");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 40 },
      { header: "Transition", key: "transitionName", width: 28 },
      { header: "Rule Category", key: "ruleCategory", width: 14 },
      { header: "ruleKey", key: "ruleKey", width: 40 },
      { header: "Parameter Path", key: "paramPath", width: 30 },
      { header: "Bad Status ID", key: "badId", width: 22 },
      { header: "Suggestion", key: "suggestion", width: 40 },
      { header: "Notes", key: "notes", width: 60 },
    ]);
    for (const r of invalidStatusRefs) {
      sheet.addRow({
        workflowName: r.workflowName,
        transitionName: r.transitionName || "",
        ruleCategory: r.ruleCategory || "",
        ruleKey: r.ruleKey || "",
        paramPath: r.paramPath || "",
        badId: r.badId || "",
        suggestion: r.suggestion || "",
        notes: r.notes || "",
      });
    }
  }

  // === SHEET 8: Invalid Role/Group Refs ==================================
  if (invalidRoleGroupRefs.length > 0) {
    const sheet = wb.addWorksheet("Invalid Role-Group Refs");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 40 },
      { header: "Transition", key: "transitionName", width: 28 },
      { header: "Rule Category", key: "ruleCategory", width: 14 },
      { header: "ruleKey", key: "ruleKey", width: 40 },
      { header: "Kind", key: "kind", width: 10 },
      { header: "Parameter Path", key: "paramPath", width: 30 },
      { header: "Bad ID/Name", key: "badId", width: 32 },
      { header: "Suggestion", key: "suggestion", width: 40 },
    ]);
    for (const r of invalidRoleGroupRefs) {
      sheet.addRow({
        workflowName: r.workflowName,
        transitionName: r.transitionName || "",
        ruleCategory: r.ruleCategory || "",
        ruleKey: r.ruleKey || "",
        kind: r.kind || "",
        paramPath: r.paramPath || "",
        badId: r.badId || "",
        suggestion: r.suggestion || "",
      });
    }
  }

  // === SHEET 9: Invalid Permission/Account Refs ==========================
  if (invalidPermissionRefs.length > 0 || invalidAccountRefs.length > 0) {
    const sheet = wb.addWorksheet("Invalid Permission-Account Refs");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 40 },
      { header: "Transition", key: "transitionName", width: 28 },
      { header: "Kind", key: "kind", width: 14 },
      { header: "ruleKey", key: "ruleKey", width: 40 },
      { header: "Parameter Path", key: "paramPath", width: 30 },
      { header: "Bad value", key: "badId", width: 36 },
      { header: "Notes", key: "notes", width: 60 },
    ]);
    for (const r of invalidPermissionRefs) {
      sheet.addRow({
        workflowName: r.workflowName,
        transitionName: r.transitionName || "",
        kind: "permission",
        ruleKey: r.ruleKey || "",
        paramPath: r.paramPath || "",
        badId: r.badId || "",
        notes: r.notes || "permission key not in Cloud /permissions catalog",
      });
    }
    for (const r of invalidAccountRefs) {
      sheet.addRow({
        workflowName: r.workflowName,
        transitionName: r.transitionName || "",
        kind: "account",
        ruleKey: r.ruleKey || "",
        paramPath: r.paramPath || "",
        badId: r.badId || "",
        notes: r.notes || "accountId not resolvable on Cloud",
      });
    }
  }

  // === SHEET 10: Invalid Asset Refs (Iteration 3) ========================
  if (invalidAssetRefs.length > 0) {
    const sheet = wb.addWorksheet("Invalid Asset Refs");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 40 },
      { header: "Transition", key: "transitionName", width: 28 },
      { header: "Kind", key: "kind", width: 14 },
      { header: "DC name", key: "dcName", width: 32 },
      { header: "Cloud match", key: "cloudId", width: 24 },
      { header: "Notes", key: "notes", width: 60 },
    ]);
    for (const r of invalidAssetRefs) {
      sheet.addRow({
        workflowName: r.workflowName,
        transitionName: r.transitionName || "",
        kind: r.kind || "",
        dcName: r.dcName || "",
        cloudId: r.cloudId || "",
        notes: r.notes || "",
      });
    }
  }

  // === SHEET 11: Asset ID Remapping Suggestions (Iteration 3) ============
  if (assetSuggestions.length > 0) {
    const sheet = wb.addWorksheet("Asset ID Remapping Suggestions");
    applyHeaderRow(sheet, [
      { header: "DC schema", key: "dcSchema", width: 28 },
      { header: "DC type", key: "dcType", width: 28 },
      { header: "DC attribute", key: "dcAttribute", width: 28 },
      { header: "Cloud schema id", key: "cloudSchemaId", width: 18 },
      { header: "Cloud type id", key: "cloudTypeId", width: 18 },
      { header: "Cloud attribute id", key: "cloudAttributeId", width: 18 },
      { header: "Notes", key: "notes", width: 60 },
    ]);
    for (const r of assetSuggestions) sheet.addRow(r);
  }

  // === SHEET 12: Matcher Diff (Iteration 2) =============================
  if (matcherDiff.length > 0) {
    const sheet = wb.addWorksheet("Matcher Diff");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 40 },
      { header: "Transition", key: "transitionName", width: 28 },
      { header: "ruleKey", key: "ruleKey", width: 40 },
      { header: "appKey", key: "appKey", width: 40 },
      { header: "v1 fingerprint", key: "v1", width: 80 },
      { header: "v2 fingerprint", key: "v2", width: 80 },
      { header: "Direction", key: "direction", width: 28 },
    ]);
    for (const r of matcherDiff) sheet.addRow(r);
  }

  // === SHEET 13: Fix Plan (Iteration 2.5) ===============================
  if (fixPlan.length > 0) {
    const sheet = wb.addWorksheet("Fix Plan");
    applyHeaderRow(sheet, [
      { header: "Workflow", key: "workflowName", width: 40 },
      { header: "Transition", key: "transitionName", width: 28 },
      { header: "Action", key: "action", width: 18 },
      { header: "ruleKey", key: "ruleKey", width: 40 },
      { header: "appKey", key: "appKey", width: 40 },
      { header: "Plan internalId", key: "internalId", width: 36 },
      { header: "Pre-flight validation", key: "validationStatus", width: 22 },
      { header: "Pushed", key: "pushed", width: 10 },
      { header: "Notes", key: "notes", width: 60 },
    ]);
    for (const r of fixPlan) {
      const row = sheet.addRow(r);
      if (r.validationStatus === "ERROR") {
        row.eachCell((c) => (c.fill = SUMMARY_BAD_FILL));
      } else if (r.pushed === true || r.pushed === "true") {
        row.eachCell((c) => (c.fill = SUMMARY_OK_FILL));
      }
    }
  }

  const outPath = path.join(collectDir, `sanitize_${timestampSlug()}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  if (log && typeof log.info === "function") {
    log.info(`Sanitize workbook written: ${outPath} (${wb.worksheets.length} sheet(s))`);
  }
  return outPath;
}

module.exports = writeSanitizeWorkbook;
