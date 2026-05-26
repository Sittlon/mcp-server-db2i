# mcp-server-db2i

[![Node](https://img.shields.io/badge/node-%3E%3D20-blue)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)

**Model Context Protocol server for IBM i (AS/400) DB2 databases.** Plug AI assistants like Claude, Cursor, or any MCP-compatible client into your IBM i data — securely, on-prem, with role-based access.

## Why this exists

IBM i (AS/400) systems run the backbone of thousands of manufacturing, logistics, retail, and ERP shops. The data is valuable, but the table and column names are often cryptic 6–10 char abbreviations (`VKFR01`, `FLDX03`, `KDNR`). This MCP server bridges that gap:

- **Schema annotations** — map cryptic columns to human-readable descriptions the LLM actually understands.
- **Auto-introspection** — discover tables and columns from `QSYS2.SYSTABLES` / `SYSCOLUMNS`, then annotate.
- **Role-based security** — separate `reader`, `analyst`, `admin` permissions; raw SELECT vs. predefined templates.
- **Query templates** — pre-built, parameterized queries for common business questions.
- **Dual connectivity** — ODBC (default) or jt400 (JDBC).

Ask your AI: *"What were sales by region last week?"* — and it knows which tables to query, what the column names mean, and returns real data.

## Quick start

```bash
# Install
npm install mcp-server-db2i

# Create a config from the example
cp config.example.json config/config.json
# Edit config/config.json with your connection string and (optionally) annotations

# Auto-discover your schema (writes schema-introspected.json)
npm run introspect -- --schema MYLIB

# Optional: have an LLM guess descriptions for cryptic columns
cd tools/annotate && npx tsx annotate.ts --input ../../schema-introspected.json
# (See tools/annotate/README.md for OpenAI / Anthropic / Ollama configuration)

# Run the MCP server (stdio transport)
npx mcp-server-db2i
```

## Configuration

Copy `config.example.json` to `config/config.json`. The file has four sections:

### 1. Connection

```json
{
  "connection": {
    "driver": "odbc",
    "odbc": {
      "connectionString": "DSN=AS400;UID=READONLY_USER;PWD=${DB2I_PASSWORD}"
    }
  }
}
```

`${...}` placeholders are interpolated from environment variables at startup. Both `odbc` and `jt400` drivers are supported (jt400 is an optional dependency — install with `npm install jt400` if you prefer JDBC).

> Use a database user with **read-only privileges**. The role-based guard in this server is defense-in-depth, not a substitute for proper DB-level permissions.

### 2. Security (roles)

```json
{
  "security": {
    "defaultRole": "reader",
    "roles": {
      "reader":  { "allowRawSelect": false, "allowedTemplates": ["*"], "maxRows": 500,   "allowedSchemas": ["SAMPLE"] },
      "analyst": { "allowRawSelect": true,  "allowedTemplates": ["*"], "maxRows": 5000,  "allowedSchemas": ["SAMPLE"], "blockedTables": ["USERS"] },
      "admin":   { "allowRawSelect": true,  "allowedTemplates": ["*"], "maxRows": 50000, "allowedSchemas": ["*"] }
    }
  }
}
```

Override the active role at startup with `--role analyst`.

### 3. Schema annotations

```json
{
  "schema": {
    "tables": {
      "SAMPLE.ORDERS": {
        "description": "Sales orders — one row per line item",
        "columns": {
          "ORDNR": { "description": "Order number",         "type": "DECIMAL(10,0)" },
          "PRICE": { "description": "Unit price (EUR)",     "type": "DECIMAL(9,2)" }
        }
      }
    }
  }
}
```

This is the killer feature. Without annotations the LLM sees `FLDX03` and guesses; with annotations it knows `FLDX03` is "unit price in EUR" and writes a correct query the first time.

Use `npm run introspect -- --schema MYLIB` to auto-generate the structure, then fill in descriptions (manually, or via the optional `tools/annotate/` LLM helper).

### 4. Query templates

```json
{
  "templates": {
    "orders_by_region": {
      "description": "Order volume and revenue grouped by region for a date range",
      "parameters": {
        "from_date": { "type": "date", "description": "Start date (YYYY-MM-DD)" },
        "to_date":   { "type": "date", "description": "End date (YYYY-MM-DD)" }
      },
      "sql": "SELECT REGION, SUM(QTY) AS units FROM SAMPLE.ORDERS WHERE ODATE BETWEEN ? AND ? GROUP BY REGION",
      "allowedRoles": ["reader", "analyst"]
    }
  }
}
```

> Templates are safe, parameterized queries. Even `reader` roles can use them.

## MCP tools exposed

| Tool            | Description                                                | Gated by                   |
|-----------------|------------------------------------------------------------|----------------------------|
| `db2i_schema`   | Show available tables, columns, descriptions               | Always available           |
| `db2i_query`    | Execute a raw SELECT query                                 | `allowRawSelect` in role   |
| `db2i_template` | Execute a predefined query template with parameters        | `allowedRoles` on template |

## Security model

- Only `SELECT` (and `WITH … SELECT`) statements pass the parser-level guard.
- DML/DDL keywords (`INSERT`, `UPDATE`, `DROP`, `ALTER`, `GRANT`, `CALL`, …) are rejected.
- Common SQL-injection patterns (line comments, block comments, classic `' OR '1'='1`, `UNION SELECT`) are rejected.
- Schema access is restricted per role.
- Specific tables can be blocked per role.
- Row limits are enforced per role (the server appends `FETCH FIRST N ROWS ONLY` when the query has no explicit limit).
- Templates use parameterized queries (no string concatenation).

See [`docs/SECURITY.md`](docs/SECURITY.md) for the full threat model and recommendations.

## Integration

### Claude Desktop

```json
{
  "mcpServers": {
    "db2i": {
      "command": "npx",
      "args": ["mcp-server-db2i", "--config", "/path/to/config.json"]
    }
  }
}
```

### Any MCP client

Stdio transport is the default — pipe stdin/stdout to any MCP-compatible client.

## Development

```bash
git clone https://github.com/<your-fork>/mcp-server-db2i
cd mcp-server-db2i
npm install
cp config.example.json config/config.json
# Edit config/config.json
npm run dev
npm test
```

You don't need an actual AS/400 connection for most development — the schema manager and security guard are pure functions and have unit tests.

## Roadmap

- [ ] HTTP / SSE / Streamable-HTTP transport (currently stdio only)
- [ ] Native `idb-connector` backend (no ODBC/JDBC stack)
- [ ] Pre-baked annotation packs for common ERP schemas
- [ ] Connection pooling for ODBC

Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Apache-2.0
