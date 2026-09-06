const test = require("node:test");
const assert = require("node:assert");
const { rewriteTrafficLightFields } = require("./trafficLightFieldRewriter");

const tlNames = new Set([
  "internal priority",
  "rag",
  "admin ready",
]);

test("appends .Label on IN comparison with quoted field", () => {
  const r = rewriteTrafficLightFields(
    '"Team Priority" in (Important, "Escalated")',
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(
    r.rewritten,
    '"Team Priority.Label" in (Important, "Escalated")',
  );
  assert.equal(r.replacements.length, 1);
  assert.equal(r.replacements[0].field, "Team Priority");
});

test("appends .Label on equality comparison", () => {
  const r = rewriteTrafficLightFields(
    '"Team Priority" = "Important"',
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(r.rewritten, '"Team Priority.Label" = "Important"');
});

test("appends .Label on != comparison", () => {
  const r = rewriteTrafficLightFields(
    '"Health" != "Red"',
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(r.rewritten, '"Health.Label" != "Red"');
});

test("appends .Label on NOT IN comparison", () => {
  const r = rewriteTrafficLightFields(
    '"Health" NOT IN ("Red", "Yellow")',
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(r.rewritten, '"Health.Label" NOT IN ("Red", "Yellow")');
});

test("does NOT modify IS EMPTY / IS NOT EMPTY (works fine without .Label)", () => {
  const a = rewriteTrafficLightFields(
    '"Team Priority" IS EMPTY',
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(a.rewritten, '"Team Priority" IS EMPTY');
  const b = rewriteTrafficLightFields(
    '"Team Priority" IS NOT EMPTY',
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(b.rewritten, '"Team Priority" IS NOT EMPTY');
});

test("does NOT modify when .Label already present", () => {
  const input = '"Team Priority.Label" = "Important"';
  const r = rewriteTrafficLightFields(input, { trafficLightFieldNames: tlNames });
  assert.equal(r.rewritten, input);
  assert.equal(r.replacements.length, 0);
});

test("does NOT modify when another accessor (.Color, .Order) is present", () => {
  const input = '"Team Priority.Color" = "red"';
  const r = rewriteTrafficLightFields(input, { trafficLightFieldNames: tlNames });
  assert.equal(r.rewritten, input);
});

test("does NOT modify cf[N] or customfield_N (Cloud rejects cf[N].Label syntax)", () => {
  const a = rewriteTrafficLightFields("cf[11304] = \"Important\"", {
    trafficLightFieldNames: tlNames,
  });
  assert.equal(a.rewritten, 'cf[11304] = "Important"');
  const b = rewriteTrafficLightFields("customfield_11304 = \"Important\"", {
    trafficLightFieldNames: tlNames,
  });
  assert.equal(b.rewritten, 'customfield_11304 = "Important"');
});

test("does NOT modify non-traffic-light fields", () => {
  const input = '"Some Other Field" = "Value"';
  const r = rewriteTrafficLightFields(input, { trafficLightFieldNames: tlNames });
  assert.equal(r.rewritten, input);
});

test("does NOT touch text inside aqlFunction(...)", () => {
  // aqlFunction bodies use escaped inner quotes (\" for the inner string).
  // The traffic-light rewriter must skip over this entire call so the
  // "Team Priority" inside isn't rewritten.
  const input =
    '"Asset Field" IN aqlFunction("\\"Team Priority\\" = \\"Important\\"")';
  const r = rewriteTrafficLightFields(input, { trafficLightFieldNames: tlNames });
  assert.equal(r.rewritten, input);
});

test("rewrites multiple traffic-light fields in one JQL", () => {
  const r = rewriteTrafficLightFields(
    'project = ACME AND "Team Priority" = "Important" AND "Health" IN ("Red", "Yellow")',
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(
    r.rewritten,
    'project = ACME AND "Team Priority.Label" = "Important" AND "Health.Label" IN ("Red", "Yellow")',
  );
  assert.equal(r.replacements.length, 2);
});

test("idempotent: second run on rewritten output changes nothing", () => {
  const r1 = rewriteTrafficLightFields(
    '"Team Priority" = "Important"',
    { trafficLightFieldNames: tlNames },
  );
  const r2 = rewriteTrafficLightFields(r1.rewritten, {
    trafficLightFieldNames: tlNames,
  });
  assert.equal(r2.rewritten, r1.rewritten);
  assert.equal(r2.replacements.length, 0);
});

test("returns input unchanged when trafficLightFieldNames is empty", () => {
  const input = '"Team Priority" = "Important"';
  const r = rewriteTrafficLightFields(input, {
    trafficLightFieldNames: new Set(),
  });
  assert.equal(r.rewritten, input);
});

test("case-insensitive field name match", () => {
  const r = rewriteTrafficLightFields(
    '"TEAM PRIORITY" = "Important"',
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(r.rewritten, '"TEAM PRIORITY.Label" = "Important"');
});

test("preserves rest of JQL exactly (no incidental edits)", () => {
  const input =
    'project = "ACME-1" AND assignee = currentUser() AND "Team Priority" IN (Important, "Escalated") ORDER BY created DESC';
  const r = rewriteTrafficLightFields(input, { trafficLightFieldNames: tlNames });
  assert.equal(
    r.rewritten,
    'project = "ACME-1" AND assignee = currentUser() AND "Team Priority.Label" IN (Important, "Escalated") ORDER BY created DESC',
  );
});

// ─── DC value-prefix stripping ─────────────────────────────────────

test("strips DC '(color) Label' value prefix on equality", () => {
  const r = rewriteTrafficLightFields(
    `"Team Priority" = "(yellow) Important"`,
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(r.rewritten, `"Team Priority.Label" = "Important"`);
  assert.equal(r.replacements[0].kind, "both");
  assert.equal(r.replacements[0].valueChanges.length, 1);
});

test("strips DC '(,color,) Label' value prefix on equality", () => {
  const r = rewriteTrafficLightFields(
    `"Health" = "(,yellow,) Yellow"`,
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(r.rewritten, `"Health.Label" = "Yellow"`);
});

test("strips DC prefix from each value in IN-list", () => {
  const r = rewriteTrafficLightFields(
    `"Team Priority" IN ("(yellow) Important", "(orange) Escalated", "(red) Internal P2")`,
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(
    r.rewritten,
    `"Team Priority.Label" IN ("Important", "Escalated", "Internal P2")`,
  );
  assert.equal(r.replacements[0].valueChanges.length, 3);
});

test("strips values when .Label is ALREADY present (kind: valueStrip)", () => {
  const r = rewriteTrafficLightFields(
    `"Team Priority.Label" IN ("(yellow) Important", "(orange) Escalated")`,
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(
    r.rewritten,
    `"Team Priority.Label" IN ("Important", "Escalated")`,
  );
  assert.equal(r.replacements[0].kind, "valueStrip");
});

test("leaves bare (already-correct) values untouched", () => {
  const r = rewriteTrafficLightFields(
    `"Team Priority" IN ("Important", "Escalated")`,
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(
    r.rewritten,
    `"Team Priority.Label" IN ("Important", "Escalated")`,
  );
  // valueChanges should be empty because the values were already correct
  const r2 = rewriteTrafficLightFields(r.rewritten, { trafficLightFieldNames: tlNames });
  assert.equal(r2.rewritten, r.rewritten);
});

test("does NOT strip prefix from non-traffic-light fields", () => {
  const r = rewriteTrafficLightFields(
    `"Other Field" = "(yellow) Important"`,
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(r.rewritten, `"Other Field" = "(yellow) Important"`);
});

test("idempotent on DC-prefixed values", () => {
  const r1 = rewriteTrafficLightFields(
    `"Team Priority" = "(yellow) Important"`,
    { trafficLightFieldNames: tlNames },
  );
  const r2 = rewriteTrafficLightFields(r1.rewritten, {
    trafficLightFieldNames: tlNames,
  });
  assert.equal(r2.rewritten, r1.rewritten);
  assert.equal(r2.replacements.length, 0);
});

test("leaves a value without DC prefix unchanged even on a TL field", () => {
  const r = rewriteTrafficLightFields(
    `"Team Priority.Label" = "Yellow"`,
    { trafficLightFieldNames: tlNames },
  );
  assert.equal(r.rewritten, `"Team Priority.Label" = "Yellow"`);
});

test("does NOT strip when paren content has no trailing label (e.g. just '(Bar)')", () => {
  // Defensive: only strip when paren prefix is followed by space+real-label.
  const r = rewriteTrafficLightFields(
    `"Team Priority" = "(Bar)"`,
    { trafficLightFieldNames: tlNames },
  );
  // Field gets .Label appended, value left alone (no match for the prefix pattern)
  assert.equal(r.rewritten, `"Team Priority.Label" = "(Bar)"`);
});
