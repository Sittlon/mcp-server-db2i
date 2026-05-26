/**
 * Configuration schema, types, and loader for mcp-server-db2i.
 *
 * Schema is defined with zod so we get:
 *   - Runtime validation with friendly error messages
 *   - TypeScript types via z.infer
 *   - JSON Schema generation (see scripts/gen-schema.ts) for editor IntelliSense
 *
 * Supports environment variable interpolation in any string value
 * (e.g. "DSN=AS400;PWD=${DB2I_PASSWORD}").
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { z } from "zod";
import { logger } from "./logger.js";

// ── Schema ──────────────────────────────────────────────────

export const ColumnAnnotationSchema = z.object({
  description: z.string(),
  type: z.string(),
});

export const TableAnnotationSchema = z.object({
  description: z.string(),
  columns: z.record(z.string(), ColumnAnnotationSchema),
});

export const TemplateParameterSchema = z.object({
  type: z.enum(["string", "integer", "date", "decimal"]),
  description: z.string(),
  default: z.union([z.string(), z.number()]).optional(),
});

export const QueryTemplateSchema = z.object({
  description: z.string(),
  parameters: z.record(z.string(), TemplateParameterSchema),
  sql: z.string().min(1),
  allowedRoles: z.array(z.string()).min(1),
});

export const RoleConfigSchema = z.object({
  allowRawSelect: z.boolean(),
  allowedTemplates: z.array(z.string()),
  maxRows: z.number().int().positive(),
  allowedSchemas: z.array(z.string()).min(1),
  blockedTables: z.array(z.string()).optional(),
});

export const ConnectionSchema = z
  .object({
    driver: z.enum(["odbc", "jt400"]),
    odbc: z
      .object({
        connectionString: z.string().min(1),
      })
      .optional(),
    jt400: z
      .object({
        host: z.string().min(1),
        user: z.string().min(1),
        password: z.string(),
        naming: z.enum(["system", "sql"]).optional(),
      })
      .optional(),
  })
  .superRefine((conn, ctx) => {
    if (conn.driver === "odbc" && !conn.odbc) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "connection.odbc is required when driver is 'odbc'",
        path: ["odbc"],
      });
    }
    if (conn.driver === "jt400" && !conn.jt400) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "connection.jt400 is required when driver is 'jt400'",
        path: ["jt400"],
      });
    }
  });

export const ConfigSchema = z
  .object({
    $schema: z.string().optional(),
    connection: ConnectionSchema,
    security: z.object({
      defaultRole: z.string().min(1),
      roles: z.record(z.string(), RoleConfigSchema),
    }),
    schema: z.object({
      tables: z.record(z.string(), TableAnnotationSchema),
    }),
    templates: z.record(z.string(), QueryTemplateSchema),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.security.roles[cfg.security.defaultRole]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `security.defaultRole "${cfg.security.defaultRole}" is not defined under security.roles`,
        path: ["security", "defaultRole"],
      });
    }
    for (const [tplName, tpl] of Object.entries(cfg.templates)) {
      for (const role of tpl.allowedRoles) {
        if (!cfg.security.roles[role]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `templates.${tplName}.allowedRoles references unknown role "${role}"`,
            path: ["templates", tplName, "allowedRoles"],
          });
        }
      }
    }
  });

// ── Inferred types ──────────────────────────────────────────

export type ColumnAnnotation = z.infer<typeof ColumnAnnotationSchema>;
export type TableAnnotation = z.infer<typeof TableAnnotationSchema>;
export type TemplateParameter = z.infer<typeof TemplateParameterSchema>;
export type QueryTemplate = z.infer<typeof QueryTemplateSchema>;
export type RoleConfig = z.infer<typeof RoleConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

// ── Loader ──────────────────────────────────────────────────

const CONFIG_PATHS = [
  "./config/config.json",
  "./config.json",
  "~/.config/mcp-server-db2i/config.json",
];

export function loadConfig(customPath?: string): Config {
  const paths = customPath ? [customPath] : CONFIG_PATHS;

  for (const p of paths) {
    const resolved = resolve(p.replace(/^~/, homedir()));
    if (existsSync(resolved)) {
      const raw = readFileSync(resolved, "utf-8");
      const interpolated = interpolateEnv(raw);
      const parsed = JSON.parse(interpolated);
      const result = ConfigSchema.safeParse(parsed);
      if (!result.success) {
        const issues = result.error.issues
          .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n");
        throw new Error(`Config validation failed for ${resolved}:\n${issues}`);
      }
      logger.info(`Config loaded from ${resolved}`);
      return result.data;
    }
  }

  throw new Error(
    `No config found. Searched: ${paths.join(", ")}\n` +
      `Copy config.example.json to config/config.json and adjust.`,
  );
}

/**
 * Replace ${ENV_VAR} placeholders with environment variable values.
 * Exported for testing.
 */
export function interpolateEnv(text: string): string {
  return text.replace(/\$\{(\w+)\}/g, (_, name) => {
    const val = process.env[name];
    if (val === undefined) {
      logger.warn(`Environment variable ${name} not set`);
      return "";
    }
    return val;
  });
}
