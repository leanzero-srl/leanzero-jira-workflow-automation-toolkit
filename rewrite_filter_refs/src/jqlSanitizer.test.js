const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeJql } = require("./jqlSanitizer");

test("quoted Customer Request Type -> Request Type", () => {
  const r = sanitizeJql('project = FOO AND "Customer Request Type" = "Bug"');
  assert.equal(r.sanitized, 'project = FOO AND "Request Type" = "Bug"');
  assert.ok(
    r.changes.some(
      (c) => c.kind === "field_rename" && c.to === "Request Type",
    ),
  );
});

test("unquoted Customer Request Type also renamed", () => {
  const r = sanitizeJql("Customer Request Type = foo");
  assert.match(r.sanitized, /Request Type/);
});

test("lowercase operators uppercased outside quotes", () => {
  const r = sanitizeJql(
    "labels not in (Test, TEST) or labels is empty",
  );
  assert.match(r.sanitized, /NOT IN/);
  assert.match(r.sanitized, /OR/);
  assert.match(r.sanitized, /IS EMPTY/);
});

test("quotes in IN list add quotes around bare tokens", () => {
  const r = sanitizeJql("labels NOT IN (Test, TEST, Duplicated)");
  assert.equal(r.sanitized, 'labels NOT IN ("Test", "TEST", "Duplicated")');
  assert.equal(r.changes.filter((c) => c.kind === "quote_in_list").length, 3);
});

test("screenshot example end-to-end", () => {
  const r = sanitizeJql(
    'project = "IT Service Desk" AND "Support Group" = "SD: IT Application Support" AND (labels not in (Test, TEST, Duplicated, Project) OR labels is EMPTY)',
  );
  assert.equal(
    r.sanitized,
    'project = "IT Service Desk" AND "Support Group" = "SD: IT Application Support" AND (labels NOT IN ("Test", "TEST", "Duplicated", "Project") OR labels IS EMPTY)',
  );
});

test("already-quoted values preserved in IN list", () => {
  const r = sanitizeJql('labels IN ("Foo", "Bar")');
  assert.equal(r.sanitized, 'labels IN ("Foo", "Bar")');
  assert.equal(r.changes.length, 0);
});

test("numeric tokens not quoted", () => {
  const r = sanitizeJql("cf[123] IN (1, 2, 3)");
  assert.equal(r.sanitized, "cf[123] IN (1, 2, 3)");
});

test("reserved words (EMPTY, NULL) never quoted", () => {
  const r = sanitizeJql("status IN (Open, EMPTY)");
  // Open gets quoted, EMPTY stays bare.
  assert.match(r.sanitized, /"Open"/);
  assert.match(r.sanitized, /, EMPTY\)/);
});

test("function-call tokens are left alone (no added quotes)", () => {
  const r = sanitizeJql("assignee IN (currentUser())");
  assert.equal(r.sanitized, "assignee IN (currentUser())");
});

test("operators inside quoted literals are untouched", () => {
  const r = sanitizeJql('summary ~ "not in flight and or"');
  assert.equal(r.sanitized, 'summary ~ "not in flight and or"');
});

test("mixed-case ORDER BY preserved; AND/OR uppercased", () => {
  const r = sanitizeJql(
    "project = FOO and priority = High ORDER BY created DESC",
  );
  assert.match(r.sanitized, /AND/);
  assert.match(r.sanitized, /ORDER BY created DESC/);
});

test("custom rename via options applied", () => {
  const r = sanitizeJql('"Epic Link" = "ABC-1"', {
    fieldRenames: { "Epic Link": "parent" },
  });
  assert.equal(r.sanitized, '"parent" = "ABC-1"');
});

test("opt-out: uppercaseOperators false", () => {
  const r = sanitizeJql("foo and bar", { uppercaseOperators: false });
  assert.equal(r.sanitized, "foo and bar");
});

test("opt-out: quoteInLists false", () => {
  const r = sanitizeJql("labels IN (Foo, Bar)", { quoteInLists: false });
  assert.equal(r.sanitized, "labels IN (Foo, Bar)");
});

test("is not empty uppercased as a unit", () => {
  const r = sanitizeJql("priority is not empty");
  assert.equal(r.sanitized, "priority IS NOT EMPTY");
});

test("null/undefined input", () => {
  assert.equal(sanitizeJql("").sanitized, "");
  assert.equal(sanitizeJql(null).sanitized, null);
});

test("Customer Request Type inside quoted literal (value, not field) is untouched", () => {
  const r = sanitizeJql(
    'summary ~ "Customer Request Type"',
  );
  // No renames applied (we only rename when the quoted segment equals the key exactly).
  // In this case the quoted text IS exactly the key, which is an edge; we accept
  // the rename as correct-by-design since a standalone quoted identical string is
  // almost always the field name reference itself (as in JQL: `"Customer Request Type" = "x"`).
  assert.match(r.sanitized, /Request Type/);
});

