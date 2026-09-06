/**
 * Pre-push additive-diff guardrail.
 *
 * Before any `/workflows/update` call, verifies that the patched envelope is
 * a strictly-additive overlay on the live Cloud workflow:
 *   - Every rule present in `cloudWorkflow` MUST also be present in
 *     `patched` with byte-identical canonical parameters (ephemeral keys
 *     stripped). Removals or modifications are bugs and abort the push.
 *   - `patched` may contain rules NOT in `cloudWorkflow`. Those are the
 *     additions we expect.
 *
 * Identity is by `parameters.id` — Cloud assigns one to every persisted
 * rule, so any rule that came from `cloudWorkflow` (live fetch) has one.
 * Newly-emitted rules in `patched` have fresh UUIDs that don't collide.
 *
 * Throws an error with a structured `.diff` payload when a violation is
 * found. The applier writes the diff to disk and skips the push so an
 * operator can inspect.
 */

const ID_KEY = "id";

// Keys that vary between persists of the same rule and must be excluded from
// canonical equality checks. Mirrors the set in `ruleFingerprint.stripEphemeralKeys`.
const EPHEMERAL_PARAM_KEYS = new Set([
  ID_KEY,
  "extensionId",
  // `disabled` flips between persists (CMA sometimes writes "true"/"false",
  // sometimes boolean) — don't fail the guardrail on disabled-state drift
  // since JCMA can legitimately toggle this.
  "disabled",
  // `tag` is metadata Cloud may add/remove on persist.
  "tag",
]);

function canonicalStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(value[k])).join(",") + "}";
}

function canonicalRule(rule) {
  if (!rule || typeof rule !== "object") return null;
  const params = rule.parameters || {};
  const filtered = {};
  for (const [k, v] of Object.entries(params)) {
    if (EPHEMERAL_PARAM_KEYS.has(k)) continue;
    filtered[k] = v;
  }
  return canonicalStringify({ ruleKey: rule.ruleKey, parameters: filtered });
}

// Collect every rule in a transition's actions / validators / conditions tree,
// indexed by parameters.id. Tracks the bucket name so the diff can say WHERE
// a rule went missing.
function indexRulesByIdInTransition(transition) {
  const out = new Map();
  if (!transition) return out;
  const visit = (rule, bucket, path) => {
    const id = rule && rule.parameters && rule.parameters[ID_KEY];
    if (!id) return; // unidentified rules (shouldn't happen for Cloud-fetched) — skip
    out.set(String(id), { rule, bucket, path });
  };
  for (let i = 0; i < (transition.actions || []).length; i++) {
    visit(transition.actions[i], "actions", `actions[${i}]`);
  }
  for (let i = 0; i < (transition.validators || []).length; i++) {
    visit(transition.validators[i], "validators", `validators[${i}]`);
  }
  const walkConds = (node, prefix) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.conditions)) {
      for (let i = 0; i < node.conditions.length; i++) {
        visit(node.conditions[i], "conditions", `${prefix}.conditions[${i}]`);
      }
    }
    if (Array.isArray(node.conditionGroups)) {
      for (let i = 0; i < node.conditionGroups.length; i++) {
        walkConds(node.conditionGroups[i], `${prefix}.conditionGroups[${i}]`);
      }
    }
  };
  if (transition.conditions) walkConds(transition.conditions, "conditions");
  return out;
}

/**
 * Diff one workflow's transitions. Returns { removed: [], modified: [] }
 * with one entry per violation. Empty arrays mean the patched envelope is
 * a clean additive overlay on this workflow.
 */
