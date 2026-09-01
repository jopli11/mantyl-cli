/**
 * passport.json v1 — the canonical contract (architecture spec §4, §6).
 * Zod is the source of truth; JSON Schema 2020-12 is exported from it.
 *
 * Contract rules encoded here:
 * - every assertion carries a truth status and source refs
 * - any status other than "unresolved" requires at least one source ref
 * - the architecture narrative can only ever be "inferred" (LLM output
 *   must not carry verified status — spec §12)
 */

import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0-draft" as const;

/** The eight-state truth model (spec §6). */
export const TruthStatusSchema = z.enum([
  "mantyl-verified",
  "locally-verified",
  "repository-confirmed",
  "agent-reported",
  "creator-confirmed",
  "inferred",
  "contradicted",
  "unresolved",
]);
export type TruthStatus = z.infer<typeof TruthStatusSchema>;

/** A reference from an assertion back to its evidence. */
export const SourceRefSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("file"),
      path: z.string().min(1),
      lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("commit"), sha: z.string().min(7) }).strict(),
  z
    .object({
      kind: z.literal("session"),
      sessionId: z.string().min(1),
      messageId: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("check"), checkId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("creator"), assertionId: z.string().min(1) }).strict(),
]);
export type SourceRef = z.infer<typeof SourceRefSchema>;

/** Shared shape of every assertion in the passport. */
const assertionBase = {
  id: z.string().min(1),
  status: TruthStatusSchema,
  refs: z.array(SourceRefSchema),
} as const;

/** status ≠ unresolved ⇒ refs must not be empty (spec §12). */
const asserted = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object({ ...assertionBase, ...shape })
    .strict()
    .superRefine((item, ctx) => {
      const a = item as unknown as { id: string; status: TruthStatus; refs: SourceRef[] };
      if (a.status !== "unresolved" && a.refs.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: `assertion "${a.id}" has status "${a.status}" but no source refs`,
          path: ["refs"],
        });
      }
    });

export const ServiceSchema = asserted({
  name: z.string().min(1),
  note: z.string().optional(),
});
export const SetupStepSchema = asserted({
  command: z.string().min(1),
  note: z.string().optional(),
});
export const EnvVarSchema = asserted({
  name: z.string().min(1),
  documented: z.boolean(),
  note: z.string().optional(),
});
export const ModuleSchema = asserted({
  name: z.string().min(1),
  path: z.string().min(1),
  note: z.string().optional(),
});
export const DecisionSchema = asserted({
  title: z.string().min(1),
  rationale: z.string().min(1),
  date: z.string().date().optional(),
});
export const ClaimSchema = asserted({
  text: z.string().min(1),
  contradictions: z.array(SourceRefSchema).default([]),
});
export const RiskSchema = asserted({
  severity: z.enum(["low", "medium", "high"]),
  text: z.string().min(1),
  remediation: z.string().optional(),
});
export const IncompleteItemSchema = asserted({
  title: z.string().min(1),
  note: z.string().optional(),
});

/** Architecture narrative — interpretation, never verification. */
export const NarrativeSchema = z
  .object({
    status: z.literal("inferred"),
    text: z.string().min(1),
    refs: z.array(SourceRefSchema),
  })
  .strict();

export const PlannedCheckSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    command: z.string().min(1),
    reason: z.string().min(1),
    selected: z.boolean(),
    skipReason: z.string().optional(),
  })
  .strict();

export const CheckResultSchema = z
  .object({
    checkId: z.string().min(1),
    outcome: z.enum(["passed", "failed", "skipped", "error"]),
    command: z.string().min(1),
    exitCode: z.number().int().optional(),
    startedAt: z.iso.datetime(),
    durationMs: z.number().int().nonnegative(),
    logsDigest: z.string().optional(),
    envFingerprint: z.string().optional(),
  })
  .strict();

export const RunInfoSchema = z
  .object({
    toolVersion: z.string().min(1),
    timestamp: z.iso.datetime(),
    commit: z.string().min(7).nullable(),
    configDigest: z.string().length(64),
  })
  .strict();

export const IntegritySchema = z
  .object({
    passportDigest: z.string().length(64).optional(),
    evidenceDigest: z.string().length(64).optional(),
    fileManifestDigest: z.string().length(64).optional(),
  })
  .strict();

export const PartySchema = z
  .object({
    name: z.string().min(1),
    organisation: z.string().optional(),
    date: z.string().date(),
  })
  .strict();

export const AcceptanceSchema = z
  .object({
    deliveredBy: PartySchema,
    acceptedBy: PartySchema.optional(),
    acknowledgedFindings: z.array(z.string().min(1)).default([]),
  })
  .strict();

/**
 * The detached acceptance record `mantyl accept` writes: a canonical
 * document binding the exact passport digest the recipient accepted,
 * kept OUTSIDE passport.json so a published passport's digest stays
 * immutable (the shape decision in trust-and-ci-prd §3.3). The inline
 * `acceptance` field above remains for pre-publish acceptance.
 */
export const AcceptanceRecordSchema = z
  .object({
    kind: z.literal("mantyl-acceptance"),
    /** Version of this record shape, independent of the passport schema. */
    recordVersion: z.literal("1"),
    /** integrity.passportDigest of the accepted passport, recomputed at accept time. */
    passportDigest: z.string().length(64),
    acceptedBy: PartySchema,
    deliveredBy: PartySchema.optional(),
    /** Ids of the open findings the recipient saw and acknowledged. */
    acknowledgedFindings: z.array(z.string().min(1)).default([]),
    acceptedAt: z.iso.datetime(),
  })
  .strict();

export const PassportSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    run: RunInfoSchema,
    project: z
      .object({
        name: z.string().min(1),
        description: z.string().optional(),
        stack: z.array(z.string().min(1)),
        services: z.array(ServiceSchema),
      })
      .strict(),
    setup: z
      .object({
        steps: z.array(SetupStepSchema),
        env: z.array(EnvVarSchema),
      })
      .strict(),
    architecture: z
      .object({
        narrative: NarrativeSchema.optional(),
        modules: z.array(ModuleSchema),
      })
      .strict(),
    decisions: z.array(DecisionSchema),
    claims: z.array(ClaimSchema),
    risks: z.array(RiskSchema),
    incomplete: z.array(IncompleteItemSchema),
    verification: z
      .object({
        plan: z.array(PlannedCheckSchema),
        results: z.array(CheckResultSchema),
      })
      .strict(),
    integrity: IntegritySchema,
    acceptance: AcceptanceSchema.optional(),
  })
  .strict();

export type Passport = z.infer<typeof PassportSchema>;
export type RunInfo = z.infer<typeof RunInfoSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Risk = z.infer<typeof RiskSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type PlannedCheck = z.infer<typeof PlannedCheckSchema>;
