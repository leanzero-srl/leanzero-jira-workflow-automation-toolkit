const test = require("node:test");
const assert = require("node:assert");
const {
  pairFieldsByName,
  numericId,
  isCloudAssetField,
  isDcAssetField,
  isTrafficLightField,
  ASSET_CUSTOM_TYPE,
} = require("./fieldMapBuilder");

const TRAFFIC_LIGHT_ARI =
  "ari:cloud:ecosystem::extension/00000012-0000-4000-8000-000000000012/00000013-0000-4000-8000-000000000013/static/traffic-light-status-field-type";

const cf = (id, name, custom, schemaCustom) => ({
  id: `customfield_${id}`,
  name,
  custom: custom !== false,
  schema: schemaCustom
    ? { custom: schemaCustom, customId: id }
    : { customId: id },
});

test("pairs DC and Cloud fields by name (basic case)", () => {
  const dc = [cf(12345, "Story Points"), cf(12346, "Sprint")];
  const cloud = [cf(67890, "Story Points"), cf(67891, "Sprint")];
  const r = pairFieldsByName(dc, cloud);
  assert.equal(r.dcIdToCloudId.get("12345"), "67890");
  assert.equal(r.dcIdToCloudId.get("12346"), "67891");
  assert.equal(r.dcLongToCloudLong.get("customfield_12345"), "customfield_67890");
  assert.equal(r.dcLongToCloudLong.get("customfield_12346"), "customfield_67891");
  assert.equal(r.stats.paired, 2);
  assert.equal(r.collisions.length, 0);
});

test("normalizes names case-insensitively and via NFC", () => {
  const dc = [cf(1, "Story Points")];
  const cloud = [cf(2, "story points")]; // different case
  const r = pairFieldsByName(dc, cloud);
  assert.equal(r.dcIdToCloudId.get("1"), "2");
});

test("flags name collisions when DC has multiple fields with the same name", () => {
  const dc = [cf(1, "Team"), cf(2, "team")];
  const cloud = [cf(99, "Team")];
  const r = pairFieldsByName(dc, cloud);
  assert.equal(r.collisions.length, 1);
  assert.deepEqual(r.collisions[0].dcIds.sort(), ["1", "2"]);
  assert.deepEqual(r.collisions[0].cloudIds, ["99"]);
});

test("flags name collisions when Cloud has multiple fields with the same name", () => {
  const dc = [cf(1, "Project Lead")];
  const cloud = [cf(50, "Project Lead"), cf(51, "Project Lead")];
  const r = pairFieldsByName(dc, cloud);
  assert.equal(r.collisions.length, 1);
  assert.deepEqual(r.collisions[0].cloudIds.sort(), ["50", "51"]);
});

test("identifies Cloud Asset fields by schema.custom (cmdb-object-cftype)", () => {
  const dc = [];
  const cloud = [
    cf(101, "Development Team", true, ASSET_CUSTOM_TYPE),
    cf(102, "Affected Device", true, ASSET_CUSTOM_TYPE),
    cf(103, "Plain Multi-Select"),
  ];
  const r = pairFieldsByName(dc, cloud);
  assert.ok(r.cloudAssetFieldNames.has("development team"));
  assert.ok(r.cloudAssetFieldNames.has("affected hardware"));
  assert.ok(!r.cloudAssetFieldNames.has("plain multi-select"));
  assert.equal(r.stats.assetFields, 2);
});

test("identifies DC Insight fields by both insight schema names", () => {
  const dc = [
    cf(11, "Tenant", true, "com.riadalabs.jira.plugins.insight:rlabs-insight-object-cftype"),
    cf(12, "Linked Asset", true, "com.riadalabs.jira.plugins.insight:rlabs-insight-references-cftype"),
    cf(13, "Plain Text"),
  ];
  const cloud = [];
  const r = pairFieldsByName(dc, cloud);
  assert.ok(r.dcAssetFieldNames.has("tenant"));
  assert.ok(r.dcAssetFieldNames.has("linked ci"));
  assert.ok(!r.dcAssetFieldNames.has("plain text"));
});

test("skips system fields (no remap entry)", () => {
  const dc = [{ id: "status", name: "Status", custom: false, schema: { type: "status" } }];
  const cloud = [{ id: "status", name: "Status", custom: false, schema: { type: "status" } }];
  const r = pairFieldsByName(dc, cloud);
  assert.equal(r.dcIdToCloudId.size, 0);
});

test("Cloud-only fields appear in cloudNameToCloudId but produce no pair", () => {
  const dc = [];
  const cloud = [cf(99, "New Cloud-Only Field")];
  const r = pairFieldsByName(dc, cloud);
  assert.equal(r.dcIdToCloudId.size, 0);
  assert.equal(r.cloudNameToCloudId.get("new cloud-only field"), "99");
});

test("DC-only fields produce no pair (Cloud doesn't have the field)", () => {
  const dc = [cf(99, "Deprecated DC Field")];
  const cloud = [];
  const r = pairFieldsByName(dc, cloud);
  assert.equal(r.dcIdToCloudId.size, 0);
});

test("does not emit a self-pair when DC id and Cloud id coincide", () => {
  const dc = [cf(12345, "Sprint")];
  const cloud = [cf(12345, "Sprint")];
  const r = pairFieldsByName(dc, cloud);
  assert.equal(r.dcIdToCloudId.has("12345"), false);
});

test("numericId tolerates customfield_N, cf[N], and bare N", () => {
  assert.equal(numericId("customfield_123"), "123");
  assert.equal(numericId("cf[456]"), "456");
  assert.equal(numericId("789"), "789");
  assert.equal(numericId("garbage"), null);
  assert.equal(numericId(null), null);
});

test("isCloudAssetField / isDcAssetField check schema.custom", () => {
  assert.ok(isCloudAssetField(cf(1, "X", true, ASSET_CUSTOM_TYPE)));
  assert.ok(!isCloudAssetField(cf(1, "X")));
  assert.ok(isDcAssetField(cf(1, "X", true, "com.riadalabs.jira.plugins.insight:rlabs-insight-object-cftype")));
  assert.ok(!isDcAssetField(cf(1, "X")));
});

test("identifies Forge traffic-light fields by ARI suffix", () => {
  const dc = [];
  const cloud = [
    cf(11304, "Team Priority", true, TRAFFIC_LIGHT_ARI),
    cf(11307, "Health", true, TRAFFIC_LIGHT_ARI),
    cf(11999, "Plain Text Field"),
    cf(12000, "Story Points", true, "com.atlassian.jira.plugin.system.customfieldtypes:float"),
  ];
  const r = pairFieldsByName(dc, cloud);
  assert.ok(r.cloudTrafficLightFieldNames.has("internal priority"));
  assert.ok(r.cloudTrafficLightFieldNames.has("rag"));
  assert.ok(!r.cloudTrafficLightFieldNames.has("plain text field"));
  assert.ok(!r.cloudTrafficLightFieldNames.has("story points"));
  assert.equal(r.stats.trafficLightFields, 2);
});

test("isTrafficLightField guard", () => {
  assert.ok(isTrafficLightField(cf(1, "X", true, TRAFFIC_LIGHT_ARI)));
  assert.ok(!isTrafficLightField(cf(1, "X")));
  assert.ok(!isTrafficLightField(cf(1, "X", true, ASSET_CUSTOM_TYPE)));
});
