#!/usr/bin/env node
/**
 * suggest_field_remap.js — Phase C of Round 3 audit fix.
 *
 * Walks every plan row, extracts DC customfield references from the
 * configuration, and emits a CSV of fields that need operator attention:
 *   - dcId  (e.g., customfield_10001)
 *   - dcDisplayName (from dc_field_catalog.json)
 *   - currentRemap (value from field_remapping_resolved.json — empty if null/missing)
 *   - usageCount (how many plan rows reference this dcId)
 *   - auditMentions (which audit issues mention this field-id-mismatch)
 *   - workflowsAffected (deduped)
 *   - cloudCandidates (when cloud_field_catalog.json is available — names whose
 *     name matches the DC name; operator picks one)
 *
 * Output:
 *   triage/field_remap_suggestions.csv
 *
 * Usage:
 *   node scripts/suggest_field_remap.js --collect-dir <path>
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

function loadJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

function flattenStrings(obj, acc) {
  if (obj == null) return;
  if (typeof obj === "string") { acc.push(obj); return; }
  if (Array.isArray(obj)) { for (const v of obj) flattenStrings(v, acc); return; }
  if (typeof obj === "object") { for (const v of Object.values(obj)) flattenStrings(v, acc); }
}

function extractCustomfieldIds(s) {
  const out = new Set();
  const re = /\bcustomfield_\d+/g;
  let m;
  while ((m = re.exec(s)) !== null) out.add(m[0]);
  return out;
}

function csvEscape(v) {
  const s = String(v == null ? "" : v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function main() {
  const { collectDir } = parseArgs();
  const plan = JSON.parse(fs.readFileSync(path.join(collectDir, "conversion_plan.json"), "utf8"));
  const dcCatalog = loadJson(path.join(collectDir, "dc_field_catalog.json"), {});
  const cloudCatalog = loadJson(path.join(collectDir, "cloud_field_catalog.json"), null);
  const remap = loadJson(path.join(collectDir, "field_remapping_resolved.json"), {});

  // Build reverse Cloud catalog: name → [cloudIds] (exact + lowercase)
  const cloudByName = new Map();
  const cloudByToken = new Map(); // token → set of cloudIds (for fuzzy matching)
  if (cloudCatalog && typeof cloudCatalog === "object") {
    for (const [cid, cname] of Object.entries(cloudCatalog)) {
      const k = String(cname || "").toLowerCase().trim();
      if (!k) continue;
      if (!cloudByName.has(k)) cloudByName.set(k, []);
      cloudByName.get(k).push(cid);
      // Tokenise on whitespace; record under each significant token (>=3 chars).
      for (const tok of k.split(/\s+/)) {
        if (tok.length < 3) continue;
        if (!cloudByToken.has(tok)) cloudByToken.set(tok, new Set());
        cloudByToken.get(tok).add(cid);
      }
    }
  }
  // Find fuzzy candidates: cloud fields whose name shares a significant token
  // with the DC display name. Sorted by token-overlap count, then by exactness
  // of the longest shared token.
  function fuzzyCandidates(dcName) {
    if (!dcName) return [];
    const dcTokens = dcName.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
    if (dcTokens.length === 0) return [];
    const scores = new Map();
    for (const tok of dcTokens) {
      const matches = cloudByToken.get(tok);
      if (!matches) continue;
      for (const cid of matches) scores.set(cid, (scores.get(cid) || 0) + 1);
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cid, score]) => `${cid}(${cloudCatalog[cid]}/${score})`);
  }

  // Walk every plan row; collect dc-field references with usage rows
  const usage = new Map(); // dcId → { count, workflows: Set, transitions: Set, shortNames: Set }
  for (const row of plan.rows || []) {
    const strings = [];
    flattenStrings(row.configuration, strings);
    flattenStrings(row.transitionName, strings);
    const ids = new Set();
    for (const s of strings) for (const id of extractCustomfieldIds(s)) ids.add(id);
    for (const id of ids) {
      if (!usage.has(id)) usage.set(id, { count: 0, workflows: new Set(), transitions: new Set(), shortNames: new Set() });
      const u = usage.get(id);
      u.count++;
      u.workflows.add(row.workflowName);
      u.transitions.add(row.transitionName);
      u.shortNames.add(row.shortName);
    }
  }

  // Pull audit-issue mentions for field-id-mismatch bucket (and audit comments
  // mentioning specific customfield IDs).
  const issuesPath = path.join(__dirname, "..", "triage", "issues_resolved.json");
  const issuesDoc = loadJson(issuesPath, { issues: [] });
  const mentionedByField = new Map(); // dcId → [sNo, sNo]
  for (const issue of issuesDoc.issues || []) {
    const blob = `${issue.dcText} ${issue.cloudText} ${issue.commentRaw}`;
    const ids = extractCustomfieldIds(blob);
    for (const id of ids) {
      if (!mentionedByField.has(id)) mentionedByField.set(id, []);
      mentionedByField.get(id).push(issue.sNo);
    }
  }

  // Build the suggestions table
  const rows = [];
  for (const [dcId, u] of usage.entries()) {
    const dcName = dcCatalog[dcId] || "";
    const currentRemap = remap[dcId] || "";
    // Cloud candidates by name match — exact first, then fuzzy (shared tokens)
    let candidates = [];
    let fuzzy = [];
    if (cloudByName.size > 0 && dcName) {
      candidates = cloudByName.get(dcName.toLowerCase().trim()) || [];
      if (candidates.length === 0) fuzzy = fuzzyCandidates(dcName);
    }
    const auditMentions = mentionedByField.get(dcId) || [];
    rows.push({
      dcId,
      dcDisplayName: dcName,
      currentRemap,
      usageCount: u.count,
      workflowsAffected: u.workflows.size,
      auditMentions: auditMentions.length,
      auditSNos: auditMentions.slice(0, 5).join(";"),
      cloudCandidates: candidates.join(";"),
      fuzzyCandidates: fuzzy.join(";"),
      confidence: candidates.length === 1
        ? "high"
        : candidates.length > 1
          ? "ambiguous"
          : (fuzzy.length > 0 ? "fuzzy" : (cloudCatalog ? "no-match" : "no-catalog")),
      shortNames: [...u.shortNames].sort().join(";"),
    });
  }
  // Sort: audit-mentioned first (most operator concern), then by usage count
  rows.sort((a, b) => (b.auditMentions - a.auditMentions) || (b.usageCount - a.usageCount));

  // Write CSV
  const cols = ["dcId", "dcDisplayName", "currentRemap", "usageCount", "workflowsAffected", "auditMentions", "auditSNos", "cloudCandidates", "fuzzyCandidates", "confidence", "shortNames"];
  const triageDir = path.join(__dirname, "..", "triage");
  if (!fs.existsSync(triageDir)) fs.mkdirSync(triageDir, { recursive: true });
  const outPath = path.join(triageDir, "field_remap_suggestions.csv");
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvEscape(r[c])).join(","));
  fs.writeFileSync(outPath, lines.join("\n"));

  // Summary
  const audited = rows.filter((r) => r.auditMentions > 0).length;
  const unresolved = rows.filter((r) => !r.currentRemap).length;
  console.log(`${rows.length} DC custom fields referenced across the plan`);
  console.log(`  → ${audited} are mentioned in the Confluence audit`);
  console.log(`  → ${unresolved} have empty/null current remap`);
  console.log(`  → wrote ${outPath}`);
  if (!cloudCatalog) {
    console.log("");
    console.log("WARNING: no cloud_field_catalog.json in collect-dir — confidence column says 'no-catalog'.");
    console.log("         Re-run --collect to populate it, then re-run this script for auto-suggestions.");
  }
}

main();
