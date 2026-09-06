const test = require("node:test");
const assert = require("node:assert");
const { cleanOrderBy, findOrderByStart, parseSortToken } = require("./orderByCleaner");

const assetNames = new Set(["development team", "affected hardware"]);

test("strips a sole ORDER BY on an asset field entirely", () => {
  const r = cleanOrderBy(
    'project = "ACME" ORDER BY "Development Team" ASC',
    { assetFieldNames: assetNames },
  );
  assert.equal(r.rewritten, 'project = "ACME"');
  assert.equal(r.stripped.length, 1);
  assert.equal(r.stripped[0].field, "Development Team");
  assert.equal(r.stripped[0].direction, "ASC");
});

test("strips one asset entry but keeps non-asset entries", () => {
  const r = cleanOrderBy(
    'project = "ACME" ORDER BY "Development Team" DESC, created DESC',
    { assetFieldNames: assetNames },
  );
  assert.equal(r.rewritten, 'project = "ACME" ORDER BY created DESC');
  assert.equal(r.stripped.length, 1);
});

test("leaves ORDER BY on a non-asset field intact", () => {
  const input = 'project = "ACME" ORDER BY created DESC';
  const r = cleanOrderBy(input, { assetFieldNames: assetNames });
  assert.equal(r.rewritten, input);
  assert.equal(r.stripped.length, 0);
});

test("case-insensitive field name match", () => {
  const r = cleanOrderBy(
    'project = "ACME" order by "development team" asc',
    { assetFieldNames: assetNames },
  );
  assert.equal(r.rewritten, 'project = "ACME"');
});

test("preserves original ORDER BY keyword casing for survivors", () => {
  const r = cleanOrderBy(
    'project = "ACME" Order By "Development Team", created',
    { assetFieldNames: assetNames },
  );
  assert.equal(r.rewritten, 'project = "ACME" Order By created');
});

test("does not strip ORDER BY substring inside a quoted value", () => {
  const r = cleanOrderBy(
    'summary ~ "set order by hand" AND "Development Team" = "Platform Squad"',
    { assetFieldNames: assetNames },
  );
  // No actual ORDER BY clause exists — the match inside quotes must be ignored.
  assert.equal(
    r.rewritten,
    'summary ~ "set order by hand" AND "Development Team" = "Platform Squad"',
  );
});

test("handles missing ORDER BY (no-op)", () => {
  const input = 'project = "ACME" AND "Development Team" = "Platform Squad"';
  const r = cleanOrderBy(input, { assetFieldNames: assetNames });
  assert.equal(r.rewritten, input);
});

test("handles asset field with spaces in name", () => {
  const r = cleanOrderBy(
    'project = ACME ORDER BY "Affected Device" DESC',
    { assetFieldNames: assetNames },
  );
  assert.equal(r.rewritten, "project = ACME");
});

test("returns input unchanged when assetFieldNames is empty", () => {
  const input = 'ORDER BY "Development Team" ASC';
  const r = cleanOrderBy(input, { assetFieldNames: new Set() });
  assert.equal(r.rewritten, input);
});

test("strips multiple asset fields in one ORDER BY", () => {
  const r = cleanOrderBy(
    'project = ACME ORDER BY "Development Team" ASC, "Affected Device" DESC, created',
    { assetFieldNames: assetNames },
  );
  assert.equal(r.rewritten, "project = ACME ORDER BY created");
  assert.equal(r.stripped.length, 2);
});

test("parseSortToken handles quoted, bare, and cf[N] forms", () => {
  assert.deepEqual(parseSortToken('"Development Team" DESC'), {
    field: "Development Team",
    direction: "DESC",
    quoted: true,
    original: '"Development Team" DESC',
  });
  assert.deepEqual(parseSortToken("created"), {
    field: "created",
    direction: "",
    quoted: false,
    original: "created",
  });
  assert.deepEqual(parseSortToken("cf[12345] ASC"), {
    field: "cf[12345]",
    direction: "ASC",
    quoted: false,
    original: "cf[12345] ASC",
  });
});

test("findOrderByStart returns -1 when ORDER BY is only in a quoted value", () => {
  assert.equal(findOrderByStart('summary ~ "order by hand"'), -1);
});

test("idempotent: second run on rewritten output strips nothing", () => {
  const r1 = cleanOrderBy(
    'project = ACME ORDER BY "Development Team", created',
    { assetFieldNames: assetNames },
  );
  const r2 = cleanOrderBy(r1.rewritten, { assetFieldNames: assetNames });
  assert.equal(r2.rewritten, r1.rewritten);
  assert.equal(r2.stripped.length, 0);
});
