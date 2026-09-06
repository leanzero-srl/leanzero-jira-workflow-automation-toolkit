const { test } = require("node:test");
const assert = require("node:assert/strict");
const { rewriteAql } = require("./aqlRewriter");

const maps = {
  dcKeyToCloudKey: new Map([
    ["CMDB-21171", "CMDB-14544"],
    ["CMDB-21180", "CMDB-18820"],
    ["CMDB-21186", "CMDB-11219"],
  ]),
  dcObjectIdToCloudObjectId: new Map([
    ["14032", "27118"],
    ["14033", "27119"],
  ]),
};

test("Key = rewrites and preserves operator", () => {
  const r = rewriteAql('Key = "CMDB-21171"', maps);
  assert.equal(r.rewritten, 'Key = "CMDB-14544"');
  assert.deepEqual(r.replacements, [
    { kind: "key", dcValue: "CMDB-21171", cloudValue: "CMDB-14544" },
  ]);
  assert.deepEqual(r.unresolved, []);
});

test("Key IN list rewrites each token", () => {
  const r = rewriteAql('Key IN ("CMDB-21171", "CMDB-21180")', maps);
  assert.equal(r.rewritten, 'Key IN ("CMDB-14544", "CMDB-18820")');
  assert.equal(r.replacements.length, 2);
  assert.deepEqual(r.unresolved, []);
});

test("Key IN with unresolved leaves token, reports unresolved", () => {
  const r = rewriteAql('Key IN ("CMDB-21171", "CMDB-99999")', maps);
  assert.equal(r.rewritten, 'Key IN ("CMDB-14544", "CMDB-99999")');
  assert.deepEqual(r.unresolved, ["key:CMDB-99999"]);
  assert.equal(r.replacements.length, 1);
});

test("objectId = rewrites numeric id", () => {
  const r = rewriteAql("objectId = 14032", maps);
  assert.equal(r.rewritten, "objectId = 27118");
});

test("objectId IN list rewrites mixed resolvable tokens", () => {
  const r = rewriteAql("objectId IN (14032, 99, 14033)", maps);
  assert.equal(r.rewritten, "objectId IN (27118, 99, 27119)");
  assert.deepEqual(r.unresolved, ["objectId:99"]);
});

test("Name filter is left untouched", () => {
  const aql = 'Name = "Goals"';
  const r = rewriteAql(aql, maps);
  assert.equal(r.rewritten, aql);
  assert.deepEqual(r.replacements, []);
});

test("compound AQL — Key + attribute — only Key rewritten", () => {
  const aql = 'Key = "CMDB-21171" AND Host.Active = true';
  const r = rewriteAql(aql, maps);
  assert.equal(r.rewritten, 'Key = "CMDB-14544" AND Host.Active = true');
});

test("case-insensitive keyword", () => {
  const r = rewriteAql('key = "CMDB-21171"', maps);
  assert.equal(r.rewritten, 'key = "CMDB-14544"');
});

test("escape round-trip inside Key string value", () => {
  const maps2 = {
    dcKeyToCloudKey: new Map([['CMDB-"quoted"', "CMDB-OK"]]),
  };
  const aql = 'Key = "CI-\\"quoted\\""';
  const r = rewriteAql(aql, maps2);
  assert.equal(r.rewritten, 'Key = "CMDB-OK"');
});

test("objectId !=", () => {
  const r = rewriteAql("objectId != 14032", maps);
  assert.equal(r.rewritten, "objectId != 27118");
});

test("empty input", () => {
  const r = rewriteAql("", maps);
  assert.equal(r.rewritten, "");
  assert.deepEqual(r.replacements, []);
  assert.deepEqual(r.unresolved, []);
});

test("null/undefined input", () => {
  const r = rewriteAql(null, maps);
  assert.equal(r.rewritten, null);
});

test("no matching identifiers returns unchanged", () => {
  const r = rewriteAql('objectType = "Server"', maps);
  assert.equal(r.rewritten, 'objectType = "Server"');
  assert.deepEqual(r.replacements, []);
});
