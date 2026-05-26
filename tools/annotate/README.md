# db2i-annotate

Optional LLM-based schema annotator for `mcp-server-db2i`.

This is a **contributor / setup helper**, not part of the MCP server runtime. It reads an introspected schema (cryptic IBM i column names like `KDNR`, `ARTNR`, `FLDX03`) and asks an LLM to generate human-readable descriptions you can merge into your `config.json`.

## Quick start

```bash
# 1. Introspect your schema (writes schema-introspected.json)
cd .. && npm run introspect -- --schema MYLIB && cd tools/annotate

# 2. Annotate it (default: Ollama with llama3.1, English prompt)
npx tsx annotate.ts --input ../../schema-introspected.json

# 3. Merge schema-annotated.json into your config.json under "schema"
```

## Providers

```bash
# Ollama (default — local, no API key)
npx tsx annotate.ts --input schema.json
npx tsx annotate.ts --input schema.json --provider ollama --model qwen2.5

# OpenAI-compatible (OpenAI, Groq, Together, vLLM, …)
OPENAI_API_KEY=sk-... npx tsx annotate.ts --input schema.json \
  --provider openai --model gpt-4o-mini

# Anthropic
ANTHROPIC_API_KEY=sk-ant-... npx tsx annotate.ts --input schema.json \
  --provider anthropic --model claude-3-5-sonnet-latest
```

Environment variables:

| Var                | Purpose                                       |
|--------------------|-----------------------------------------------|
| `LLM_PROVIDER`     | `ollama` (default) / `openai` / `anthropic`   |
| `LLM_MODEL`        | Model name override                           |
| `OLLAMA_URL`       | Default `http://localhost:11434`              |
| `OPENAI_BASE_URL`  | Default `https://api.openai.com/v1`           |
| `OPENAI_API_KEY`   | Required for `openai`                         |
| `ANTHROPIC_API_KEY`| Required for `anthropic`                      |

## Prompts (language / domain)

The system prompt is loaded from a Markdown file, so you can tailor it to your business domain and language without code changes.

- `prompts/default-en.md` — neutral English ERP/IBM i context (default)
- `prompts/example-de.md` — German example

```bash
# Use the German example
npx tsx annotate.ts --input schema.json --prompt prompts/example-de.md

# Or your own
npx tsx annotate.ts --input schema.json --prompt /path/to/my-prompt.md
```

## Modes

| Flag        | Behavior                                              |
|-------------|-------------------------------------------------------|
| *(default)* | Diff mode — only new tables, new cols, TODO entries   |
| `--new`     | Re-annotate everything from scratch                   |
| `--resume`  | Continue an interrupted run (skip already-done)       |
| `--batch-size N` | Tables per LLM call (default 3)                  |

## Output

Writes `schema-annotated.json` in this format:

```json
{
  "schema": {
    "tables": {
      "MYLIB.ORDERS": {
        "description": "Sales orders — one row per line item",
        "columns": {
          "ORDNR": { "description": "Order number", "type": "DECIMAL(10,0)" }
        }
      }
    }
  }
}
```

Copy the `schema.tables` block into your `config.json`.
