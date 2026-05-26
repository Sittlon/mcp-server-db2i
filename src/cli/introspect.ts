#!/usr/bin/env node
/**
 * Schema introspection CLI — connects to the AS400 and generates
 * a schema config with all tables and columns.
 *
 * Usage:
 *   npm run introspect -- --schema PINOLIB
 *   npm run introspect -- --schema PINOLIB --output schema.json
 */

import { parseArgs } from "node:util";
import { writeFileSync } from "fs";
import { loadConfig } from "../config.js";
import { createConnector } from "../connectors/db.js";

const { values } = parseArgs({
  options: {
    schema: { type: "string", short: "s" },
    output: { type: "string", short: "o", default: "schema-introspected.json" },
    config: { type: "string", short: "c" },
  },
});

async function main() {
  if (!values.schema) {
    console.error("Usage: npm run introspect -- --schema MYLIB");
    process.exit(1);
  }

  const config = loadConfig(values.config);
  const connector = createConnector(config.connection);

  console.log(`\n🔍 Introspecting schema: ${values.schema}\n`);
  await connector.connect();

  const result = await connector.introspect(values.schema);

  console.log(`Found ${result.tables.length} tables:\n`);

  // Build config-compatible output
  const schemaConfig: Record<string, any> = {};

  for (const table of result.tables) {
    const fullName = `${table.schema}.${table.name}`;
    console.log(`  ${fullName} (${table.columns.length} columns)`);

    const columns: Record<string, any> = {};
    for (const col of table.columns) {
      columns[col.name] = {
        description: "TODO: Add description",
        type: col.type + (col.length ? `(${col.length})` : ""),
      };
    }

    schemaConfig[fullName] = {
      description: "TODO: Add description",
      columns,
    };
  }

  // Write output
  const output = JSON.stringify({ schema: { tables: schemaConfig } }, null, 2);
  writeFileSync(values.output!, output, "utf-8");

  console.log(`\n✓ Schema written to ${values.output}`);
  console.log(`  Edit the file to add descriptions for tables and columns.`);
  console.log(`  Then merge into your config.json under the "schema" key.\n`);

  await connector.disconnect();
}

main().catch((err) => {
  console.error("Introspection failed:", err);
  process.exit(1);
});
