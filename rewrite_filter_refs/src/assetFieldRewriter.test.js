const test = require("node:test");
const assert = require("node:assert");
const { rewriteAssetFieldRefs, classifyValueToken } = require("./assetFieldRewriter");

const baseMaps = () => ({
  assetFieldNames: new Set(["development team", "affected hardware"]),
  dcKeyToCloudName: new Map([
    ["CMDB-21171", "Platform Squad"],
    ["HW-1", "Device A"],
    ["HW-2", "Device B"],
  ]),
  dcObjectIdToCloudName: new Map([
    ["14032", "Platform Squad"],
    ["14033", "Delivery Squad"],
  ]),
  cloudObjectIdToCloudName: new Map([
    ["27118", "Platform Squad"],
    ["27200", "Operations"],
  ]),
  cloudKeyToCloudName: new Map([["CMDB-14544", "Platform Squad"]]),
});

test("rewrites quoted field with DC numeric ID value to cloud name", () => {
  const opts = baseMaps();
  const r = rewriteAssetFieldRefs(
    '"Development Team" = 14032',
    opts,
  );
  assert.equal(r.rewritten, '"Development Team" = "Platform Squad"');
  assert.equal(r.replacements.length, 1);
  assert.equal(r.replacements[0].cloudName, "Platform Squad");
  assert.equal(r.replacements[0].form, "numeric");
});

test("rewrites quoted field with DC key value to cloud name", () => {
  const opts = baseMaps();
  const r = rewriteAssetFieldRefs(
    '"Development Team" = "CMDB-21171"',
    opts,
  );
  assert.equal(r.rewritten, '"Development Team" = "Platform Squad"');
});

test("rewrites ARI form to cloud name via cloudObjectIdToCloudName", () => {
  const opts = baseMaps();
  const r = rewriteAssetFieldRefs(
    '"Development Team" = "ari:cloud:cmdb:00000010-0000-4000-8000-000000000010:object/27118"',
    opts,
  );
  assert.equal(r.rewritten, '"Development Team" = "Platform Squad"');
  assert.equal(r.replacements[0].form, "ari");
});

test("rewrites IN-list with mixed values (numeric, key, ari)", () => {
  const opts = baseMaps();
  const input =
    '"Development Team" IN (14032, "CMDB-21171", "ari:cloud:cmdb:ws/27200")';
  const r = rewriteAssetFieldRefs(input, opts);
  assert.equal(
    r.rewritten,
    '"Development Team" IN ("Platform Squad", "Platform Squad", "Operations")',
  );
  assert.equal(r.replacements.length, 3);
});

test("rewrites NOT IN list and preserves operator casing", () => {
  const opts = baseMaps();
  const r = rewriteAssetFieldRefs(
    '"Affected Device" NOT IN ("HW-1", "HW-2")',
    opts,
  );
  assert.equal(
    r.rewritten,
    '"Affected Device" NOT IN ("Device A", "Device B")',
  );
});

test("leaves text inside aqlFunction(...) untouched", () => {
  const opts = baseMaps();
  const input =
    '"Development Team" IN aqlFunction("Key = \\"CMDB-21171\\"")';
  const r = rewriteAssetFieldRefs(input, opts);
  assert.equal(r.rewritten, input);
  assert.equal(r.replacements.length, 0);
});

test("does not rewrite non-asset fields", () => {
  const opts = baseMaps();
  const input = 'project = "ACME" AND "Some Other Field" = "CMDB-21171"';
  const r = rewriteAssetFieldRefs(input, opts);
  assert.equal(r.rewritten, input);
});

test("passes through values that already look like names", () => {
  const opts = baseMaps();
  const input = '"Development Team" = "Platform Squad"';
  const r = rewriteAssetFieldRefs(input, opts);
  assert.equal(r.rewritten, input);
  assert.equal(r.replacements.length, 0);
});

test("records unresolved values when the maps have no entry", () => {
  const opts = baseMaps();
  const r = rewriteAssetFieldRefs('"Development Team" = 99999', opts);
  assert.equal(r.rewritten, '"Development Team" = 99999');
  assert.equal(r.unresolved.length, 1);
  assert.ok(r.unresolved[0].includes("99999"));
});

test("handles != operator", () => {
  const opts = baseMaps();
  const r = rewriteAssetFieldRefs(
    '"Development Team" != "CMDB-21171"',
    opts,
  );
  assert.equal(r.rewritten, '"Development Team" != "Platform Squad"');
});

