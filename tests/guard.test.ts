import { describe, it, expect } from "vitest";
import { validateQuery, validateTemplateAccess } from "../src/security/guard.js";
import type { RoleConfig } from "../src/config.js";

const reader: RoleConfig = {
  allowRawSelect: true,
  allowedTemplates: ["*"],
  maxRows: 100,
  allowedSchemas: ["SAMPLE"],
};

const restricted: RoleConfig = {
  ...reader,
  allowedSchemas: ["SAMPLE"],
  blockedTables: ["USERS", "CREDENTIALS"],
};

describe("validateQuery — happy path", () => {
  it("allows a simple SELECT", () => {
    expect(validateQuery("SELECT * FROM SAMPLE.ORDERS", reader).allowed).toBe(true);
  });

  it("allows SELECT with WHERE / ORDER BY / FETCH", () => {
    const sql = "SELECT a, b FROM SAMPLE.ORDERS WHERE a > 1 ORDER BY b FETCH FIRST 10 ROWS ONLY";
    expect(validateQuery(sql, reader).allowed).toBe(true);
  });

  it("allows JOIN across allowed schema", () => {
    const sql = "SELECT * FROM SAMPLE.ORDERS o JOIN SAMPLE.CUSTOMERS c ON o.CUSTID = c.CUSTID";
    expect(validateQuery(sql, reader).allowed).toBe(true);
  });
});

describe("validateQuery — DML/DDL rejection", () => {
  it.each([
    "INSERT INTO SAMPLE.ORDERS VALUES (1)",
    "UPDATE SAMPLE.ORDERS SET QTY = 0",
    "DELETE FROM SAMPLE.ORDERS",
    "DROP TABLE SAMPLE.ORDERS",
    "ALTER TABLE SAMPLE.ORDERS ADD X INT",
    "CREATE TABLE X (A INT)",
    "TRUNCATE TABLE SAMPLE.ORDERS",
    "GRANT SELECT ON SAMPLE.ORDERS TO PUBLIC",
  ])("rejects %s", (sql) => {
    expect(validateQuery(sql, reader).allowed).toBe(false);
  });

  it("rejects multi-statement injection", () => {
    const sql = "SELECT * FROM SAMPLE.ORDERS; DROP TABLE SAMPLE.ORDERS";
    expect(validateQuery(sql, reader).allowed).toBe(false);
  });
});

describe("validateQuery — injection patterns", () => {
  it("rejects line comments", () => {
    expect(validateQuery("SELECT * FROM SAMPLE.ORDERS -- comment", reader).allowed).toBe(false);
  });

  it("rejects block comments", () => {
    expect(validateQuery("SELECT /* x */ * FROM SAMPLE.ORDERS", reader).allowed).toBe(false);
  });

  it("rejects classic OR injection", () => {
    expect(validateQuery("SELECT * FROM SAMPLE.ORDERS WHERE x = '' OR '1' = '1'", reader).allowed).toBe(false);
  });

  it("rejects UNION SELECT", () => {
    const sql = "SELECT a FROM SAMPLE.ORDERS UNION SELECT password FROM SAMPLE.USERS";
    expect(validateQuery(sql, reader).allowed).toBe(false);
  });
});

describe("validateQuery — schema gating", () => {
  it("blocks queries against unallowed schemas", () => {
    const r = validateQuery("SELECT * FROM OTHER.SECRETS", reader);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/OTHER/);
  });

  it("allows wildcard schemas for admin role", () => {
    const admin: RoleConfig = { ...reader, allowedSchemas: ["*"] };
    expect(validateQuery("SELECT * FROM ANY.TABLE", admin).allowed).toBe(true);
  });
});

describe("validateQuery — blocked tables", () => {
  it("blocks listed tables", () => {
    const r = validateQuery("SELECT * FROM SAMPLE.USERS", restricted);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/USERS/);
  });

  it("blocks even when joined", () => {
    const sql = "SELECT * FROM SAMPLE.ORDERS o JOIN SAMPLE.CREDENTIALS c ON 1=1";
    expect(validateQuery(sql, restricted).allowed).toBe(false);
  });
});

describe("validateTemplateAccess", () => {
  it("allows when role is in template's allowedRoles", () => {
    expect(validateTemplateAccess("t", ["reader", "analyst"], "analyst").allowed).toBe(true);
  });

  it("rejects when role is not listed", () => {
    const r = validateTemplateAccess("t", ["analyst"], "reader");
    expect(r.allowed).toBe(false);
  });
});
