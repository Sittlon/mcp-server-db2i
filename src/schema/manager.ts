/**
 * Schema Manager — builds rich schema descriptions for LLM consumption.
 * Combines auto-introspected DB metadata with manual annotations from config.
 */

import type { Config, TableAnnotation } from "../config.js";
import type { DbConnector, IntrospectedTable } from "../connectors/db.js";
import { logger } from "../logger.js";

export interface EnrichedColumn {
  name: string;
  type: string;
  description: string;
  nullable?: boolean;
}

export interface EnrichedTable {
  fullName: string;       // SCHEMA.TABLE
  description: string;
  columns: EnrichedColumn[];
}

export interface SchemaInfo {
  tables: EnrichedTable[];
  asText: string;          // Pre-formatted for LLM prompt injection
}

/**
 * Build enriched schema info by merging config annotations with
 * live DB introspection (if available).
 */
export async function buildSchemaInfo(
  config: Config,
  connector?: DbConnector
): Promise<SchemaInfo> {
  const tables: EnrichedTable[] = [];

  // 1. Start with annotated tables from config
  for (const [fullName, annotation] of Object.entries(config.schema.tables)) {
    tables.push(enrichFromAnnotation(fullName, annotation));
  }

  // 2. If connector is available, introspect and merge
  if (connector) {
    const schemas = new Set<string>();
    for (const fullName of Object.keys(config.schema.tables)) {
      const [schema] = fullName.split(".");
      schemas.add(schema);
    }

    for (const schema of schemas) {
      try {
        const introspected = await connector.introspect(schema);
        mergeIntrospection(tables, introspected.tables, config.schema.tables);
      } catch (err) {
        logger.warn(`Introspection failed for schema ${schema}: ${err}`);
      }
    }
  }

  const asText = formatForLLM(tables);
  return { tables, asText };
}

/**
 * Enrich a table purely from config annotations.
 */
function enrichFromAnnotation(
  fullName: string,
  annotation: TableAnnotation
): EnrichedTable {
  const columns: EnrichedColumn[] = Object.entries(annotation.columns).map(
    ([name, col]) => ({
      name,
      type: col.type,
      description: col.description,
    })
  );

  return {
    fullName,
    description: annotation.description,
    columns,
  };
}

/**
 * Merge introspected tables into the enriched set.
 * - Tables already in config get their columns validated/extended
 * - New tables (not in config) get added with generic descriptions
 */
function mergeIntrospection(
  enriched: EnrichedTable[],
  introspected: IntrospectedTable[],
  annotations: Record<string, TableAnnotation>
) {
  for (const table of introspected) {
    const fullName = `${table.schema}.${table.name}`;
    const existing = enriched.find((e) => e.fullName === fullName);
    const annotation = annotations[fullName];

    if (existing) {
      // Merge: add any columns from introspection not in config
      for (const col of table.columns) {
        const hasAnnotation = existing.columns.some(
          (c) => c.name === col.name
        );
        if (!hasAnnotation) {
          existing.columns.push({
            name: col.name,
            type: col.type,
            description: "(no description)",
            nullable: col.nullable,
          });
        }
      }
    } else {
      // New table discovered via introspection
      enriched.push({
        fullName,
        description: `Table ${fullName} (auto-discovered, no annotations)`,
        columns: table.columns.map((c) => ({
          name: c.name,
          type: c.type,
          description: "(no description)",
          nullable: c.nullable,
        })),
      });
    }
  }
}

/**
 * Format schema info as a human/LLM-readable text block.
 * This gets injected into tool descriptions so the LLM knows
 * what tables and columns are available.
 */
function formatForLLM(tables: EnrichedTable[]): string {
  const parts: string[] = [];

  for (const table of tables) {
    parts.push(`📋 ${table.fullName}`);
    parts.push(`   ${table.description}`);
    parts.push(`   Columns:`);
    for (const col of table.columns) {
      parts.push(`   - ${col.name} (${col.type}): ${col.description}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}
