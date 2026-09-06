const test = require("node:test");
const assert = require("node:assert");
const { rewriteProjectIds } = require("./projectIdRewriter");

const map = new Map([
  ["21540", "P3"],
  ["10100", "SD"],
]);

test("rewrites quoted project equality", () => {
  const r = rewriteProjectIds('project = "21540" AND status = Open', map);
  assert.equal(r.rewritten, 'project = "P3" AND status = Open');
  assert.equal(r.replacements.length, 1);
});

test("rewrites bare numeric project equality", () => {
  const r = rewriteProjectIds("project = 21540 AND status = Open", map);
  assert.equal(r.rewritten, "project = P3 AND status = Open");
});

test("rewrites IN-list with mixed quoted and bare numerics", () => {
  const r = rewriteProjectIds(
    'project in ("21540", 10100, "Other") AND status = Open',
    map,
  );
  assert.equal(
    r.rewritten,
    'project in ("P3", SD, "Other") AND status = Open',
  );
});

test("leaves non-mapped numerics alone and reports them as unresolved", () => {
  const r = rewriteProjectIds('project = "99999"', map);
  assert.equal(r.rewritten, 'project = "99999"');
  assert.deepEqual(r.unresolved, ["99999"]);
});

test("does not touch project tokens inside string literals", () => {
  const r = rewriteProjectIds('summary ~ "project = 21540 broken"', map);
  assert.equal(r.rewritten, 'summary ~ "project = 21540 broken"');
});

test("returns input unchanged when no mapping is supplied", () => {
  const r = rewriteProjectIds('project = "21540"', null);
  assert.equal(r.rewritten, 'project = "21540"');
});

test("returns input unchanged when input is empty", () => {
  const r = rewriteProjectIds("", map);
  assert.equal(r.rewritten, "");
});

test("handles NOT IN form", () => {
  const r = rewriteProjectIds('project not in (21540, 10100)', map);
  assert.equal(r.rewritten, 'project not in (P3, SD)');
});
