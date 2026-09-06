#!/usr/bin/env node
/**
 * parse_confluence_issues.js — Phase A.1 of Round 3 audit fix.
 *
 * Parses the Confluence storage-format XML at issues.xml into a normalised
 * JSON triage file. Each issue row from the table is captured as one entry.
 * Comment-bucket normalisation collapses case/whitespace variants ("Run As
 * user mismatch" / "Run As user Mismatch" / "Run As user difference" all
 * → `run-as-mismatch`).
 *
 * Output:
 *   triage/issues.json
 *
 * Usage:
 *   node scripts/parse_confluence_issues.js [--xml <path>] [--out <path>]
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = { xml: null, out: null };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--xml") args.xml = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  args.xml = args.xml || path.join(__dirname, "..", "issues.xml");
  args.out = args.out || path.join(__dirname, "..", "triage", "issues.json");
  return args;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s) {
  // Strip all XML/HTML tags but preserve image filenames as `[img: name]`
  return s
    .replace(/<ac:image[^>]*><ri:attachment\s+ri:filename="([^"]+)"[^/]*\/><\/ac:image>/g, " [img: $1] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normaliseComment(raw) {
  if (!raw) return "blank";
  const c = raw.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  // Canonical buckets — order matters (most specific first).
  if (/has? errors? in cloud/.test(c) || /have errors/.test(c) || /jmwe migration errors/.test(c)) return "has-errors-in-cloud";
  if (/missing post[ -]?function/.test(c) || /missing post-function/.test(c)) return "missing-post-function";
  if (/missing transition/.test(c)) return "missing-transition";
  if (/missing condition/.test(c)) return "missing-condition";
  if (/missing custom event/.test(c) || /custom event missing/.test(c)) return "custom-event-missing";
  if (/custom event mismatch/.test(c) || /event mismatch/.test(c)) return "custom-event-mismatch";
  if (/run as user (mismatch|difference)/.test(c)) return "run-as-mismatch";
  if (/field value (is )?not set to be updated/.test(c) || /not set to be updated/.test(c)) return "field-value-not-set";
  if (/should refer customfield|should be customfield|custom field id mismatch/.test(c)) return "field-id-mismatch";
  if (/not migrated properly/.test(c) || /seems to be not migrated/.test(c)) return "not-migrated-properly";
  if (/not migrated/.test(c)) return "not-migrated";
  if (/ignored for checking/.test(c)) return "ignored-by-operator";
  if (/body content html/.test(c)) return "body-html-mismatch";
  return "other:" + (raw.trim().toLowerCase().slice(0, 50) || "blank");
}

function main() {
  const { xml: xmlPath, out } = parseArgs();
  const xml = fs.readFileSync(xmlPath, "utf8");

  // Each issue is a <tr>...</tr>. The header row has <th> cells; skip it.
  const rows = xml.match(/<tr>[\s\S]*?<\/tr>/g) || [];
  const issues = [];
  for (const row of rows) {
    if (/<th/.test(row)) continue; // header
    const tds = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    if (tds.length < 6) continue;
    const cells = tds.map((t) => decodeEntities(stripTags(t)));
    const sNo = cells[0];
    if (!sNo || !/^\d+$/.test(sNo)) continue; // not a real data row
    const commentRaw = cells[5];
    issues.push({
      sNo: Number(sNo),
      workflow: cells[1],
      transition: cells[2],
      dcText: cells[3],
      cloudText: cells[4],
      commentRaw,
      commentBucket: normaliseComment(commentRaw),
    });
  }

  // Bucket counts
  const counts = {};
  for (const i of issues) counts[i.commentBucket] = (counts[i.commentBucket] || 0) + 1;

  const outDir = path.dirname(out);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: path.relative(path.join(__dirname, ".."), xmlPath),
    total: issues.length,
    counts,
    issues,
  }, null, 2));

  console.log(`Parsed ${issues.length} issues → ${out}`);
  console.log("\nBucket counts:");
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)} ${k}`);
  }
}

main();
