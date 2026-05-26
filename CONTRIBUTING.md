# Contributing to mcp-server-db2i

Thanks for your interest! This project bridges IBM i (AS/400) systems with modern AI tooling via the Model Context Protocol.

## Reporting bugs

Open an issue using the bug-report template. Include:
- Your environment (OS, Node version, ODBC driver, IBM i version)
- Steps to reproduce
- Expected vs. actual behavior
- Relevant config (**redact credentials**)

## Feature requests

Use the feature-request template. Describe the use case and why existing tools/templates don't cover it.

## Pull requests

1. Fork the repo and create a feature branch (`git checkout -b feat/my-feature`).
2. Make your changes.
3. Run `npm test -- --run` and `npm run build` locally — both must pass.
4. Add a `## [Unreleased]` entry in `CHANGELOG.md`.
5. Submit a PR using the template.

## Development setup

```bash
git clone https://github.com/<your-fork>/mcp-server-db2i
cd mcp-server-db2i
npm install
cp config.example.json config/config.json
# Edit config/config.json — but a real AS/400 connection isn't required for
# most development; the security guard, schema manager, and row-limit logic
# are pure functions with full unit-test coverage.
npm test
```

## Code style

- TypeScript strict mode.
- Functional where practical; classes for stateful things (connectors).
- No abbreviations in identifiers (except established ones: `sql`, `db`, `cfg`).
- Comments explain *why*, not *what*.
- All runtime logging goes through the `logger` module (stderr-only). **Never** `console.log` from server code — it corrupts the MCP stdio protocol.
- Don't commit real connection strings, real schemas, or customer data. The `.gitignore` already blocks `schema-*.json` and `config/config.json`.

## Areas that need help

- Native `idb-connector` backend (no ODBC/JDBC stack required).
- Pre-baked annotation packs for common IBM i ERP schemas (BPCS, JD Edwards, Infor LX, …) — neutral / anonymized only.
- Streamable-HTTP / SSE transport.
- Connection pooling for ODBC.
- Localized system prompts for `tools/annotate/`.