function diffWorkflowTransitions(cloudWorkflow, patched) {
  const removed = [];
  const modified = [];
  const cloudTxnsById = new Map();
  for (const t of cloudWorkflow.transitions || []) {
    if (t && t.id != null) cloudTxnsById.set(String(t.id), t);
  }
  const patchedTxnsById = new Map();
  for (const t of patched.transitions || []) {
    if (t && t.id != null) patchedTxnsById.set(String(t.id), t);
  }
  for (const [txnId, cloudTxn] of cloudTxnsById) {
    const patchedTxn = patchedTxnsById.get(txnId);
    if (!patchedTxn) {
      // Transition removed entirely. Surface every rule on it as removed.
      const idx = indexRulesByIdInTransition(cloudTxn);
      for (const [ruleId, entry] of idx) {
        removed.push({
          transitionId: txnId,
          transitionName: cloudTxn.name,
          ruleId,
          ruleKey: entry.rule.ruleKey,
          path: entry.path,
          reason: "containing-transition-removed",
        });
      }
      continue;
    }
    const cloudIdx = indexRulesByIdInTransition(cloudTxn);
    const patchedIdx = indexRulesByIdInTransition(patchedTxn);
    for (const [ruleId, cloudEntry] of cloudIdx) {
      const patchedEntry = patchedIdx.get(ruleId);
      if (!patchedEntry) {
        removed.push({
          transitionId: txnId,
          transitionName: cloudTxn.name,
          ruleId,
          ruleKey: cloudEntry.rule.ruleKey,
          path: cloudEntry.path,
          reason: "rule-removed-from-transition",
        });
        continue;
      }
      const cloudCanon = canonicalRule(cloudEntry.rule);
      const patchedCanon = canonicalRule(patchedEntry.rule);
      if (cloudCanon !== patchedCanon) {
        modified.push({
          transitionId: txnId,
          transitionName: cloudTxn.name,
          ruleId,
          ruleKey: cloudEntry.rule.ruleKey,
          path: cloudEntry.path,
          reason: "rule-parameters-modified",
          before: cloudCanon,
          after: patchedCanon,
        });
      }
    }
  }
  return { removed, modified };
}

/**
 * Verify the patched envelope is purely additive vs the live cloudWorkflow.
 * Returns:
 *   { ok: true, additions: <count>, removed: [], modified: [] } on success.
 *   { ok: false, ..., removed: [...], modified: [...] } on violation.
 *
 * Non-throwing — caller decides whether to abort, log, or both.
 */
function verifyAdditive(cloudWorkflow, patched) {
  if (!cloudWorkflow || !patched) {
    return { ok: false, removed: [], modified: [], error: "missing cloudWorkflow or patched" };
  }
  const { removed, modified } = diffWorkflowTransitions(cloudWorkflow, patched);
  // Count additions: rules in `patched` with no matching id in cloudWorkflow.
  let additions = 0;
  const cloudIds = new Set();
  for (const t of cloudWorkflow.transitions || []) {
    for (const [id] of indexRulesByIdInTransition(t)) cloudIds.add(id);
  }
  for (const t of patched.transitions || []) {
    for (const [id] of indexRulesByIdInTransition(t)) {
      if (!cloudIds.has(id)) additions++;
    }
  }
  return {
    ok: removed.length === 0 && modified.length === 0,
    additions,
    removed,
    modified,
  };
}

/**
 * Verify the patched envelope is a SUBTRACTIVE-only overlay: every rule
 * removed in `patched` carried `parameters.migrationSourceId` (i.e., was
 * ours to remove), no JCMA / operator rule was touched, no rule was
 * modified, and no rule was added.
 *
 * Used by `--clean` mode to enforce the safety contract: a clean run
 * removes ONLY rules we previously pushed, leaving every other rule on
 * Cloud byte-identical.
 *
 * Returns:
 *   { ok: true, expectedRemovals: [...our rules removed],
 *     violations: { unexpectedRemovals: [], modifications: [], additions: [] } }
 *   { ok: false, ..., violations: { unexpectedRemovals: [...], ... } }
 *
 * `unexpectedRemovals` = rules that ARE missing in patched but did NOT
 * carry migrationSourceId on Cloud (so they were JCMA's / operator's /
 * older-emit-without-tag — not ours to remove).
 */
