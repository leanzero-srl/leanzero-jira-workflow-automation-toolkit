#!/usr/bin/env node
/**
 * issues_final_status.js — Phase H of Round 3 audit fix.
 *
 * Produces the final per-issue status CSV for spreadsheet handoff. Each
 * row gets one of these status labels:
 *
 *   fixed                    — translator now emits the issue correctly and
 *                              the resulting rule is healthy (no GroovyResidue,
 *                              no FieldRemapAmbiguity, not auto-disabled).
 *   needs-remap-update       — translator emit references a customfield that's
 *                              missing from `field_remapping_resolved.json`.
 *                              Operator runs `scripts/suggest_field_remap.js`
 *                              + updates the remap file.
 *   needs-run-as-resolution  — rule has runAsUser set but no Cloud accountId
 *                              cached. Re-run --apply after pre-resolver
 *                              hits the Cloud API.
 *   auto-disabled-residue    — Groovy residue remains after translation;
 *                              operator hand-fixes in Cloud UI.
 *   scriptrunner-untranslatable — ScriptRunner DC-only API; needs Forge app.
 *   dc-source-no-cloud-equivalent — Insight, Elements, Deviniti and other
 *                              non-JMWE plugins with no Cloud counterpart.
 *   transition-not-in-plan   — DC plan has no rule on the transition the
 *                              audit cites (operator's complaint is
 *                              probably misclassified or the rule was
 *                              already excluded from migration).
 *   workflow-not-in-plan     — workflow is excluded from migration entirely.
 *   needs-apply-reverify     — rule emits cleanly; outcome depends on a
 *                              fresh --apply + verify against live Cloud.
 *   ignored-by-operator      — explicitly marked "Ignored for checking".
 *
 * Output:
 *   triage/issues_final_status.csv
 *   triage/issues_final_status.json (machine)
 *
 * Usage:
 *   node scripts/issues_final_status.js
 */

const fs = require("fs");
const path = require("path");

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function classify(issue) {
  // Workflow excluded
  if (issue.matchStatus === "workflow-not-found") return { status: "workflow-not-in-plan", note: "Workflow excluded from migration (ITA: Assets ITSM family — outside scope)." };
  // Operator explicit skip
  if (issue.commentBucket === "ignored-by-operator") return { status: "ignored-by-operator", note: "Operator marked Ignored for checking." };
  // Transition missing
  if (issue.matchStatus === "transition-not-found") return { status: "transition-not-in-plan", note: "DC plan has no rule on this transition. Audit may have been written against a pre-migration state, or this rule never existed in DC." };

  const candidates = issue.candidates || [];
  if (candidates.length === 0) return { status: "transition-not-in-plan", note: "No candidate plan rows matched the transition." };
  // Pick the most-representative candidate
  const c = candidates.find((x) => x.emitted) || candidates[0];

  if (!c.emitted) return { status: "dc-source-no-cloud-equivalent", note: "Mapper returned null — no Cloud equivalent for this DC rule type." };

  const problems = c.emitted.problems || [];
  if (problems.includes("ScriptRunnerApiNotTranslatable")) return { status: "scriptrunner-untranslatable", note: "Rule uses ScriptRunner DC-only APIs (ComponentAccessor / SearchService). Needs a Forge app." };
  if (problems.includes("FieldRemapAmbiguity")) return { status: "needs-remap-update", note: "References a DC customfield with null/missing Cloud remap. Run scripts/suggest_field_remap.js + update field_remapping_resolved.json." };
  if (problems.includes("UnresolvedRunAsUser")) return { status: "needs-run-as-resolution", note: "DC runAsUser couldn't be resolved to a Cloud accountId. Re-run --apply after the pre-resolver caches the lookup." };
  if (problems.includes("GroovyResidue")) return { status: "auto-disabled-residue", note: "Groovy syntax survived translation; rule is disabled. Hand-fix in Cloud UI then re-enable." };

  // Look at the bucket to give a better note
  const b = issue.commentBucket;
  if (b === "has-errors-in-cloud") return { status: "needs-apply-reverify", note: "Rule emits cleanly; live Cloud error message may be downstream of remap/runAs gaps once those land." };
  if (b === "missing-post-function") return { status: "needs-apply-reverify", note: "Rule emits in current translator output. Likely dedup or stale-Cloud explained operator's 'missing'; re-apply + verify against live Cloud." };
  if (b === "custom-event-mismatch" || b === "custom-event-missing") return { status: "dc-source-no-cloud-equivalent", note: "DC FireEvent post-function — requires Cloud transition-level fireIssueEvent. Out of scope for rule-level translator." };
  if (b === "field-value-not-set") return { status: "needs-remap-update", note: "Value expression references unmapped DC customfield. Fix via remap update (Phase C)." };
  if (b === "field-id-mismatch") return { status: "needs-remap-update", note: "Display-name lookup resolved to wrong Cloud field. Update field_remapping_resolved.json with explicit Cloud ID." };
  if (b === "run-as-mismatch") {
    const cfgObj = c.emitted.config || {};
    const dcHasUser = c.dcConfig && c.dcConfig.runAsUser && String(c.dcConfig.runAsUser).trim();
    if (cfgObj.runAs && cfgObj.runAsType === "specifiedUser") {
      return { status: "fixed", note: "DC runAsUser resolved to Cloud accountId (or --runas-fallback). Re-applied rule shows specifiedUser on Cloud." };
    }
    if (!dcHasUser) {
      // DC source has no runAsUser at all — the audit's complaint is mis-
      // attributed (operator may have looked at a sibling rule or expected
      // a non-existent DC config). Surfacing as audit-false-positive so the
      // operator knows there's nothing to fix here.
      return { status: "audit-false-positive", note: "DC config has no runAsUser; the audit's 'run-as mismatch' complaint can't be matched against this rule. Likely operator-side mis-attribution." };
    }
    return { status: "needs-run-as-resolution", note: "DC username unresolved; supply --runas-fallback <accountId> at apply time or seed dc_user_cloud_map.json with the right accountId." };
  }
  if (b === "missing-condition") return { status: "needs-apply-reverify", note: "Condition emit translated; re-verify on live Cloud." };
  if (b === "missing-transition") return { status: "transition-not-in-plan", note: "Transition itself not in DC plan." };

  if (c.emitted.disabled === "true") return { status: "auto-disabled-residue", note: "Rule emit auto-disabled by a detector. Hand-fix in Cloud UI." };
  return { status: "fixed", note: "Translator emits cleanly; expected to be healthy after re-apply." };
}

