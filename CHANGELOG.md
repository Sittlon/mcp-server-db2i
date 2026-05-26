# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Zod-based config schema with friendly validation errors and JSON-schema generation (`npm run gen:schema`).
- Stderr-only `logger` module — stdio MCP transport no longer gets corrupted by log output.
- Provider-agnostic LLM annotator under `tools/annotate/` (Ollama, OpenAI-compatible, Anthropic) with externalized system prompts.
- Test suite (vitest) for security guard, schema manager, config validation, and row-limit logic.
- GitHub Actions CI on Node 20 and 22.
- Cross-platform `~` expansion in config paths (uses `os.homedir()`).
- Documentation: `docs/SECURITY.md`, `docs/CONFIG.md`, `docs/CONNECTORS.md`.

### Changed
- Restructured source layout: `src/schema/manager.ts`, `src/security/guard.ts`, `src/rowlimit.ts`, `src/logger.ts`.
- Hardened SQL guard: strips string literals before pattern checks, recognizes `WITH` CTEs, ignores aliases when checking schema access, supports schema-qualified blocked tables.
- Hardened row-limit logic: wraps queries in a subselect so `ORDER BY`, `UNION`, and trailing `;` no longer break the appended `FETCH FIRST`.
- Replaced Pino-specific example config and German LLM prompt with neutral English defaults.
- `LICENSE` now contains the full Apache-2.0 text.

### Removed
- Committed customer schema dumps (`schema-introspected.json`, `schema-annotated.json`) and committed `node_modules/` (now `.gitignore`d).
- `src/cli/annotate.ts` (moved and generalized under `tools/annotate/`).

## [0.1.0] - TBD

Initial public release.
