#!/usr/bin/env node
/**
 * measure_residue.js — offline count of GroovyResidue and ScriptRunnerAPI
 * markers across a conversion_plan.json. Used to verify R2 translator
 * improvements drop residue counts.
 *
 * Usage: node scripts/measure_residue.js --collect-dir /tmp/sandbox_final2
 */
const fs = require("fs");
const path = require("path");
const { convertToJmwe } = require("../src/jsuJmweMappers");

const args = process.argv.slice(2);
let collectDir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--collect-dir") collectDir = args[++i];
}
if (!collectDir) { console.error("--collect-dir required"); process.exit(2); }

const plan = JSON.parse(fs.readFileSync(path.join(collectDir, "conversion_plan.json"), "utf8"));
const ctx = { fieldRemapping: {}, cloudFieldNames: {} };
const remapPath = path.join(collectDir, "field_remapping.json");
if (fs.existsSync(remapPath)) Object.assign(ctx, JSON.parse(fs.readFileSync(remapPath, "utf8")));

let totalRules = 0, withResidue = 0, withScriptRunnerApi = 0;
const byPattern = {}, byField = {}, samples = [];

for (const row of plan.rows || []) {
  if (!row.shortName) continue;
  const c = convertToJmwe(row.shortName, row.configuration, ctx);
  if (!c || !c.parameters) continue;
  totalRules++;
  let cfg;
  try { cfg = JSON.parse(c.parameters.config); } catch { continue; }
  const g = (cfg.problems || []).filter((p) => p.type === "GroovyResidue");
  const s = (cfg.problems || []).filter((p) => p.type === "ScriptRunnerApiNotTranslatable");
  if (g.length) withResidue++;
  if (s.length) withScriptRunnerApi++;
  for (const m of g) {
    const loc = Array.isArray(m.location) ? m.location : [];
    const field = loc[0] || "?";
    const marker = loc[1] || "";
    const patMatch = marker.match(/^([\w.-]+):/);
    const pat = patMatch ? patMatch[1] : "?";
    byField[field] = (byField[field] || 0) + 1;
    byPattern[pat] = (byPattern[pat] || 0) + 1;
    samples.push({ shortName: row.shortName, field, pat, marker, wf: row.workflowName, tr: row.transitionName });
  }
}

console.log(`Total mapper outputs: ${totalRules}`);
console.log(`Rules with GroovyResidue:  ${withResidue}`);
console.log(`Rules with ScriptRunnerAPI: ${withScriptRunnerApi}`);
console.log("");
console.log("By pattern:");
for (const [k, v] of Object.entries(byPattern).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)} ${k}`);
}
console.log("");
console.log("By field:");
for (const [k, v] of Object.entries(byField).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)} ${k}`);
}

// Print samples on request
if (process.argv.includes("--samples")) {
  console.log("\nUnique snippet samples (up to 30):");
  const seen = new Set();
  let count = 0;
  for (const s of samples) {
    const key = s.marker.slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    if (++count > 30) break;
    console.log(`  [${s.shortName}] ${s.wf}/${s.tr}`);
    console.log(`    ${s.marker.slice(0, 180)}`);
  }
}
