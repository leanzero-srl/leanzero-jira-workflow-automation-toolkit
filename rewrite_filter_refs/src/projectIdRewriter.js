// Rewrites DC numeric project IDs to Cloud project keys.
//
// JCMA preserves project keys across DC→Cloud (e.g. "P3" stays "P3") but
// reassigns numeric project IDs — so a filter that says `project = "21540"`
// works on DC (matches by ID) but breaks on Cloud (Cloud's project 21540 is
// different or doesn't exist). The fix: rewrite `project = "<dc_id>"` to
// `project = "<key>"` since the key is portable.
//
// Handled patterns:
//   project = "<numeric>"      → project = "<key>"
//   project = <numeric>        → project = <key>
//   project in ("<numeric>", "X")  → project in ("<key>", "X")
//   project not in (<numeric>, …)  → unchanged shape, numeric tokens replaced
//
// Tokens that are NOT pure numerics are left alone (already keys or names).
// Numerics not in the supplied map are left alone + reported as unresolved.

function rewriteProjectIds(jql, dcProjectIdToKey) {
  if (!jql || typeof jql !== "string") {
    return { rewritten: jql, replacements: [], unresolved: [] };
  }
  if (!dcProjectIdToKey || (dcProjectIdToKey instanceof Map ? dcProjectIdToKey.size === 0 : Object.keys(dcProjectIdToKey).length === 0)) {
    return { rewritten: jql, replacements: [], unresolved: [] };
  }
  const map = dcProjectIdToKey instanceof Map
    ? dcProjectIdToKey
    : new Map(Object.entries(dcProjectIdToKey));

  const replacements = [];
  const unresolved = new Set();

  // Find each `project` clause (case-insensitive, on the LHS) and inspect
  // the RHS. We avoid touching `project` appearing inside string literals by
  // using a stateful walk.
  const reField = /\bproject\b/gi;
  let out = "";
  let lastEnd = 0;
  let m;
  while ((m = reField.exec(jql)) !== null) {
    // Skip if inside a quoted region.
    const before = jql.slice(0, m.index);
    const dquotes = (before.match(/"/g) || []).length;
    const squotes = (before.match(/'/g) || []).length;
    if (dquotes % 2 === 1 || squotes % 2 === 1) continue;

    // Look at what follows
    const after = jql.slice(m.index + m[0].length);
    const opMatch = after.match(/^\s*(=|!=|\bNOT\s+IN\b|\bIN\b)\s*/i);
    if (!opMatch) continue;
    const op = opMatch[1].toUpperCase().replace(/\s+/g, " ");
    const opEnd = m.index + m[0].length + opMatch[0].length;

    let valueEnd, newVal;
    if (op === "IN" || op === "NOT IN") {
      if (jql[opEnd] !== "(") continue;
      // Find matching close paren
      let depth = 1, j = opEnd + 1, inQ = false, qC = "";
      while (j < jql.length && depth > 0) {
        const ch = jql[j];
        if (inQ) {
          if (ch === "\\" && j + 1 < jql.length) { j += 2; continue; }
          if (ch === qC) inQ = false;
          j++; continue;
        }
        if (ch === '"' || ch === "'") { inQ = true; qC = ch; }
        else if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (depth === 0) break;
        j++;
      }
      if (depth !== 0) continue;
      const listInner = jql.slice(opEnd + 1, j);
      const tokens = listInner.split(",");
      const newTokens = tokens.map((rawTok) => {
        const leading = rawTok.match(/^\s*/)[0];
        const trailing = rawTok.match(/\s*$/)[0];
        const core = rawTok.trim();
        // Strip surrounding quotes if present
        let inner = core;
        let q = "";
        if ((core.startsWith('"') && core.endsWith('"')) || (core.startsWith("'") && core.endsWith("'"))) {
          q = core[0];
          inner = core.slice(1, -1);
        }
        if (/^\d+$/.test(inner) && map.has(inner)) {
          const key = map.get(inner);
          replacements.push({ from: inner, to: key, form: "in_list" });
          // Preserve quoting style: if the original had quotes, keep them.
          // (Cloud accepts both bare and quoted project keys; the existing
          // sanitizer will quote later if needed.)
          return `${leading}${q}${key}${q}${trailing}`;
        }
        if (/^\d+$/.test(inner)) {
          unresolved.add(inner);
        }
        return rawTok;
      });
      valueEnd = j + 1; // include the closing paren
      newVal = `(${newTokens.join(",")})`;
    } else {
      // = or !=
      const rest = jql.slice(opEnd);
      let valMatch = rest.match(/^(["'])(\d+)\1/);
      let valLen, inner, q = "";
      if (valMatch) {
        q = valMatch[1];
        inner = valMatch[2];
        valLen = valMatch[0].length;
      } else {
        valMatch = rest.match(/^(\d+)\b/);
        if (!valMatch) continue;
        inner = valMatch[1];
        valLen = valMatch[0].length;
      }
      if (!map.has(inner)) {
        unresolved.add(inner);
        continue;
      }
      const key = map.get(inner);
      replacements.push({ from: inner, to: key, form: "equality" });
      valueEnd = opEnd + valLen;
      newVal = `${q}${key}${q}`;
    }

    // Splice replacement into out
    out += jql.slice(lastEnd, opEnd);
    // For IN form, opEnd is at "(" — we replace from "(" through ")"
    out += newVal;
    lastEnd = valueEnd;
  }
  out += jql.slice(lastEnd);

  return {
    rewritten: out,
    replacements,
    unresolved: Array.from(unresolved),
  };
}

module.exports = { rewriteProjectIds };