test("returns input unchanged when assetFieldNames is empty", () => {
  const r = rewriteAssetFieldRefs(
    '"Development Team" = 14032',
    { assetFieldNames: new Set() },
  );
  assert.equal(r.rewritten, '"Development Team" = 14032');
});

test("works in a larger JQL with conjunctions", () => {
  const opts = baseMaps();
  const input =
    'project = "ACME" AND "Development Team" = 14032 AND status != Closed ORDER BY created DESC';
  const r = rewriteAssetFieldRefs(input, opts);
  assert.equal(
    r.rewritten,
    'project = "ACME" AND "Development Team" = "Platform Squad" AND status != Closed ORDER BY created DESC',
  );
});

test("classifyValueToken correctly identifies value kinds", () => {
  assert.equal(classifyValueToken("14032").kind, "numeric");
  assert.equal(classifyValueToken('"CMDB-21171"').kind, "key");
  assert.equal(classifyValueToken('"ari:cloud:cmdb:ws/27118"').kind, "ari");
  assert.equal(classifyValueToken('"Platform Squad"').kind, "name");
  assert.equal(classifyValueToken("").kind, "empty");
});

test("respects case-insensitive field name matching", () => {
  const opts = baseMaps();
  const r = rewriteAssetFieldRefs(
    '"DEVELOPMENT TEAM" = 14032',
    opts,
  );
  assert.equal(r.rewritten, '"DEVELOPMENT TEAM" = "Platform Squad"');
});

test("DC key fallback to cloudKeyToCloudName if dcKeyToCloudName has no entry", () => {
  const opts = baseMaps();
  // CMDB-14544 is a Cloud-side key not present in dcKeyToCloudName
  const r = rewriteAssetFieldRefs(
    '"Development Team" = "CMDB-14544"',
    opts,
  );
  assert.equal(r.rewritten, '"Development Team" = "Platform Squad"');
});

test("rewrites DC display form 'Name (CI-NNNN)' by resolving the bracketed key", () => {
  const opts = baseMaps();
  const r = rewriteAssetFieldRefs(
    '"Development Team" = "Region Two (CMDB-21171)"',
    opts,
  );
  assert.equal(r.rewritten, '"Development Team" = "Platform Squad"');
  assert.equal(r.replacements[0].form, "keyed-key");
});

test("rewrites IN-list of 'Name (CI-N)' tokens", () => {
  const opts = baseMaps();
  opts.dcKeyToCloudName.set("CMDB-7960", "Region Two");
  opts.dcKeyToCloudName.set("CMDB-7980", "Region Four");
  const r = rewriteAssetFieldRefs(
    '"Affected Device" IN ("Region Two (CMDB-7960)", "Region Four (CMDB-7980)")',
    opts,
  );
  assert.equal(
    r.rewritten,
    '"Affected Device" IN ("Region Two", "Region Four")',
  );
});

test("keyed-numeric form: 'Name (12345)' falls back to dcObjectIdToCloudName", () => {
  const opts = baseMaps();
  const r = rewriteAssetFieldRefs(
    '"Development Team" = "Some Team (14032)"',
    opts,
  );
  assert.equal(r.rewritten, '"Development Team" = "Platform Squad"');
  assert.equal(r.replacements[0].form, "keyed-numeric");
});

test("keyed-name with no map entry stays as-is", () => {
  const opts = baseMaps();
  const r = rewriteAssetFieldRefs(
    '"Development Team" = "Unknown (CMDB-99999)"',
    opts,
  );
  assert.equal(r.rewritten, '"Development Team" = "Unknown (CMDB-99999)"');
  assert.equal(r.unresolved.length, 1);
});

test("plain 'Name (something)' (not a key/numeric inside parens) is pass-through", () => {
  const opts = baseMaps();
  const r = rewriteAssetFieldRefs(
    '"Development Team" = "Foo (Bar)"',
    opts,
  );
  assert.equal(r.rewritten, '"Development Team" = "Foo (Bar)"');
});

// ─── Collision-aware tests ──────────────────────────────────────────────
//
// These cover the case where two Cloud Assets objects share the same name.
// Plain `Field = "Name"` is ambiguous on Cloud's JQL parser in that scenario,
// so we must emit ARI form for the specific objectIds involved.

const WS = "00000011-0000-4000-8000-000000000011";

