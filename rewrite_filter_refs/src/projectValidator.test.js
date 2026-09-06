const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildKnownProjectSet,
  detectMissingProjects,
  pruneMissingProjectsFromInLists,
} = require("./projectValidator");

const known = buildKnownProjectSet([
  { id: 10000, key: "FE", name: "Acme Front End" },
  { id: 10001, key: "ENG", name: "Engineering" },
]);

test("buildKnownProjectSet folds key + name + id, lowercased", () => {
  assert.ok(known.has("obfe"));
  assert.ok(known.has("Acme Front End"));
  assert.ok(known.has("10000"));
});

test("detectMissingProjects finds missing keys in equality form", () => {
  const out = detectMissingProjects("project = AGILE", known);
  assert.deepEqual(out, ["AGILE"]);
});

test("detectMissingProjects finds missing names (quoted)", () => {
  const out = detectMissingProjects('project = "Reporting Platform"', known);
  assert.deepEqual(out, ["Reporting Platform"]);
});

test("detectMissingProjects finds missing values in IN list and ignores valid ones", () => {
  const out = detectMissingProjects(
    "project IN (FE, PLATFORM, CONTENT, ENG)",
    known,
  );
  assert.deepEqual(out.sort(), ["PLATFORM", "CONTENT"].sort());
});

test("detectMissingProjects returns [] when all projects valid", () => {
  const out = detectMissingProjects(
    "project IN (FE, ENG) AND status = Open",
    known,
  );
  assert.deepEqual(out, []);
});

test("detectMissingProjects ignores 'project' tokens inside quoted values", () => {
  // "project" appears inside a quoted summary search — not a field reference.
  const out = detectMissingProjects(
    'summary ~ "the project = CORE thing"',
    known,
  );
  assert.deepEqual(out, []);
});

test("pruneMissingProjectsFromInLists drops only missing values", () => {
  const r = pruneMissingProjectsFromInLists(
    "project IN (FE, PLATFORM, ENG) AND labels = foo",
    known,
  );
  assert.equal(r.rewritten, "project IN (FE, ENG) AND labels = foo");
  assert.deepEqual(r.dropped, ["PLATFORM"]);
});

test("pruneMissingProjectsFromInLists returns null when all values missing", () => {
  const r = pruneMissingProjectsFromInLists(
    "project IN (FOO, BAR, BAZ) AND labels = x",
    known,
  );
  assert.equal(r.rewritten, null);
  assert.equal(r.missingValues.length, 3);
});

test("pruneMissingProjectsFromInLists flags equality miss but does NOT rewrite", () => {
  const r = pruneMissingProjectsFromInLists(
    "project = AGILE AND status = Open",
    known,
  );
  assert.ok(r.hasEqualityMiss);
  // equality form left unchanged — caller should mark filter as skipped
  assert.equal(r.rewritten, "project = AGILE AND status = Open");
});

test("pruneMissingProjectsFromInLists preserves quoted multi-word names", () => {
  const r = pruneMissingProjectsFromInLists(
    'project IN (FE, "Reporting Platform", ENG)',
    known,
  );
  assert.equal(r.rewritten, "project IN (FE, ENG)");
  assert.deepEqual(r.dropped, ["Reporting Platform"]);
});

test("pruneMissingProjectsFromInLists no-op when known set empty", () => {
  const r = pruneMissingProjectsFromInLists(
    "project IN (FOO)",
    new Set(),
  );
  assert.equal(r.rewritten, "project IN (FOO)");
});
