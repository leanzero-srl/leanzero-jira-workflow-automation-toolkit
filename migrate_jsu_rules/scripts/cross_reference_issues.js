#!/usr/bin/env node
/**
 * cross_reference_issues.js — Phase A.2 of Round 3 audit fix.
 *
 * Joins each parsed audit issue (from triage/issues.json) against:
 *   - conversion_plan.json (DC source — workflow + transition + shortName +
 *     migrationSourceId + configuration)
 *   - the mapper output (offline mapper run produces the emit shape the
 *     applier WOULD push to Cloud, without requiring a live apply)
 *
 * Workflow-name matching is fuzzy: exact → DC mangling variants
 * (`:` ↔ `_`, `/` ↔ `_`) → case-folded. Unmatched issues emit a
 * reconciliation CSV for manual edits.
 *
 * Output:
 *   triage/issues_resolved.json
 *   triage/issue_workflow_reconcile.csv (only when unmatched issues exist)
 *
 * Usage:
 *   node scripts/cross_reference_issues.js --collect-dir <path>
 */

const fs = require("fs");
const path = require("path");
const { convertToJmwe } = require("../src/jsuJmweMappers");

function parseArgs() {
  const args = { collectDir: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--collect-dir") args.collectDir = argv[++i];
  }
  if (!args.collectDir) { console.error("--collect-dir required"); process.exit(2); }
  return args;
}

function loadContext(collectDir) {
  const ctx = { fieldRemapping: {}, cloudFieldNames: {}, dcFieldNames: {}, dcUserMap: {} };
  // Order matters — later loads override earlier ones for the same key. We
  // want field_remapping_resolved.json (built by the applier) to win over
  // any older field_remapping.json.
  const paths = [
    ["fieldRemapping", "field_remapping.json"],
    ["fieldRemapping", "field_remapping_resolved.json"],
    ["cloudFieldNames", "cloud_field_catalog.json"],
    ["dcFieldNames", "dc_field_catalog.json"],
    ["dcFieldNames", "field_mapping.json"],
  ];
  for (const [key, file] of paths) {
    const p = path.join(collectDir, file);
    if (fs.existsSync(p)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
        if (parsed.fieldRemapping) ctx[key] = parsed.fieldRemapping;
        else if (parsed.byId) ctx[key] = parsed.byId;
        else ctx[key] = parsed;
      } catch {}
    }
  }
  // Load DC user map from the resolver cache so mappers' applyRunAs uses
  // the resolved accountIds (otherwise every rule with a runAsUser flags
  // UnresolvedRunAsUser).
  const userP = path.join(collectDir, "dc_user_cloud_map.json");
  if (fs.existsSync(userP)) {
    try {
      const store = JSON.parse(fs.readFileSync(userP, "utf8"));
      if (store && store.entries) ctx.dcUserMap = store.entries;
    } catch {}
  }
  return ctx;
}