function withCollision(opts) {
  // Two distinct Cloud objectIds both named "VendorOne".
  opts.cloudObjectIdToCloudName.set("50582", "VendorOne");
  opts.cloudObjectIdToCloudName.set("51074", "VendorOne");
  opts.cloudNameToCloudObjectIds = new Map([
    ["vendorone", ["50582", "51074"]],
  ]);
  opts.workspaceId = WS;
  // Add an asset field that uses the colliding name.
  opts.assetFieldNames = new Set([
    ...opts.assetFieldNames,
    "product suite/s (tsd)",
  ]);
  return opts;
}

test("FIX-MODE: bare name with multiple cloud objects is left UNCHANGED (no auto-broadening)", () => {
  const opts = withCollision(baseMaps());
  const input =
    'project = SD AND "Product Line" = "VendorOne" AND status NOT IN ("Closed", "Resolved")';
  const r = rewriteAssetFieldRefs(input, opts);
  // Bare-name tokens are NEVER auto-expanded. The filter was written with a
  // plain name; we don't know which specific object the author meant, so
  // we don't change it. (To get ARI emission, run against the DC original
  // which retains the (CI-NNN) form.)
  assert.equal(r.rewritten, input);
  assert.equal(r.ariCollisions.length, 0);
});

test("FIX-MODE: bare name with != is left unchanged too", () => {
  const opts = withCollision(baseMaps());
  const input = '"Product Line" != "VendorOne"';
  const r = rewriteAssetFieldRefs(input, opts);
  assert.equal(r.rewritten, input);
  assert.equal(r.ariCollisions.length, 0);
});

test("FIX-MODE: single keyed token whose cloud name is globally ambiguous → still resolves to plain name (NOT ARI)", () => {
  // Strict per-filter rule: a single keyed token is never ambiguous IN THIS
  // FILTER, no matter how many cloud objects share its name globally. The
  // rewriter resolves to the plain name. (The filter may still be ambiguous
  // on Cloud — that's a Cloud-Assets problem to fix manually, not by
  // broadening this filter's semantics.)
  const opts = withCollision(baseMaps());
  opts.dcKeyToCloudName.set("CMDB-22856", "VendorOne");
  opts.dcKeyToCloudObjectId = new Map([["CMDB-22856", "50582"]]);
  const r = rewriteAssetFieldRefs(
    '"Product Line" = "VendorOne (CMDB-22856)"',
    opts,
  );
  assert.equal(r.rewritten, '"Product Line" = "VendorOne"');
  assert.equal(r.ariCollisions.length, 0);
});

test("STRICT per-name: only duplicate-name tokens become ARI, others resolve to plain name", () => {
  // Acme Retail x2 (same name, distinct keys) → ARI for those two.
  // Acme Retail (Standard) is a DIFFERENT cloud name → resolves to plain
  // name, NOT ARI'd, even though it sits in the same filter.
  const opts = withCollision(baseMaps());
  opts.assetFieldNames = new Set([
    ...opts.assetFieldNames,
    "operator/s (tsd)",
    "sub-operator/s (tsd)",
  ]);
  opts.dcKeyToCloudName.set("CMDB-8526", "Acme Retail");
  opts.dcKeyToCloudName.set("CMDB-9726", "Acme Retail");
  opts.dcKeyToCloudName.set("CMDB-12970", "Acme Retail (Standard)");
  opts.dcKeyToCloudObjectId = new Map([
    ["CMDB-8526", "43506"],
    ["CMDB-9726", "43507"],
    ["CMDB-12970", "45124"],
  ]);
  const r = rewriteAssetFieldRefs(
    '"Operator/s (SD)" = "Acme Retail (CMDB-8526)" AND "Sub-Account" IN ("Acme Retail (CMDB-9726)", "Acme Retail (Standard) (CMDB-12970)")',
    opts,
  );
  assert.equal(
    r.rewritten,
    `"Operator/s (SD)" = "ari:cloud:cmdb::object/${WS}/43506" AND "Sub-Account" IN ("ari:cloud:cmdb::object/${WS}/43507", "Acme Retail (Standard)")`,
  );
});

