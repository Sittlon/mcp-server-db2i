#!/usr/bin/env node
/**
 * Generate config.schema.json from the zod Config schema.
 *
 * The generated file gives editors (VS Code, IntelliJ, Helix, etc.)
 * IntelliSense and inline validation when authoring config.json — picked up
 * via the `"$schema": "./config.schema.json"` line in config.example.json.
 *
 * Run: npm run gen:schema
 */

import { writeFileSync } from "fs";
import { resolve } from "path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ConfigSchema } from "../src/config.js";

const schema = zodToJsonSchema(ConfigSchema, {
  name: "Db2iMcpConfig",
  $refStrategy: "none",
});

const outPath = resolve(process.cwd(), "config.schema.json");
writeFileSync(outPath, JSON.stringify(schema, null, 2) + "\n", "utf-8");
console.log(`Wrote ${outPath}`);