// Canonical workflow-name normaliser. DC export turns `:` and `/` into `_`;
// audit text uses display names. Compare a normalised form.
function canonicalWorkflowName(name) {
  if (!name) return "";
  return String(name)
    .replace(/[/:]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function matchWorkflow(issueName, planNames) {
  const canon = canonicalWorkflowName(issueName);
  for (const p of planNames) {
    if (canonicalWorkflowName(p) === canon) return p;
  }
  // Suffix/prefix fuzzy
  for (const p of planNames) {
    const pc = canonicalWorkflowName(p);
    if (pc.includes(canon) || canon.includes(pc)) return p;
  }
  return null;
}

// Extract the audit-transition display name from "Create - Post function"
// style strings; we keep only the leading transition name part.
function parseTransitionField(s) {
  if (!s) return { transitionName: "", category: "" };
  const cleaned = s.replace(/\s+/g, " ").trim();
  // Common shapes: "Create - Post function" / "Create Post function" /
  // "Approval Provided - Condition" / "Reject - Post function"
  const m = cleaned.match(/^([^-]+?)\s*[- ]+\s*(Post[- ]?function|Validator|Condition|Transition).*$/i);
  if (m) return { transitionName: m[1].trim(), category: m[2].toLowerCase() };
  return { transitionName: cleaned, category: "" };
}

function main() {
  const { collectDir } = parseArgs();
  const issuesPath = path.join(__dirname, "..", "triage", "issues.json");
  if (!fs.existsSync(issuesPath)) {
    console.error("Run parse_confluence_issues.js first."); process.exit(2);
  }
  const issuesDoc = JSON.parse(fs.readFileSync(issuesPath, "utf8"));
  const plan = JSON.parse(fs.readFileSync(path.join(collectDir, "conversion_plan.json"), "utf8"));
  const ctx = loadContext(collectDir);

  // Build plan index: workflow → [rows]
  const planByWf = new Map();
  for (const row of plan.rows || []) {
    const wf = row.workflowName;
    if (!planByWf.has(wf)) planByWf.set(wf, []);
    planByWf.get(wf).push(row);
  }
  const planWfNames = [...planByWf.keys()];

  // Helper: find candidate plan rows matching transition + ruleCategory
  // (postFunction/validator/condition). The audit's "Transition Rule"
  // column has shapes like "Create - Post function" or "Create Post
  // function".
  // Normalise transition name from audit. Handles common operator quirks:
  //   - trailing "(NNN)" DC transition-ID suffix (e.g., "Reopen (1001)")
  //   - mid-word spaces (e.g., "C reate" → "Create")
  //   - case differences
  const normaliseTransitionName = (raw) => {
    if (!raw) return "";
    let s = String(raw).trim();
    s = s.replace(/\s*\(\d+\)\s*$/, ""); // strip "(NNN)" suffix
    // Collapse repeated spaces and remove single-char gaps that look like typos:
    // "C reate" → "Create", "Cre ate" → "Create" (heuristic for known typo pattern).
    // Only collapse spaces if NO word is short enough to be a real ID; safe heuristic
    // is to merge isolated single-letter splits at the start.
    s = s.replace(/^([A-Z])\s+(?=[a-z])/, "$1"); // "C reate" → "Create"
    return s.replace(/\s+/g, " ").trim();
  };
  const findCandidatePlanRows = (planRows, transitionName, category) => {
    if (!transitionName) return planRows;
    const t = normaliseTransitionName(transitionName).toLowerCase();
    const cat = (category || "").trim().toLowerCase();
    const filterByCategory = (rows) => rows.filter((r) => {
      if (!cat) return true;
      if (cat.startsWith("post")) return r.ruleCategory === "postFunction";
      if (cat.startsWith("valid")) return r.ruleCategory === "validator";
      if (cat.startsWith("cond")) return r.ruleCategory === "condition";
      return true;
    });
    // Exact match first
    let hits = planRows.filter((r) => r.transitionName && r.transitionName.toLowerCase() === t);
    if (hits.length > 0) return filterByCategory(hits);
    // Prefix match — audit may say "Create" when plan has "Create Issue"
    hits = planRows.filter((r) => {
      const rn = (r.transitionName || "").toLowerCase();
      return rn.startsWith(t + " ") || t.startsWith(rn + " ");
    });
    if (hits.length > 0) return filterByCategory(hits);
    // Substring match (loose)
    hits = planRows.filter((r) => {
      const rn = (r.transitionName || "").toLowerCase();
      return rn.includes(t) || t.includes(rn);
    });
    return filterByCategory(hits);
  };

  // Process each issue
  const resolved = [];
  const reconcile = [];
  for (const issue of issuesDoc.issues) {
    const matchedWf = matchWorkflow(issue.workflow, planWfNames);
    if (!matchedWf) {
      reconcile.push({ ...issue, reason: "workflow-not-found-in-plan" });
      resolved.push({ ...issue, matchStatus: "workflow-not-found" });
      continue;
    }
    const planRows = planByWf.get(matchedWf) || [];
    const { transitionName, category } = parseTransitionField(issue.transition);
    const candidates = findCandidatePlanRows(planRows, transitionName, category);
    // Run each candidate through the mapper to capture emit shape.
    const emittedCandidates = candidates.map((row) => {
      let emitted = null;
      try {
        emitted = convertToJmwe(row.shortName, row.configuration, { ...ctx, ruleId: row.migrationSourceId });
      } catch {}
      let cfgObj = null;
      if (emitted && emitted.parameters && emitted.parameters.config) {
        try { cfgObj = JSON.parse(emitted.parameters.config); } catch {}
      }
      return {
        migrationSourceId: row.migrationSourceId,
        shortName: row.shortName,
        ruleCategory: row.ruleCategory,
        dcConfig: row.configuration,
        emitted: emitted ? {
          ruleKey: emitted.ruleKey,
          appKey: emitted.parameters && emitted.parameters.appKey,
          disabled: emitted.parameters && emitted.parameters.disabled,
          id: emitted.parameters && emitted.parameters.id,
          configKeys: cfgObj ? Object.keys(cfgObj) : null,
          problems: cfgObj && cfgObj.problems ? cfgObj.problems.map((p) => p.type) : [],
          config: cfgObj, // full emit for downstream phases
        } : null,
      };
    });

    resolved.push({
      ...issue,
      matchStatus: candidates.length > 0 ? "matched" : "transition-not-found",
      matchedWorkflow: matchedWf,
      parsedTransition: transitionName,
      parsedCategory: category,
      candidateCount: candidates.length,
      candidates: emittedCandidates,
    });

    if (candidates.length === 0) {
      reconcile.push({
        sNo: issue.sNo,
        workflow: issue.workflow,
        matchedWorkflow: matchedWf,
        transition: issue.transition,
        parsedTransition: transitionName,
        parsedCategory: category,
        reason: "transition-not-found-in-plan",
        commentBucket: issue.commentBucket,
      });
    }
  }

  // Write outputs
  const triageDir = path.join(__dirname, "..", "triage");
  if (!fs.existsSync(triageDir)) fs.mkdirSync(triageDir, { recursive: true });

  fs.writeFileSync(
    path.join(triageDir, "issues_resolved.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      collectDir,
      total: resolved.length,
      issues: resolved,
    }, null, 2),
  );

  if (reconcile.length > 0) {
    const cols = ["sNo", "workflow", "matchedWorkflow", "transition", "parsedTransition", "parsedCategory", "reason", "commentBucket"];
    const lines = [cols.join(",")];
    for (const r of reconcile) {
      lines.push(cols.map((c) => `"${String(r[c] || "").replace(/"/g, '""')}"`).join(","));
    }
    fs.writeFileSync(path.join(triageDir, "issue_workflow_reconcile.csv"), lines.join("\n"));
  }

  // Summary
  const statusCounts = {};
  for (const r of resolved) statusCounts[r.matchStatus] = (statusCounts[r.matchStatus] || 0) + 1;
  console.log(`Resolved ${resolved.length} issues → triage/issues_resolved.json`);
  console.log("Match status:");
  for (const [k, v] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)} ${k}`);
  }
  if (reconcile.length > 0) {
    console.log(`\n${reconcile.length} entries need manual reconciliation → triage/issue_workflow_reconcile.csv`);
  }
}

main();