test("STRICT per-name: OperatorOne regression — only duplicate OperatorOne tokens become ARI", () => {
  // DC IN-list with 5 distinct names: OperatorOne (x2 — duplicates), OperatorOne
  // REGION ONE (unique), OperatorOne.usnj (unique), OperatorTwo REGION ONE (unique).
  // Only the two duplicate-named OperatorOne tokens get ARI; the others resolve
  // to plain names.
  const opts = baseMaps();
  opts.assetFieldNames = new Set([
    ...opts.assetFieldNames,
    "operator/s (tsd)",
  ]);
  opts.dcKeyToCloudName.set("CMDB-8330", "OperatorOne");
  opts.dcKeyToCloudName.set("CMDB-9194", "OperatorOne");
  opts.dcKeyToCloudName.set("CMDB-9193", "OperatorOne REGION ONE");
  opts.dcKeyToCloudName.set("CMDB-9195", "OperatorOne.usnj");
  opts.dcKeyToCloudName.set("CMDB-9196", "OperatorTwo REGION ONE");
  opts.dcKeyToCloudObjectId = new Map([
    ["CMDB-8330", "47574"],
    ["CMDB-9194", "47574"],   // sibling map collapses to same id
    ["CMDB-9193", "46238"],
    ["CMDB-9195", "47504"],
    ["CMDB-9196", "46370"],
  ]);
  opts.workspaceId = WS;
  const r = rewriteAssetFieldRefs(
    '"Operator/s (SD)" in ("OperatorOne (CMDB-8330)","OperatorOne (CMDB-9194)","OperatorOne REGION ONE (CMDB-9193)","OperatorOne.usnj (CMDB-9195)","OperatorTwo REGION ONE (CMDB-9196)")',
    opts,
  );
  assert.equal(
    r.rewritten,
    `"Operator/s (SD)" in ("ari:cloud:cmdb::object/${WS}/47574","ari:cloud:cmdb::object/${WS}/47574","OperatorOne REGION ONE","OperatorOne.usnj","OperatorTwo REGION ONE")`,
  );
});

test("FIX-MODE: keyed token whose cloud name is UNIQUE → resolves to plain name (no ARI)", () => {
  const opts = withCollision(baseMaps());
  opts.cloudObjectIdToCloudName.set("99001", "SampleProduct");
  opts.cloudNameToCloudObjectIds.set("sampleproduct", ["99001"]);
  opts.dcKeyToCloudName.set("CMDB-77", "SampleProduct");
  opts.dcKeyToCloudObjectId = new Map([["CMDB-77", "99001"]]);
  const r = rewriteAssetFieldRefs(
    '"Product Line" = "SampleProduct (CMDB-77)"',
    opts,
  );
  assert.equal(r.rewritten, '"Product Line" = "SampleProduct"');
  assert.equal(r.ariCollisions.length, 0);
});

test("FIX-MODE: bare name (single or multiple cloud match) is left unchanged", () => {
  const opts = withCollision(baseMaps());
  opts.cloudObjectIdToCloudName.set("99001", "SampleProduct");
  opts.cloudNameToCloudObjectIds.set("sampleproduct", ["99001"]);
  const r = rewriteAssetFieldRefs(
    '"Product Line" = "SampleProduct"',
    opts,
  );
  assert.equal(r.rewritten, '"Product Line" = "SampleProduct"');
});

test("Case B: two DC-keyed tokens in OR resolving to same name → each becomes its own ARI", () => {
  const opts = withCollision(baseMaps());
  // Two different DC keys, both resolving to "VendorOne" but distinct objectIds.
  opts.dcKeyToCloudName.set("CMDB-12345", "VendorOne");
  opts.dcKeyToCloudName.set("CMDB-45678", "VendorOne");
  opts.dcKeyToCloudObjectId = new Map([
    ["CMDB-12345", "50582"],
    ["CMDB-45678", "51074"],
  ]);
  const r = rewriteAssetFieldRefs(
    '"Product Line" = "CMDB-12345" OR "Product Line" = "CMDB-45678"',
    opts,
  );
  assert.equal(
    r.rewritten,
    `"Product Line" = "ari:cloud:cmdb::object/${WS}/50582" OR "Product Line" = "ari:cloud:cmdb::object/${WS}/51074"`,
  );
});

test("Case B: two Name (CI-N) tokens in IN list → both become ARIs inside IN", () => {
  const opts = withCollision(baseMaps());
  opts.dcKeyToCloudName.set("CMDB-12345", "VendorOne");
  opts.dcKeyToCloudName.set("CMDB-45678", "VendorOne");
  opts.dcKeyToCloudObjectId = new Map([
    ["CMDB-12345", "50582"],
    ["CMDB-45678", "51074"],
  ]);
  const r = rewriteAssetFieldRefs(
    '"Product Line" IN ("VendorOne (CMDB-12345)", "VendorOne (CMDB-45678)")',
    opts,
  );
  assert.equal(
    r.rewritten,
    `"Product Line" IN ("ari:cloud:cmdb::object/${WS}/50582", "ari:cloud:cmdb::object/${WS}/51074")`,
  );
});

