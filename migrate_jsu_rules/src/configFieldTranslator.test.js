/**
 * Unit tests for configFieldTranslator. Run with `node src/configFieldTranslator.test.js`.
 * Exit code 0 on pass, 1 on fail.
 */

const assert = require("assert");
const {
  translateConfigFieldIds,
  translateNunjucksFieldRefs,
  translateConfigForEmit,
} = require("./configFieldTranslator");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("PASS", name); }
  catch (e) { fail++; console.error("FAIL", name, "-", e.message); }
}

t("translateConfigFieldIds rewrites DC ID to Cloud ID in string values", () => {
  const cfg = { fieldId: "customfield_14133", expression: "issue.customfield_14133 == 'x'" };
  const remap = { customfield_14133: "customfield_10389" };
  const out = translateConfigFieldIds(cfg, remap);
  assert.strictEqual(out.fieldId, "customfield_10389");
  assert.strictEqual(out.expression, "issue.customfield_10389 == 'x'");
});

t("translateConfigFieldIds passes unmapped IDs through unchanged", () => {
  const cfg = { fieldId: "customfield_99999" };
  const out = translateConfigFieldIds(cfg, { customfield_14133: "customfield_10389" });
  assert.strictEqual(out.fieldId, "customfield_99999");
});

t("translateConfigFieldIds is a no-op on empty remap", () => {
  const cfg = { fieldId: "customfield_14133", nested: { a: "customfield_14133" } };
  const out = translateConfigFieldIds(cfg, {});
  assert.strictEqual(out.fieldId, "customfield_14133");
  assert.strictEqual(out.nested.a, "customfield_14133");
});

t("translateConfigFieldIds walks arrays and nested objects", () => {
  const cfg = { fields: ["customfield_14133", "customfield_14134"], nested: { x: "ref customfield_14133 here" } };
  const remap = { customfield_14133: "customfield_10001", customfield_14134: "customfield_10002" };
  const out = translateConfigFieldIds(cfg, remap);
  assert.deepStrictEqual(out.fields, ["customfield_10001", "customfield_10002"]);
  assert.strictEqual(out.nested.x, "ref customfield_10001 here");
});

t("translateConfigFieldIds returns NEW objects (non-destructive)", () => {
  const cfg = { fieldId: "customfield_14133" };
  const out = translateConfigFieldIds(cfg, { customfield_14133: "customfield_10001" });
  assert.notStrictEqual(out, cfg);
  assert.strictEqual(cfg.fieldId, "customfield_14133"); // original untouched
});

t("translateNunjucksFieldRefs rewrites broken issue.fields.customfield_NNN inside {{...}}", () => {
  const cfg = { comment: "Set by {{ issue.fields.customfield_10389.displayName }}" };
  const names = { customfield_10389: "Raised By" };
  const out = translateNunjucksFieldRefs(cfg, names, {});
  assert.ok(out.comment.includes("issue.fields['Raised By']"), `got: ${out.comment}`);
  assert.ok(out.comment.includes("default(\"\")"), "default() safety net added");
});

t("translateNunjucksFieldRefs leaves Jira Expression strings alone (no {{...}} block)", () => {
  const cfg = { expression: "issue.fields.customfield_10389 == 'foo'" };
  const names = { customfield_10389: "Raised By" };
  const out = translateNunjucksFieldRefs(cfg, names, {});
  assert.strictEqual(out.expression, "issue.fields.customfield_10389 == 'foo'");
});

t("translateNunjucksFieldRefs uses fieldRemap fallback for DC-leaked IDs", () => {
  const cfg = { comment: "{{ issue.fields.customfield_14133 }}" };
  const names = { customfield_10389: "Raised By" };
  const remap = { customfield_14133: "customfield_10389" };
  const out = translateNunjucksFieldRefs(cfg, names, remap);
  assert.ok(out.comment.includes("issue.fields['Raised By']"), `got: ${out.comment}`);
});

t("translateNunjucksFieldRefs leaves unresolvable refs unchanged", () => {
  const cfg = { comment: "{{ issue.fields.customfield_99999 }}" };
  const out = translateNunjucksFieldRefs(cfg, {}, {});
  assert.strictEqual(out.comment, "{{ issue.fields.customfield_99999 }}");
});

t("translateNunjucksFieldRefs handles names containing single quotes", () => {
  const cfg = { comment: "{{ issue.fields.customfield_10001 }}" };
  const names = { customfield_10001: "Sam's Field" };
  const out = translateNunjucksFieldRefs(cfg, names, {});
  assert.ok(out.comment.includes(`issue.fields["Sam's Field"]`), `got: ${out.comment}`);
});

t("translateConfigForEmit composes both passes with full ctx", () => {
  const cfg = {
    fieldId: "customfield_14133",
    comment: "Hi {{ issue.fields.customfield_14133.displayName }}",
  };
  const ctx = {
    fieldRemapping: { customfield_14133: "customfield_10389" },
    cloudFieldNames: { customfield_10389: "Raised By" },
  };
  const out = translateConfigForEmit(cfg, ctx);
  assert.strictEqual(out.fieldId, "customfield_10389");
  assert.ok(out.comment.includes("issue.fields['Raised By']"), `got: ${out.comment}`);
});

t("translateConfigForEmit is no-op with no ctx", () => {
  const cfg = { fieldId: "customfield_14133" };
  const out = translateConfigForEmit(cfg, null);
  assert.strictEqual(out.fieldId, "customfield_14133");
});

t("translateConfigForEmit running twice is idempotent", () => {
  const cfg = { comment: "{{ issue.fields.customfield_10389 }}" };
  const ctx = { fieldRemapping: {}, cloudFieldNames: { customfield_10389: "Raised By" } };
  const once = translateConfigForEmit(cfg, ctx);
  const twice = translateConfigForEmit(once, ctx);
  assert.strictEqual(twice.comment, once.comment);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
