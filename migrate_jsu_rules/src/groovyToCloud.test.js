/**
 * Unit tests for groovyToCloud — R2 round of translator improvements:
 *   - method-chain filter rewriting
 *   - getAsHtml accessor variant
 *   - multi-statement def/if/else/return translator
 */
const assert = require("assert");
const {
  groovyTemplateToNunjucks,
  groovyMultiStatementToNunjucks,
  atomToNunjucksExpr,
  parseChainForNunjucks,
} = require("./groovyToCloud");

let _passed = 0;
let _failed = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    _passed++;
  } catch (e) {
    console.log(`FAIL ${name} - ${e.message}`);
    _failed++;
  }
}

const ctx = { fieldRemapping: {}, cloudFieldNames: {} };

// ─── parseChainForNunjucks ──────────────────────────────────────────────────

t("parseChainForNunjucks: empty chain returns empty", () => {
  const r = parseChainForNunjucks("");
  assert.deepStrictEqual(r, { tokens: [], filters: [], formatArg: null });
});

t("parseChainForNunjucks: simple property", () => {
  const r = parseChainForNunjucks(".name");
  assert.deepStrictEqual(r.tokens, [".name"]);
});

t("parseChainForNunjucks: ?.first() to [0]", () => {
  const r = parseChainForNunjucks("?.first()");
  assert.deepStrictEqual(r.tokens, ["[0]"]);
});

t("parseChainForNunjucks: .optionId to .id", () => {
  const r = parseChainForNunjucks(".optionId");
  assert.deepStrictEqual(r.tokens, [".id"]);
});

t("parseChainForNunjucks: .toString to | string filter", () => {
  const r = parseChainForNunjucks(".toString()");
  assert.deepStrictEqual(r.filters, ["string"]);
});

t("parseChainForNunjucks: .toLowerCase to | lower", () => {
  const r = parseChainForNunjucks(".toLowerCase()");
  assert.deepStrictEqual(r.filters, ["lower"]);
});

t("parseChainForNunjucks: .trim to | trim", () => {
  const r = parseChainForNunjucks(".trim()");
  assert.deepStrictEqual(r.filters, ["trim"]);
});

t("parseChainForNunjucks: .length to | length", () => {
  const r = parseChainForNunjucks(".length()");
  assert.deepStrictEqual(r.filters, ["length"]);
});

t("parseChainForNunjucks: .length (bare property) to | length", () => {
  const r = parseChainForNunjucks(".length");
  assert.deepStrictEqual(r.filters, ["length"]);
});

t("parseChainForNunjucks: .replace(a,b) to | replace", () => {
  const r = parseChainForNunjucks('.replace("a", "b")');
  assert.deepStrictEqual(r.filters, ['replace("a", "b")']);
});

t("parseChainForNunjucks: .substring(n) to .slice(n)", () => {
  const r = parseChainForNunjucks(".substring(5)");
  assert.deepStrictEqual(r.tokens, [".slice(5)"]);
});

t("parseChainForNunjucks: .substring(a,b) to .slice(a,b)", () => {
  const r = parseChainForNunjucks(".substring(0, 10)");
  assert.deepStrictEqual(r.tokens, [".slice(0, 10)"]);
});

t("parseChainForNunjucks: chained mix", () => {
  const r = parseChainForNunjucks("?.first()?.value.toLowerCase()");
  assert.deepStrictEqual(r.tokens, ["[0]", ".value"]);
  assert.deepStrictEqual(r.filters, ["lower"]);
});

t("parseChainForNunjucks: unrecognised method returns null", () => {
  const r = parseChainForNunjucks(".unknownMethod()");
  assert.strictEqual(r, null);
});

t("parseChainForNunjucks: .format(FMT) captured separately", () => {
  const r = parseChainForNunjucks('.format("yyyy-MM-dd")');
  assert.strictEqual(r.formatArg, "yyyy-MM-dd");
});

// ─── atomToNunjucksExpr ─────────────────────────────────────────────────────

t("atomToNunjucksExpr: string literal preserved", () => {
  assert.strictEqual(atomToNunjucksExpr('"hello"', ctx), '"hello"');
});

t("atomToNunjucksExpr: currentUser", () => {
  assert.strictEqual(atomToNunjucksExpr("currentUser", ctx), "user");
});

t("atomToNunjucksExpr: currentUser.displayName", () => {
  assert.strictEqual(atomToNunjucksExpr("currentUser.displayName", ctx), "user.displayName");
});

t("atomToNunjucksExpr: issue.getAsString", () => {
  assert.strictEqual(atomToNunjucksExpr('issue.getAsString("priority")', ctx), "issue.fields.priority");
});

t("atomToNunjucksExpr: bare issue.prop", () => {
  assert.strictEqual(atomToNunjucksExpr("issue.summary", ctx), "issue.summary");
});

t("atomToNunjucksExpr: numeric literal", () => {
  assert.strictEqual(atomToNunjucksExpr("42", ctx), "42");
});

t("atomToNunjucksExpr: boolean literal", () => {
  assert.strictEqual(atomToNunjucksExpr("true", ctx), "true");
  assert.strictEqual(atomToNunjucksExpr("false", ctx), "false");
});

