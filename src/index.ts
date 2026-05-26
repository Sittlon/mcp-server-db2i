#!/usr/bin/env node
/**
 * mcp-server-db2i — MCP server for IBM i (AS/400) DB2 databases.
 *
 * Exposes three tools to LLM clients:
 *   - db2i_schema:   Show available tables, columns, and descriptions
 *   - db2i_query:    Execute a raw SELECT query (role-gated)
 *   - db2i_template: Execute a predefined query template with parameters
 *
 * Usage:
 *   npx mcp-server-db2i                          # stdio transport (default)
 *   npx mcp-server-db2i --config ./my-config.json # custom config path
 *   npx mcp-server-db2i --role analyst            # override default role
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { createConnector } from "./connectors/db.js";
import { buildSchemaInfo, type SchemaInfo } from "./schema/manager.js";
import { validateQuery, validateTemplateAccess } from "./security/guard.js";
import { logger } from "./logger.js";

// ── Parse CLI args ──────────────────────────────────────────

const args = process.argv.slice(2);
const configPath = args.includes("--config")
  ? args[args.indexOf("--config") + 1]
  : undefined;
const roleOverride = args.includes("--role")
  ? args[args.indexOf("--role") + 1]
  : undefined;

// ── Bootstrap ───────────────────────────────────────────────

const config = loadConfig(configPath);
const activeRole = roleOverride ?? config.security.defaultRole;
const roleConfig = config.security.roles[activeRole];

if (!roleConfig) {
  logger.error(`Role "${activeRole}" not found in config`);
  process.exit(1);
}

logger.info(`Active role: ${activeRole}`);
logger.info(`  Raw SELECT: ${roleConfig.allowRawSelect ? "yes" : "no"}`);
logger.info(`  Max rows: ${roleConfig.maxRows}`);
logger.info(`  Schemas: ${roleConfig.allowedSchemas.join(", ")}`);

const connector = createConnector(config.connection);
let schemaInfo: SchemaInfo;

// ── MCP Server ──────────────────────────────────────────────

const server = new Server(
  {
    name: "mcp-server-db2i",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ── List Tools ──────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: any[] = [];

  // 1. Schema tool (always available)
  tools.push({
    name: "db2i_schema",
    description:
      "Show the database schema — available tables, their columns, data types, and descriptions. " +
      "Call this first to understand what data is available before writing queries.",
    inputSchema: {
      type: "object" as const,
      properties: {
        table: {
          type: "string",
          description:
            "Optional: filter to a specific table (e.g. 'PINOLIB.VKFRONT'). Omit to see all tables.",
        },
      },
    },
  });

  // 2. Raw query tool (only if role allows)
  if (roleConfig.allowRawSelect) {
    tools.push({
      name: "db2i_query",
      description:
        "Execute a raw SQL SELECT query against the IBM i DB2 database. " +
        "Only SELECT statements are allowed. " +
        "Use db2i_schema first to understand available tables and columns.\n\n" +
        "Available schema:\n" + schemaInfo.asText,
      inputSchema: {
        type: "object" as const,
        properties: {
          sql: {
            type: "string",
            description: "The SQL SELECT statement to execute",
          },
          params: {
            type: "array",
            items: { type: "string" },
            description: "Optional query parameters for ? placeholders",
          },
        },
        required: ["sql"],
      },
    });
  }

  // 3. Template tools (filtered by role)
  const availableTemplates = Object.entries(config.templates).filter(
    ([_, tmpl]) => tmpl.allowedRoles.includes(activeRole)
  );

  if (availableTemplates.length > 0) {
    const templateDescriptions = availableTemplates
      .map(([name, tmpl]) => {
        const params = Object.entries(tmpl.parameters)
          .map(([p, def]) => `  - ${p} (${def.type}): ${def.description}`)
          .join("\n");
        return `• ${name}: ${tmpl.description}\n${params}`;
      })
      .join("\n\n");

    tools.push({
      name: "db2i_template",
      description:
        "Execute a predefined query template with parameters. " +
        "Templates are pre-built, optimized queries for common tasks.\n\n" +
        "Available templates:\n" + templateDescriptions,
      inputSchema: {
        type: "object" as const,
        properties: {
          template: {
            type: "string",
            description: "Template name",
            enum: availableTemplates.map(([name]) => name),
          },
          params: {
            type: "object",
            description: "Template parameters as key-value pairs",
            additionalProperties: true,
          },
        },
        required: ["template"],
      },
    });
  }

  return { tools };
});

// ── Call Tool ───────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: toolArgs } = request.params;

  try {
    switch (name) {
      case "db2i_schema":
        return handleSchema(toolArgs as { table?: string });

      case "db2i_query":
        return await handleQuery(toolArgs as { sql: string; params?: string[] });

      case "db2i_template":
        return await handleTemplate(
          toolArgs as { template: string; params?: Record<string, unknown> }
        );

      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [
        { type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` },
      ],
      isError: true,
    };
  }
});

// ── Tool Handlers ───────────────────────────────────────────

function handleSchema(args: { table?: string }) {
  let text: string;

  if (args.table) {
    const table = schemaInfo.tables.find(
      (t) => t.fullName.toUpperCase() === args.table!.toUpperCase()
    );
    if (!table) {
      text = `Table "${args.table}" not found. Available tables:\n${schemaInfo.tables.map((t) => t.fullName).join("\n")}`;
    } else {
      const cols = table.columns
        .map((c) => `  ${c.name} (${c.type}): ${c.description}`)
        .join("\n");
      text = `${table.fullName}\n${table.description}\n\nColumns:\n${cols}`;
    }
  } else {
    text = schemaInfo.asText;
  }

  return { content: [{ type: "text" as const, text }] };
}

async function handleQuery(args: { sql: string; params?: string[] }) {
  // Security check
  const check = validateQuery(args.sql, roleConfig);
  if (!check.allowed) {
    return {
      content: [{ type: "text" as const, text: `Query blocked: ${check.reason}` }],
      isError: true,
    };
  }

  const result = await connector.query(
    args.sql,
    args.params ?? [],
    roleConfig.maxRows
  );

  const text = formatResult(result);
  return { content: [{ type: "text" as const, text }] };
}

async function handleTemplate(args: {
  template: string;
  params?: Record<string, unknown>;
}) {
  const tmpl = config.templates[args.template];
  if (!tmpl) {
    return {
      content: [
        { type: "text" as const, text: `Template "${args.template}" not found` },
      ],
      isError: true,
    };
  }

  // Role check
  const access = validateTemplateAccess(
    args.template,
    tmpl.allowedRoles,
    activeRole
  );
  if (!access.allowed) {
    return {
      content: [{ type: "text" as const, text: `Access denied: ${access.reason}` }],
      isError: true,
    };
  }

  // Build parameter array in order of ? placeholders
  const paramValues: unknown[] = [];
  for (const [paramName, paramDef] of Object.entries(tmpl.parameters)) {
    const val = args.params?.[paramName] ?? paramDef.default;
    if (val === undefined) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Missing required parameter: ${paramName} (${paramDef.description})`,
          },
        ],
        isError: true,
      };
    }
    paramValues.push(val);
  }

  const result = await connector.query(
    tmpl.sql,
    paramValues,
    roleConfig.maxRows
  );

  const text = `Template: ${args.template}\n${tmpl.description}\n\n${formatResult(result)}`;
  return { content: [{ type: "text" as const, text }] };
}

// ── Helpers ─────────────────────────────────────────────────

function formatResult(result: import("./connectors/db.js").QueryResult): string {
  if (result.rowCount === 0) {
    return "No results found.";
  }

  // Build a simple text table
  const headers = result.columns;
  const widths = headers.map((h) =>
    Math.max(
      h.length,
      ...result.rows.map((r) => String(r[h] ?? "").length)
    )
  );

  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join(" | ");
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");
  const dataLines = result.rows.map((row) =>
    headers.map((h, i) => String(row[h] ?? "").padEnd(widths[i])).join(" | ")
  );

  let text = `${headerLine}\n${separator}\n${dataLines.join("\n")}`;
  text += `\n\n${result.rowCount} rows`;
  if (result.truncated) {
    text += ` (truncated at ${result.rowCount} — increase maxRows or narrow the query)`;
  }

  return text;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  logger.info("mcp-server-db2i starting...");

  await connector.connect();
  schemaInfo = await buildSchemaInfo(config, connector);

  logger.info(`Schema: ${schemaInfo.tables.length} tables loaded`);
  logger.info(`Templates: ${Object.keys(config.templates).length} available`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server running (stdio transport)");

  // Graceful shutdown
  process.on("SIGINT", async () => {
    await connector.disconnect();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(`Server failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