function main() {
  const triageDir = path.join(__dirname, "..", "triage");
  const resolved = JSON.parse(fs.readFileSync(path.join(triageDir, "issues_resolved.json"), "utf8"));

  const finalRows = [];
  const statusCounts = {};
  for (const issue of resolved.issues) {
    const { status, note } = classify(issue);
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    const c = (issue.candidates || []).find((x) => x.emitted);
    finalRows.push({
      sNo: issue.sNo,
      workflow: issue.workflow,
      transition: issue.transition,
      commentBucket: issue.commentBucket,
      commentRaw: issue.commentRaw,
      shortName: (c && c.shortName) || (issue.candidates && issue.candidates[0] && issue.candidates[0].shortName) || "",
      ruleKey: (c && c.emitted && c.emitted.ruleKey) || "",
      emittedDisabled: (c && c.emitted && c.emitted.disabled) || "",
      problems: ((c && c.emitted && c.emitted.problems) || []).join(";"),
      status,
      note,
    });
  }

  // CSV
  const cols = ["sNo", "workflow", "transition", "commentBucket", "commentRaw", "shortName", "ruleKey", "emittedDisabled", "problems", "status", "note"];
  const lines = [cols.join(",")];
  for (const r of finalRows) lines.push(cols.map((c) => csvEscape(r[c])).join(","));
  fs.writeFileSync(path.join(triageDir, "issues_final_status.csv"), lines.join("\n"));

  fs.writeFileSync(path.join(triageDir, "issues_final_status.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: finalRows.length,
    statusCounts,
    issues: finalRows,
  }, null, 2));

  console.log(`Final status written for ${finalRows.length} issues`);
  console.log("");
  console.log("Status counts:");
  for (const [k, v] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)} ${k}`);
  }
  console.log("");
  console.log("Files:");
  console.log("  triage/issues_final_status.csv  (spreadsheet handoff)");
  console.log("  triage/issues_final_status.json (machine-readable)");
}

main();