test("FIX-MODE: IN-list of bare names — all left as-is (no auto-expansion)", () => {
  const opts = withCollision(baseMaps());
  opts.cloudObjectIdToCloudName.set("99001", "SampleProduct");
  opts.cloudNameToCloudObjectIds.set("sampleproduct", ["99001"]);
  const r = rewriteAssetFieldRefs(
    '"Product Line" IN ("VendorOne", "SampleProduct")',
    opts,
  );
  // Both bare-name tokens stay unchanged. To rewrite, the filter must use
  // keyed form (e.g. "VendorOne (CMDB-22856)") so we know which specific cloud
  // object was intended.
  assert.equal(r.rewritten, '"Product Line" IN ("VendorOne", "SampleProduct")');
});

test("Collision logic stays OFF when workspaceId is missing (legacy callers)", () => {
  const opts = baseMaps();
  opts.cloudObjectIdToCloudName.set("50582", "VendorOne");
  opts.cloudObjectIdToCloudName.set("51074", "VendorOne");
  opts.cloudNameToCloudObjectIds = new Map([["vendorone", ["50582", "51074"]]]);
  opts.assetFieldNames = new Set([
    ...opts.assetFieldNames,
    "product suite/s (tsd)",
  ]);
  // No workspaceId provided.
  const r = rewriteAssetFieldRefs(
    '"Product Line" = "VendorOne"',
    opts,
  );
  // Same as input — collision-aware path is gated off.
  assert.equal(r.rewritten, '"Product Line" = "VendorOne"');
});

test("TYPE-AWARE: keyed token with multiple type-matched cloud candidates emits multi-ARI when filter is also Case-B", () => {
  // Sub-Operator/s field has TWO tokens of the same DC name (Acme Retail)
  // but different keys (CMDB-9726, CMDB-8526). CMDB-9726 maps to two cloud Sub-Op
  // candidates after type-aware enrichment (48333 and 48350) — within-type
  // ambiguity. The rewriter should emit BOTH ARIs for the multi-candidate
  // token, plus a single ARI for the unique-candidate token, because Case B
  // is satisfied (≥2 distinct DC keys for the same name).
  const opts = withCollision(baseMaps());
  opts.assetFieldNames = new Set([
    ...opts.assetFieldNames,
    "sub-operator/s (tsd)",
  ]);
  opts.dcKeyToCloudName.set("CMDB-9726", "Acme Retail");
  opts.dcKeyToCloudName.set("CMDB-8527", "Acme Retail");
  opts.dcKeyToCloudObjectId = new Map([
    ["CMDB-9726", "48333"],
    ["CMDB-8527", "48999"],
  ]);
  opts.dcKeyToCloudObjectIdsMulti = new Map([
    ["CMDB-9726", ["48333", "48350"]],
  ]);
  const r = rewriteAssetFieldRefs(
    '"Sub-Account" IN ("Acme Retail (CMDB-9726)", "Acme Retail (CMDB-8527)")',
    opts,
  );
  assert.equal(
    r.rewritten,
    `"Sub-Account" IN ("ari:cloud:cmdb::object/${WS}/48333", "ari:cloud:cmdb::object/${WS}/48350", "ari:cloud:cmdb::object/${WS}/48999")`,
  );
});

test("Per-filter scope: state does not leak between independent calls", () => {
  // Two separate JQL strings should each be analysed in their own scope.
  const opts = withCollision(baseMaps());
  opts.dcKeyToCloudName.set("CMDB-12345", "VendorOne");
  opts.dcKeyToCloudName.set("CMDB-45678", "VendorOne");
  opts.dcKeyToCloudObjectId = new Map([
    ["CMDB-12345", "50582"],
    ["CMDB-45678", "51074"],
  ]);
  // Filter 1 has TWO keyed tokens with same name → ambiguous → ARI emission.
  const r1 = rewriteAssetFieldRefs(
    '"Product Line" = "VendorOne (CMDB-12345)" OR "Product Line" = "VendorOne (CMDB-45678)"',
    opts,
  );
  assert.ok(r1.rewritten.includes("ari:cloud:cmdb::object"));
  // Filter 2 has only one keyed token → not ambiguous → no ARI.
  const r2 = rewriteAssetFieldRefs(
    '"Product Line" = "VendorOne (CMDB-12345)"',
    opts,
  );
  assert.equal(r2.rewritten, '"Product Line" = "VendorOne"');
});
