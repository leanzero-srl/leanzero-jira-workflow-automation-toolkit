/**
 * Unit tests for unmappedCsvWriter. Run with `node src/unmappedCsvWriter.test.js`.
 */

const assert = require("assert");
const {
  escapeCsvCell,
  previewConfig,
  renderUnmappedCsv,
} = require("./unmappedCsvWriter");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("PASS", name); }
  catch (e) { fail++; console.error("FAIL", name, "-", e.message); }
}

t("escapeCsvCell wraps comma-bearing values in quotes", () => {
  assert.strictEqual(escapeCsvCell("a, b"), '"a, b"');
});

t("escapeCsvCell doubles up embedded double-quotes", () => {
  assert.strictEqual(escapeCsvCell('a "b" c'), '"a ""b"" c"');
});

t("escapeCsvCell passes plain text through", () => {
  assert.strictEqual(escapeCsvCell("plain"), "plain");
});

t("escapeCsvCell stringifies null/undefined as empty", () => {
  assert.strictEqual(escapeCsvCell(null), "");
  assert.strictEqual(escapeCsvCell(undefined), "");
});

t("escapeCsvCell wraps newline-bearing values", () => {
  assert.strictEqual(escapeCsvCell("a\nb"), '"a\nb"');
});

t("previewConfig stringifies config and caps length", () => {
  const big = { a: "x".repeat(500) };
  const out = previewConfig(big);
  assert.ok(out.endsWith("..."), `got: ${out}`);
  assert.ok(out.length <= 200);
});

t("previewConfig strips newlines and tabs", () => {
  const out = previewConfig({ s: "a\nb\tc" });
  assert.ok(!/[\n\r\t]/.test(out));
});

t("renderUnmappedCsv header contains all expected identifier columns", () => {
  const csv = renderUnmappedCsv([]);
  const header = csv.split("\r\n")[0];
  for (const col of [
    "workflow", "cloudWorkflow", "transition", "transitionId", "ruleCategory",
    "dcSlot", "shortName", "ruleSummary", "migrationSourceId", "cloudRuleId",
    "strategy", "reason", "dcConfigPreview",
  ]) {
    assert.ok(header.includes(col), `header missing column: ${col}`);
  }
});

t("renderUnmappedCsv produces RFC4180-compliant rows with CRLF terminators", () => {
  const rows = [
    {
      workflowName: "WF1",
      transitionName: "Start, Now",
      transitionId: 11,
      ruleCategory: "validator",
      pathWithinTransition: "validators[0]",
      dcType: "com.googlecode.jsu.workflow.validator.FieldsRequiredValidator",
      shortName: "fields-required-validator",
      strategy: "jmwe",
      migrationSourceId: "abc123def456",
      reason: 'mapper returned null because "X"',
      configuration: { hidFieldsList: "customfield_A@@customfield_B" },
    },
  ];
  const csv = renderUnmappedCsv(rows);
  const lines = csv.split("\r\n");
  assert.strictEqual(lines.length, 3);
  assert.ok(lines[1].includes('"Start, Now"'), `comma-quoted: ${lines[1]}`);
  assert.ok(lines[1].includes('"mapper returned null because ""X"""'), `quote-escaped: ${lines[1]}`);
  assert.ok(lines[1].includes("validators[0]"), `dcSlot present: ${lines[1]}`);
  assert.ok(lines[1].includes("abc123def456"), `migrationSourceId present: ${lines[1]}`);
});

t("renderUnmappedCsv applies workflowNameOverrides to the cloudWorkflow column", () => {
  const rows = [{ workflowName: "FOO_ Workflow", reason: "r" }];
  const csv = renderUnmappedCsv(rows, {
    workflowNameOverrides: { "FOO_ Workflow": "FOO: Workflow" },
  });
  const dataLine = csv.split("\r\n")[1];
  // Order: workflow, cloudWorkflow, ...
  const cells = dataLine.split(",");
  assert.strictEqual(cells[0], "FOO_ Workflow");
  assert.strictEqual(cells[1], "FOO: Workflow");
});

t("renderUnmappedCsv cloudWorkflow defaults to workflow when no override", () => {
  const rows = [{ workflowName: "Simple", reason: "r" }];
  const csv = renderUnmappedCsv(rows);
  const cells = csv.split("\r\n")[1].split(",");
  assert.strictEqual(cells[0], "Simple");
  assert.strictEqual(cells[1], "Simple");
});

t("renderUnmappedCsv handles empty/missing fields gracefully", () => {
  const csv = renderUnmappedCsv([{ workflowName: "WF" }, null]);
  const lines = csv.split("\r\n");
  assert.strictEqual(lines.length, 3); // header + 1 data + trailing ""
  assert.ok(lines[1].startsWith("WF,"));
});

t("renderUnmappedCsv falls back to defaultStrategy when strategy missing", () => {
  const csv = renderUnmappedCsv([
    { workflowName: "WF", defaultStrategy: "native", reason: "r" },
  ]);
  assert.ok(csv.includes(",native,"));
});

t("renderUnmappedCsv emits empty body when given empty array", () => {
  const csv = renderUnmappedCsv([]);
  assert.strictEqual(csv.split("\r\n").length, 2);
});

t("renderUnmappedCsv ruleSummary column is populated by the summarizer", () => {
  const rows = [{
    workflowName: "W",
    dcType: "com.googlecode.jsu.workflow.function.UpdateIssueCustomFieldPostFunction",
    configuration: { "field.name": "customfield_X", "field.value": "Yes" },
    reason: "r",
  }];
  const csv = renderUnmappedCsv(rows);
  assert.ok(csv.includes("customfield_X"), `ruleSummary should mention the field: ${csv}`);
  assert.ok(csv.includes("Yes"), `ruleSummary should mention the value: ${csv}`);
});

t("renderUnmappedCsv includes cloudRuleId when present", () => {
  const csv = renderUnmappedCsv([{
    workflowName: "W", cloudRuleId: "1234-abcd-...", reason: "r",
  }]);
  assert.ok(csv.includes("1234-abcd-..."));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