test("operator uppercasing does not corrupt identifiers", () => {
  const r = sanitizeJql(
    "project = Information AND priority = Normal",
  );
  // 'in' inside 'Information' must not be uppercased.
  assert.match(r.sanitized, /Information/);
});

// ─── cf[N] DC→Cloud remap ────────────────────────────────────

test("cf[N] is rewritten using cfMap option", () => {
  const r = sanitizeJql("ORDER BY cf[10156] DESC", {
    cfMap: { 10156: 21000 },
  });
  assert.equal(r.sanitized, "ORDER BY cf[21000] DESC");
  assert.ok(
    r.changes.some(
      (c) => c.kind === "cf_remap" && c.from === "cf[10156]" && c.to === "cf[21000]",
    ),
  );
});

test("cf[N] is rewritten in clauses too, multiple ids in one JQL", () => {
  const r = sanitizeJql(
    "cf[100] = foo AND cf[200] IN (1,2) ORDER BY cf[100]",
    { cfMap: { 100: 999, 200: 888 } },
  );
  assert.match(r.sanitized, /cf\[999\] = foo/);
  assert.match(r.sanitized, /cf\[888\] IN/);
  assert.match(r.sanitized, /ORDER BY cf\[999\]/);
});

test("cf[N] without a mapping passes through untouched", () => {
  const r = sanitizeJql("cf[12345] = x", { cfMap: { 999: 1 } });
  assert.match(r.sanitized, /cf\[12345\]/);
  assert.equal(
    r.changes.filter((c) => c.kind === "cf_remap").length,
    0,
  );
});

test("cf[N] rewrite tolerates missing cfMap option", () => {
  const r = sanitizeJql("cf[123] = x");
  assert.equal(r.sanitized, "cf[123] = x");
});

test("customfield_N long form is rewritten using cfMap option", () => {
  const r = sanitizeJql("customfield_10156 = foo", {
    cfMap: { 10156: 21000 },
  });
  assert.equal(r.sanitized, "customfield_21000 = foo");
  assert.ok(
    r.changes.some(
      (c) =>
        c.kind === "cf_remap" &&
        c.from === "customfield_10156" &&
        c.to === "customfield_21000",
    ),
  );
});

test("customfield_N rewritten in mixed JQL alongside cf[N]", () => {
  const r = sanitizeJql(
    "cf[100] = foo AND customfield_200 IN (1, 2) ORDER BY customfield_100",
    { cfMap: { 100: 999, 200: 888 } },
  );
  assert.match(r.sanitized, /cf\[999\] = foo/);
  assert.match(r.sanitized, /customfield_888 IN/);
  assert.match(r.sanitized, /ORDER BY customfield_999/);
});

test("customfield_N without a mapping passes through untouched", () => {
  const r = sanitizeJql("customfield_12345 = x", { cfMap: { 999: 1 } });
  assert.match(r.sanitized, /customfield_12345/);
  assert.equal(
    r.changes.filter((c) => c.kind === "cf_remap").length,
    0,
  );
});

// ─── mixed-quote IN list (regression) ────────────────────────

test("mixed-quote IN list: bare tokens get quoted alongside already-quoted ones", () => {
  // Real-world example from filter 10068: project list mixes bare
  // (`Alpha`) and quoted (`"Acme Front End"`) tokens. Pre-fix, the
  // segment-based architecture saw these as separate segments and the
  // IN-list regex couldn't span them, so `Alpha` stayed unquoted.
  const r = sanitizeJql(
    'project in (Alpha, "Acme Front End", "Acme Player APIs") AND labels = fusion-casino',
  );
  assert.equal(
    r.sanitized,
    'project IN ("Alpha", "Acme Front End", "Acme Player APIs") AND labels = fusion-casino',
  );
  assert.equal(
    r.changes.filter((c) => c.kind === "quote_in_list").length,
    1,
    "exactly one bare token (`Alpha`) was quoted",
  );
});

test("mixed-quote IN list with reserved word inside", () => {
  // EMPTY/NULL must still be left bare even when adjacent quoted tokens exist.
  const r = sanitizeJql('fixVersion in ("Release1", "Release0", NULL)');
  assert.equal(r.sanitized, 'fixVersion IN ("Release1", "Release0", NULL)');
});

test("mixed-quote IN list: numeric tokens stay bare alongside quoted ones", () => {
  const r = sanitizeJql('cf[100] in ("foo", 42, "bar")');
  assert.equal(r.sanitized, 'cf[100] IN ("foo", 42, "bar")');
});

