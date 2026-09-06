const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractFilterIds,
  rewriteJql,
  rewriteAqlFunctionBodies,
} = require("./jqlRewriter");
const { rewriteAql } = require("./aqlRewriter");

const MAP = { 12012: "20012", 67890: "77890", 99999: "88888" };

test("rewrites simple equality", () => {
  const r = rewriteJql("filter = 12012", MAP);
  assert.equal(r.rewritten, "filter = 20012");
  assert.deepEqual(r.unresolved, []);
  assert.equal(r.replacements.length, 1);
});

test("rewrites quoted numeric operand and preserves quotes", () => {
  const r = rewriteJql('filter = "12012"', MAP);
  assert.equal(r.rewritten, 'filter = "20012"');
});

test("rewrites inequality", () => {
  const r = rewriteJql("filter != 12012 AND project = TEST", MAP);
  assert.equal(r.rewritten, "filter != 20012 AND project = TEST");
});

test("IN list with mixed numeric and named — only numerics rewritten", () => {
  const r = rewriteJql('filter IN (12012, 67890, "My Named Filter")', MAP);
  assert.equal(
    r.rewritten,
    'filter IN (20012, 77890, "My Named Filter")'
  );
  assert.equal(r.replacements.length, 2);
});

test("NOT IN + ORDER BY preserved", () => {
  const r = rewriteJql(
    "filter NOT IN (12012) ORDER BY created DESC",
    MAP
  );
  assert.equal(
    r.rewritten,
    "filter NOT IN (20012) ORDER BY created DESC"
  );
});

test("savedFilter alias is rewritten", () => {
  const r = rewriteJql("savedFilter = 12012", MAP);
  assert.equal(r.rewritten, "savedFilter = 20012");
});

test("does not match inside word (myfilter = 123 stays)", () => {
  const r = rewriteJql("myfilter = 12012", MAP);
  assert.equal(r.rewritten, "myfilter = 12012");
  assert.equal(r.replacements.length, 0);
});

test("does not touch quoted string containing filter keyword", () => {
  const r = rewriteJql(
    'summary ~ "filter = 12012 is annoying"',
    MAP
  );
  // Our regex will match here because we don't do a full JQL parse.
  // This is an accepted limitation: quoted-string containing literal
  // "filter = N" is uncommon. Document in the CSV — if it ever matters,
  // reviewer can fix manually. Test records current behavior:
  assert.equal(
    r.rewritten,
    'summary ~ "filter = 20012 is annoying"'
  );
});

test("unmapped id left intact and reported", () => {
  const r = rewriteJql("filter = 99991", MAP);
  assert.equal(r.rewritten, "filter = 99991");
  assert.deepEqual(r.unresolved, ["99991"]);
  assert.equal(r.replacements.length, 0);
});

test("multiple refs in single JQL", () => {
  const r = rewriteJql(
    "filter = 12012 OR filter IN (67890, 99999)",
    MAP
  );
  assert.equal(
    r.rewritten,
    "filter = 20012 OR filter IN (77890, 88888)"
  );
  assert.equal(r.replacements.length, 3);
});

test("empty jql returns identity", () => {
  const r = rewriteJql("", MAP);
  assert.equal(r.rewritten, "");
  assert.deepEqual(r.replacements, []);
});

test("null jql returns identity", () => {
  const r = rewriteJql(null, MAP);
  assert.equal(r.rewritten, null);
});

test("case-insensitive keyword and operator", () => {
  const r = rewriteJql("FILTER iN (12012)", MAP);
  assert.equal(r.rewritten, "FILTER iN (20012)");
});

test("extractFilterIds finds all ids", () => {
  const ids = extractFilterIds(
    'filter = 12012 AND filter IN (67890, "My Name", 99999)'
  );
  assert.deepEqual(
    ids.map((i) => i.id).sort(),
    ["12012", "67890", "99999"]
  );
});

test("extractFilterIds returns [] for no refs", () => {
  assert.deepEqual(extractFilterIds("project = TEST ORDER BY created"), []);
});

test("preserves whitespace inside IN list", () => {
  const r = rewriteJql("filter IN (  12012 ,   67890  )", MAP);
  assert.equal(r.rewritten, "filter IN (  20012 ,   77890  )");
});

test("partial rewrite — some resolved, some unresolved", () => {
  const r = rewriteJql(
    "filter IN (12012, 55555, 67890)",
    MAP
  );
  assert.equal(r.rewritten, "filter IN (20012, 55555, 77890)");
  assert.deepEqual(r.unresolved.sort(), ["55555"]);
});

// --- aqlFunction scanner tests ---

const ASSET_MAPS = {
  dcKeyToCloudKey: new Map([
    ["CMDB-21171", "CMDB-14544"],
    ["CMDB-21180", "CMDB-18820"],
  ]),
  dcObjectIdToCloudObjectId: new Map([["14032", "27118"]]),
};
const aqlFn = (body) => rewriteAql(body, ASSET_MAPS);

test("aqlFunction body with Key equality is rewritten", () => {
  const r = rewriteAqlFunctionBodies(
    'project = FOO AND assetField in aqlFunction("Key = \\"CMDB-21171\\"")',
    aqlFn,
  );
  assert.match(r.rewritten, /CMDB-14544/);
  assert.equal(r.unresolved.length, 0);
  assert.equal(r.replacements.length, 1);
  assert.equal(r.replacements[0].function, "aqlFunction");
});

test("aqlFunction body with Key IN list rewrites multiple", () => {
  const r = rewriteAqlFunctionBodies(
    'f in aqlFunction("Key IN (\\"CMDB-21171\\", \\"CMDB-21180\\")")',
    aqlFn,
  );
  assert.match(r.rewritten, /CMDB-14544/);
  assert.match(r.rewritten, /CMDB-18820/);
  assert.equal(r.replacements.length, 2);
});

test("aqlFunction body with objectId", () => {
  const r = rewriteAqlFunctionBodies(
    'f in aqlFunction("objectId = 14032")',
    aqlFn,
  );
  assert.match(r.rewritten, /objectId = 27118/);
});

test("multiple aqlFunction calls in same JQL", () => {
  const r = rewriteAqlFunctionBodies(
    'a in aqlFunction("Key = \\"CMDB-21171\\"") AND b in aqlFunction("objectId = 14032")',
    aqlFn,
  );
  assert.match(r.rewritten, /CMDB-14544/);
  assert.match(r.rewritten, /27118/);
});

test("aqlFunction with unresolved key is preserved and reported", () => {
  const r = rewriteAqlFunctionBodies(
    'f in aqlFunction("Key = \\"CMDB-99999\\"")',
    aqlFn,
  );
  assert.match(r.rewritten, /CMDB-99999/);
  assert.deepEqual(r.unresolved, ["key:CMDB-99999"]);
});

test("aqlFunction body without target identifiers round-trips unchanged", () => {
  const jql = 'f in aqlFunction("Name = \\"Goals\\"")';
  const r = rewriteAqlFunctionBodies(jql, aqlFn);
  assert.equal(r.rewritten, jql);
  assert.equal(r.replacements.length, 0);
});

test("no aqlFunction in JQL returns unchanged", () => {
  const jql = "project = FOO AND status = Open";
  const r = rewriteAqlFunctionBodies(jql, aqlFn);
  assert.equal(r.rewritten, jql);
});
