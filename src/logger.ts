/**
 * Tiny stderr-only logger.
 *
 * The MCP stdio transport reserves stdout for JSON-RPC messages — any write
 * to stdout corrupts the protocol. All diagnostic output therefore goes to
 * stderr via this module.
 *
 * Level is controlled by the DB2I_LOG_LEVEL env var:
 *   error | warn | info (default) | debug
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function currentLevel(): number {
  const raw = (process.env.DB2I_LOG_LEVEL ?? "info").toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}

function write(level: LogLevel, msg: string): void {
  if (LEVELS[level] > currentLevel()) return;
  process.stderr.write(`[${level}] ${msg}\n`);
}

export const logger = {
  error: (msg: string): void => write("error", msg),
  warn: (msg: string): void => write("warn", msg),
  info: (msg: string): void => write("info", msg),
  debug: (msg: string): void => write("debug", msg),
};
