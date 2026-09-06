/**
 * Tests for groovyResidueDetector. Run with `node src/groovyResidueDetector.test.js`.
 */

const assert = require("assert");
const { detectGroovyResidue, scanString } = require("./groovyResidueDetector");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("PASS", name); }
  catch (e) { fail++; console.error("FAIL", name, "-", e.message); }
}

// ───── scanString ─────

t("scanString detects def-declaration", () => {
  const hits = scanString("def x = 5");
  assert.ok(hits.some((h) => h.pattern === "def-declaration"), JSON.stringify(hits));
});

t("scanString detects return-statement", () => {
  const hits = scanString("if (x) { return true } else { return false }");
  assert.ok(hits.some((h) => h.pattern === "return-statement"));
});

t("scanString detects Groovy regex-match operator =~", () => {
  const hits = scanString("issue.summary =~ /foo/");
  assert.ok(hits.some((h) => h.pattern === "regex-match-operator"));
});

t("scanString detects try-block", () => {
  const hits = scanString("try { doStuff() } catch (e) { log.warn(e) }");
  assert.ok(hits.some((h) => h.pattern === "try-block"));
  assert.ok(hits.some((h) => h.pattern === "catch-block"));
});

t("scanString detects ScriptRunner customFields accessor", () => {
  const hits = scanString("customFields.find {it.name == 'X'}");
  assert.ok(hits.some((h) => h.pattern === "scriptrunner-customFields-accessor"));
});

t("scanString detects JSP scriptlet", () => {
  const hits = scanString("Hello <% out.print(name) %>");
  assert.ok(hits.some((h) => h.pattern === "jsp-scriptlet"));
});

t("scanString detects Groovy import", () => {
  const hits = scanString("import com.atlassian.jira.IssueManager; doStuff()");
  assert.ok(hits.some((h) => h.pattern === "groovy-import"));
});

t("scanString detects new-constructor", () => {
  const hits = scanString("new DateTime().minusDays(5)");
  assert.ok(hits.some((h) => h.pattern === "groovy-constructor"));
});

t("scanString detects unconverted issue.get(...) calls", () => {
  const hits = scanString('issue.get("customfield_12345")');
  assert.ok(hits.some((h) => h.pattern === "unconverted-issue.get"));
});

t("scanString detects unconverted issue.getAsString calls", () => {
  const hits = scanString('issue.getAsString("status")');
  assert.ok(hits.some((h) => h.pattern === "unconverted-issue.getAsString"));
});

t("scanString detects unconverted GString outside Nunjucks block", () => {
  const hits = scanString("Hello ${issue.reporter} — your ticket");
  assert.ok(hits.some((h) => h.pattern === "unconverted-gstring"));
});

t("scanString does NOT flag $ inside Nunjucks block", () => {
  const hits = scanString("Hello {{ issue.fields.summary }} cost is $100");
  const gstring = hits.filter((h) => h.pattern === "unconverted-gstring");
  assert.strictEqual(gstring.length, 0);
});

t("scanString does NOT flag clean Nunjucks template", () => {
  const hits = scanString("{{ issue.fields.summary | default('none') }}");
  assert.strictEqual(hits.length, 0);
});

t("scanString does NOT flag clean Jira Expression", () => {
  const hits = scanString('user && user.groups.some(g => ["devs","ops"].includes(g))');
  assert.strictEqual(hits.length, 0);
});

t("scanString does NOT flag null-safe ?. accessor (valid in Jira Expressions)", () => {
  const hits = scanString("issue.assignee?.displayName");
  assert.strictEqual(hits.length, 0);
});

t("scanString includes snippet with context", () => {
  const hits = scanString("some text before def myVar = 42 some text after");
  const def = hits.find((h) => h.pattern === "def-declaration");
  assert.ok(def.snippet.includes("def myVar"), `got: ${def.snippet}`);
});

t("scanString snippet collapses newlines/tabs", () => {
  const hits = scanString("line one\nline two def x = 5\nline three");
  const def = hits.find((h) => h.pattern === "def-declaration");
  assert.ok(!/[\n\r\t]/.test(def.snippet));
});

// ───── detectGroovyResidue ─────

t("detectGroovyResidue scans known config fields", () => {
  const cfg = {
    expression: 'issue.get("customfield_10001")',
    subject: "clean subject",
  };
  const hits = detectGroovyResidue(cfg);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].field, "expression");
  assert.strictEqual(hits[0].pattern, "unconverted-issue.get");
});

t("detectGroovyResidue ignores non-target fields", () => {
  const cfg = {
    fieldId: "customfield_10001",
    runAsType: "INITIATING_USER",
  };
  const hits = detectGroovyResidue(cfg);
  assert.strictEqual(hits.length, 0);
});

t("detectGroovyResidue walks fieldsConfig arrays", () => {
  const cfg = {
    fieldsConfig: [
      { fieldId: "customfield_10001", value: 'clean ${broken-gstring}' },
      { fieldId: "customfield_10002", value: "{{ issue.fields.summary }}" },
    ],
  };
  const hits = detectGroovyResidue(cfg);
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].field.startsWith("fieldsConfig"), `got: ${hits[0].field}`);
});

t("detectGroovyResidue skips problems[] array (translator markers)", () => {
  const cfg = {
    expression: "true",
    problems: [{ kind: "GroovyScriptToJiraExpression", path: ["x"] }],
  };
  const hits = detectGroovyResidue(cfg);
  assert.strictEqual(hits.length, 0);
});

t("detectGroovyResidue returns empty for non-object input", () => {
  assert.deepStrictEqual(detectGroovyResidue(null), []);
  assert.deepStrictEqual(detectGroovyResidue("string"), []);
  assert.deepStrictEqual(detectGroovyResidue(42), []);
});

t("detectGroovyResidue catches multiple hits in one config", () => {
  const cfg = {
    expression: 'def x = issue.get("X")',
    conditionalExecutionScript: "try { return true } catch (e) { return false }",
  };
  const hits = detectGroovyResidue(cfg);
  // expression has 2 (def + issue.get), conditionalExecutionScript has 3 (try/catch/return)
  assert.ok(hits.length >= 4, `got: ${hits.length}, hits=${JSON.stringify(hits, null, 2)}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
