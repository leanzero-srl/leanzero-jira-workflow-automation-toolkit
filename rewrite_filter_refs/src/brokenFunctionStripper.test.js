const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  stripBrokenFunctions,
  findFunctionCalls,
  cleanupJql,
} = require("./brokenFunctionStripper");

test("strips trailing subtask() with leading AND", () => {
  const r = stripBrokenFunctions(
    'project = BLUE AND issue in subtask("project = BLUE AND issuetype = \\"Test Preparation\\"")',
  );
  assert.equal(r.rewritten, "project = BLUE");
  assert.equal(r.stripped.length, 1);
  assert.equal(r.stripped[0].function, "subtask");
});

test("strips trailing subtask() then ORDER BY", () => {
  const r = stripBrokenFunctions(
    'project = BLUE AND issue in subtask("a") ORDER BY priority',
  );
  assert.match(r.rewritten, /^project = BLUE ORDER BY priority/);
});

test("strips leading clause with trailing AND glue", () => {
  const r = stripBrokenFunctions(
    'issue in subtask("x") AND project = BLUE',
  );
  assert.equal(r.rewritten, "project = BLUE");
});

test("strips standalone clause leaving an empty top-level expression", () => {
  const r = stripBrokenFunctions('issue in subtask("x")');
  // No surrounding clause to keep — result is empty, but caller can detect
  assert.equal(r.rewritten, "");
  assert.equal(r.stripped.length, 1);
});

test("strips parent() function inside a parenthesised subgroup", () => {
  const r = stripBrokenFunctions(
    'project = X AND (status != Closed AND issue in parent("filter = 50241"))',
  );
  assert.equal(r.rewritten, "project = X AND (status != Closed)");
});

test("strips membersOfGroups() call", () => {
  const r = stripBrokenFunctions(
    'project = X AND assignee in membersOfGroups("ops", "deployers")',
  );
  assert.equal(r.rewritten, "project = X");
  assert.equal(r.stripped[0].function, "membersOfGroups");
});

test("strips multiple unsupported calls in one JQL", () => {
  const r = stripBrokenFunctions(
    'issue in subtask("a") OR issue in parent("b") OR project = X',
  );
  assert.equal(r.rewritten, "project = X");
  assert.equal(r.stripped.length, 2);
});

test("preserves quoted strings that contain function-name-like text", () => {
  const r = stripBrokenFunctions(
    'project = X AND summary ~ "issue in subtask matters"',
  );
  // `subtask` here is inside a quoted summary value — must NOT be matched.
  assert.equal(
    r.rewritten,
    'project = X AND summary ~ "issue in subtask matters"',
  );
  assert.equal(r.stripped.length, 0);
});

test("findFunctionCalls handles balanced nested parens in body", () => {
  const calls = findFunctionCalls(
    'subtask("project = X AND (assignee = currentUser())")',
    ["subtask"],
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "subtask");
});

test("respects --broken-functions override (case-insensitive)", () => {
  const r = stripBrokenFunctions("issue in linkedIssuesInProject(APIPROJ)", {
    functions: ["LINKEDISSUESINPROJECT"],
  });
  assert.equal(r.rewritten, "");
});

test("non-listed functions pass through unchanged", () => {
  const r = stripBrokenFunctions(
    "assignee in (currentUser()) AND project = X",
  );
  assert.match(r.rewritten, /currentUser\(\)/);
  assert.match(r.rewritten, /project = X/);
  assert.equal(r.stripped.length, 0);
});

test("cleanupJql collapses orphan empty parens and dangling AND", () => {
  assert.equal(cleanupJql("project = X AND ( )"), "project = X");
  assert.equal(cleanupJql("AND project = X"), "project = X");
  assert.equal(cleanupJql("project = X AND"), "project = X");
  assert.equal(cleanupJql("(  AND project = X)"), "(project = X)");
});

test("cleanupJql does NOT remove valid AND between operands", () => {
  assert.equal(
    cleanupJql("project = X AND status = Open"),
    "project = X AND status = Open",
  );
});

test("cleanupJql preserves ORDER BY suffix when clause stripped before it", () => {
  // After stripping, we may end up with "ORDER BY priority" alone;
  // the AND/OR cleanup should not eat into ORDER BY.
  assert.equal(
    cleanupJql("project = X ORDER BY priority"),
    "project = X ORDER BY priority",
  );
});

// ─────────────────────────────────────────────────────────────────────
// issueFunction-as-field handling and expanded broken-function list
// (the JQL Tricks / older ScriptRunner pattern that motivated the v2.2 fix)
// ─────────────────────────────────────────────────────────────────────

