/**
 * Client-side ledger of every rule we pushed to Cloud.
 *
 * Why: Cloud's `/workflows/update` endpoint strips unrecognised parameter
 * keys on persist. Our `parameters.migrationSourceId` tag DOES NOT survive
 * (verified live against a JSM sandbox 2026-05). Without a way to
 * identify our rules post-push, `--clean` can't find them and cross-run
 * dedup can't recognise them as already-on-cloud.
 *
 * Cloud DOES preserve `parameters.id` (the rule UUID we set via
 * `ctx.ruleId = uuidv4()`). So we record `(workflow, transitionId, ruleId)`
 * tuples client-side at apply time. The cleaner uses this ledger to find
 * what to remove. The applier reads prior ledgers to seed the snapshot
 * dedup with `migration:<id>` synthetic fingerprints, so re-runs still
 * recognise previously-pushed rules.
 *
 * File layout (one per workflow, per collect dir):
 *   <collect-dir>/migration_ledger_<safeFilename(workflowName)>.json
 *   {
 *     workflowName, cloudWorkflowName, cloudBaseUrl, lastWrittenAt,
 *     entries: [
 *       { migrationSourceId, ruleId, ruleKey, transitionId, transitionName,
 *         ruleCategory, shortName, autoDisabled, pushedAt }
 *     ]
 *   }
 *
 * `entries` is APPEND-ONLY on subsequent applies. If a previous run pushed
 * a rule and we push the same `migrationSourceId` again, we OVERWRITE the
 * matching entry (latest ruleId wins) so the ledger stays in sync with
 * Cloud's current state.
 */

const fs = require("fs");
const path = require("path");
const { safeFilename } = require("./utils");

function ledgerPath(collectDir, workflowName) {
  return path.join(collectDir, `migration_ledger_${safeFilename(workflowName)}.json`);
}

function readLedger(collectDir, workflowName) {
  const p = ledgerPath(collectDir, workflowName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

/**
 * Read every `migration_ledger_*.json` in the collect dir, returning a map
 * keyed by workflowName. Used by the cleaner to discover what's there.
 */
function readAllLedgers(collectDir) {
  const out = {};
  if (!fs.existsSync(collectDir)) return out;
  for (const file of fs.readdirSync(collectDir)) {
    if (!file.startsWith("migration_ledger_") || !file.endsWith(".json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(collectDir, file), "utf8"));
      if (data && data.workflowName) out[data.workflowName] = data;
    } catch {
      // ignore parse errors
    }
  }
  return out;
}

/**
 * Merge new entries into the workflow's ledger and write it. Each new entry
 * is keyed by `migrationSourceId` — if a previous apply recorded the same
 * id, we OVERWRITE its ruleId/transitionId/etc. (latest wins, since the
 * previous Cloud rule has been overwritten by the latest push).
 *
 * Returns the count of entries in the resulting ledger.
 */
function appendLedger(collectDir, workflowName, cloudWorkflowName, cloudBaseUrl, newEntries) {
  const existing = readLedger(collectDir, workflowName) || {
    workflowName,
    cloudWorkflowName,
    cloudBaseUrl,
    entries: [],
  };
  // Index by migrationSourceId, then by transitionId+ruleId as fallback for
  // entries that somehow lack it. Update or insert per new entry.
  const byMigId = new Map();
  for (const e of existing.entries || []) {
    const k = e.migrationSourceId || `${e.transitionId}|${e.ruleId}`;
    byMigId.set(k, e);
  }
  for (const e of newEntries || []) {
    const k = e.migrationSourceId || `${e.transitionId}|${e.ruleId}`;
    byMigId.set(k, { ...e });
  }
  const merged = {
    workflowName,
    cloudWorkflowName: cloudWorkflowName || existing.cloudWorkflowName,
    cloudBaseUrl: cloudBaseUrl || existing.cloudBaseUrl,
    lastWrittenAt: new Date().toISOString(),
    entries: Array.from(byMigId.values()),
  };
  fs.writeFileSync(ledgerPath(collectDir, workflowName), JSON.stringify(merged, null, 2));
  return merged.entries.length;
}

/**
 * Build a Set of Cloud rule IDs the ledger says we own for this workflow.
 * Used by `JsuCleaner._stripMigrationTaggedRules` to identify what to remove.
 */
function ourCloudRuleIds(collectDir, workflowName) {
  const led = readLedger(collectDir, workflowName);
  const out = new Set();
  if (!led) return out;
  for (const e of led.entries || []) {
    if (e.ruleId) out.add(String(e.ruleId));
  }
  return out;
}

/**
 * Reconstruct ledger entries by walking an `update_payload_<wf>.json` file
 * (the envelope the applier wrote pre-push). Used by the one-time
 * rebuild-from-payloads utility for any apply that ran before the ledger
 * was wired in.
 *
 * The payload contains every rule we sent INCLUDING the migrationSourceId
 * we stamped (Cloud strips it, but our local payload still has it). Walk
 * every transition's rules, collect those with migrationSourceId set.
 */
function entriesFromPayload(workflowName, payload) {
  const out = [];
  const wf = (payload && payload.workflows && payload.workflows[0]) || null;
  if (!wf) return out;
  const visit = (rule, transition, ruleCategory) => {
    const p = rule && rule.parameters;
    if (!p) return;
    if (!p.migrationSourceId) return;
    out.push({
      migrationSourceId: String(p.migrationSourceId),
      ruleId: p.id ? String(p.id) : null,
      ruleKey: rule.ruleKey,
      transitionId: transition.id,
      transitionName: transition.name,
      ruleCategory,
      shortName: null, // not in payload — caller may enrich from plan
      autoDisabled: p.disabled === "true" || p.disabled === true,
      pushedAt: payload.generatedAt || null,
    });
  };
  for (const t of wf.transitions || []) {
    for (const a of t.actions || []) visit(a, t, "postFunction");
    for (const v of t.validators || []) visit(v, t, "validator");
    const walk = (n) => {
      if (!n) return;
      for (const c of n.conditions || []) visit(c, t, "condition");
      for (const cg of n.conditionGroups || []) walk(cg);
    };
    if (t.conditions) walk(t.conditions);
  }
  return out;
}

module.exports = {
  ledgerPath,
  readLedger,
  readAllLedgers,
  appendLedger,
  ourCloudRuleIds,
  entriesFromPayload,
};
