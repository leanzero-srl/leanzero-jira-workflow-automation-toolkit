/**
 * Detect Groovy-language residue in a JMWE rule's stringified config. Used by
 * `wrap()` in jsuJmweMappers.js to auto-disable rules whose translation from
 * Groovy → Nunjucks / Jira-Expression left fragments behind that Cloud's
 * runtime engines can't evaluate.
 *
 * The translator (`src/groovyToCloud.js`) handles the common patterns —
 * `${issue.get("X")}` GStrings, `issue.getAsString("X")` accessors,
 * `currentUser.displayName`, simple ternaries. What it CAN'T translate stays
 * verbatim and gets flagged via a `problems[]` marker. Pre-2026-05, those
 * rules emitted with `disabled: false` — they'd persist on Cloud, fire when
 * the user clicked the transition, and silently fail (Nunjucks renders empty
 * for unrecognised syntax; Jira Expression throws which JMWE treats as
 * "condition not met").
 *
 * This detector runs as a final emit-time gate. Rules with residue are
 * emitted with `disabled: true` and a `GroovyResidue` marker so the operator
 * sees them in the manual-review workbook and the CSV.
 *
 * The detector is intentionally CONSERVATIVE: false negatives (residue
 * slipping through) are worse than false positives (a clean rule getting
 * disabled by accident). The operator can re-enable a misclassified rule in
 * the Cloud UI; an undetected residue rule is a silent failure.
 */