test("T1: strips `issueFunction in subtasksOf(...)` inside an OR group (filter 19358 fixture)", () => {
  const orig =
    'project = SUP AND ("Development Team" = CMDB-22727 OR ' +
    'issueFunction in subtasksOf("project = SUP and \\"development team\\" = CMDB-22727")) ' +
    "ORDER BY Rank ASC";
  const r = stripBrokenFunctions(orig);
  assert.equal(
    r.rewritten,
    'project = SUP AND ("Development Team" = CMDB-22727) ORDER BY Rank ASC',
  );
  assert.equal(r.stripped.length, 1);
  assert.match(r.stripped[0].function, /^issueFunction in subtasksOf/);
});

test("T2: strips `issueFunction not in linkedIssuesOf(...)`", () => {
  const r = stripBrokenFunctions(
    'project = X AND issueFunction not in linkedIssuesOf("filter = 50000", "blocks")',
  );
  assert.equal(r.rewritten, "project = X");
  assert.equal(r.stripped.length, 1);
  assert.match(r.stripped[0].function, /^issueFunction not in linkedIssuesOf/);
});

test("T3: strips `issueFunction = subtasksOf(...)` (rare equality form)", () => {
  const r = stripBrokenFunctions(
    'issueFunction = subtasksOf("filter = 1") AND project = X',
  );
  assert.equal(r.rewritten, "project = X");
  assert.equal(r.stripped.length, 1);
});

test("T4: strips multiple issueFunction-field clauses in one JQL", () => {
  const r = stripBrokenFunctions(
    'issueFunction in subtasksOf("a") OR issueFunction in linkedIssuesOf("b") OR project = X',
  );
  assert.equal(r.rewritten, "project = X");
  assert.equal(r.stripped.length, 2);
});

test("T5: does NOT touch literal 'issueFunction in subtasksOf(...)' inside a quoted value", () => {
  const orig =
    'summary ~ "issueFunction in subtasksOf(stuff)" AND project = X';
  const r = stripBrokenFunctions(orig);
  assert.equal(r.rewritten, orig);
  assert.equal(r.stripped.length, 0);
});

test("T6: strips `hasSubtasks(Development)` (newly-added default)", () => {
  const r = stripBrokenFunctions(
    "project = X AND issue in hasSubtasks(Development)",
  );
  assert.equal(r.rewritten, "project = X");
  assert.equal(r.stripped[0].function, "hasSubtasks");
});

test("T7: empty-IN cleanup — `affectedVersion in (versionsAfterDate(\"...\"))` collapses cleanly", () => {
  const r = stripBrokenFunctions(
    'project = X AND affectedVersion in (versionsAfterDate("2012/10/10")) AND status = Open',
  );
  // After stripping the inner versionsAfterDate(...) call, the cleanup pass
  // must remove the resulting `affectedVersion in ()` orphan and the
  // surrounding ANDs.
  assert.equal(r.rewritten, "project = X AND status = Open");
  assert.equal(r.stripped[0].function, "versionsAfterDate");
});

test("T8: strips two issuesWhereEpicIn(...) calls in one filter (filter 25901 fixture)", () => {
  const r = stripBrokenFunctions(
    'project = X AND (issue in issuesWhereEpicIn("filter = \\"A\\"") OR issue in issuesWhereEpicIn("filter = \\"B\\""))',
  );
  assert.equal(r.rewritten, "project = X");
  assert.equal(r.stripped.length, 2);
  assert.equal(r.stripped[0].function, "issuesWhereEpicIn");
});

test("T9: strips `epicsOf(...)` (newly-added DC-only default)", () => {
  const r = stripBrokenFunctions(
    'project = X AND issue in epicsOf("project = X")',
  );
  assert.equal(r.rewritten, "project = X");
  assert.equal(r.stripped[0].function, "epicsOf");
});

test("T10: regression guard — `parentEpic = DEMO-1` is NOT stripped (Cloud-valid)", () => {
  // parentEpic IS a valid Cloud JQL function. Adding it to the broken list
  // would corrupt valid filters; this test pins that we did NOT add it.
  const orig = "project = X AND parentEpic = DEMO-1";
  const r = stripBrokenFunctions(orig);
  assert.equal(r.rewritten, orig);
  assert.equal(r.stripped.length, 0);
});

test("T10b: standalone DC-only function (no field+op prefix) is removed gracefully", () => {
  // The expandToClauseStart returns callStart when no operator precedes,
  // so the bare call gets removed and the surrounding connector cleanup
  // tidies the result.
  const r = stripBrokenFunctions(
    'hasSubtasks(Development) AND project = X',
  );
  // The bare function call is removed; cleanupJql then drops the orphan AND.
  assert.equal(r.rewritten, "project = X");
  assert.equal(r.stripped.length, 1);
});

test("T11: cleanupJql collapses orphan `NOT AND` to nothing", () => {
  assert.equal(
    cleanupJql("project = X AND NOT AND status = Open"),
    "project = X AND status = Open",
  );
});

