/**
 * Detect ScriptRunner DC-only API usage in a JMWE/ScriptRunner rule's
 * stringified config. Used by `wrap()` in jsuJmweMappers.js to give the
 * operator an actionable reason in the CSV instead of the generic
 * "groovy-residue-auto-disabled" — these rules CANNOT be auto-translated
 * because Jira Cloud has no equivalent API. They need a Forge app or a
 * REST-API-backed JMWE Scripted-* rule, written by hand.
 *
 * Patterns:
 *   - `ComponentAccessor.*`               (Java reflection into JIRA core)
 *   - `SearchService`, `getComponent(`    (server-side search/IoC)
 *   - `ApplicationUser`, `PagerFilter`    (DC type references)
 *   - `import com.atlassian.jira.bc.*`    (server-only Atlassian Java BC)
 *   - `import com.atlassian.jira.component.*`
 *   - `assert .. .errors`                 (DC validation-block convention)
 *
 * These patterns indicate the operator wrote ScriptRunner code that relies
 * on JIRA's internal Java APIs. JMWE Cloud's runtime is JavaScript-only
 * (Nunjucks templates + Jira Expressions); none of these exist there.
 *
 * Surfaced as `ScriptRunnerApiNotTranslatable` markers on the rule's
 * problems[] array. The applier picks them up and writes a targeted CSV
 * reason instead of the generic residue reason.
 */

const SCRIPTRUNNER_PATTERNS = [
  [/\bComponentAccessor\s*\./, "ComponentAccessor"],
  [/\bSearchService\b/, "SearchService"],
  [/\bgetComponent\s*\(/, "getComponent"],
  [/\bApplicationUser\b/, "ApplicationUser"],
  [/\bPagerFilter\b/, "PagerFilter"],
  [/\bimport\s+com\.atlassian\.jira\.bc\./, "import-jira-bc"],
  [/\bimport\s+com\.atlassian\.jira\.component\./, "import-jira-component"],
  [/\bassert\s+\w+\s*\.\s*errors\b/, "assert-errors"],
  [/\bJiraAuthenticationContext\b/, "JiraAuthenticationContext"],
  [/\bImportClass\s*\(/, "ImportClass"],
  // Common DC-only base packages that show up when an operator pasted in
  // ScriptRunner snippets verbatim.
  [/\bimport\s+com\.onresolve\b/, "import-onresolve-scriptrunner"],
];

function scanString(s) {
  if (typeof s !== "string" || !s) return [];
  const hits = [];
  for (const [re, label] of SCRIPTRUNNER_PATTERNS) {
    const m = re.exec(s);
    if (m) {
      hits.push({ pattern: label, snippet: contextSnippet(s, m.index, m[0].length) });
    }
  }
  return hits;
}

function contextSnippet(s, start, len) {
  const pad = 25;
  const a = Math.max(0, start - pad);
  const b = Math.min(s.length, start + len + pad);
  let snippet = s.slice(a, b);
  if (a > 0) snippet = "..." + snippet;
  if (b < s.length) snippet = snippet + "...";
  return snippet.replace(/[\r\n\t]+/g, " ").trim();
}

// Same scan-target set the residue detector uses — any string-bearing field
// that could carry Groovy.
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

function detectScriptRunnerApi(config) {
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
        if (k === "problems") continue;
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
  detectScriptRunnerApi,
  scanString,
  SCRIPTRUNNER_PATTERNS,
  SCAN_TARGETS,
};