// Per-string scan. Each pattern is a tuple [regex, label]; the label appears
// in the CSV reason. Order doesn't matter — first match wins per string but
// all strings are scanned independently.
//
// Patterns are intentionally narrow to avoid false positives on legitimate
// Jira Expression / Nunjucks syntax:
//   - `def `        → Groovy variable declaration (not JE/Nunjucks syntax)
//   - `return `     → Groovy explicit return (JE auto-returns last expression;
//                     Nunjucks has no return statement)
//   - `=~`          → Groovy regex-match operator
//   - `try {`       → Groovy try-block (JE has no try/catch)
//   - `customFields.` → ScriptRunner Groovy accessor (use `issue.fields[...]`)
//   - `<%`          → JSP/Velocity scriptlet (DC JMWE template legacy)
//   - `${` outside `{{...}}` → unconverted GString
//   - `import `     → Groovy import statement at top of script
//   - `class ` (with whitespace+brace) → Groovy class definition
//   - `new ` (with type ctor pattern)  → Groovy object construction
//   - `issue.get(` / `issue.getAsString(`  → unconverted Groovy getter
//                     (translator should rewrite these to `issue.X` form)
//
// `?.` and `?:` are Groovy null-safe / Elvis operators — Jira Expressions
// supports `?.` (per docs) so we don't flag that. `?:` IS supported in JE
// too. Don't flag.
const RESIDUE_PATTERNS = [
  [/\bdef\s+[A-Za-z_]\w*\s*=/, "def-declaration"],
  // Start-of-line OR after `;` / `{` (block-start) only. Avoids false
  // positives on plain English email-body text containing "return of
  // equipment" / "return policy" etc. (verified live 2026-05 against 4
  // htmlBody + 3 textBody false positives). `{return X` covers Groovy/Java
  // if/else/method-body returns; `;return X` covers semicolon-separated.
  [/(?:^|[;{])\s*return\s+\S/m, "return-statement"],
  // Groovy imperative `if (X) return Y` and `else return Y`. R2.0's strict
  // start-of-line gate misses these — they're "return" preceded by a
  // closing `)` or the bare `else` keyword. JE has no `return`, so seeing
  // these in a translated expression means the operator wrote Groovy and
  // we didn't translate. (Bug fix 2026-05-23: caught 2 enabled-but-broken
  // expression-validator rules in TRS workflow.)
  [/(?:\belse\b|\bif\s*\([^)]{1,200}\))\s*return\s+\S/, "return-statement-imperative"],
  [/=~\s*[\/'"]/, "regex-match-operator"],
  [/\btry\s*\{/, "try-block"],
  [/\bcatch\s*\(/, "catch-block"],
  [/\bthrow\s+new\s/, "throw-statement"],
  [/\bcustomFields\s*\./, "scriptrunner-customFields-accessor"],
  [/<%[\s\S]*?%>/, "jsp-scriptlet"],
  [/\bimport\s+(?:static\s+)?[A-Za-z_][\w.]*\s*;?/, "groovy-import"],
  [/\bclass\s+[A-Z]\w*\s*(?:extends|implements|\{)/, "groovy-class-definition"],
  [/\bnew\s+[A-Z]\w*\s*\(/, "groovy-constructor"],
  // Unconverted issue accessors. The translator rewrites these to property
  // form; survivors mean translation hit a case it couldn't handle.
  [/\bissue\.get\(\s*["']/, "unconverted-issue.get"],
  [/\bissue\.getAsString\(\s*["']/, "unconverted-issue.getAsString"],
];

// Context gate: a string only gets scanned for residue if it shows at least
// one indicator that it's actually Groovy code, not plain English HTML/text.
// Without this, the residue detector falsely flags email bodies containing
// words like "return", "import", etc. as natural English prose.
//
// Indicators (any one is sufficient):
//   - `${` (CMA-inerted or live GString)
//   - `<%` (Velocity/JSP scriptlet)
//   - `def IDENT =` (Groovy variable declaration)
//   - leading `return EXPR` (start-of-line return)
//   - `import ...`
//   - `class X extends/implements/{`
//   - `issue.<accessor>(` (Groovy method-style accessor)
//   - `customFields.` (ScriptRunner accessor)
//   - `try {` / `catch (`
//   - `=~` regex-match operator
const CONTEXT_INDICATORS = [
  /\$\{/,
  /<%/,
  /\bdef\s+[A-Za-z_]\w*\s*[=:]/,
  /(?:^|[;{])\s*return\s+\S/m,
  /\bimport\s+(?:static\s+)?[A-Za-z_]/,
  /\bclass\s+[A-Z]\w*\s*(?:extends|implements|\{)/,
  /\bissue\s*\.\s*(?:get|getAsString|getAsHtml|getRawValue|setFieldValue)\s*\(/,
  /\bcustomFields\s*\./,
  /\btry\s*\{|\bcatch\s*\(/,
  /=~\s*[\/'"]/,
  // Groovy/Java control-flow with parens — but the parens must contain a
  // CODE token (`==`, `&&`, `issue.X`, etc.), not English prose. A
  // standalone "if (you need help)" in an email body should NOT trigger
  // the gate (verified 2026-05-23: caught both TRS validators AND let
  // the English false positive through).
  /\b(?:if|else|while|for|switch)\s*\([^)]*(?:[!=<>]=|&&|\|\||==|\bissue\.|\buser\.|\bcustomfield_)/,
  /\b(?:if|else|while|for|switch)\s*\{/,
  // Constructor pattern `new TypeName(...)` — distinctly code-shaped.
  /\bnew\s+[A-Z]\w*\s*\(/,
];
function hasGroovyContext(s) {
  if (typeof s !== "string" || !s) return false;
  for (const re of CONTEXT_INDICATORS) {
    if (re.test(s)) return true;
  }
  return false;
}

// GString detection requires more care: `${...}` is Groovy interpolation.
// Nunjucks uses `{{ ... }}` blocks; inside those a single bare `$` is fine.
// Velocity uses `${...}` too — JMWE Cloud's Nunjucks engine does NOT
// interpret `${...}`. So any `${...}` not enclosed in a `{{ ... }}` block
// is residue.
const GSTRING_RE = /\$\{[^}]+\}/g;
const NUNJUCKS_BLOCK_RE = /\{\{[\s\S]*?\}\}/g;

function scanString(s) {
  if (typeof s !== "string" || !s) return [];
  // Skip plain-text strings (HTML email bodies, etc.) that don't show any
  // sign of being Groovy code. This prevents false positives on natural
  // English content like "Please return your equipment" matching the
  // `return-statement` pattern.
  if (!hasGroovyContext(s)) return [];
  const hits = [];
  for (const [re, label] of RESIDUE_PATTERNS) {
    const m = re.exec(s);
    if (m) {
      hits.push({ pattern: label, snippet: contextSnippet(s, m.index, m[0].length) });
    }
  }
  // GString-outside-Nunjucks detection: strip nunjucks blocks then scan.
  const stripped = s.replace(NUNJUCKS_BLOCK_RE, "");
  const gstringMatch = GSTRING_RE.exec(stripped);
  if (gstringMatch) {
    hits.push({
      pattern: "unconverted-gstring",
      snippet: contextSnippet(s, s.indexOf(gstringMatch[0]), gstringMatch[0].length),
    });
  }
  // Reset stateful regex
  GSTRING_RE.lastIndex = 0;
  return hits;
}

function contextSnippet(s, start, len) {
  const pad = 25;
  const a = Math.max(0, start - pad);
  const b = Math.min(s.length, start + len + pad);
  let snippet = s.slice(a, b);
  if (a > 0) snippet = "..." + snippet;
  if (b < s.length) snippet = snippet + "...";
  // Single-line for CSV-friendliness.
  return snippet.replace(/[\r\n\t]+/g, " ").trim();
}

// Walk a config object and scan every string-valued field that could carry a
// Jira Expression or Nunjucks template. Returns an array of detections, each
// `{ field, pattern, snippet }`.
const SCAN_TARGETS = new Set([
  "expression",
  "script",
  "conditionalExecutionScript",
  "conditionalValidationScript",
  "comment",
  "subject",
  "textBody",
  "htmlBody",
  "value",
  "toEmailsScript",
  "groovyExpression",
  "errorMessage",
  "jqlQuery",
]);

function detectGroovyResidue(config) {
  if (!config || typeof config !== "object") return [];
  const out = [];
  const walk = (node, pathPrefix) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${pathPrefix}[${i}]`));
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "problems") continue; // never scan our own translation markers
        const newPrefix = pathPrefix ? `${pathPrefix}.${k}` : k;
        if (typeof v === "string" && SCAN_TARGETS.has(k)) {
          for (const hit of scanString(v)) {
            out.push({ field: newPrefix, ...hit });
          }
        } else {
          walk(v, newPrefix);
        }
      }
    }
  };
  walk(config, "");
  return out;
}

module.exports = {
  detectGroovyResidue,
  scanString,
  // Exposed for tests / introspection only.
  RESIDUE_PATTERNS,
  SCAN_TARGETS,
};