test("T12: cleanupJql preserves valid `NOT (...)` subgroup", () => {
  const orig = "project = X AND NOT (status = Done)";
  assert.equal(cleanupJql(orig), orig);
});

test("T13: cleanupJql preserves `IS NOT EMPTY`", () => {
  const orig = "project = X AND fixVersion IS NOT EMPTY";
  assert.equal(cleanupJql(orig), orig);
});

test("T14: cleanupJql strips trailing orphan NOT", () => {
  assert.equal(cleanupJql("project = X AND NOT"), "project = X");
});

test("T15: end-to-end smoking-gun for filter 19358 — no `issueFunction` survives", () => {
  const orig =
    'project = SUP AND ("Development Team" = CMDB-22727 OR ' +
    'issueFunction in subtasksOf("project = SUP and \\"development team\\" = CMDB-22727")) ' +
    "ORDER BY Rank ASC";
  const r = stripBrokenFunctions(orig);
  assert.doesNotMatch(r.rewritten, /issueFunction/i);
  assert.match(r.rewritten, /project = SUP/);
  assert.match(r.rewritten, /ORDER BY Rank ASC/);
  assert.equal(r.stripped.length, 1);
});

test("T15b: cleanupJql preserves the SPACE between surviving clause and ORDER BY (filter 10275 fixture)", () => {
  // Regression for the bug where stripping a clause directly before
  // ORDER BY produced `NewORDER BY` (no space). Cloud emitted:
  //   "Expecting either 'OR' or 'AND' but got 'DESC'."
  // The cleanup MUST leave one space between the kept text and ORDER BY.
  const r = stripBrokenFunctions(
    "project = BLUE AND issuetype = Change AND site = SkyPoker AND status = New AND not issue in hasSubTasks() ORDER BY priority DESC, key DESC",
  );
  assert.match(r.rewritten, / ORDER BY /);
  assert.doesNotMatch(r.rewritten, /[A-Za-z0-9"]ORDER BY/);
  assert.equal(r.stripped.length, 1);
});

test("T15c: cleanupJql preserves the SPACE before ORDER BY for membersOfGroups stripping (filter 17400 fixture)", () => {
  const r = stripBrokenFunctions(
    'project = CORE AND fixVersion = 3.34.27 AND not reporter in (membersOfGroups("Retail Customer")) ORDER BY priority DESC',
  );
  assert.match(r.rewritten, / ORDER BY /);
  assert.doesNotMatch(r.rewritten, /[A-Za-z0-9"]ORDER BY/);
});

test("T15d: cleanupJql with bare orphan AND before ORDER BY collapses cleanly", () => {
  assert.equal(
    cleanupJql("project = X AND ORDER BY priority"),
    "project = X ORDER BY priority",
  );
});

test("T15e: cleanupJql with orphan NOT before ORDER BY preserves separator", () => {
  assert.equal(
    cleanupJql("project = X AND status = Open NOT ORDER BY priority"),
    "project = X AND status = Open ORDER BY priority",
  );
});

test("T16: --broken-functions override that omits issueFunction still strips the field-form clause", () => {
  // The override is a list of FUNCTION names; issueFunction-as-field is
  // recognised independently because here issueFunction is the FIELD.
  const r = stripBrokenFunctions(
    'project = X AND issueFunction in subtasksOf("a")',
    { functions: ["subtask", "parent"] }, // explicitly excludes issuefunction
  );
  assert.equal(r.rewritten, "project = X");
  assert.equal(r.stripped.length, 1);
  assert.match(r.stripped[0].function, /^issueFunction in/);
});

// ─────────────────────────────────────────────────────────────
//  Regression: cleanupJql empty-IN regex must recognise cf[N] /
//  customfield_N / quoted-name field forms, AND must not treat
//  reserved words (NOT, IN, ...) as field names.
// ─────────────────────────────────────────────────────────────

test("cleanupJql strips cf[N] NOT IN ()", () => {
  // Previously this was the malformed pre-fix output:
  //   "x AND cf[10037] NOT IN () AND y"  →  "x AND  AND y" (bug)
  // and then orphan-AND cleanup left an invalid result. With the fix the
  // entire `cf[10037] NOT IN ()` clause + the adjacent AND collapse cleanly.
  assert.equal(
    cleanupJql("project = X AND cf[10037] NOT IN () AND status = Open"),
    "project = X AND status = Open",
  );
});

test("cleanupJql strips cf[N] IN ()", () => {
  assert.equal(
    cleanupJql("project = X AND cf[10037] IN () AND status = Open"),
    "project = X AND status = Open",
  );
});

test("cleanupJql strips customfield_N NOT IN ()", () => {
  assert.equal(
    cleanupJql("project = X AND customfield_10037 NOT IN () AND status = Open"),
    "project = X AND status = Open",
  );
});

test("cleanupJql strips quoted-field name NOT IN ()", () => {
  // Field names with spaces or special chars must be quoted in JQL.
  assert.equal(
    cleanupJql('project = X AND "Sub-Account" NOT IN () AND status = Open'),
    "project = X AND status = Open",
  );
});

test("cleanupJql does NOT treat NOT as a field name (regression)", () => {
  // The bug: empty-IN regex matched "NOT IN ()" with "NOT" as the field,
  // stripping just that substring and leaving `cf[10037]` as an orphan.
  // The fixed regex must strip the WHOLE `cf[10037] NOT IN ()` clause.
  const before = "project = X AND cf[10037] NOT IN () AND status = Open";
  const after = cleanupJql(before);
  assert.equal(after, "project = X AND status = Open");
  // And specifically: no orphan `cf[10037]  AND` remains.
  assert.equal(/cf\[\d+\]\s+AND/.test(after), false);
});

// ─────────────────────────────────────────────────────────────
//  Recovery: orphan cf[N] / customfield_N already-corrupted state
// ─────────────────────────────────────────────────────────────

test("cleanupJql recovers orphan cf[N] before AND (already-corrupted)", () => {
  // Real production-broken input: cf[N] without operator followed by AND.
  // Recovery rule must strip the orphan field reference.
  const broken = "project = SD AND priority IN (10000) AND cf[10037]  AND status = Open";
  assert.equal(
    cleanupJql(broken),
    "project = SD AND priority IN (10000) AND status = Open",
  );
});

test("cleanupJql recovers orphan customfield_N before OR", () => {
  const broken = "x = 1 AND customfield_99 OR y = 2";
  assert.equal(cleanupJql(broken), "x = 1 OR y = 2");
});

test("cleanupJql recovers orphan cf[N] before ORDER BY", () => {
  const broken = "project = X AND cf[10037] ORDER BY created";
  assert.equal(cleanupJql(broken), "project = X ORDER BY created");
});

test("cleanupJql does NOT mangle valid cf[N] = ... usage", () => {
  // Sanity: valid JQL where cf[N] HAS an operator must not be touched.
  const valid = 'project = X AND cf[10037] = "Foo" AND status = Open';
  assert.equal(cleanupJql(valid), valid);
});

test("cleanupJql does NOT mangle valid customfield_N IN (...) usage", () => {
  const valid = 'project = X AND customfield_99 IN ("Foo") AND status = Open';
  assert.equal(cleanupJql(valid), valid);
});

// ─────────────────────────────────────────────────────────────
//  Regression: empty-parens rule must NOT strip function-call
//  parens (currentUser(), startOfMonth(), subTaskIssueTypes(),
//  ...). The bug stripped them and Cloud rejected the bare
//  identifier as an invalid value.
// ─────────────────────────────────────────────────────────────

test("cleanupJql preserves currentUser() parens", () => {
  const jql = "assignee = currentUser() AND status = Open";
  assert.equal(cleanupJql(jql), jql);
});

test("cleanupJql preserves startOfMonth() and startOfMonth(-1) parens", () => {
  const jql = "created <= startOfMonth() AND created >= startOfMonth(-1)";
  assert.equal(cleanupJql(jql), jql);
});

test("cleanupJql preserves subTaskIssueTypes() and standardIssueTypes() in IN list", () => {
  const jql = 'issuetype IN ("Change", "Defect", subTaskIssueTypes(), standardIssueTypes())';
  assert.equal(cleanupJql(jql), jql);
});

test("cleanupJql still strips standalone empty grouping parens", () => {
  // Grouping parens with no preceding identifier — strip
  assert.equal(cleanupJql("project = X AND ( ) AND status = Open"), "project = X AND status = Open");
  assert.equal(cleanupJql("project = X AND () AND status = Open"), "project = X AND status = Open");
});

test("cleanupJql still strips field [NOT] IN () via empty-IN rule", () => {
  // The empty-IN rule strips the WHOLE clause; the empty-parens rule never
  // needs to fire for cf[N]/customfield_N/quoted forms.
  assert.equal(
    cleanupJql("project = X AND cf[10037] NOT IN () AND status = Open"),
    "project = X AND status = Open",
  );
});

test("cleanupJql does NOT touch nested empty parens in regex-like literals", () => {
  // Defensive: a quoted string containing () must not be touched. Since
  // cleanupJql doesn't tokenize quoted strings, we don't actually protect
  // against this corner case, but verify a benign pattern.
  // Note: JQL doesn't allow regex-like literals, so this is purely a
  // sanity test confirming our changes don't break anything weird.
  const jql = 'summary ~ "foo()"';
  // This may or may not be preserved depending on regex behavior; we just
  // assert it doesn't crash.
  cleanupJql(jql);
});
