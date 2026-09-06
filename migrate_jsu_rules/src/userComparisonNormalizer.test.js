#!/usr/bin/env node
// Unit tests for userComparisonNormalizer. Run: node src/userComparisonNormalizer.test.js
const assert = require("node:assert/strict");
const { normalizeUserComparisons } = require("./userComparisonNormalizer");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    fail++;
  }
}

t("rewrites user != issue.reporter (the user-reported case)", () => {
  const r = normalizeUserComparisons("user != issue.reporter");
  assert.equal(r.output, "user.accountId != issue.reporter.accountId");
  assert.equal(r.changes.length, 1);
});

t("rewrites user == issue.reporter", () => {
  const r = normalizeUserComparisons("user == issue.reporter");
  assert.equal(r.output, "user.accountId == issue.reporter.accountId");
});

t("rewrites issue.reporter == issue.assignee", () => {
  const r = normalizeUserComparisons("issue.reporter == issue.assignee");
  assert.equal(r.output, "issue.reporter.accountId == issue.assignee.accountId");
});

t("rewrites issue.creator != user", () => {
  const r = normalizeUserComparisons("issue.creator != user");
  assert.equal(r.output, "issue.creator.accountId != user.accountId");
});

t("rewrites strict-equality === and !==", () => {
  const r1 = normalizeUserComparisons("user === issue.assignee");
  assert.equal(r1.output, "user.accountId === issue.assignee.accountId");
  const r2 = normalizeUserComparisons("user !== issue.reporter");
  assert.equal(r2.output, "user.accountId !== issue.reporter.accountId");
});

t("rewrites issue.parent.reporter != user", () => {
  const r = normalizeUserComparisons("issue.parent.reporter != user");
  assert.equal(r.output, "issue.parent.reporter.accountId != user.accountId");
});

t("rewrites app.user == issue.reporter", () => {
  const r = normalizeUserComparisons("app.user == issue.reporter");
  assert.equal(r.output, "app.user.accountId == issue.reporter.accountId");
});

t("does NOT rewrite user == null", () => {
  const r = normalizeUserComparisons("user == null");
  assert.equal(r.output, "user == null");
  assert.equal(r.changes.length, 0);
});

t("does NOT rewrite user != null", () => {
  const r = normalizeUserComparisons("user != null");
  assert.equal(r.output, "user != null");
});

t("does NOT rewrite when both sides already use .accountId (idempotent)", () => {
  const input = "user.accountId == issue.reporter.accountId";
  const r = normalizeUserComparisons(input);
  assert.equal(r.output, input);
  assert.equal(r.changes.length, 0);
});

t("does NOT touch issue.reporter.displayName == user.displayName", () => {
  const input = "issue.reporter.displayName == user.displayName";
  const r = normalizeUserComparisons(input);
  assert.equal(r.output, input);
});

t("does NOT match user inside iuser identifier", () => {
  const r = normalizeUserComparisons("iuser != issue.reporter");
  assert.equal(r.output, "iuser != issue.reporter");
  assert.equal(r.changes.length, 0);
});

t("does NOT match prefix.app.user (app.user must be at word boundary)", () => {
  const r = normalizeUserComparisons("myapp.user == issue.reporter");
  assert.equal(r.output, "myapp.user == issue.reporter");
});

t("ignores patterns inside double-quoted string literals", () => {
  const input = 'issue.summary == "user != issue.reporter"';
  const r = normalizeUserComparisons(input);
  assert.equal(r.output, input);
});

t("ignores patterns inside single-quoted string literals", () => {
  const input = "issue.summary == 'user != issue.reporter'";
  const r = normalizeUserComparisons(input);
  assert.equal(r.output, input);
});

t("rewrites inside larger expression with AND/OR", () => {
  const r = normalizeUserComparisons("user != issue.reporter && issue.status.name == 'Open'");
  assert.equal(
    r.output,
    "user.accountId != issue.reporter.accountId && issue.status.name == 'Open'",
  );
});

t("rewrites multiple occurrences in one expression", () => {
  const r = normalizeUserComparisons(
    "user == issue.reporter || user == issue.assignee",
  );
  assert.equal(
    r.output,
    "user.accountId == issue.reporter.accountId || user.accountId == issue.assignee.accountId",
  );
  assert.equal(r.changes.length, 2);
});

t("running twice is idempotent", () => {
  const once = normalizeUserComparisons("user != issue.reporter").output;
  const twice = normalizeUserComparisons(once).output;
  assert.equal(twice, once);
});

t("empty/null input passes through", () => {
  assert.equal(normalizeUserComparisons("").output, "");
  assert.equal(normalizeUserComparisons(null).output, "");
  assert.equal(normalizeUserComparisons(undefined).output, "");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
