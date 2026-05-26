import { describe, it, expect } from "vitest";
import { ensureRowLimit, hasExplicitLimit } from "../src/rowlimit.js";

describe("ensureRowLimit", () => {
  it("wraps a plain SELECT with FETCH FIRST", () => {
    const out = ensureRowLimit("SELECT * FROM T", 10);
    expect(out).toMatch(/FETCH FIRST 10 ROWS ONLY$/);
    expect(out).toMatch(/SELECT \* FROM \(SELECT \* FROM T\)/);
  });

  it("strips a trailing semicolon before wrapping", () => {
    const out = ensureRowLimit("SELECT * FROM T;", 10);
    expect(out).not.toMatch(/;.*FETCH/);
  });

  it("preserves ORDER BY semantics by wrapping", () => {
    const out = ensureRowLimit("SELECT * FROM T ORDER BY x", 5);
    expect(out).toMatch(/SELECT \* FROM \(SELECT \* FROM T ORDER BY x\)/);
    expect(out).toMatch(/FETCH FIRST 5 ROWS ONLY$/);
  });

  it("leaves an explicit FETCH FIRST untouched (other than trim)", () => {
    const sql = "SELECT * FROM T FETCH FIRST 3 ROWS ONLY";
    expect(ensureRowLimit(sql, 1000)).toBe(sql);
  });

  it("leaves an explicit LIMIT untouched", () => {
    const sql = "SELECT * FROM T LIMIT 7";
    expect(ensureRowLimit(sql, 1000)).toBe(sql);
  });

  it("handles UNION queries by wrapping", () => {
    const sql = "SELECT a FROM T1 UNION SELECT a FROM T2";
    const out = ensureRowLimit(sql, 50);
    expect(out).toMatch(/FETCH FIRST 50 ROWS ONLY$/);
  });

  it("does not treat 'LIMIT' inside a string literal as a real limit", () => {
    const sql = "SELECT * FROM T WHERE x = 'LIMIT 9'";
    const out = ensureRowLimit(sql, 25);
    expect(out).toMatch(/FETCH FIRST 25 ROWS ONLY$/);
  });

  it("does not apply a limit when maxRows <= 0", () => {
    expect(ensureRowLimit("SELECT 1", 0)).toBe("SELECT 1");
  });
});

describe("hasExplicitLimit", () => {
  it("detects FETCH FIRST in any case", () => {
    expect(hasExplicitLimit("select * from t fetch first 5 rows only")).toBe(true);
  });

  it("detects LIMIT", () => {
    expect(hasExplicitLimit("SELECT * FROM T LIMIT 3")).toBe(true);
  });

  it("returns false for plain SELECT", () => {
    expect(hasExplicitLimit("SELECT * FROM T")).toBe(false);
  });
});
