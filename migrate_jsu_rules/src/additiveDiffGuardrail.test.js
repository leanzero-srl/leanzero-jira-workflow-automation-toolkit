/**
 * Tests for additiveDiffGuardrail. Run with `node src/additiveDiffGuardrail.test.js`.
 */

const assert = require("assert");
const {
  verifyAdditive,
  canonicalRule,
  indexRulesByIdInTransition,
} = require("./additiveDiffGuardrail");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("PASS", name); }
  catch (e) { fail++; console.error("FAIL", name, "-", e.message); }
}

function rule(id, ruleKey, params = {}) {
  return { ruleKey, parameters: { id, ...params } };
}
function txn(id, name, opts = {}) {
  return {
    id,
    name,
    type: "DIRECTED",
    actions: opts.actions || [],
    validators: opts.validators || [],
    conditions: opts.conditions || { operation: "ALL", conditions: [], conditionGroups: [] },
  };
}
function wf(transitions) {
  return { id: "wf1", name: "WF", transitions };
}

// ───── canonicalRule ─────

t("canonicalRule strips ephemeral keys (id, extensionId, disabled, tag)", () => {
  const a = canonicalRule({
    ruleKey: "system:foo",
    parameters: { id: "a-id", extensionId: "ext", disabled: "false", tag: "x", field: "X" },
  });
  const b = canonicalRule({
    ruleKey: "system:foo",
    parameters: { id: "b-id", extensionId: "ext2", disabled: "true", tag: "y", field: "X" },
  });
  assert.strictEqual(a, b);
});

t("canonicalRule distinguishes rules with different non-ephemeral params", () => {
  const a = canonicalRule({ ruleKey: "system:foo", parameters: { id: "a", field: "X" } });
  const b = canonicalRule({ ruleKey: "system:foo", parameters: { id: "a", field: "Y" } });
  assert.notStrictEqual(a, b);
});

// ───── indexRulesByIdInTransition ─────

t("indexRulesByIdInTransition walks actions, validators, conditions tree", () => {
  const t1 = txn("t1", "T", {
    actions: [rule("a1", "system:update-field", { field: "summary" })],
    validators: [rule("v1", "system:validate-field-value", { ruleType: "fieldRequired" })],
    conditions: {
      operation: "ALL",
      conditions: [rule("c1", "system:check-field-value", { fieldId: "status" })],
      conditionGroups: [
        {
          operation: "ANY",
          conditions: [rule("c2", "system:check-permission-validator", { permissionKey: "EDIT_ISSUES" })],
          conditionGroups: [],
        },
      ],
    },
  });
  const idx = indexRulesByIdInTransition(t1);
  assert.strictEqual(idx.size, 4);
  assert.ok(idx.has("a1"));
  assert.ok(idx.has("v1"));
  assert.ok(idx.has("c1"));
  assert.ok(idx.has("c2"));
});

t("indexRulesByIdInTransition skips rules with no parameters.id", () => {
  const t1 = txn("t1", "T", {
    actions: [{ ruleKey: "system:foo", parameters: { field: "X" } }, rule("a2", "system:foo")],
  });
  const idx = indexRulesByIdInTransition(t1);
  assert.strictEqual(idx.size, 1);
  assert.ok(idx.has("a2"));
});

// ───── verifyAdditive ─────

t("verifyAdditive: pure additions are ok", () => {
  const cloud = wf([
    txn("t1", "Start", { actions: [rule("a1", "system:update-field", { field: "X" })] }),
  ]);
  const patched = wf([
    txn("t1", "Start", {
      actions: [
        rule("a1", "system:update-field", { field: "X" }),
        rule("new-a", "system:update-field", { field: "Y" }),
      ],
    }),
  ]);
  const r = verifyAdditive(cloud, patched);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.additions, 1);
  assert.deepStrictEqual(r.removed, []);
  assert.deepStrictEqual(r.modified, []);
});

t("verifyAdditive: removing an existing rule is detected", () => {
  const cloud = wf([
    txn("t1", "Start", {
      actions: [
        rule("a1", "system:update-field", { field: "X" }),
        rule("a2", "system:update-field", { field: "Y" }),
      ],
    }),
  ]);
  const patched = wf([
    txn("t1", "Start", { actions: [rule("a1", "system:update-field", { field: "X" })] }),
  ]);
  const r = verifyAdditive(cloud, patched);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.removed.length, 1);
  assert.strictEqual(r.removed[0].ruleId, "a2");
  assert.strictEqual(r.removed[0].reason, "rule-removed-from-transition");
});

