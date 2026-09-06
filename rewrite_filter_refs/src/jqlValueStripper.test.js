const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseMissingFieldValues,
  stripMissingValues,
} = require("./jqlValueStripper");

// ─────────────────────────────────────────────────────────────────
// parseMissingFieldValues
// ─────────────────────────────────────────────────────────────────

test("parses single 'value does not exist for the field' message", () => {
  const out = parseMissingFieldValues({
    errorMessages: ["The value 'Transactional API' does not exist for the field 'component'."],
    errors: {},
  });
  assert.deepEqual(out, [{ field: "component", value: "Transactional API" }]);
});

test("parses multiple values from one error body (filter 27370 / 11298 fixture)", () => {
  const out = parseMissingFieldValues({
    errorMessages: [
      "The value 'Platform Reports' does not exist for the field 'component'.",
      "The value 'Bundles' does not exist for the field 'component'.",
    ],
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { field: "component", value: "Platform Reports" });
  assert.deepEqual(out[1], { field: "component", value: "Bundles" });
});

test("parses fixVersion / affectedVersion / status field errors", () => {
  const out = parseMissingFieldValues({
    errorMessages: [
      "The value 'Product A v12.6' does not exist for the field 'fixVersion'.",
      "The value 'Release 166.5.4' does not exist for the field 'affectedVersion'.",
      "The value 'Screening' does not exist for the field 'status'.",
    ],
  });
  assert.equal(out.length, 3);
  assert.equal(out[0].field, "fixVersion");
  assert.equal(out[1].field, "affectedVersion");
  assert.equal(out[2].field, "status");
});

test("parses 'value with ID' form (stale filter-by-id reference)", () => {
  const out = parseMissingFieldValues({
    errorMessages: [
      "A value with ID '50518' does not exist for the field 'filter'.",
    ],
  });
  assert.deepEqual(out, [{ field: "filter", value: "50518" }]);
});

test("parses 'option' form (custom-field options)", () => {
  const out = parseMissingFieldValues({
    errorMessages: [
      "The option 'Front End - Desktop' for field 'Capability Areas' does not exist.",
    ],
  });
  assert.deepEqual(out, [
    { field: "Capability Areas", value: "Front End - Desktop" },
  ]);
});

test("dedupes repeated (field,value) pairs", () => {
  const out = parseMissingFieldValues({
    errorMessages: [
      "The value 'X' does not exist for the field 'component'.",
      "The value 'X' does not exist for the field 'component'.",
    ],
  });
  assert.equal(out.length, 1);
});

test("returns empty list for unrelated 400 messages", () => {
  const out = parseMissingFieldValues({
    errorMessages: ["You may only create, modify or delete filters if you are the owner."],
  });
  assert.deepEqual(out, []);
});

test("accepts a plain-string error body too", () => {
  const out = parseMissingFieldValues(
    `HTTP 400: {"errorMessages":["The value 'X' does not exist for the field 'component'."]}`,
  );
  assert.deepEqual(out, [{ field: "component", value: "X" }]);
});

test("returns [] for null/empty input", () => {
  assert.deepEqual(parseMissingFieldValues(null), []);
  assert.deepEqual(parseMissingFieldValues(""), []);
  assert.deepEqual(parseMissingFieldValues({}), []);
});

// ─────────────────────────────────────────────────────────────────
// stripMissingValues — IN-list drops
// ─────────────────────────────────────────────────────────────────

test("drops a single quoted value from a NOT IN list (filter 27370 fixture)", () => {
  const r = stripMissingValues(
    'project = AcmeSports AND (component IS EMPTY OR component NOT IN ("Publication Server", "Transactional API", "Phone Betting", "Feed Handler", "Pricing Interface"))',
    [{ field: "component", value: "Transactional API" }],
  );
  assert.equal(
    r.rewritten,
    'project = AcmeSports AND (component IS EMPTY OR component NOT IN ("Publication Server", "Phone Betting", "Feed Handler", "Pricing Interface"))',
  );
  assert.deepEqual(r.dropped, [
    { field: "component", value: "Transactional API" },
  ]);
  assert.deepEqual(r.equalityMiss, []);
  assert.deepEqual(r.listsEmptied, []);
});

test("drops multiple values across the same field's IN list", () => {
  const r = stripMissingValues(
    'component in ("Platform Reports", "Other", "Bundles")',
    [
      { field: "component", value: "Platform Reports" },
      { field: "component", value: "Bundles" },
    ],
  );
  assert.equal(r.rewritten, 'component in ("Other")');
  assert.equal(r.dropped.length, 2);
});

test("drops bare unquoted values too (case-insensitive)", () => {
  const r = stripMissingValues(
    "fixVersion in (Product A v12.6, ATs, v11.7)",
    [{ field: "fixVersion", value: "ATs" }],
  );
  assert.equal(r.rewritten, "fixVersion in (Product A v12.6, v11.7)");
});

test("flags equality miss without mutating the JQL", () => {
  const r = stripMissingValues(
    "status = Screening AND project = X",
    [{ field: "status", value: "Screening" }],
  );
  // Equality clause unchanged — caller must decide (we error out)
  assert.equal(r.rewritten, "status = Screening AND project = X");
  assert.deepEqual(r.equalityMiss, [{ field: "status", value: "Screening" }]);
});

test("when the IN list becomes empty, leaves `field IN ()` for downstream cleanup", () => {
  const r = stripMissingValues(
    'project = X AND component in ("Bad")',
    [{ field: "component", value: "Bad" }],
  );
  assert.equal(r.rewritten, "project = X AND component in ()");
  assert.deepEqual(r.listsEmptied, [{ field: "component" }]);
});

test("preserves quoting/casing of a quoted field name (e.g. \"Capability Areas\")", () => {
  const r = stripMissingValues(
    '"Capability Areas" in ("Front End - Desktop", "Other")',
    [{ field: "Capability Areas", value: "Front End - Desktop" }],
  );
  assert.equal(r.rewritten, '"Capability Areas" in ("Other")');
});

test("never strips from an unrelated field's IN list", () => {
  const r = stripMissingValues(
    'project IN ("Foo") AND component IN ("Foo")',
    [{ field: "component", value: "Foo" }],
  );
  assert.match(r.rewritten, /project IN \("Foo"\)/);
  assert.match(r.rewritten, /component IN \(\)/);
});

test("no drops returns the JQL untouched", () => {
  const orig = "project = X AND component in (A, B)";
  const r = stripMissingValues(orig, []);
  assert.equal(r.rewritten, orig);
  assert.deepEqual(r.dropped, []);
});

test("input value matching is case-insensitive on both sides", () => {
  const r = stripMissingValues(
    'component in ("Transactional API", "Other")',
    [{ field: "component", value: "Transactional API" }],
  );
  assert.equal(r.rewritten, 'component in ("Other")');
});

// ─────────────────────────────────────────────────────────────────
// Equality form (post-fix)
// ─────────────────────────────────────────────────────────────────

test("detects quoted-value equality miss (filter 10206 fixture: 'Product A v12.6')", () => {
  // Was missed before because the regex used [^\s,)]+ which stops at
  // whitespace inside the quoted value.
  const r = stripMissingValues(
    'fixVersion = "Product A v12.6" AND project = X',
    [{ field: "fixVersion", value: "Product A v12.6" }],
  );
  // Default stripEquality=false → record but don't mutate
  assert.equal(r.rewritten, 'fixVersion = "Product A v12.6" AND project = X');
  assert.deepEqual(r.equalityMiss, [{ field: "fixVersion", value: "Product A v12.6" }]);
  assert.deepEqual(r.equalityStripped, []);
});

test("detects bare-value equality miss too", () => {
  const r = stripMissingValues(
    "fixVersion = ATs AND project = X",
    [{ field: "fixVersion", value: "ATs" }],
  );
  assert.deepEqual(r.equalityMiss, [{ field: "fixVersion", value: "ATs" }]);
});

test("--strip-equality-misses: drops the entire equality clause + leading AND", () => {
  const r = stripMissingValues(
    'project = X AND fixVersion = "Product A v12.6" AND status = Open',
    [{ field: "fixVersion", value: "Product A v12.6" }],
    { stripEquality: true },
  );
  assert.equal(r.rewritten, "project = X AND status = Open");
  assert.equal(r.equalityStripped.length, 1);
  assert.equal(r.equalityStripped[0].field, "fixVersion");
  assert.equal(r.equalityStripped[0].value, "Product A v12.6");
});

test("--strip-equality-misses: drops trailing equality clause (consumes trailing AND)", () => {
  const r = stripMissingValues(
    'project = X AND fixVersion = "Product A v12.6"',
    [{ field: "fixVersion", value: "Product A v12.6" }],
    { stripEquality: true },
  );
  // After surgery, cleanup of orphan AND happens in the caller via cleanupJql
  // — here we just verify the value clause is gone. Trailing AND or empty
  // string remains, both are valid inputs to cleanupJql.
  assert.doesNotMatch(r.rewritten, /fixVersion/);
  assert.equal(r.equalityStripped.length, 1);
});

test("--strip-equality-misses: handles != form too", () => {
  const r = stripMissingValues(
    'project = X AND fixVersion != "Product A v12.6" AND status = Open',
    [{ field: "fixVersion", value: "Product A v12.6" }],
    { stripEquality: true },
  );
  assert.equal(r.rewritten, "project = X AND status = Open");
  assert.equal(r.equalityStripped.length, 1);
});

test("--strip-equality-misses: multiple equality clauses for the same field both stripped", () => {
  const r = stripMissingValues(
    'project = X AND fixVersion = "v1" AND owner = me AND fixVersion = "v2"',
    [
      { field: "fixVersion", value: "v1" },
      { field: "fixVersion", value: "v2" },
    ],
    { stripEquality: true },
  );
  assert.match(r.rewritten, /project = X AND owner = me/);
  assert.doesNotMatch(r.rewritten, /fixVersion/);
  assert.equal(r.equalityStripped.length, 2);
});

test("end-to-end: parse + strip from real filter 27370 error body", () => {
  const errorBody = {
    errorMessages: [
      "The value 'Transactional API' does not exist for the field 'component'.",
    ],
    errors: {},
  };
  const drops = parseMissingFieldValues(errorBody);
  const r = stripMissingValues(
    'project = AcmeSports AND (component IS EMPTY OR component NOT IN ("Publication Server", "Transactional API", "Phone Betting", "Feed Handler", "Pricing Interface"))',
    drops,
  );
  assert.match(
    r.rewritten,
    /component NOT IN \("Publication Server", "Phone Betting", "Feed Handler", "Pricing Interface"\)/,
  );
  assert.equal(r.dropped.length, 1);
  assert.equal(r.equalityMiss.length, 0);
});
