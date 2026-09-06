/**
 * Tests for ruleSummarizer. Run with `node src/ruleSummarizer.test.js`.
 */

const assert = require("assert");
const { summarizeRule } = require("./ruleSummarizer");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("PASS", name); }
  catch (e) { fail++; console.error("FAIL", name, "-", e.message); }
}

// ─── JSU ───

t("UpdateIssueCustomFieldPostFunction shows field and value", () => {
  const s = summarizeRule(
    "com.googlecode.jsu.workflow.function.UpdateIssueCustomFieldPostFunction",
    { "field.name": "customfield_11908", "field.value": "Yes" },
  );
  assert.ok(s.includes("customfield_11908"), s);
  assert.ok(s.includes("Yes"), s);
});

t("UpdateIssueCustomFieldPostFunction with append.value adds annotation", () => {
  const s = summarizeRule(
    "com.googlecode.jsu.workflow.function.UpdateIssueCustomFieldPostFunction",
    { "field.name": "labels", "field.value": "X", "append.value": "true" },
  );
  assert.ok(s.includes("append"), s);
});

t("ClearFieldValuePostFunction shows the field", () => {
  const s = summarizeRule(
    "com.googlecode.jsu.workflow.function.ClearFieldValuePostFunction",
    { field: "customfield_10001" },
  );
  assert.ok(s.startsWith("Clear field"), s);
});

t("FieldsRequiredValidator splits @@-separated field list", () => {
  const s = summarizeRule(
    "com.googlecode.jsu.workflow.validator.FieldsRequiredValidator",
    { hidFieldsList: "customfield_X@@customfield_Y@@customfield_Z" },
  );
  assert.ok(s.includes("customfield_X"), s);
  assert.ok(s.includes("customfield_Y"), s);
  assert.ok(s.includes("customfield_Z"), s);
});

t("ValueFieldCondition shows field = value", () => {
  const s = summarizeRule(
    "com.googlecode.jsu.workflow.condition.ValueFieldCondition",
    { fieldsList: "status", fieldValue: "In Progress" },
  );
  assert.ok(s.includes("status"), s);
  assert.ok(s.includes("In Progress"), s);
});

t("JqlCondition shows query", () => {
  const s = summarizeRule(
    "com.googlecode.jsu.workflow.condition.JqlCondition",
    { query: "issuetype = Story AND status = Done" },
  );
  assert.ok(s.includes("issuetype = Story"), s);
});

t("UserIsInAnyRolesCondition shows roles", () => {
  const s = summarizeRule(
    "com.googlecode.jsu.workflow.condition.UserIsInAnyRolesCondition",
    { hidRolesList: "Administrators@@Developers" },
  );
  assert.ok(s.includes("Administrators"), s);
  assert.ok(s.includes("Developers"), s);
});

// ─── JMWE ───

t("JMWE SetFieldValueFunction shows fieldsConfig entries", () => {
  const s = summarizeRule(
    "com.innovalog.jmwe.plugins.functions.SetFieldValueFunction",
    { fieldsConfig: JSON.stringify([
      { fieldId: "customfield_11908", value: "Approved" },
      { fieldId: "customfield_11909", value: "Yes" },
    ])},
  );
  assert.ok(s.includes("customfield_11908"), s);
  assert.ok(s.includes("Approved"), s);
});

t("JMWE EmailIssueFunction shows subject and recipient", () => {
  const s = summarizeRule(
    "com.innovalog.jmwe.plugins.functions.EmailIssueFunction",
    { subject: "Ticket update", toAddresses: "ops@example.com" },
  );
  assert.ok(s.includes("Ticket update"), s);
  assert.ok(s.includes("ops@example.com"), s);
});

t("JMWE CommentIssueFunction shows comment preview", () => {
  const s = summarizeRule(
    "com.innovalog.jmwe.plugins.functions.CommentIssueFunction",
    { comment: "Auto-generated comment" },
  );
  assert.ok(s.includes("Auto-generated comment"), s);
});

t("JMWE FieldHasSingleValueValidator names the field", () => {
  const s = summarizeRule(
    "com.innovalog.jmwe.plugins.validators.FieldHasSingleValueValidator",
    { fieldKey: "customfield_11908" },
  );
  assert.ok(s.includes("customfield_11908"), s);
  assert.ok(s.includes("single value"), s);
});

t("JMWE GroovyValidator shows script preview", () => {
  const s = summarizeRule(
    "com.innovalog.jmwe.plugins.validators.GroovyValidator",
    { script: 'issue.get("summary").length() > 5' },
  );
  assert.ok(s.includes("Groovy"), s);
  assert.ok(s.includes("issue.get"), s);
});

t("JMWE NonInteractiveCondition has fixed string", () => {
  const s = summarizeRule(
    "com.innovalog.jmwe.plugins.conditions.NonInteractiveCondition",
    {},
  );
  assert.ok(s.startsWith("Non-interactive"), s);
});

t("JMWE LinkedIssuesCondition shows linkType and statuses", () => {
  const s = summarizeRule(
    "com.innovalog.jmwe.plugins.conditions.LinkedIssuesCondition",
    { linkType: "blocks", "jira.linked.statuses": "10001@@10002" },
  );
  assert.ok(s.includes("blocks"), s);
  assert.ok(s.includes("10001"), s);
});

t("JMWE CopyIssueFieldsFunction shows count + target", () => {
  const s = summarizeRule(
    "com.innovalog.jmwe.plugins.functions.CopyIssueFieldsFunction",
    {
      copyFieldsConfig: JSON.stringify([
        { sourceField: "customfield_10001", destinationField: "customfield_10613" },
        { sourceField: "customfield_10002", destinationField: "customfield_10614" },
      ]),
      targetIssue: "linkedIssue",
    },
  );
  assert.ok(s.includes("linkedIssue"), s);
  assert.ok(/\b2\b/.test(s), s);
});

// ─── BeeCom ───

t("BeeCom CreateLinkedIssueFunction has fixed string", () => {
  const s = summarizeRule(
    "ch.beecom.jira.jsu.workflow.function.createlinkedissue.CreateLinkedIssueFunction",
    {},
  );
  assert.ok(s.includes("BeeCom"), s);
  assert.ok(s.includes("create linked"), s);
});

t("BeeCom UserIsInAnyUsersCondition shows users", () => {
  const s = summarizeRule(
    "ch.beecom.jira.jsu.workflow.condition.userisinanyusers.UserIsInAnyUsersCondition",
    { usersList: "alice@@bob" },
  );
  assert.ok(s.includes("alice"), s);
  assert.ok(s.includes("bob"), s);
});

// ─── Fallback ───

t("Unknown dcType falls back to class tail + config hints", () => {
  const s = summarizeRule(
    "com.unknown.plugin.SomeMysteryFunction",
    { customParam: "value", anotherParam: 42 },
  );
  assert.ok(s.includes("SomeMysteryFunction"), s);
});

t("All summaries respect MAX truncation", () => {
  const s = summarizeRule(
    "com.googlecode.jsu.workflow.function.UpdateIssueCustomFieldPostFunction",
    {
      "field.name": "x".repeat(200),
      "field.value": "y".repeat(200),
    },
  );
  assert.ok(s.length <= 120, "got length " + s.length);
});

t("Null/undefined configuration safe", () => {
  assert.doesNotThrow(() => summarizeRule("com.foo.Bar", null));
  assert.doesNotThrow(() => summarizeRule("com.foo.Bar", undefined));
  assert.doesNotThrow(() => summarizeRule(null, {}));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
