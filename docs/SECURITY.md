# Security model

`mcp-server-db2i` exposes a DB2 for i database to an LLM client. That is inherently a sensitive operation. This document describes the layers of defense, the threats they address, and what they do **not** protect against.

## TL;DR

1. **Use a read-only DB user.** This is the most important rule. Everything else is defense-in-depth.
2. **Never run the server with an admin / `*ALLOBJ` profile.**
3. **Restrict `allowedSchemas` per role** — the LLM can be fooled into asking for tables it shouldn't.
4. **Prefer templates over `allowRawSelect: true`** for production deployments.
5. **Audit your DB-level logs**, not just the MCP server logs.

## Layers of defense

### Layer 1 — Database privileges (mandatory)

The DB user in your `connection.odbc.connectionString` (or `connection.jt400`) **must have SELECT-only privileges** on the schemas you intend to expose. Nothing in this server is a substitute for proper IBM i object authorities.

Recommended setup:
- Dedicated user profile (e.g. `MCPRO`) with `*USE` authority on tables, no `*CHANGE` / `*ALL`.
- Initial program / library list configured for read-only access.
- Optionally, a dedicated subsystem with limited resources (CPU/timeout caps).

### Layer 2 — Role-based config (this server)

`security.roles` defines a set of named roles, each with:

| Field              | Purpose                                                            |
|--------------------|--------------------------------------------------------------------|
| `allowRawSelect`   | If `false`, only templates can be invoked (recommended for prod).  |
| `allowedSchemas`   | Whitelist; `["*"]` disables schema gating (admin only).            |
| `blockedTables`    | Per-role denylist (matched against bare table names).              |
| `maxRows`          | Hard cap appended as `FETCH FIRST N ROWS ONLY`.                    |
| `allowedTemplates` | Reserved for future fine-grained template gating.                  |

The active role is `security.defaultRole` unless overridden with `--role <name>` at startup.

### Layer 3 — SQL guard (`src/security/guard.ts`)

Before any query reaches the connector:

- Must start with `SELECT` or `WITH` (CTEs).
- DML/DDL keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `MERGE`, `GRANT`, `REVOKE`, `CALL`, `EXEC`, `EXECUTE`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`) are rejected.
- Common injection patterns are rejected: line comments (`--`), block comments (`/* */`), classic `' OR '1'='1`, `UNION SELECT`, multi-statement (`;` followed by more SQL).
- String literals are stripped *before* keyword/comment checks, so quoted content (`WHERE name = '--admin'`) does not produce false positives.
- Schema gating compares each `FROM`/`JOIN`/`INTO`/`UPDATE`/`TABLE` qualifier against `allowedSchemas`. Aliases (`o.col`) are ignored.
- Blocked tables are matched against the bare table name in any FROM/JOIN clause, with or without schema qualifier.

The guard is regex-based and intentionally conservative. It will refuse some legitimate-looking queries (anything with `--` even inside a comment is rejected). That is by design — false positives are easier to debug than false negatives.

### Layer 4 — Row caps & truncation

The connector wraps every query as
```sql
SELECT * FROM (<your-sql>) AS __db2i_limited FETCH FIRST <maxRows> ROWS ONLY
```
unless an explicit `FETCH FIRST` or `LIMIT` is already present. The result includes a `truncated` flag so the LLM (and the user) knows when output was capped.

## What this server does **not** protect against

- A compromised LLM client. If the client itself is hostile, `allowRawSelect: true` plus broad `allowedSchemas` is a very wide door.
- Side-channel data exfiltration via legitimate templates (e.g. a template that joins customer data into an aggregate).
- Resource-exhaustion attacks via expensive queries. Use IBM i query governors (`QQRYTIMLMT`, `QQRYDEGREE`) to cap query cost.
- Network-layer attacks. Run the server behind a firewall / VPN; stdio transport assumes a trusted local client.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems. Email the maintainers (see `package.json`'s `author` / `bugs` field) with details and a proof of concept. We aim to acknowledge within 72 hours.
