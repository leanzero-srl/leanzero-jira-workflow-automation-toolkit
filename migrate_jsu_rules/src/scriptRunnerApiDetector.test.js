/**
 * Unit tests for scriptRunnerApiDetector.
 */
const assert = require("assert");
const { detectScriptRunnerApi, scanString } = require("./scriptRunnerApiDetector");

let _passed = 0;
let _failed = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    _passed++;
  } catch (e) {
    console.log(`FAIL ${name} - ${e.message}`);
    _failed++;
  }
}

t("scanString detects ComponentAccessor", () => {
  const hits = scanString("def x = ComponentAccessor.getCustomFieldManager()");
  assert.ok(hits.some((h) => h.pattern === "ComponentAccessor"));
});

t("scanString detects SearchService", () => {
  const hits = scanString("def s = SearchService");
  assert.ok(hits.some((h) => h.pattern === "SearchService"));
});

t("scanString detects getComponent", () => {
  const hits = scanString("def mgr = getComponent(CustomFieldManager)");
  assert.ok(hits.some((h) => h.pattern === "getComponent"));
});

t("scanString detects ApplicationUser type reference", () => {
  const hits = scanString("ApplicationUser user = ...");
  assert.ok(hits.some((h) => h.pattern === "ApplicationUser"));
});

t("scanString detects PagerFilter", () => {
  const hits = scanString("def pager = new PagerFilter(0, 100)");
  assert.ok(hits.some((h) => h.pattern === "PagerFilter"));
});

t("scanString detects import com.atlassian.jira.bc", () => {
  const hits = scanString("import com.atlassian.jira.bc.issue.search.SearchService");
  assert.ok(hits.some((h) => h.pattern === "import-jira-bc"));
});

t("scanString detects import com.atlassian.jira.component", () => {
  const hits = scanString("import com.atlassian.jira.component.ComponentAccessor");
  assert.ok(hits.some((h) => h.pattern === "import-jira-component"));
});

t("scanString detects assert .. .errors", () => {
  const hits = scanString("assert result.errors.size() == 0");
  assert.ok(hits.some((h) => h.pattern === "assert-errors"));
});

t("scanString detects JiraAuthenticationContext", () => {
  const hits = scanString("def u = JiraAuthenticationContext.getLoggedInUser()");
  assert.ok(hits.some((h) => h.pattern === "JiraAuthenticationContext"));
});

t("scanString detects ImportClass", () => {
  const hits = scanString("ImportClass(java.util.Date)");
  assert.ok(hits.some((h) => h.pattern === "ImportClass"));
});

t("scanString detects import com.onresolve", () => {
  const hits = scanString("import com.onresolve.scriptrunner.runner.ScriptRunnerImpl");
  assert.ok(hits.some((h) => h.pattern === "import-onresolve-scriptrunner"));
});

t("scanString returns empty for clean Nunjucks", () => {
  const hits = scanString("{{ issue.fields.summary | default(\"\") }}");
  assert.deepStrictEqual(hits, []);
});

t("scanString returns empty for plain English", () => {
  const hits = scanString("Please review this ticket and approve.");
  assert.deepStrictEqual(hits, []);
});

t("detectScriptRunnerApi finds hits in nested config", () => {
  const config = {
    expression: "ComponentAccessor.getCustomFieldManager().getCustomFieldObject('X')",
    fieldsConfig: [{ value: "import com.atlassian.jira.bc.issue.IssueService" }],
  };
  const hits = detectScriptRunnerApi(config);
  assert.ok(hits.length >= 2);
  assert.ok(hits.some((h) => h.pattern === "ComponentAccessor"));
});

t("detectScriptRunnerApi ignores non-target fields", () => {
  const config = { someUnknownField: "ComponentAccessor.x" };
  const hits = detectScriptRunnerApi(config);
  assert.deepStrictEqual(hits, []);
});

t("detectScriptRunnerApi skips problems[] array", () => {
  const config = {
    expression: "issue.summary == 'X'",
    problems: [{ type: "Other", location: ["ComponentAccessor.x"] }],
  };
  const hits = detectScriptRunnerApi(config);
  assert.deepStrictEqual(hits, []);
});

t("detectScriptRunnerApi returns empty for non-object input", () => {
  assert.deepStrictEqual(detectScriptRunnerApi(null), []);
  assert.deepStrictEqual(detectScriptRunnerApi(undefined), []);
  assert.deepStrictEqual(detectScriptRunnerApi("string"), []);
});

console.log(`\n${_passed} passed, ${_failed} failed`);
if (_failed > 0) process.exit(1);
