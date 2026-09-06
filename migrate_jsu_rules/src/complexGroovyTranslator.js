/**
 * complexGroovyTranslator.js — second-tier translators for Groovy shapes
 * that the simple multi-statement translator in groovyToCloud.js can't
 * handle on its own. These are intentionally segregated so the "weird"
 * patterns are easy to find, diagnose, and disable if Cloud behaviour
 * changes.
 *
 * Each translator is tried in order by `complexGroovyToNunjucks`. They
 * all share the same contract:
 *   ({ output, problems, translated }) = fn(text, location, ctx)
 * `translated: false` means "this shape isn't mine"; the caller falls
 * through to the next translator (or the residue detector as the last
 * resort).
 *
 * Shapes covered:
 *
 *   (a) DEF-ONLY      — `def X = EXPR` (single or multiple) with no
 *                       if/else and no `return`. Groovy treats the last
 *                       expression's value as the block's value. Emit:
 *                       `{% set A = … %}{% set B = … %}{{ Last | default(…) }}`
 *                       (or just `{{ EXPR }}` for the single-def case).
 *
 *   (b) ELSE-IF CHAIN — `if (A) return 1 else if (B) return 2 else if (C)
 *                       return 3 [else return 4]`. Translates to
 *                       `{% if A %}1{% elif B %}2{% elif C %}3{% else %}4{% endif %}`.
 *
 *   (c) UNINIT-DEF    — `def X\n if (cond) { X = a; return X } else
 *                       { X = b; return X }`. The variable is uninitialised
 *                       and assigned per-branch. We INLINE the assignments
 *                       so the output becomes:
 *                       `{% if cond %}a{% else %}b{% endif %}` (no set).
 *
 * Anything outside these shapes returns `translated: false`. The residue
 * detector catches the original and auto-disables the rule.
 */

const {
  groovyTemplateToNunjucks,
  groovyValueExpressionToNunjucks,
  groovyExpressionToJiraExpression,
  atomToNunjucksExpr,
  isCleanJiraExpression,
  isCleanNunjucks,
  nunjucksFieldRef, // eslint-disable-line no-unused-vars
} = require("./groovyToCloud");