t("atomToNunjucksExpr: method-chain emits JS method form", () => {
  // In {% set %} RHS, chains like .toString() / .replace() emit as method
  // calls (JMWE Cloud's Nunjucks supports JS string methods).
  const r = atomToNunjucksExpr('issue.get("X").toString()', ctx);
  assert.ok(r.endsWith(".toString()"));
});

// ─── groovyMultiStatementToNunjucks ────────────────────────────────────────

t("multi-statement: def + if/else inline", () => {
  const r = groovyMultiStatementToNunjucks(
    'def X = issue.getAsString("status")\nif (X == "Open") return "A" else return "B"',
    [], ctx,
  );
  assert.strictEqual(r.translated, true);
  assert.strictEqual(r.output, '{% set X = issue.fields.status %}{% if X == "Open" %}A{% else %}B{% endif %}');
});

t("multi-statement: def + if/else braced", () => {
  const r = groovyMultiStatementToNunjucks(
    'def X = issue.getAsString("status")\nif (X == "Open") { return "A" } else { return "B" }',
    [], ctx,
  );
  assert.strictEqual(r.translated, true);
  assert.strictEqual(r.output, '{% set X = issue.fields.status %}{% if X == "Open" %}A{% else %}B{% endif %}');
});

t("multi-statement: two defs + if/else", () => {
  const r = groovyMultiStatementToNunjucks(
    'def X = issue.get("customfield_100")\ndef Y = issue.get("customfield_200")\nif (X == "A" || Y == "B") return "C" else return "D"',
    [], ctx,
  );
  assert.strictEqual(r.translated, true);
  assert.ok(r.output.startsWith("{% set X = "));
  assert.ok(r.output.includes('{% if X == "A" || Y == "B" %}C{% else %}D{% endif %}'));
});

t("multi-statement: def + bare return", () => {
  const r = groovyMultiStatementToNunjucks(
    'def X = issue.getAsString("priority")\nreturn X',
    [], ctx,
  );
  assert.strictEqual(r.translated, true);
  assert.strictEqual(r.output, '{% set X = issue.fields.priority %}{{ X | default("") }}');
});

t("multi-statement: simple return", () => {
  const r = groovyMultiStatementToNunjucks('return "hello"', [], ctx);
  assert.strictEqual(r.translated, true);
  assert.strictEqual(r.output, "hello");
});

t("multi-statement: numeric literal in def", () => {
  const r = groovyMultiStatementToNunjucks(
    'def X = 5; if (X > 0) return "pos" else return "neg"',
    [], ctx,
  );
  assert.strictEqual(r.translated, true);
  assert.strictEqual(r.output, '{% set X = 5 %}{% if X > 0 %}pos{% else %}neg{% endif %}');
});

t("multi-statement: unrecognised statement bails", () => {
  const r = groovyMultiStatementToNunjucks(
    'def X = ComponentAccessor.getCustomFieldManager()',
    [], ctx,
  );
  assert.strictEqual(r.translated, false);
});

t("multi-statement: switch statement bails", () => {
  const r = groovyMultiStatementToNunjucks(
    'switch (X) { case "A": return "1"; default: return "2"; }',
    [], ctx,
  );
  assert.strictEqual(r.translated, false);
});

t("multi-statement: empty input bails", () => {
  const r = groovyMultiStatementToNunjucks("", [], ctx);
  assert.strictEqual(r.translated, false);
});

t("multi-statement: comments stripped", () => {
  const r = groovyMultiStatementToNunjucks(
    '// fetch status\ndef X = issue.getAsString("status")\n// emit result\nreturn X',
    [], ctx,
  );
  assert.strictEqual(r.translated, true);
  assert.ok(r.output.includes("{% set X ="));
  assert.ok(r.output.includes("{{ X |"));
});

// ─── groovyTemplateToNunjucks integration ──────────────────────────────────

t("template integration: multi-statement routed through translator", () => {
  const r = groovyTemplateToNunjucks(
    'def X = issue.getAsString("status")\nif (X == "Open") return "A" else return "B"',
    [], ctx,
  );
  assert.strictEqual(r.translated, true);
  assert.ok(r.output.startsWith("{% set"));
});

t("template integration: simple GString still works (no regression)", () => {
  const r = groovyTemplateToNunjucks('${issue.get("summary")}', [], ctx);
  assert.strictEqual(r.translated, true);
  assert.strictEqual(r.output, '{{ issue.fields.summary | default("") }}');
});

t("template integration: method-chain filter pipeline", () => {
  const r = groovyTemplateToNunjucks(
    '${issue.get("summary").toLowerCase().trim()}',
    [], ctx,
  );
  assert.strictEqual(r.translated, true);
  assert.ok(r.output.includes("| lower | trim"));
});

t("template integration: getAsHtml works", () => {
  const r = groovyTemplateToNunjucks('${issue.getAsHtml("description")}', [], ctx);
  assert.strictEqual(r.translated, true);
  assert.strictEqual(r.output, '{{ issue.fields.description | default("") }}');
});

console.log(`\n${_passed} passed, ${_failed} failed`);
if (_failed > 0) process.exit(1);
