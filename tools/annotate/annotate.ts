#!/usr/bin/env node
/**
 * Schema Auto-Annotator — uses an LLM to guess descriptions for cryptic
 * IBM i table and column names.
 *
 * This is an OPTIONAL contributor / setup helper, not part of the MCP server
 * runtime. It reads an introspected schema (produced by `npm run introspect`),
 * asks an LLM for human-readable descriptions, and writes an annotated schema
 * file you can merge into your config.
 *
 * Default mode compares introspected schema against existing annotations and
 * only processes new tables, new columns, and TODO entries.
 *   --new      Re-annotate everything from scratch.
 *   --resume   Continue an interrupted run.
 *
 * Provider selection (default: ollama, no API key required):
 *   --provider ollama|openai|anthropic
 *   --model    <model-name>
 *   --base-url <url>            (ollama / openai-compatible)
 *
 * Prompt language: pass --prompt path/to/prompt.md to override. A neutral
 * English default ships in ./prompts/default-en.md and a German example in
 * ./prompts/example-de.md.
 *
 * Usage:
 *   npx tsx annotate.ts --input schema-introspected.json
 *   npx tsx annotate.ts --input schema-introspected.json --new
 *   npx tsx annotate.ts --resume --provider openai --model gpt-4o-mini
 */

import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createProvider, type LlmProvider } from "./providers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPT = resolve(HERE, "prompts/default-en.md");

const { values } = parseArgs({
  options: {
    input: { type: "string", short: "i", default: "schema-introspected.json" },
    output: { type: "string", short: "o", default: "schema-annotated.json" },
    "batch-size": { type: "string", short: "b", default: "3" },
    new: { type: "boolean", short: "n", default: false },
    resume: { type: "boolean", short: "r", default: false },
    provider: { type: "string", short: "p" },
    model: { type: "string", short: "m" },
    "base-url": { type: "string" },
    prompt: { type: "string", default: DEFAULT_PROMPT },
  },
});

let llm: LlmProvider;
let SYSTEM_PROMPT: string;

