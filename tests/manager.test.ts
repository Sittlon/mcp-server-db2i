import { describe, it, expect } from "vitest";
import { buildSchemaInfo } from "../src/schema/manager.js";
import type { Config } from "../src/config.js";
import type { DbConnector, IntrospectionResult, QueryResult } from "../src/connectors/db.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    connection: { driver: "odbc", odbc: { connectionString: "x" } },
    security: {
      defaultRole: "reader",
      roles: {
        reader: { allowRawSelect: false, allowedTemplates: ["*"], maxRows: 10, allowedSchemas: ["S"] },
      },
    },
    schema: {
      tables: {
        "S.ORDERS": {
          description: "Orders",
          columns: { ORDNR: { description: "Order number", type: "INT" } },
        },
      },
    },
    templates: {},
    ...overrides,
  } as Config;
}

class FakeConnector implements DbConnector {
  readonly driverName = "fake";
  constructor(private result: IntrospectionResult) {}
  async connect() {}
  async disconnect() {}
  async query(): Promise<QueryResult> {
    return { columns: [], rows: [], rowCount: 0, truncated: false };
  }
  async introspect(): Promise<IntrospectionResult> {
    return this.result;
  }
}

describe("buildSchemaInfo", () => {
  it("returns annotated tables when no connector is given", async () => {
    const info = await buildSchemaInfo(makeConfig());
    expect(info.tables).toHaveLength(1);
    expect(info.tables[0].columns[0].description).toBe("Order number");
  });

  it("merges introspected columns missing from annotations as '(no description)'", async () => {
    const conn = new FakeConnector({
      tables: [
        {
          schema: "S",
          name: "ORDERS",
          columns: [
            { name: "ORDNR", type: "INT", nullable: false },
            { name: "EXTRA", type: "CHAR", nullable: true, length: 5 },
          ],
        },
      ],
    });
    const info = await buildSchemaInfo(makeConfig(), conn);
    const orders = info.tables.find((t) => t.fullName === "S.ORDERS")!;
    const extra = orders.columns.find((c) => c.name === "EXTRA");
    expect(extra?.description).toBe("(no description)");
  });

  it("adds wholly new tables discovered by introspection", async () => {
    const conn = new FakeConnector({
      tables: [
        {
          schema: "S",
          name: "NEWTAB",
          columns: [{ name: "X", type: "INT", nullable: false }],
        },
      ],
    });
    const info = await buildSchemaInfo(makeConfig(), conn);
    const newTab = info.tables.find((t) => t.fullName === "S.NEWTAB");
    expect(newTab).toBeDefined();
    expect(newTab!.description).toMatch(/auto-discovered/);
  });

  it("formats schema as text with English 'Columns:' label", async () => {
    const info = await buildSchemaInfo(makeConfig());
    expect(info.asText).toMatch(/Columns:/);
    expect(info.asText).not.toMatch(/Spalten:/);
  });
});