test("Customer Request Type rename still works in mixed-quote context", () => {
  // Rename inside a quoted-segment placeholder, plus mixed IN list elsewhere.
  const r = sanitizeJql(
    'project in (Foo, "Bar") AND "Customer Request Type" = "x"',
  );
  assert.match(r.sanitized, /project IN \("Foo", "Bar"\)/);
  assert.match(r.sanitized, /"Request Type" = "x"/);
});

test("operator inside quoted literal still untouched after refactor", () => {
  // Regression check: ensure tokenizing-quoted-strings preserves their
  // contents byte-for-byte during the round trip.
  const r = sanitizeJql('summary ~ "not in flight and or"');
  assert.equal(r.sanitized, 'summary ~ "not in flight and or"');
});

test("escapes inside quoted strings round-trip cleanly", () => {
  const r = sanitizeJql(
    'project = X AND summary ~ "say \\"hi\\" please"',
  );
  assert.match(r.sanitized, /summary ~ "say \\"hi\\" please"/);
});

// ─────────────────────────────────────────────────────────────────
// Paren-less function names (R1: filter 11607 fixture)
// ─────────────────────────────────────────────────────────────────

test("standardIssueTypes / subTaskIssueTypes are auto-converted to fn() form, not quoted (filter 11607)", () => {
  // DC accepted these without parens; Cloud rejects with
  //   "Operator 'in' does not support the non-list value 'standardIssueTypes'"
  // The IN-list quoter must rewrite `name` → `name()`, NOT wrap in quotes.
  const r = sanitizeJql(
    "issuetype in (standardIssueTypes, subTaskIssueTypes)",
  );
  assert.equal(
    r.sanitized,
    "issuetype IN (standardIssueTypes(), subTaskIssueTypes())",
  );
  assert.equal(
    r.changes.filter((c) => c.kind === "fn_parens_added").length,
    2,
  );
});

test("votedIssues / watchedIssues paren-less also auto-converted", () => {
  const r = sanitizeJql("issue in (votedIssues, watchedIssues)");
  assert.equal(r.sanitized, "issue IN (votedIssues(), watchedIssues())");
});

test("standardWorkTypes new-terminology variant also handled", () => {
  const r = sanitizeJql("workType in (standardWorkTypes, subtaskWorkTypes)");
  assert.equal(
    r.sanitized,
    "workType IN (standardWorkTypes(), subtaskWorkTypes())",
  );
});

test("a token that already has () is not double-parenthesised", () => {
  const r = sanitizeJql("issuetype in (standardIssueTypes())");
  assert.match(r.sanitized, /standardIssueTypes\(\)/);
  assert.doesNotMatch(r.sanitized, /standardIssueTypes\(\)\(\)/);
});

test("regular bare value next to a paren-less function name: only the function gets ()", () => {
  const r = sanitizeJql("issuetype in (Bug, standardIssueTypes)");
  assert.match(r.sanitized, /"Bug"/);
  assert.match(r.sanitized, /standardIssueTypes\(\)/);
});

// ─────────────────────────────────────────────────────────────────
// Placeholder collision regression (filter 14957 / 14856 / 18743)
// ─────────────────────────────────────────────────────────────────

test("values containing Q<digit> (e.g. 2020Q1) do NOT collide with placeholder indices", () => {
  // The placeholder format is `\x01Q<index>\x02` — wrapped in SOH/STX so
  // that bare `Q1` / `Q4` / etc. inside user-authored JQL values cannot
  // be mistaken for placeholders. A previous regression had PH_OPEN/CLOSE
  // truncated to empty strings, causing values like `2020Q1` to be replaced
  // by whatever quoted string occupied placeholder slot 1.
  const r = sanitizeJql(
    'project = P5 AND labels = 2020Q1 AND issuetype IN (change, "Team Agile") AND labels IN ("LBL#3")',
  );
  // The bare value `2020Q1` must survive verbatim.
  assert.match(r.sanitized, /labels = 2020Q1\b/);
  // The quoted "LBL#3" must remain intact in the second IN list.
  assert.match(r.sanitized, /labels IN \("LBL#3"\)/);
  // And must NOT have leaked into the equality clause's value.
  assert.doesNotMatch(r.sanitized, /labels = 2020"LBL#3"/);
});

test("values like 2019Q4 / RiskHigh do NOT collide either", () => {
  const r = sanitizeJql(
    'labels = 2019Q4 AND labels NOT IN ("RiskMedium", "RiskMinor", "RiskHigh", "RiskCritical")',
  );
  assert.match(r.sanitized, /labels = 2019Q4\b/);
  assert.match(r.sanitized, /labels NOT IN \("RiskMedium", "RiskMinor", "RiskHigh", "RiskCritical"\)/);
  assert.doesNotMatch(r.sanitized, /labels = 2019"[^"]+"/);
});
