/**
 * Append a row limit to a SELECT statement when the user hasn't already
 * specified one. Used by every connector before it executes a query.
 *
 * Strategy:
 *   1. Strip a trailing semicolon.
 *   2. If the query already contains a LIMIT or FETCH FIRST clause as a
 *      standalone token (outside string literals), leave it alone.
 *   3. Otherwise wrap the query as
 *        SELECT * FROM (<sql>) AS __db2i_limited FETCH FIRST N ROWS ONLY
 *      which is correct for ORDER BY, UNION, parenthesized queries, and CTEs.
 *
 * DB2 for i supports `FETCH FIRST n ROWS ONLY` natively. For the rare case
 * a query already uses `LIMIT n` (DB2 i 7.2+), we leave it untouched.
 */

export function ensureRowLimit(sql: string, maxRows: number): string {
  if (maxRows <= 0) return sql;

  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (hasExplicitLimit(trimmed)) return trimmed;

  return `SELECT * FROM (${trimmed}) AS __db2i_limited FETCH FIRST ${maxRows} ROWS ONLY`;
}

/**
 * True when the query (ignoring string literals) contains a
 * standalone LIMIT or FETCH FIRST clause.
 */
export function hasExplicitLimit(sql: string): boolean {
  const stripped = stripStringLiterals(sql).toUpperCase();
  return /\bFETCH\s+FIRST\b/.test(stripped) || /\bLIMIT\s+\d+/.test(stripped);
}

function stripStringLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const q = ch;
      out += q;
      i++;
      while (i < sql.length) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) { i += 2; continue; }
          out += q;
          i++;
          break;
        }
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