async function askLlm(prompt: string, retries = 2): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await llm.chat(SYSTEM_PROMPT, prompt);
    } catch (err) {
      if (attempt < retries) {
        console.warn(`  Attempt ${attempt + 1} failed, retrying...`);
        await sleep(2000);
      } else {
        throw err;
      }
    }
  }
  throw new Error("Unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Parse LLM response ─────────────────────────────────────

function parseLLMResponse(response: string): Record<string, any> {
  let cleaned = response.trim();
  cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```\s*/gi, "");

  let depth = 0;
  let jsonStart = -1;
  let jsonEnd = -1;

  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "{") {
      if (depth === 0) jsonStart = i;
      depth++;
    } else if (cleaned[i] === "}") {
      depth--;
      if (depth === 0) { jsonEnd = i; break; }
    }
  }

  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error("No JSON object found in response");
  }

  cleaned = cleaned.slice(jsonStart, jsonEnd + 1)
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]")
    .replace(/[\x00-\x1F]/g, " ")
    .replace(/\t/g, " ");

  return JSON.parse(cleaned);
}

// ── Diff logic ──────────────────────────────────────────────

interface DiffResult {
  newTables: string[];
  newColumns: Map<string, string[]>;
  todoTables: string[];
  todoColumns: Map<string, string[]>;
  unchanged: number;
}

function diffSchemas(
  introspected: Record<string, any>,
  existing: Record<string, any>,
): DiffResult {
  const result: DiffResult = {
    newTables: [],
    newColumns: new Map(),
    todoTables: [],
    todoColumns: new Map(),
    unchanged: 0,
  };

  for (const tableName of Object.keys(introspected)) {
    const exTable = existing[tableName];

    if (!exTable) {
      result.newTables.push(tableName);
      continue;
    }

    let tableNeedsWork = false;
    if (isTodo(exTable.description)) {
      result.todoTables.push(tableName);
      tableNeedsWork = true;
    }

    const newCols: string[] = [];
    const todoCols: string[] = [];
    for (const colName of Object.keys(introspected[tableName].columns)) {
      const exCol = exTable.columns?.[colName];
      if (!exCol) newCols.push(colName);
      else if (isTodo(exCol.description)) todoCols.push(colName);
    }

    if (newCols.length > 0) { result.newColumns.set(tableName, newCols); tableNeedsWork = true; }
    if (todoCols.length > 0) { result.todoColumns.set(tableName, todoCols); tableNeedsWork = true; }
    if (!tableNeedsWork) result.unchanged++;
  }

  return result;
}

function isTodo(desc: string | undefined): boolean {
  if (!desc) return true;
  return desc.startsWith("TODO");
}

// ── Annotate functions ──────────────────────────────────────

const MAX_COLUMNS_PER_CALL = 30;

async function annotateSingleTable(
  tableName: string,
  table: any,
  onlyColumns?: string[],
): Promise<{ description: string; columns: Record<string, string> } | null> {
  const colEntries = onlyColumns
    ? onlyColumns.map((c) => [c, table.columns[c]] as [string, any])
    : Object.entries(table.columns) as [string, any][];

  if (colEntries.length <= MAX_COLUMNS_PER_CALL) {
    return annotateSingleCall(tableName, colEntries, true);
  }

  console.log(`  ${tableName}: ${colEntries.length} columns, splitting into chunks of ${MAX_COLUMNS_PER_CALL}`);
  let tableDescription = "";
  const allColumns: Record<string, string> = {};

  const chunks: [string, any][][] = [];
  for (let i = 0; i < colEntries.length; i += MAX_COLUMNS_PER_CALL) {
    chunks.push(colEntries.slice(i, i + MAX_COLUMNS_PER_CALL));
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isFirst = i === 0;
    try {
      const result = await annotateSingleCall(tableName, chunk, isFirst);
      if (result) {
        if (isFirst && result.description) tableDescription = result.description;
        Object.assign(allColumns, result.columns ?? {});
      }
      console.log(`     Chunk ${i + 1}/${chunks.length}: ${Object.keys(result?.columns ?? {}).length}/${chunk.length} columns`);
    } catch (err) {
      console.warn(`     Chunk ${i + 1}/${chunks.length} failed: ${(err as Error).message?.slice(0, 60)}`);
      for (const [colName] of chunk) {
        if (!allColumns[colName]) allColumns[colName] = "TODO (chunk failed)";
      }
    }
  }

  if (!tableDescription && !Object.keys(allColumns).length) return null;
  return { description: tableDescription || "TODO", columns: allColumns };
}

async function annotateSingleCall(
  tableName: string,
  colEntries: [string, any][],
  includeTableDescription: boolean,
): Promise<{ description: string; columns: Record<string, string> } | null> {
  const columns: Record<string, string> = {};
  for (const [colName, colDef] of colEntries) {
    columns[colName] = (colDef as any).type ?? String(colDef);
  }

  const descInstruction = includeTableDescription
    ? `Describe this table and its columns as JSON:`
    : `Describe ONLY these columns of table ${tableName} as JSON (omit table description):`;

  const format = includeTableDescription
    ? `{ "description": "table description", "columns": { "COLNAME": "column description" } }`
    : `{ "description": "", "columns": { "COLNAME": "column description" } }`;

  const prompt = `${descInstruction}

Table: ${tableName}
Columns:
${Object.entries(columns).map(([n, t]) => `  ${n}: ${t}`).join("\n")}

Response format:
${format}`;

  const response = await askLlm(prompt);
  const parsed = parseLLMResponse(response);

  if (parsed.description !== undefined && parsed.columns) {
    return parsed as { description: string; columns: Record<string, string> };
  }
  const firstKey = Object.keys(parsed)[0];
  if (firstKey && parsed[firstKey]?.columns) return parsed[firstKey];
  return null;
}

async function annotateBatch(
  batch: string[],
  tables: Record<string, any>,
): Promise<Record<string, { description: string; columns: Record<string, string> }>> {
  const batchInput: Record<string, any> = {};
  for (const tableName of batch) {
    const columns: Record<string, string> = {};
    for (const [colName, colDef] of Object.entries(tables[tableName].columns)) {
      columns[colName] = (colDef as any).type ?? String(colDef);
    }
    batchInput[tableName] = { columns };
  }

  const prompt = `Describe these tables and columns as JSON. Each table needs a "description" and a "columns" object with column descriptions:

${JSON.stringify(batchInput, null, 2)}`;

  const response = await askLlm(prompt);
  return parseLLMResponse(response);
}

function buildTodoEntry(table: any, reason: string): any {
  const columns: Record<string, any> = {};
  for (const [colName, colDef] of Object.entries(table.columns)) {
    columns[colName] = {
      description: `TODO (${reason})`,
      type: (colDef as any).type ?? String(colDef),
    };
  }
  return { description: `TODO (${reason})`, columns };
}

async function processTable(
  tableName: string,
  introspectedTable: any,
  existingEntry: any | undefined,
  mode: "full" | "columns-only",
  onlyColumns?: string[],
): Promise<any> {
  const result = await annotateSingleTable(tableName, introspectedTable, onlyColumns);
  if (!result) return null;

  if (mode === "full") {
    const columns: Record<string, any> = {};
    for (const [colName, colDef] of Object.entries(introspectedTable.columns)) {
      columns[colName] = {
        description: result.columns?.[colName] ?? "TODO",
        type: (colDef as any).type ?? String(colDef),
      };
    }
    return { description: result.description, columns };
  }

  const merged = JSON.parse(JSON.stringify(existingEntry));
  if (isTodo(merged.description) && result.description) merged.description = result.description;
  for (const colName of onlyColumns ?? []) {
    if (result.columns?.[colName]) {
      merged.columns[colName] = {
        ...merged.columns[colName],
        description: result.columns[colName],
      };
    }
  }
  return merged;
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const inputFile = values.input!;
  const outputFile = values.output!;
  const batchSize = parseInt(values["batch-size"]!);
  const isNew = values.new!;
  const isResume = values.resume!;

  llm = createProvider({
    provider: values.provider,
    model: values.model,
    baseUrl: values["base-url"],
  });
  SYSTEM_PROMPT = readFileSync(values.prompt!, "utf-8");

  console.log(`\nSchema Auto-Annotator`);
  console.log(`   Mode:       ${isNew ? "FULL (--new)" : isResume ? "RESUME" : "DIFF (changes only)"}`);
  console.log(`   Provider:   ${llm.name}`);
  console.log(`   Prompt:     ${values.prompt}`);
  console.log(`   Input:      ${inputFile}`);
  console.log(`   Output:     ${outputFile}`);
  console.log(`   Batch size: ${batchSize}\n`);

  const rawInput = JSON.parse(readFileSync(inputFile, "utf-8"));
  const introspected = rawInput.schema?.tables ?? rawInput.tables ?? rawInput;
  const allTableNames = Object.keys(introspected);
  console.log(`${allTableNames.length} tables in introspected schema`);

  let annotated: Record<string, any> = {};
  if (!isNew && existsSync(outputFile)) {
    try {
      const existing = JSON.parse(readFileSync(outputFile, "utf-8"));
      annotated = existing.schema?.tables ?? existing.tables ?? existing;
      console.log(`${Object.keys(annotated).length} tables in existing annotations`);
    } catch {
      console.warn(`Could not parse ${outputFile}, starting fresh`);
    }
  }

  interface WorkItem {
    tableName: string;
    mode: "full" | "columns-only";
    reason: string;
    onlyColumns?: string[];
  }

  let workItems: WorkItem[] = [];

  if (isNew) {
    workItems = allTableNames.map((t) => ({ tableName: t, mode: "full" as const, reason: "new run" }));
  } else if (isResume) {
    workItems = allTableNames.filter((t) => !annotated[t])
      .map((t) => ({ tableName: t, mode: "full" as const, reason: "resume" }));
  } else {
    const diff = diffSchemas(introspected, annotated);
    console.log(`\nDiff result:`);
    console.log(`   New tables:          ${diff.newTables.length}`);
    console.log(`   TODO tables:         ${diff.todoTables.length}`);
    console.log(`   Tables w/ new cols:  ${diff.newColumns.size}`);
    console.log(`   Tables w/ TODO cols: ${diff.todoColumns.size}`);
    console.log(`   Unchanged:           ${diff.unchanged}`);

    for (const t of diff.newTables) workItems.push({ tableName: t, mode: "full", reason: "new table" });
    for (const t of diff.todoTables) {
      if (!diff.newTables.includes(t)) workItems.push({ tableName: t, mode: "full", reason: "TODO table" });
    }
    for (const [t, cols] of diff.newColumns) {
      if (!diff.newTables.includes(t) && !diff.todoTables.includes(t)) {
        workItems.push({ tableName: t, mode: "columns-only", reason: `${cols.length} new cols`, onlyColumns: cols });
      }
    }
    for (const [t, cols] of diff.todoColumns) {
      if (!diff.newTables.includes(t) && !diff.todoTables.includes(t)) {
        const existing = workItems.find((w) => w.tableName === t);
        if (existing && existing.onlyColumns) {
          existing.onlyColumns.push(...cols);
          existing.reason += ` + ${cols.length} TODO cols`;
        } else if (!existing) {
          workItems.push({ tableName: t, mode: "columns-only", reason: `${cols.length} TODO cols`, onlyColumns: cols });
        }
      }
    }
  }

  console.log(`\n${workItems.length} tables to process\n`);
  if (workItems.length === 0) {
    console.log("Everything up to date! Nothing to annotate.\n");
    return;
  }

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const startTime = performance.now();

  const fullItems = workItems.filter((w) => w.mode === "full");
  const partialItems = workItems.filter((w) => w.mode === "columns-only");

  for (let i = 0; i < fullItems.length; i += batchSize) {
    const batch = fullItems.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(fullItems.length / batchSize);
    if (fullItems.length > 0) console.log(`-- Full batch ${batchNum}/${totalBatches} --`);

    let batchResults: Record<string, any> | null = null;
    if (batchSize > 1) {
      try {
        batchResults = await annotateBatch(batch.map((w) => w.tableName), introspected);
      } catch {
        console.warn(`  Batch failed, falling back to single-table mode`);
      }
    }

    for (const item of batch) {
      try {
        let entry: any = null;
        if (batchResults && batchResults[item.tableName]?.description) {
          const br = batchResults[item.tableName];
          const columns: Record<string, any> = {};
          for (const [colName, colDef] of Object.entries(introspected[item.tableName].columns)) {
            columns[colName] = {
              description: br.columns?.[colName] ?? "TODO",
              type: (colDef as any).type ?? String(colDef),
            };
          }
          entry = { description: br.description, columns };
        }
        if (!entry) {
          entry = await processTable(
            item.tableName, introspected[item.tableName],
            annotated[item.tableName], "full",
          );
        }
        if (entry) {
          annotated[item.tableName] = entry;
          const descCount = Object.values(entry.columns).filter(
            (c: any) => c.description && !c.description.startsWith("TODO"),
          ).length;
          const totalCols = Object.keys(entry.columns).length;
          console.log(`  OK ${item.tableName}: "${entry.description}" (${descCount}/${totalCols}) [${item.reason}]`);
          succeeded++;
        } else {
          annotated[item.tableName] = buildTodoEntry(introspected[item.tableName], "no result");
          console.log(`  -- ${item.tableName}: no result [${item.reason}]`);
          failed++;
        }
      } catch (err) {
        annotated[item.tableName] = buildTodoEntry(introspected[item.tableName], "LLM error");
        console.log(`  XX ${item.tableName}: ${(err as Error).message?.slice(0, 80)} [${item.reason}]`);
        failed++;
      }
      processed++;
    }

    writeFileSync(outputFile, JSON.stringify({ schema: { tables: annotated } }, null, 2), "utf-8");
    const elapsed = (performance.now() - startTime) / 1000;
    const total = fullItems.length + partialItems.length;
    const rate = processed / (elapsed || 1);
    const eta = ((total - processed) / (rate || 1) / 60).toFixed(1);
    console.log(`   ${processed}/${total} done | ${elapsed.toFixed(0)}s | ~${eta} min left\n`);
  }

  if (partialItems.length > 0) {
    console.log(`-- Partial updates (${partialItems.length} tables with new/TODO columns) --`);
  }
  for (const item of partialItems) {
    try {
      const entry = await processTable(
        item.tableName, introspected[item.tableName],
        annotated[item.tableName], "columns-only", item.onlyColumns,
      );
      if (entry) {
        annotated[item.tableName] = entry;
        console.log(`  OK ${item.tableName}: updated ${item.onlyColumns?.length} columns [${item.reason}]`);
        succeeded++;
      } else {
        console.log(`  -- ${item.tableName}: no result [${item.reason}]`);
        failed++;
      }
    } catch (err) {
      console.log(`  XX ${item.tableName}: ${(err as Error).message?.slice(0, 80)} [${item.reason}]`);
      failed++;
    }
    processed++;
    if (processed % 10 === 0) {
      writeFileSync(outputFile, JSON.stringify({ schema: { tables: annotated } }, null, 2), "utf-8");
    }
  }

  writeFileSync(outputFile, JSON.stringify({ schema: { tables: annotated } }, null, 2), "utf-8");

  const totalAnnotated = Object.keys(annotated).length;
  const withDesc = Object.values(annotated).filter(
    (t: any) => t.description && !t.description.startsWith("TODO"),
  ).length;
  const totalCols = Object.values(annotated).reduce(
    (sum: number, t: any) => sum + Object.keys(t.columns).length, 0,
  );
  const colsDescribed = Object.values(annotated).reduce(
    (sum: number, t: any) =>
      sum + Object.values(t.columns).filter(
        (c: any) => c.description && !c.description.startsWith("TODO"),
      ).length,
    0,
  );

  console.log(`\nDone!`);
  console.log(`   Processed:  ${succeeded} succeeded, ${failed} failed`);
  console.log(`   Tables:     ${withDesc}/${totalAnnotated} described`);
  console.log(`   Columns:    ${colsDescribed}/${totalCols} described`);
  console.log(`   Output:     ${outputFile}\n`);
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  console.error("   Run again with --resume to continue\n");
  process.exit(1);
});
