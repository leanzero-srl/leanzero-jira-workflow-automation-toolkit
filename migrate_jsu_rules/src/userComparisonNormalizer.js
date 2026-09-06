/**
 * Normalize user-object equality comparisons in Jira Expressions.
 *
 * In Jira Expressions, `==` / `!=` on User objects compares object identity,
 * not user identity — two references to the same user can compare unequal.
 * The supported form is `<userObj>.accountId == <userObj>.accountId`.
 *
 * Patterns rewritten (both `==` and `!=`):
 *   user == issue.reporter          → user.accountId == issue.reporter.accountId
 *   issue.reporter != issue.assignee → issue.reporter.accountId != issue.assignee.accountId
 *
 * User-object tokens recognised: `user`, `app.user`, `issue.reporter`,
 * `issue.assignee`, `issue.creator`, `issue.parent.reporter`,
 * `issue.parent.assignee`, `issue.parent.creator`.
 *
 * Left untouched (would be wrong to rewrite):
 *   - `user == null` / `user != null`   (null has no accountId)
 *   - `user.accountId == issue.reporter.accountId` (already normalised — idempotent)
 *   - `issue.reporter.displayName == user.displayName` (operator chose a
 *     different property — respect it)
 *   - Patterns inside quoted string literals.
 *
 * Pure module. Returns `{ output, changes: [{ before, after }] }`.
 */

const USER_OBJ_SOURCE =
  "(?:app\\.user|issue\\.parent\\.(?:reporter|assignee|creator)|issue\\.(?:reporter|assignee|creator)|user)";

// Match a user-object token NOT preceded by a word char OR a dot (so neither
// `iuser` nor `myapp.user` match the standalone `user` alternative), and NOT
// followed by another `.<identifier>` accessor (so `user.accountId` /
// `issue.reporter.displayName` are excluded).
const TOKEN_START = "(?<![A-Za-z0-9_.])";
const TOKEN_END = "(?![A-Za-z0-9_])(?!\\s*\\.\\s*[A-Za-z_])";
const CMP_RE = new RegExp(
  `${TOKEN_START}(${USER_OBJ_SOURCE})${TOKEN_END}\\s*(===|!==|==|!=)\\s*${TOKEN_START}(${USER_OBJ_SOURCE})${TOKEN_END}`,
  "g",
);

// Mask quoted string literals so the regex never matches inside them.
// Supports single and double quotes with backslash escapes.
function maskStrings(text) {
  const tokens = [];
  let masked = "";
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\" && j + 1 < text.length) {
          j += 2;
          continue;
        }
        if (text[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      const placeholder = `STR${tokens.length}`;
      tokens.push(text.slice(i, j));
      masked += placeholder;
      i = j;
    } else {
      masked += ch;
      i++;
    }
  }
  return { masked, tokens };
}

function unmask(text, tokens) {
  return text.replace(/STR(\d+)/g, (_, n) => tokens[Number(n)]);
}

/**
 * Rewrite user-object comparisons to compare `.accountId`.
 * @param {string} text
 * @returns {{ output: string, changes: Array<{before:string,after:string}> }}
 */
function normalizeUserComparisons(text) {
  if (typeof text !== "string" || !text) return { output: text || "", changes: [] };

  const { masked, tokens } = maskStrings(text);
  const changes = [];

  const rewritten = masked.replace(CMP_RE, (full, left, op, right) => {
    const after = `${left}.accountId ${op} ${right}.accountId`;
    changes.push({ before: full, after });
    return after;
  });

  return { output: unmask(rewritten, tokens), changes };
}

module.exports = { normalizeUserComparisons };
