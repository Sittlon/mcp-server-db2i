/**
 * SQL Security Guard — validates queries against role permissions before
 * the connector touches the database.
 *
 * IMPORTANT: this is **defense-in-depth**, not a substitute for a read-only
 * database user. Always run the MCP server with a DB account that has
 * SELECT-only privileges on the schemas you intend to expose.
 *
 * Strategy:
 *   1. Strip string literals so quoted content cannot trick keyword/comment
 *      checks (e.g. WHERE NAME = 'O''Brien --').
 *   2. Allow leading SELECT or WITH (CTE) statements.
 *   3. Reject DML/DDL/admin keywords appearing as standalone tokens.
 *   4. Reject classic injection patterns (line/block comments, multi-stmt,
 *      classic OR, UNION SELECT).
 *   5. Enforce role.allowedSchemas / role.blockedTables based on
 *      schema.table references in FROM/JOIN/INTO clauses (aliases ignored).
 */

import type { RoleConfig } from "../config.js";

export interface SecurityCheckResult {
  allowed: boolean;
  reason?: string;
}

const BLOCKED_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE",
  "TRUNCATE", "MERGE", "GRANT", "REVOKE", "CALL", "EXEC",
  "EXECUTE", "COMMIT", "ROLLBACK", "SAVEPOINT",
];

const INJECTION_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /--/, reason: "line comment" },
  { pattern: /\/\*[\s\S]*?\*\//, reason: "block comment" },
  { pattern: /'\s*OR\s+'?[^']*'?\s*=\s*'/i, reason: "classic OR injection" },
  { pattern: /\bUNION\s+(ALL\s+)?SELECT\b/i, reason: "UNION SELECT" },
  { pattern: /;\s*\S/, reason: "multi-statement" },
];

export function validateQuery(
  sql: string,
  role: RoleConfig,
): SecurityCheckResult {
  const trimmedRaw = sql.trim().replace(/;\s*$/, "");
  // String-literal-stripped variant for safe pattern matching.
  const stripped = stripStringLiterals(trimmedRaw);
  const upper = stripped.toUpperCase();

  // 1. Must start with SELECT or WITH … SELECT (CTE)
  if (!/^\s*(SELECT|WITH)\b/i.test(stripped)) {
    return { allowed: false, reason: "Only SELECT (or WITH … SELECT) statements are allowed" };
  }

  // 2. Blocked keyword check on stripped text
  for (const kw of BLOCKED_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(stripped)) {
      return { allowed: false, reason: `Statement contains blocked keyword: ${kw}` };
    }
  }

  // 3. Injection patterns (use stripped text so quoted content is safe)
  for (const { pattern, reason } of INJECTION_PATTERNS) {
    if (pattern.test(stripped)) {
      return { allowed: false, reason: `Query contains a potentially dangerous pattern: ${reason}` };
    }
  }

  // 4. Schema gating
  if (!role.allowedSchemas.includes("*")) {
    const allowed = new Set(role.allowedSchemas.map((s) => s.toUpperCase()));
    for (const schema of extractReferencedSchemas(upper)) {
      if (!allowed.has(schema)) {
        return {
          allowed: false,
          reason: `Access to schema "${schema}" is not permitted for this role`,
        };
      }
    }
  }

  // 5. Blocked tables
  if (role.blockedTables && role.blockedTables.length > 0) {
    const blocked = new Set(role.blockedTables.map((t) => t.toUpperCase()));
    for (const table of extractReferencedTables(upper)) {
      if (blocked.has(table)) {
        return {
          allowed: false,
          reason: `Access to table "${table}" is blocked for this role`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Replace single- and double-quoted string literals with empty quotes so
 * regex-based checks can't be fooled by content inside literals.
 *
 * Handles SQL's doubled-quote escape ('O''Brien') by consuming pairs.
 */
function stripStringLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += quote;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          // doubled-quote escape => stay inside literal
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          out += quote;
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

/**
 * Extract SCHEMA names referenced as `SCHEMA.TABLE` in FROM/JOIN/INTO/UPDATE
 * clauses. Aliases of the form `alias.col` are ignored because they don't
 * appear after a FROM/JOIN keyword.
 */
function extractReferencedSchemas(upperSql: string): string[] {
  const schemas = new Set<string>();
  const re = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+([A-Z_][\w]*)\s*\.\s*[A-Z_][\w]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(upperSql)) !== null) {
    schemas.add(m[1]);
  }
  return [...schemas];
}

/**
 * Extract bare table names referenced after FROM/JOIN, with or without a
 * schema qualifier. Used for the blocked-tables check.
 */
function extractReferencedTables(upperSql: string): string[] {
  const tables = new Set<string>();
  const re = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:[A-Z_][\w]*\s*\.\s*)?([A-Z_][\w]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(upperSql)) !== null) {
    tables.add(m[1]);
  }
  return [...tables];
}

/**
 * Check whether a role may invoke a given template.
 */
export function validateTemplateAccess(
  templateName: string,
  templateRoles: string[],
  userRole: string,
): SecurityCheckResult {
  if (!templateRoles.includes(userRole)) {
    return {
      allowed: false,
      reason: `Template "${templateName}" is not available for role "${userRole}"`,
    };
  }
  return { allowed: true };
}
