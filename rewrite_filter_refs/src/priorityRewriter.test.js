const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  rewritePriorityValues,
  splitTopLevelCommas,
} = require("./priorityRewriter");

// Standard fixture: a tenant where every priority was renamed in the Cloud
// UI to a "P<n> - <DC-name>" form. Keys are normalized (lowercased + NFC +
// trimmed) — that's what buildPriorityMap produces.
function makeMap() {
  return new Map([
    ["critical", "P0 - Critical"],
    ["high", "P1 - High"],
    ["medium", "P2 - Medium"],
    ["low", "P3 - Low"],
    ["blocker", "P0 - Blocker"],
  ]);
}

test("bare equality value gets quoted on output when name has whitespace", () => {
  const r = rewritePriorityValues("priority = High", {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, 'priority = "P1 - High"');
  assert.equal(r.replacements.length, 1);
  assert.equal(r.replacements[0].from, "High");
  assert.equal(r.replacements[0].to, "P1 - High");
});

test("already-quoted equality value rewritten and re-quoted", () => {
  const r = rewritePriorityValues('priority = "High"', {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, 'priority = "P1 - High"');
});

test("inequality is also rewritten", () => {
  const r = rewritePriorityValues("priority != Low", {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, 'priority != "P3 - Low"');
  assert.equal(r.replacements[0].form, "!=");
});

test("IN list with mix of bare + quoted values", () => {
  const r = rewritePriorityValues('priority IN (High, "Medium")', {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, 'priority IN ("P1 - High", "P2 - Medium")');
  assert.equal(r.replacements.length, 2);
  assert.ok(r.replacements.every((rep) => rep.form === "IN"));
});

test("NOT IN list rewritten", () => {
  const r = rewritePriorityValues("priority NOT IN (Critical, Blocker)", {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(
    r.rewritten,
    'priority NOT IN ("P0 - Critical", "P0 - Blocker")',
  );
  assert.ok(r.replacements.every((rep) => rep.form === "NOT IN"));
});

test("numeric ID form is left untouched", () => {
  const r = rewritePriorityValues("priority = 1", {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, "priority = 1");
  assert.equal(r.replacements.length, 0);
});

test("numeric tokens inside IN list also untouched", () => {
  const r = rewritePriorityValues("priority IN (1, 2, High)", {
    dcNameToCloudName: makeMap(),
  });
  // Numeric tokens preserved; only the bare name is rewritten.
  assert.equal(r.rewritten, 'priority IN (1, 2, "P1 - High")');
});

test("unknown priority value left untouched (no map entry)", () => {
  const r = rewritePriorityValues("priority = Trivial", {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, "priority = Trivial");
  assert.equal(r.replacements.length, 0);
});

test("identity map entry produces no replacement", () => {
  const map = new Map([["high", "High"]]);
  const r = rewritePriorityValues("priority = High", {
    dcNameToCloudName: map,
  });
  assert.equal(r.rewritten, "priority = High");
  assert.equal(r.replacements.length, 0);
});

test("priority IS EMPTY left untouched", () => {
  const r = rewritePriorityValues("priority IS EMPTY", {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, "priority IS EMPTY");
  assert.equal(r.replacements.length, 0);
});

test("priority IS NOT EMPTY left untouched", () => {
  const r = rewritePriorityValues("priority IS NOT EMPTY", {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, "priority IS NOT EMPTY");
  assert.equal(r.replacements.length, 0);
});

test("ORDER BY priority left untouched", () => {
  const r = rewritePriorityValues("project = FOO ORDER BY priority DESC", {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, "project = FOO ORDER BY priority DESC");
  assert.equal(r.replacements.length, 0);
});

test("priority WAS / CHANGED operators left untouched (v1 scope)", () => {
  const r1 = rewritePriorityValues("priority WAS High", {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r1.rewritten, "priority WAS High");
  assert.equal(r1.replacements.length, 0);

  const r2 = rewritePriorityValues(
    "priority CHANGED FROM High TO Low",
    { dcNameToCloudName: makeMap() },
  );
  assert.equal(r2.rewritten, "priority CHANGED FROM High TO Low");
  assert.equal(r2.replacements.length, 0);
});

test("quoted priority field token works the same", () => {
  const r = rewritePriorityValues('"priority" = High', {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, '"priority" = "P1 - High"');
});

test("case-insensitive field name and value lookup", () => {
  const r = rewritePriorityValues("Priority = HIGH AND PRIORITY = low", {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(
    r.rewritten,
    'Priority = "P1 - High" AND PRIORITY = "P3 - Low"',
  );
});

test("priority clause embedded in a larger expression", () => {
  const r = rewritePriorityValues(
    'project = FOO AND priority = High AND status = "Open"',
    { dcNameToCloudName: makeMap() },
  );
  assert.equal(
    r.rewritten,
    'project = FOO AND priority = "P1 - High" AND status = "Open"',
  );
});

test("value appearing as a string literal is not affected (different field)", () => {
  // `summary ~ "High"` references a string literal `"High"`, not the
  // priority field. Our regex only matches values directly following a
  // `priority` field token.
  const r = rewritePriorityValues('summary ~ "High"', {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, 'summary ~ "High"');
  assert.equal(r.replacements.length, 0);
});

test("priority appearing as a value (not field) is not affected", () => {
  // `labels = "priority"` — `"priority"` here is a value, not the field.
  // The regex pattern only matches when there's an operator AFTER priority.
  const r = rewritePriorityValues('labels = "priority"', {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, 'labels = "priority"');
});

test("empty map → no rewrites", () => {
  const r = rewritePriorityValues("priority = High", {
    dcNameToCloudName: new Map(),
  });
  assert.equal(r.rewritten, "priority = High");
  assert.equal(r.replacements.length, 0);
});

test("missing/null jql is a no-op", () => {
  const r1 = rewritePriorityValues(null, { dcNameToCloudName: makeMap() });
  assert.equal(r1.rewritten, null);
  const r2 = rewritePriorityValues("", { dcNameToCloudName: makeMap() });
  assert.equal(r2.rewritten, "");
});

test("splitTopLevelCommas respects paren depth (so function args don't split)", () => {
  // Post-tokenization input: quoted strings are already placeholders, so
  // this helper only needs paren-awareness, not quote-awareness.
  const parts = splitTopLevelCommas("High, currentUser(), Low");
  assert.deepEqual(parts, ["High", " currentUser()", " Low"]);
});

// --- false-positive regression coverage (the reason for the tokenize pass) ---

test("custom field whose name contains 'priority' is NOT rewritten", () => {
  const r = rewritePriorityValues('"Delivery Priority" = Critical', {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, '"Delivery Priority" = Critical');
  assert.equal(r.replacements.length, 0);
});

test('"Team Priority" (Forge traffic-light field) is NOT rewritten', () => {
  const r = rewritePriorityValues('"Team Priority" = High', {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, '"Team Priority" = High');
  assert.equal(r.replacements.length, 0);
});

test("priority clause INSIDE a string literal value is NOT rewritten", () => {
  // A free-text contains-search for the literal substring "priority = X"
  // must not be misread as a real priority clause.
  const r = rewritePriorityValues('summary ~ "priority = Critical"', {
    dcNameToCloudName: makeMap(),
  });
  assert.equal(r.rewritten, 'summary ~ "priority = Critical"');
  assert.equal(r.replacements.length, 0);
});

test("priority IN clause INSIDE a string literal is NOT rewritten", () => {
  // The original-implementation bug: regex matched `priority IN (Critical,
  // High)` inside the description literal and corrupted the surrounding
  // quotes. Tokenization fixes this.
  const r = rewritePriorityValues(
    'description ~ "priority IN (Critical, High)"',
    { dcNameToCloudName: makeMap() },
  );
  assert.equal(
    r.rewritten,
    'description ~ "priority IN (Critical, High)"',
  );
  assert.equal(r.replacements.length, 0);
});

test("nested function call in IN list is preserved (paren-balancing)", () => {
  // `currentUser()` is a function, not a priority name. We must not split
  // on the comma inside its arg list and we must not consume its closing
  // paren as the list's closing paren.
  const r = rewritePriorityValues(
    "priority IN (High, currentUser())",
    { dcNameToCloudName: makeMap() },
  );
  // High gets rewritten; currentUser() left alone; outer parens preserved.
  assert.equal(
    r.rewritten,
    'priority IN ("P1 - High", currentUser())',
  );
});

test("single-quoted value preserves the single-quote style", () => {
  const r = rewritePriorityValues("priority = 'High'", {
    dcNameToCloudName: makeMap(),
  });
  // Body mutated in place; quote style preserved.
  assert.equal(r.rewritten, "priority = 'P1 - High'");
});

test("two priority clauses, one IS EMPTY and one =, both handled correctly", () => {
  const r = rewritePriorityValues(
    "priority IS EMPTY OR priority = Critical",
    { dcNameToCloudName: makeMap() },
  );
  assert.equal(
    r.rewritten,
    'priority IS EMPTY OR priority = "P0 - Critical"',
  );
  assert.equal(r.replacements.length, 1);
});
