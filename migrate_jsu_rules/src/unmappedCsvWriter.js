/**
 * CSV writer for rules the applier could not migrate (or auto-disabled).
 *
 * Output schema (one row per unmapped rule):
 *   workflow              — DC workflow name (matches the XML filename root)
 *   cloudWorkflow         — Cloud workflow name (after `workflowNameOverrides`).
 *                           Identical to `workflow` when no override applies.
 *   transition            — Human-readable DC transition name (matches Cloud's
 *                           transition name post-JCMA).
 *   transitionId          — Numeric DC transition id; same id on Cloud when
 *                           JCMA preserved it (verified live, the common case).
 *   ruleCategory          — condition | validator | postFunction.
 *   dcSlot                — pathWithinTransition (e.g. "postFunctions[0]" or
 *                           "(AND)[0](OR)[1]" for nested conditions). Pinpoints
 *                           WHICH rule slot in the DC transition this row is.
 *   shortName             — canonical mapper key (e.g. "jmwe-set-field-value").
 *   ruleSummary           — one-line human readable: "Set customfield_X = 'Y'",
 *                           "Email '...' → ...", "Require fields: A, B", etc.
 *                           Use this to grep / spreadsheet-filter by intent.
 *   migrationSourceId     — 16-hex deterministic identity of the DC source rule
 *                           (sha1 of workflow+transition+slot+dcType). Stable
 *                           across re-runs; grep this in update_payload_*.json
 *                           and migration_ledger_*.json to find this exact row.
 *   cloudRuleId           — When the rule WAS pushed (e.g. auto-disabled), the
 *                           Cloud-side rule UUID. Blank for rules that never
 *                           reached Cloud. Use this to find the rule in the
 *                           Cloud UI / `inspect_cloud_workflow.js`.
 *   strategy              — native | jmwe | skip | manual-review.
 *   reason                — why this row is in the CSV.
 *   dcConfigPreview       — first 200 chars of the DC config JSON. Last resort
 *                           when ruleSummary isn't enough.
 *
 * Everything is RFC-4180 escaped (CRLF terminators, double-quoted cells when
 * they contain a comma/quote/newline).
 */

const { summarizeRule } = require("./ruleSummarizer");

function escapeCsvCell(value) {
  if (value == null) return "";
  const s = String(value);
  // RFC 4180: enclose in double quotes if the value contains a comma, double
  // quote, or newline. Double-up embedded double quotes.
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function previewConfig(configuration, maxLen = 200) {
  if (!configuration || typeof configuration !== "object") return "";
  let s;
  try { s = JSON.stringify(configuration); }
  catch { s = String(configuration); }
  // Strip newlines and tabs so the cell stays on one line in spreadsheets.
  s = s.replace(/[\r\n\t]+/g, " ");
  if (s.length > maxLen) s = s.slice(0, maxLen - 3) + "...";
  return s;
}

/**
 * Render unmapped rules as CSV text. `unmapped` is the same array shape
 * jsuApplier writes to `unmapped_rules.json` — each entry has
 *   { workflowName, transitionName, transitionId?, ruleCategory, dcType,
 *     shortName, strategy?, defaultStrategy?, reason, configuration? }
 */
function renderUnmappedCsv(unmapped, options = {}) {
  const workflowNameOverrides = (options && options.workflowNameOverrides) || {};
  const header = [
    "workflow",
    "cloudWorkflow",
    "transition",
    "transitionId",
    "ruleCategory",
    "dcSlot",
    "shortName",
    "ruleSummary",
    "migrationSourceId",
    "cloudRuleId",
    "strategy",
    "reason",
    "dcConfigPreview",
  ].join(",");
  const lines = [header];
  for (const row of unmapped || []) {
    if (!row) continue;
    const strategy = row.strategy || row.defaultStrategy || "";
    const cloudWorkflow =
      row.cloudWorkflowName ||
      workflowNameOverrides[row.workflowName] ||
      row.workflowName ||
      "";
    const dcSlot = row.pathWithinTransition || "";
    const ruleSummary = summarizeRule(row.dcType, row.configuration);
    const cells = [
      row.workflowName,
      cloudWorkflow,
      row.transitionName,
      row.transitionId != null ? String(row.transitionId) : "",
      row.ruleCategory,
      dcSlot,
      row.shortName,
      ruleSummary,
      row.migrationSourceId || "",
      row.cloudRuleId || "",
      strategy,
      row.reason,
      previewConfig(row.configuration),
    ].map(escapeCsvCell);
    lines.push(cells.join(","));
  }
  // CRLF per RFC 4180 — keeps Excel from auto-detecting LF as the only line
  // break, which has historically tripped some legacy openers.
  return lines.join("\r\n") + "\r\n";
}

function writeUnmappedCsv(filePath, unmapped, options = {}) {
  const fs = require("fs");
  fs.writeFileSync(filePath, renderUnmappedCsv(unmapped, options));
  return { path: filePath, rowCount: (unmapped || []).length };
}

module.exports = {
  escapeCsvCell,
  previewConfig,
  renderUnmappedCsv,
  writeUnmappedCsv,
};
