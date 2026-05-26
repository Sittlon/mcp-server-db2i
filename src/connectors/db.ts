/**
 * Database connector abstraction.
 * Supports ODBC and jt400 (JDBC) backends — same interface for both.
 */

import { logger } from "../logger.js";
import { ensureRowLimit } from "../rowlimit.js";

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export interface DbConnector {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[], maxRows?: number): Promise<QueryResult>;
  introspect(schema: string): Promise<IntrospectionResult>;
  disconnect(): Promise<void>;
  readonly driverName: string;
}

export interface IntrospectedColumn {
  name: string;
  type: string;
  nullable: boolean;
  length?: number;
}

export interface IntrospectedTable {
  schema: string;
  name: string;
  columns: IntrospectedColumn[];
}

export interface IntrospectionResult {
  tables: IntrospectedTable[];
}

// ── ODBC Connector ──────────────────────────────────────────

export class OdbcConnector implements DbConnector {
  private connection: any = null;
  private connectionString: string;
  readonly driverName = "odbc";

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  async connect(): Promise<void> {
    const odbc = await import("odbc");
    this.connection = await odbc.default.connect(this.connectionString);
    logger.info("ODBC connected");
  }

  async query(
    sql: string,
    params: unknown[] = [],
    maxRows: number = 1000
  ): Promise<QueryResult> {
    if (!this.connection) throw new Error("Not connected");

    const limitedSql = ensureRowLimit(sql, maxRows);
    const result = await this.connection.query(limitedSql, params);

    const columns = result.columns
      ? result.columns.map((c: any) => c.name)
      : result.length > 0
        ? Object.keys(result[0])
        : [];

    return {
      columns,
      rows: result as Record<string, unknown>[],
      rowCount: result.length,
      truncated: result.length >= maxRows,
    };
  }

  async introspect(schema: string): Promise<IntrospectionResult> {
    if (!this.connection) throw new Error("Not connected");

    const tables: IntrospectedTable[] = [];

    // Get all tables in schema
    // T=Table, P=Physical File, V=View, L=Logical File
    // IBM i stores most data in Physical Files (P), not Tables (T)
    const tableResult = await this.connection.query(
      `SELECT TABLE_NAME, TABLE_TYPE FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('T', 'P', 'V', 'L') ORDER BY TABLE_NAME`,
      [schema]
    );

    for (const row of tableResult) {
      const tableName = (row as any).TABLE_NAME?.trim();
      if (!tableName) continue;

      // Get columns for this table
      const colResult = await this.connection.query(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
         FROM QSYS2.SYSCOLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [schema, tableName]
      );

      const columns: IntrospectedColumn[] = (colResult as any[]).map((c: any) => ({
        name: c.COLUMN_NAME?.trim(),
        type: c.DATA_TYPE?.trim(),
        nullable: c.IS_NULLABLE === "Y",
        length: c.CHARACTER_MAXIMUM_LENGTH ?? undefined,
      }));

      tables.push({ schema, name: tableName, columns });
    }

    return { tables };
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
      logger.info("ODBC disconnected");
    }
  }

}

// ── jt400 (JDBC) Connector ──────────────────────────────────

export class Jt400Connector implements DbConnector {
  private pool: any = null;
  private config: { host: string; user: string; password: string; naming?: string };
  readonly driverName = "jt400";

  constructor(config: { host: string; user: string; password: string; naming?: string }) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      // jt400 is an optional peer dependency; loaded dynamically so the
      // server still works in ODBC-only environments without Java installed.
      // @ts-ignore — module is optional, types may not be present
      const jt400 = await import("jt400");
      this.pool = (jt400 as any).default.pool({
        host: this.config.host,
        user: this.config.user,
        password: this.config.password,
        naming: this.config.naming ?? "system",
      });
      logger.info("jt400 connected");
    } catch (err) {
      throw new Error(
        `jt400 not available. Install with: npm install jt400\n${err}`
      );
    }
  }

  async query(
    sql: string,
    params: unknown[] = [],
    maxRows: number = 1000
  ): Promise<QueryResult> {
    if (!this.pool) throw new Error("Not connected");

    const limitedSql = ensureRowLimit(sql, maxRows);
    const result = await this.pool.query(limitedSql, params);

    const columns = result.length > 0 ? Object.keys(result[0]) : [];

    return {
      columns,
      rows: result as Record<string, unknown>[],
      rowCount: result.length,
      truncated: result.length >= maxRows,
    };
  }

  async introspect(schema: string): Promise<IntrospectionResult> {
    if (!this.pool) throw new Error("Not connected");

    const tableResult = await this.pool.query(
      `SELECT TABLE_NAME, TABLE_TYPE FROM QSYS2.SYSTABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('T', 'P', 'V', 'L') ORDER BY TABLE_NAME`,
      [schema]
    );

    const tables: IntrospectedTable[] = [];

    for (const row of tableResult) {
      const tableName = (row as any).TABLE_NAME?.trim();
      if (!tableName) continue;

      const colResult = await this.pool.query(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
         FROM QSYS2.SYSCOLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [schema, tableName]
      );

      const columns: IntrospectedColumn[] = (colResult as any[]).map((c: any) => ({
        name: c.COLUMN_NAME?.trim(),
        type: c.DATA_TYPE?.trim(),
        nullable: c.IS_NULLABLE === "Y",
        length: c.CHARACTER_MAXIMUM_LENGTH ?? undefined,
      }));

      tables.push({ schema, name: tableName, columns });
    }

    return { tables };
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
      logger.info("jt400 disconnected");
    }
  }
}

// ── Factory ─────────────────────────────────────────────────

export function createConnector(config: {
  driver: "odbc" | "jt400";
  odbc?: { connectionString: string };
  jt400?: { host: string; user: string; password: string; naming?: string };
}): DbConnector {
  if (config.driver === "jt400") {
    if (!config.jt400) throw new Error("jt400 config missing");
    return new Jt400Connector(config.jt400);
  }
  if (!config.odbc) throw new Error("ODBC config missing");
  return new OdbcConnector(config.odbc.connectionString);
}