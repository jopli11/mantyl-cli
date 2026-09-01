/**
 * @mantyl/config — configuration loading and validation.
 * Config is validated against a versioned schema before any workflow runs
 * (architecture spec §4). Invalid config is a hard stop, not a warning.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { digestValue } from "@mantyl/schema";

export const CONFIG_FILENAME = "mantyl.config.json";
export const CONFIG_SCHEMA_VERSION = "1" as const;

export const MantylConfigSchema = z
  .object({
    $schema: z.string().optional(),
    configVersion: z.literal(CONFIG_SCHEMA_VERSION).default(CONFIG_SCHEMA_VERSION),
    project: z
      .object({
        name: z.string().min(1).optional(),
      })
      .strict()
      .default({}),
    llm: z
      .object({
        /** Interpretation only — never verification (spec: deterministic core). */
        provider: z.enum(["anthropic", "none"]).default("none"),
        model: z.string().min(1).optional(),
      })
      .strict()
      .default({ provider: "none" }),
    verify: z
      .object({
        /** Network stays off in the sandbox unless explicitly enabled. */
        network: z.boolean().default(false),
        timeoutSeconds: z.number().int().positive().max(3600).default(600),
      })
      .strict()
      .prefault({}),
    redaction: z
      .object({
        /** Secret detection/redaction is on by default and should stay on. */
        enabled: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    scan: z
      .object({
        /**
         * Glob patterns (POSIX, relative to project root) excluded from
         * collection — e.g. nested fixture projects, vendored examples.
         * Excluded files produce no facts, claims, manifest entries or
         * evidence refs.
         */
        exclude: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type MantylConfig = z.infer<typeof MantylConfigSchema>;

/**
 * JSON Schema 2020-12 for mantyl.config.json, generated from the Zod
 * source of truth. Served at https://mantyl.dev/schemas/config-v1.json,
 * the URL init writes into every config file's $schema field.
 */
export function configJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(MantylConfigSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;
}

export class InvalidConfigError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = "InvalidConfigError";
  }
}

export interface ResolvedConfig {
  config: MantylConfig;
  /** Canonical digest of the resolved config — part of the run context. */
  digest: string;
  /** Where the config came from. */
  source: "file" | "defaults";
}

/** The fully-defaulted configuration used when no config file exists. */
export function defaultConfig(): MantylConfig {
  return MantylConfigSchema.parse({});
}

/** Validate an already-parsed JSON value as Mantyl configuration. */
export function resolveConfig(data: unknown, source: ResolvedConfig["source"]): ResolvedConfig {
  const parsed = MantylConfigSchema.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`)
      .join("; ");
    throw new InvalidConfigError(`invalid ${CONFIG_FILENAME}: ${detail}`, parsed.error);
  }
  return { config: parsed.data, digest: digestValue(parsed.data), source };
}

/** Load {projectRoot}/mantyl.config.json, falling back to defaults. */
export async function loadConfig(projectRoot: string): Promise<ResolvedConfig> {
  const file = join(projectRoot, CONFIG_FILENAME);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return resolveConfig({}, "defaults");
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new InvalidConfigError(`${CONFIG_FILENAME} is not valid JSON`, err);
  }
  return resolveConfig(data, "file");
}