t("verifyAdditive: modifying an existing rule's params is detected", () => {
  const cloud = wf([
    txn("t1", "Start", { actions: [rule("a1", "system:update-field", { field: "X", value: "1" })] }),
  ]);
  const patched = wf([
    txn("t1", "Start", { actions: [rule("a1", "system:update-field", { field: "X", value: "2" })] }),
  ]);
  const r = verifyAdditive(cloud, patched);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.modified.length, 1);
  assert.strictEqual(r.modified[0].ruleId, "a1");
  assert.strictEqual(r.modified[0].reason, "rule-parameters-modified");
});

t("verifyAdditive: tag/disabled drift does NOT trigger modification", () => {
  const cloud = wf([
    txn("t1", "Start", {
      actions: [rule("a1", "system:update-field", { field: "X", tag: "", disabled: "false" })],
    }),
  ]);
  const patched = wf([
    txn("t1", "Start", {
      actions: [rule("a1", "system:update-field", { field: "X", tag: "migration-success", disabled: "true" })],
    }),
  ]);
  const r = verifyAdditive(cloud, patched);
  assert.strictEqual(r.ok, true);
});

t("verifyAdditive: missing transition surfaces all its rules as removed", () => {
  const cloud = wf([
    txn("t1", "Start", { actions: [rule("a1", "system:foo")] }),
    txn("t2", "Stop", { actions: [rule("a2", "system:bar")] }),
  ]);
  const patched = wf([
    txn("t1", "Start", { actions: [rule("a1", "system:foo")] }),
  ]);
  const r = verifyAdditive(cloud, patched);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.removed.length, 1);
  assert.strictEqual(r.removed[0].reason, "containing-transition-removed");
});

t("verifyAdditive: missing cloudWorkflow or patched returns ok=false", () => {
  assert.strictEqual(verifyAdditive(null, {}).ok, false);
  assert.strictEqual(verifyAdditive({}, null).ok, false);
});

t("verifyAdditive: rule added to conditions tree counts as addition", () => {
  const cloud = wf([
    txn("t1", "Start", {
      conditions: {
        operation: "ALL",
        conditions: [rule("c1", "system:check-field-value", { fieldId: "X" })],
        conditionGroups: [],
      },
    }),
  ]);
  const patched = wf([
    txn("t1", "Start", {
      conditions: {
        operation: "ALL",
        conditions: [
          rule("c1", "system:check-field-value", { fieldId: "X" }),
          rule("c-new", "system:check-field-value", { fieldId: "Y" }),
        ],
        conditionGroups: [],
      },
    }),
  ]);
  const r = verifyAdditive(cloud, patched);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.additions, 1);
});

t("verifyAdditive: removing a rule from a nested conditionGroup is detected", () => {
  const cloud = wf([
    txn("t1", "Start", {
      conditions: {
        operation: "ALL",
        conditions: [],
        conditionGroups: [{
          operation: "ANY",
          conditions: [rule("c-deep", "system:check-field-value", { fieldId: "X" })],
          conditionGroups: [],
        }],
      },
    }),
  ]);
  const patched = wf([
    txn("t1", "Start", {
      conditions: {
        operation: "ALL",
        conditions: [],
        conditionGroups: [{
          operation: "ANY",
          conditions: [],
          conditionGroups: [],
        }],
      },
    }),
  ]);
  const r = verifyAdditive(cloud, patched);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.removed.length, 1);
  assert.strictEqual(r.removed[0].ruleId, "c-deep");
});

// ───── verifySubtractive ─────

const { verifySubtractive } = require("./additiveDiffGuardrail");

// Helper to set migrationSourceId on a rule's parameters.
function tagged(id, ruleKey, migrationSourceId, params = {}) {
  return { ruleKey, parameters: { id, migrationSourceId, ...params } };
}

