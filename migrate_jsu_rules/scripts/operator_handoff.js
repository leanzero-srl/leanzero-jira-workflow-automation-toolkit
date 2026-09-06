#!/usr/bin/env node
/**
 * operator_handoff.js — produce 3 operator-facing CSVs from the latest
 * audit triage so the work can be shared/assigned.
 *
 * Splits the 141 audit rows into 3 actionable buckets:
 *
 *   1. triage/operator_manual_rewrite.csv      — ~10 items needing Forge
 *                                                 app / Cloud-API rewrite
 *      (statuses: scriptrunner-untranslatable, dc-source-no-cloud-equivalent,
 *                 workflow-not-in-plan)
 *
 *   2. triage/operator_audit_verification.csv  — ~29 items where the audit's
 *                                                 complaint can't be matched
 *                                                 against DC reality
 *      (statuses: transition-not-in-plan, audit-false-positive)
 *
 *   3. triage/operator_cloud_ui_fix.csv        — ~25 rules emitted as
 *                                                 auto-disabled; operator
 *                                                 hand-fixes Groovy in
 *                                                 Cloud UI then re-enables
 *      (statuses: auto-disabled-residue)
 *
 * Each row carries workflow + transition NAME + transition ID + DC short
 * name + audit comment + Cloud rule ID (when known) + a concrete
 * "what to do" sentence. Operator opens the CSV in Excel and walks the
 * rows.
 *
 * Usage:
 *   node scripts/operator_handoff.js --collect-dir <path>
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = { collectDir: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--collect-dir") args.collectDir = argv[++i];
  }
  if (!args.collectDir) { console.error("--collect-dir required"); process.exit(2); }
  return args;
}

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function loadJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

function main() {
  const { collectDir } = parseArgs();
  const triageDir = path.join(__dirname, "..", "triage");
  const final = loadJson(path.join(triageDir, "issues_final_status.json"), { issues: [] });
  const resolved = loadJson(path.join(triageDir, "issues_resolved.json"), { issues: [] });
  const plan = loadJson(path.join(collectDir, "conversion_plan.json"), { rows: [] });

  // Pick the latest apply_*.json so we can match an audit row to the
  // cloudRuleId that emit produced.
  const applyFiles = fs.readdirSync(collectDir).filter((f) => /^apply_\d{8}_\d{6}\.json$/.test(f)).sort();
  const latestApply = applyFiles[applyFiles.length - 1];
  const apply = latestApply ? loadJson(path.join(collectDir, latestApply), { workflows: [] }) : { workflows: [] };

  // Index plan rows by migrationSourceId → row (for transition IDs).
  const planByMigSrc = new Map();
  for (const row of plan.rows || []) {
    if (row.migrationSourceId) planByMigSrc.set(row.migrationSourceId, row);
  }
  // Index applied rules: migrationSourceId → cloudRuleId
  const cloudIdByMigSrc = new Map();
  for (const wf of apply.workflows || []) {
    for (const a of wf.appended || []) {
      if (a.migrationSourceId && a.ruleId) cloudIdByMigSrc.set(a.migrationSourceId, a.ruleId);
    }
  }
  const resolvedBySNo = new Map();
  for (const i of resolved.issues || []) resolvedBySNo.set(i.sNo, i);

  // Map audit row → handoff row with transition ID + cloudRuleId resolved.
  const buildRow = (item, whatToDo) => {
    const r = resolvedBySNo.get(item.sNo) || {};
    const c = (r.candidates || []).find((x) => x.emitted) || (r.candidates || [])[0] || {};
    const planRow = c.migrationSourceId && planByMigSrc.get(c.migrationSourceId);
    const transitionId = planRow ? planRow.transitionId : "";
    const cloudRuleId = c.migrationSourceId ? (cloudIdByMigSrc.get(c.migrationSourceId) || "") : "";
    return {
      sNo: item.sNo,
      workflow: item.workflow,
      transition: item.transition,
      transitionId,
      dcShortName: c.shortName || "",
      ruleCategory: c.ruleCategory || "",
      migrationSourceId: c.migrationSourceId || "",
      cloudRuleId,
      auditComment: item.commentRaw,
      status: item.status,
      whatToDo,
    };
  };

  // Three buckets
  const buckets = [
    {
      file: "operator_manual_rewrite.csv",
      title: "Manual rewrite required",
      includedStatuses: ["scriptrunner-untranslatable", "dc-source-no-cloud-equivalent", "workflow-not-in-plan"],
      whatToDo: {
        "scriptrunner-untranslatable":
          "Rule uses ScriptRunner DC-only API (ComponentAccessor/SearchService). Hand-rewrite as a Forge app, OR as a JMWE Cloud ScriptedCondition/Validator whose Jira Expression reads REST-API-fetched data.",
        "dc-source-no-cloud-equivalent":
          "DC plugin (Deviniti / FireEvent / Elements Copy & Sync) has no Cloud counterpart. Either drop the rule or rewrite with the Cloud-side equivalent plugin/integration.",
        "workflow-not-in-plan":
          "Workflow is excluded from migration entirely (e.g. ITA: Assets family). Confirm exclusion is intended; if not, add it to the next --collect.",
      },
    },
    {
      file: "operator_audit_verification.csv",
      title: "Audit verification — operator confirms or closes",
      includedStatuses: ["transition-not-in-plan", "audit-false-positive"],
      whatToDo: {
        "transition-not-in-plan":
          "DC plan has no rule on this transition. Verify the audit row wasn't written against a different transition; if confirmed, close the audit row as 'no-op (DC has no rule here)'.",
        "audit-false-positive":
          "Audit says 'Run-As mismatch' but the DC source has no runAsUser at all — the complaint can't be matched. Close the audit row as 'not applicable'.",
      },
    },
    {
      file: "operator_cloud_ui_fix.csv",
      title: "Cloud-UI hand-fix needed (rule auto-disabled)",
      includedStatuses: ["auto-disabled-residue"],
      whatToDo: {
        "auto-disabled-residue":
          "Rule emitted with disabled=true because Groovy survived translation. Open Cloud workflow editor, edit the rule's Groovy/Expression to the Cloud equivalent, re-enable the rule.",
      },
    },
  ];

  const cols = ["sNo", "workflow", "transition", "transitionId", "dcShortName", "ruleCategory", "migrationSourceId", "cloudRuleId", "auditComment", "status", "whatToDo"];
  const written = [];
  for (const b of buckets) {
    const items = (final.issues || []).filter((i) => b.includedStatuses.includes(i.status));
    const rows = items.map((i) => buildRow(i, b.whatToDo[i.status] || ""));
    rows.sort((a, b) => a.workflow.localeCompare(b.workflow) || (a.transition || "").localeCompare(b.transition || "") || a.sNo - b.sNo);
    const lines = [`# ${b.title} — ${rows.length} row(s)`, cols.join(",")];
    for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(","));
    const outPath = path.join(triageDir, b.file);
    fs.writeFileSync(outPath, lines.join("\n"));
    written.push({ file: b.file, count: rows.length, title: b.title });
  }

  console.log("Operator handoff CSVs written:");
  for (const w of written) {
    console.log(`  triage/${w.file.padEnd(38)} ${String(w.count).padStart(4)} row(s)  ${w.title}`);
  }
  console.log(`\nTotal covered: ${written.reduce((a, w) => a + w.count, 0)} of ${(final.issues || []).length}`);
}

main();