// Local copy of splitStatements + paren-balanced splitter from groovyToCloud.
// We keep these private so the public API is just the translators.
function _splitStatements(src) {
  const parts = [];
  let buf = "";
  let parenDepth = 0;
  let braceDepth = 0;
  let inStr = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      buf += ch;
      if (ch === inStr && src[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; buf += ch; continue; }
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === "{") braceDepth++;
    else if (ch === "}") braceDepth--;
    if ((ch === ";" || ch === "\n") && parenDepth === 0 && braceDepth === 0) {
      if (buf.trim()) parts.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

function _findMatchingClose(s, openIdx) {
  let depth = 1;
  let inStr = null;
  for (let i = openIdx + 1; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === inStr && s[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function _stripCommentsAndJoin(src) {
  let out = src.replace(/\/\*\s*custom field ID missing on Cloud\s*\*\//g, "");
  out = out.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  return out;
}

// ─────────────────────────────────────────────────────────────
//  (a) DEF-ONLY translator
// ─────────────────────────────────────────────────────────────

function defOnlyToNunjucks(text, location = [], ctx = null) {
  if (typeof text !== "string" || !text) return { output: text || "", problems: [], translated: false };
  const src = _stripCommentsAndJoin(text).trim();
  if (!src) return { output: text, problems: [], translated: false };
  const stmts = _splitStatements(src);
  if (stmts.length === 0) return { output: text, problems: [], translated: false };
  const defs = [];
  for (const raw of stmts) {
    const stmt = raw.trim().replace(/;$/, "").trim();
    if (!stmt) continue;
    const m = stmt.match(/^def\s+(\w+)\s*=\s*([\s\S]+)$/);
    if (!m) return { output: text, problems: [], translated: false };
    const ident = m[1];
    const expr = atomToNunjucksExpr(m[2].trim(), ctx);
    if (expr == null) return { output: text, problems: [], translated: false };
    defs.push({ ident, expr });
  }
  if (defs.length === 0) return { output: text, problems: [], translated: false };

  // For single-def: skip the `{% set %}` and emit the expression directly
  // inside `{{ }}`. For multi-def: set each, then emit the LAST var.
  let output;
  if (defs.length === 1) {
    output = `{{ ${defs[0].expr} | default("") }}`;
  } else {
    const sets = defs.map((d) => `{% set ${d.ident} = ${d.expr} %}`);
    output = sets.join("") + `{{ ${defs[defs.length - 1].ident} | default("") }}`;
  }
  if (!isCleanNunjucks(output)) return { output: text, problems: [], translated: false };
  return {
    output,
    problems: [{ type: "GroovyTemplateToNunjucks", location }],
    translated: true,
  };
}

// ─────────────────────────────────────────────────────────────
//  (b) ELSE-IF CHAIN translator
// ─────────────────────────────────────────────────────────────

/**
 * Parse `if (COND1) BODY1 else if (COND2) BODY2 ... [else BODYN]` into
 * { branches: [{ cond, body }], elseBody }. Returns null on shape mismatch.
 *
 * Recursive: after parsing the first if, when the trailing rest starts
 * with `else if ...`, we recurse to chain another branch.
 */
function _parseIfElseIfChain(src) {
  const trimmed = src.replace(/\s+/g, " ").trim();
  const ifMatch = trimmed.match(/^if\s*\(/);
  if (!ifMatch) return null;
  const openIdx = ifMatch[0].length - 1;
  const closeIdx = _findMatchingClose(trimmed, openIdx);
  if (closeIdx === -1) return null;
  const cond = trimmed.slice(openIdx + 1, closeIdx).trim();
  let rest = trimmed.slice(closeIdx + 1).trim();
  // Extract this branch's body. Either braced `{...}` or bare-until-else.
  let body = "";
  if (rest.startsWith("{")) {
    const cb = _findMatchingClose("(" + rest, 0); // hack: wrap to reuse matcher
    void cb;
    // Better: manually walk the braces.
    let depth = 1, j = 1, inStr = null;
    for (; j < rest.length; j++) {
      const ch = rest[j];
      if (inStr) { if (ch === inStr && rest[j - 1] !== "\\") inStr = null; continue; }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) return null;
    body = rest.slice(1, j).trim();
    rest = rest.slice(j + 1).trim();
  } else {
    // Bare body — runs until ` else ` (not inside braces/parens/strings).
    let depth = 0, j = 0, inStr = null;
    for (; j < rest.length - 4; j++) {
      const ch = rest[j];
      if (inStr) { if (ch === inStr && rest[j - 1] !== "\\") inStr = null; continue; }
      if (ch === '"' || ch === "'") { inStr = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (depth === 0 && rest.slice(j, j + 6) === " else ") break;
    }
    if (j >= rest.length - 4) {
      // No else found — the body is the full rest, no chain.
      body = rest.trim();
      rest = "";
    } else {
      body = rest.slice(0, j).trim();
      rest = rest.slice(j + 1).trim(); // includes leading "else"
    }
  }
  // Strip leading `return ` from body
  body = body.replace(/^return\s+/, "").trim();
  if (body.endsWith(";")) body = body.slice(0, -1).trim();

  // If next chunk starts with `else if`, recurse.
  if (/^else\s+if\s*\(/.test(rest)) {
    const sub = _parseIfElseIfChain(rest.slice("else ".length).trim());
    if (!sub) return null;
    return { branches: [{ cond, body }, ...sub.branches], elseBody: sub.elseBody };
  }
  // If next chunk starts with `else { ... }` or `else BODY`, capture as elseBody.
  let elseBody = null;
  if (/^else\b/.test(rest)) {
    let after = rest.slice("else".length).trim();
    if (after.startsWith("{")) {
      let depth = 1, j = 1, inStr = null;
      for (; j < after.length; j++) {
        const ch = after[j];
        if (inStr) { if (ch === inStr && after[j - 1] !== "\\") inStr = null; continue; }
        if (ch === '"' || ch === "'") { inStr = ch; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) break; }
      }
      if (depth !== 0) return null;
      elseBody = after.slice(1, j).trim();
    } else {
      elseBody = after.trim();
    }
    elseBody = elseBody.replace(/^return\s+/, "").trim();
    if (elseBody && elseBody.endsWith(";")) elseBody = elseBody.slice(0, -1).trim();
  }
  return { branches: [{ cond, body }], elseBody };
}

function elseIfChainToNunjucks(text, location = [], ctx = null) {
  if (typeof text !== "string" || !text) return { output: text || "", problems: [], translated: false };
  let src = _stripCommentsAndJoin(text);
  // Same blank-line-glue pre-pass as the simple translator.
  src = _joinIfElseAcrossLines(src);
  const stmts = _splitStatements(src);
  if (stmts.length === 0) return { output: text, problems: [], translated: false };

  const setBlocks = [];
  let ifChain = null;
  for (const raw of stmts) {
    const stmt = raw.trim().replace(/;$/, "").trim();
    if (!stmt) continue;
    const defMatch = stmt.match(/^def\s+(\w+)\s*=\s*([\s\S]+)$/);
    if (defMatch) {
      if (ifChain) return { output: text, problems: [], translated: false };
      const expr = atomToNunjucksExpr(defMatch[2].trim(), ctx);
      if (expr == null) return { output: text, problems: [], translated: false };
      setBlocks.push({ ident: defMatch[1], expr });
      continue;
    }
    if (/^if\s*\(/.test(stmt)) {
      const chain = _parseIfElseIfChain(stmt);
      if (!chain) return { output: text, problems: [], translated: false };
      // Require >= 2 branches (else-if). The simple translator already
      // handles 1-branch + else; we only fire when it's a real chain.
      if (chain.branches.length < 2) return { output: text, problems: [], translated: false };
      ifChain = chain;
      continue;
    }
    return { output: text, problems: [], translated: false };
  }
  if (!ifChain) return { output: text, problems: [], translated: false };

  const knownIdents = new Set(setBlocks.map((s) => s.ident));
  const renderBody = (b) => {
    let t = b.trim();
    if (!t) return "";
    const sm = t.match(/^"((?:[^"\\]|\\.)*)"$/) || t.match(/^'((?:[^'\\]|\\.)*)'$/);
    if (sm) return sm[1].replace(/\\(["'\\])/g, "$1");
    if (/^[A-Za-z_]\w*$/.test(t) && knownIdents.has(t)) return `{{ ${t} | default("") }}`;
    // Try value-expression
    const ve = groovyValueExpressionToNunjucks(t, location, ctx);
    if (ve.translated) return ve.output;
    return null;
  };

  const parts = [];
  for (const s of setBlocks) parts.push(`{% set ${s.ident} = ${s.expr} %}`);
  for (let i = 0; i < ifChain.branches.length; i++) {
    const br = ifChain.branches[i];
    const condJE = groovyExpressionToJiraExpression(br.cond, location, ctx);
    if (!isCleanJiraExpression(condJE.output)) return { output: text, problems: [], translated: false };
    const body = renderBody(br.body);
    if (body == null) return { output: text, problems: [], translated: false };
    parts.push(i === 0 ? `{% if ${condJE.output} %}` : `{% elif ${condJE.output} %}`);
    parts.push(body);
  }
  if (ifChain.elseBody != null) {
    const eb = renderBody(ifChain.elseBody);
    if (eb == null) return { output: text, problems: [], translated: false };
    parts.push(`{% else %}${eb}`);
  }
  parts.push(`{% endif %}`);
  const output = parts.join("");
  if (!isCleanNunjucks(output)) return { output: text, problems: [], translated: false };
  return { output, problems: [{ type: "GroovyTemplateToNunjucks", location }], translated: true };
}

// Local copy of joinIfElseAcrossLines from groovyToCloud (not exported).
function _joinIfElseAcrossLines(src) {
  const lines = src.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }
    if (/^if\s*\(/.test(line) || /^else\b/.test(line)) {
      let buf = line;
      i++;
      let sawElse = /^else\b/.test(line);
      let safety = 0;
      while (i < lines.length && safety++ < 200) {
        const t = lines[i].trim();
        i++;
        if (!t) continue;
        buf += " " + t;
        if (/^else\b/.test(t)) { sawElse = true; continue; }
        if (/^return\b/.test(t) || /^\{/.test(t) || /^[A-Za-z_]\w*\s*=/.test(t)) {
          if (sawElse) {
            // Peek for another `else if`
            const peek = (lines[i] || "").trim();
            if (/^else\b/.test(peek)) { continue; }
            break;
          }
          const peek = (lines[i] || "").trim();
          if (!/^else\b/.test(peek) && peek !== "") break;
          continue;
        }
      }
      out.push(buf);
    } else {
      out.push(line);
      i++;
    }
  }
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────
//  (c) UNINIT-DEF translator
// ─────────────────────────────────────────────────────────────

function uninitDefToNunjucks(text, location = [], ctx = null) {
  if (typeof text !== "string" || !text) return { output: text || "", problems: [], translated: false };
  let src = _stripCommentsAndJoin(text);
  src = _joinIfElseAcrossLines(src);
  const stmts = _splitStatements(src);
  if (stmts.length === 0) return { output: text, problems: [], translated: false };
  // First statement must be an uninitialised def: `def X` (no `=`).
  const firstStmt = (stmts[0] || "").trim().replace(/;$/, "").trim();
  const uninitMatch = firstStmt.match(/^def\s+(\w+)\s*$/);
  if (!uninitMatch) return { output: text, problems: [], translated: false };
  const targetVar = uninitMatch[1];
  // Remaining statements must be a single if/else chain whose branches
  // assign `targetVar = EXPR; return targetVar`. Concat the rest.
  const rest = stmts.slice(1).join("\n").trim();
  if (!rest.startsWith("if")) return { output: text, problems: [], translated: false };
  const chain = _parseIfElseIfChain(rest);
  if (!chain) return { output: text, problems: [], translated: false };

  // Each branch body must be `<targetVar>=<EXPR>; return <targetVar>` (or
  // `<EXPR>` if the branch only assigns + returns). Strip the assignment.
  const extractAssign = (body) => {
    const t = body.replace(/\s+/g, " ").trim();
    // Strip surrounding braces
    const inner = t.startsWith("{") && t.endsWith("}") ? t.slice(1, -1).trim() : t;
    // Pattern: `targetVar = EXPR ; return targetVar` (with optional `;`)
    const re = new RegExp(`^${targetVar}\\s*=\\s*([\\s\\S]+?)\\s*;?\\s*return\\s+${targetVar}\\s*;?\\s*$`);
    const m = inner.match(re);
    if (m) return m[1].trim();
    // Pattern: `targetVar = EXPR` (no explicit return — implicit)
    const re2 = new RegExp(`^${targetVar}\\s*=\\s*([\\s\\S]+?)\\s*;?\\s*$`);
    const m2 = inner.match(re2);
    if (m2) return m2[1].trim();
    return null;
  };
  const branches = [];
  for (const br of chain.branches) {
    const expr = extractAssign(br.body);
    if (expr == null) return { output: text, problems: [], translated: false };
    branches.push({ cond: br.cond, expr });
  }
  let elseExpr = null;
  if (chain.elseBody != null) {
    elseExpr = extractAssign(chain.elseBody);
    if (elseExpr == null) return { output: text, problems: [], translated: false };
  }

  // Translate each EXPR to Nunjucks text.
  const renderExpr = (e) => {
    const t = e.trim();
    const sm = t.match(/^"((?:[^"\\]|\\.)*)"$/) || t.match(/^'((?:[^'\\]|\\.)*)'$/);
    if (sm) return sm[1].replace(/\\(["'\\])/g, "$1");
    // Try value-expression translator
    const ve = groovyValueExpressionToNunjucks(t, location, ctx);
    if (ve.translated) return ve.output;
    // Try template translator (for `${X}` or other surface)
    const te = groovyTemplateToNunjucks(t, location, ctx);
    if (te.translated) return te.output;
    return null;
  };
  const renderedBranches = [];
  for (const br of branches) {
    const e = renderExpr(br.expr);
    if (e == null) return { output: text, problems: [], translated: false };
    renderedBranches.push({ cond: br.cond, expr: e });
  }
  let renderedElse = null;
  if (elseExpr != null) {
    renderedElse = renderExpr(elseExpr);
    if (renderedElse == null) return { output: text, problems: [], translated: false };
  }

  // Emit the {% if … elif … else … endif %} block.
  const parts = [];
  for (let i = 0; i < renderedBranches.length; i++) {
    const br = renderedBranches[i];
    const condJE = groovyExpressionToJiraExpression(br.cond, location, ctx);
    if (!isCleanJiraExpression(condJE.output)) return { output: text, problems: [], translated: false };
    parts.push(i === 0 ? `{% if ${condJE.output} %}` : `{% elif ${condJE.output} %}`);
    parts.push(br.expr);
  }
  if (renderedElse != null) parts.push(`{% else %}${renderedElse}`);
  parts.push(`{% endif %}`);
  const output = parts.join("");
  if (!isCleanNunjucks(output)) return { output: text, problems: [], translated: false };
  return { output, problems: [{ type: "GroovyTemplateToNunjucks", location }], translated: true };
}

// ─────────────────────────────────────────────────────────────
//  Dispatcher
// ─────────────────────────────────────────────────────────────

/**
 * Try each complex translator in order. The first one that returns
 * `translated: true` wins. If all bail, returns `translated: false` and
 * the caller hands the original text to the residue detector.
 */
function complexGroovyToNunjucks(text, location = [], ctx = null) {
  // Order matters: try the most-specific translators first.
  const order = [
    uninitDefToNunjucks,       // def X; if (…) X = a; return X else X = b; return X
    elseIfChainToNunjucks,     // if/elif/elif/else
    defOnlyToNunjucks,         // def X = EXPR  (no if, no return)
  ];
  for (const fn of order) {
    try {
      const r = fn(text, location, ctx);
      if (r && r.translated) return r;
    } catch {
      // Translator threw — fall through to the next one. We never want
      // a buggy translator to break the rest of the pipeline.
    }
  }
  return { output: text, problems: [], translated: false };
}

module.exports = {
  complexGroovyToNunjucks,
  // Exposed for unit tests / introspection.
  defOnlyToNunjucks,
  elseIfChainToNunjucks,
  uninitDefToNunjucks,
};