t("verifySubtractive: removing a tagged rule is ok", () => {
  const cloud = wf([
    txn("t1", "Start", {
      actions: [
        rule("a1", "system:update-field", { field: "X" }), // JCMA's (untagged)
        tagged("a2", "system:update-field", "mig-abc", { field: "Y" }), // ours
      ],
    }),
  ]);
  const patched = wf([
    txn("t1", "Start", { actions: [rule("a1", "system:update-field", { field: "X" })] }),
  ]);
  const r = verifySubtractive(cloud, patched);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.expectedRemovals.length, 1);
  assert.strictEqual(r.expectedRemovals[0].ruleId, "a2");
  assert.strictEqual(r.expectedRemovals[0].migrationSourceId, "mig-abc");
  assert.deepStrictEqual(r.violations.unexpectedRemovals, []);
});

t("verifySubtractive: removing an UNTAGGED rule is a violation", () => {
  const cloud = wf([
    txn("t1", "Start", { actions: [rule("a1", "system:update-field", { field: "X" })] }),
  ]);
  const patched = wf([
    txn("t1", "Start", { actions: [] }),
  ]);
  const r = verifySubtractive(cloud, patched);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.violations.unexpectedRemovals.length, 1);
  assert.strictEqual(r.violations.unexpectedRemovals[0].ruleId, "a1");
});

t("verifySubtractive: modifying an existing rule is a violation", () => {
  const cloud = wf([
    txn("t1", "Start", { actions: [rule("a1", "system:update-field", { field: "X" })] }),
  ]);
  const patched = wf([
    txn("t1", "Start", { actions: [rule("a1", "system:update-field", { field: "Y" })] }),
  ]);
  const r = verifySubtractive(cloud, patched);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.violations.modifications.length, 1);
});

t("verifySubtractive: adding a new rule during clean is a violation", () => {
  const cloud = wf([
    txn("t1", "Start", { actions: [rule("a1", "system:update-field")] }),
  ]);
  const patched = wf([
    txn("t1", "Start", {
      actions: [rule("a1", "system:update-field"), rule("a-new", "system:update-field")],
    }),
  ]);
  const r = verifySubtractive(cloud, patched);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.violations.additions.length, 1);
});

t("verifySubtractive: removing tagged rules from nested conditions tree is ok", () => {
  const cloud = wf([
    txn("t1", "Start", {
      conditions: {
        operation: "ALL",
        conditions: [],
        conditionGroups: [
          {
            operation: "ANY",
            conditions: [tagged("c-mine", "connect:expression-condition", "mig-x")],
            conditionGroups: [],
          },
        ],
      },
    }),
  ]);
  const patched = wf([
    txn("t1", "Start", {
      conditions: {
        operation: "ALL",
        conditions: [],
        conditionGroups: [{ operation: "ANY", conditions: [], conditionGroups: [] }],
      },
    }),
  ]);
  const r = verifySubtractive(cloud, patched);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.expectedRemovals.length, 1);
});

t("verifySubtractive: complete no-op (patched == cloud) is ok", () => {
  const cloud = wf([
    txn("t1", "Start", {
      actions: [rule("a1", "system:update-field"), tagged("a2", "system:update-field", "mig-x")],
    }),
  ]);
  const patched = wf([
    txn("t1", "Start", {
      actions: [rule("a1", "system:update-field"), tagged("a2", "system:update-field", "mig-x")],
    }),
  ]);
  const r = verifySubtractive(cloud, patched);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.expectedRemovals.length, 0);
});

t("verifySubtractive: mixed clean — tagged removed, untagged preserved", () => {
  const cloud = wf([
    txn("t1", "Start", {
      actions: [
        rule("a1", "system:update-field"),
        tagged("a2", "system:update-field", "mig-1"),
        tagged("a3", "system:update-field", "mig-2"),
        rule("a4", "system:update-field"),
      ],
    }),
  ]);
  const patched = wf([
    txn("t1", "Start", {
      actions: [
        rule("a1", "system:update-field"),
        rule("a4", "system:update-field"),
      ],
    }),
  ]);
  const r = verifySubtractive(cloud, patched);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.expectedRemovals.length, 2);
  const ids = r.expectedRemovals.map((x) => x.ruleId).sort();
  assert.deepStrictEqual(ids, ["a2", "a3"]);
});

t("verifySubtractive: missing input returns ok=false", () => {
  assert.strictEqual(verifySubtractive(null, {}).ok, false);
  assert.strictEqual(verifySubtractive({}, null).ok, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