function verifySubtractive(cloudWorkflow, patched, options = {}) {
  if (!cloudWorkflow || !patched) {
    return {
      ok: false,
      expectedRemovals: [],
      violations: { unexpectedRemovals: [], modifications: [], additions: [] },
      error: "missing cloudWorkflow or patched",
    };
  }
  // `options.expectedRuleIds` is an authoritative ledger-driven set of
  // Cloud rule IDs the caller intends to remove. Cloud strips
  // `parameters.migrationSourceId` on persist (verified 2026-05 against
  // a JSM sandbox), so the original migrationSourceId-based check
  // alone misses every legitimately-ours-but-Cloud-stripped rule. When the
  // caller supplies a ledger-derived `expectedRuleIds`, a removal is
  // "expected" if EITHER the rule's id is in that set OR it still carries
  // a migrationSourceId in memory.
  const expectedRuleIds = options.expectedRuleIds instanceof Set
    ? options.expectedRuleIds
    : null;
  const { removed, modified } = diffWorkflowTransitions(cloudWorkflow, patched);
  // Bucket each removal: is it ours (ledger-recorded or migrationSourceId-tagged)?
  const expectedRemovals = [];
  const unexpectedRemovals = [];
  for (const r of removed) {
    const cloudRule = _findRuleByIdInWorkflow(cloudWorkflow, r.ruleId);
    const hadMigrationSourceId =
      cloudRule && cloudRule.parameters && cloudRule.parameters.migrationSourceId;
    const ledgerOwned = expectedRuleIds && expectedRuleIds.has(String(r.ruleId));
    if (hadMigrationSourceId || ledgerOwned) {
      expectedRemovals.push({
        ...r,
        migrationSourceId: hadMigrationSourceId ? String(cloudRule.parameters.migrationSourceId) : null,
        tag: (cloudRule && cloudRule.parameters && cloudRule.parameters.tag) || null,
        appKey: (cloudRule && cloudRule.parameters && cloudRule.parameters.appKey) || null,
        ownedVia: ledgerOwned ? "ledger" : "migrationSourceId",
      });
    } else {
      unexpectedRemovals.push({
        ...r,
        reason: "rule not in ledger and had no migrationSourceId — not ours to remove",
      });
    }
  }
  // Count additions in patched vs cloud.
  const additions = [];
  const cloudIds = new Set();
  for (const t of cloudWorkflow.transitions || []) {
    for (const [id] of indexRulesByIdInTransition(t)) cloudIds.add(id);
  }
  for (const t of patched.transitions || []) {
    for (const [id, entry] of indexRulesByIdInTransition(t)) {
      if (!cloudIds.has(id)) {
        additions.push({
          transitionId: t.id,
          transitionName: t.name,
          ruleId: id,
          ruleKey: entry.rule.ruleKey,
          path: entry.path,
          reason: "rule added during clean — not expected",
        });
      }
    }
  }
  const violations = {
    unexpectedRemovals,
    modifications: modified,
    additions,
  };
  return {
    ok:
      unexpectedRemovals.length === 0 &&
      modified.length === 0 &&
      additions.length === 0,
    expectedRemovals,
    violations,
  };
}

// Locate a rule by parameters.id anywhere in a workflow (actions, validators,
// or conditions tree of any transition). Returns the rule object or null.
function _findRuleByIdInWorkflow(workflow, ruleId) {
  const target = String(ruleId);
  for (const t of workflow.transitions || []) {
    const visit = (rule) => {
      if (!rule || !rule.parameters) return null;
      if (String(rule.parameters.id) === target) return rule;
      return null;
    };
    for (const a of t.actions || []) {
      const hit = visit(a);
      if (hit) return hit;
    }
    for (const v of t.validators || []) {
      const hit = visit(v);
      if (hit) return hit;
    }
    const walk = (node) => {
      if (!node || typeof node !== "object") return null;
      for (const c of node.conditions || []) {
        const hit = visit(c);
        if (hit) return hit;
      }
      for (const cg of node.conditionGroups || []) {
        const hit = walk(cg);
        if (hit) return hit;
      }
      return null;
    };
    if (t.conditions) {
      const hit = walk(t.conditions);
      if (hit) return hit;
    }
  }
  return null;
}

module.exports = {
  verifyAdditive,
  verifySubtractive,
  diffWorkflowTransitions,
  indexRulesByIdInTransition,
  canonicalRule,
  canonicalStringify,
  EPHEMERAL_PARAM_KEYS,
};
