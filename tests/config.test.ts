import { describe, it, expect } from "vitest";
import { ConfigSchema, interpolateEnv } from "../src/config.js";

const validConfig = {
  connection: {
    driver: "odbc",
    odbc: { connectionString: "DSN=X" },
  },
  security: {
    defaultRole: "reader",
    roles: {
      reader: {
        allowRawSelect: false,
        allowedTemplates: ["*"],
        maxRows: 100,
        allowedSchemas: ["S"],
      },
    },
  },
  schema: { tables: {} },
  templates: {},
};

describe("ConfigSchema", () => {
  it("accepts a minimal valid config", () => {
    const r = ConfigSchema.safeParse(validConfig);
    expect(r.success).toBe(true);
  });

  it("rejects when defaultRole is missing from roles", () => {
    const bad = { ...validConfig, security: { ...validConfig.security, defaultRole: "ghost" } };
    const r = ConfigSchema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /ghost/.test(i.message))).toBe(true);
    }
  });

  it("rejects ODBC driver without odbc block", () => {
    const bad = { ...validConfig, connection: { driver: "odbc" } };
    const r = ConfigSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects jt400 driver without jt400 block", () => {
    const bad = { ...validConfig, connection: { driver: "jt400" } };
    const r = ConfigSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects template referencing unknown role", () => {
    const bad = {
      ...validConfig,
      templates: {
        t1: {
          description: "x",
          parameters: {},
          sql: "SELECT 1 FROM SYSIBM.SYSDUMMY1",
          allowedRoles: ["nope"],
        },
      },
    };
    const r = ConfigSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects negative maxRows", () => {
    const bad = JSON.parse(JSON.stringify(validConfig));
    bad.security.roles.reader.maxRows = -1;
    const r = ConfigSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });
});

describe("interpolateEnv", () => {
  it("substitutes set env vars", () => {
    process.env.TEST_VAR_DB2I = "secret";
    expect(interpolateEnv("PWD=${TEST_VAR_DB2I}")).toBe("PWD=secret");
  });

  it("returns empty string for unset vars", () => {
    delete process.env.TEST_VAR_DB2I_MISSING;
    expect(interpolateEnv("X=${TEST_VAR_DB2I_MISSING}")).toBe("X=");
  });

  it("leaves non-template text untouched", () => {
    expect(interpolateEnv("hello world")).toBe("hello world");
  });
});
