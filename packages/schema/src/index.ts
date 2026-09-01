/**
 * @mantyl/schema — the canonical passport contract.
 * passport.json is the versioned model consumed by renderers, CI, cloud
 * publishing and integrations. This package is the ONLY place it is defined.
 */

import { z } from "zod";
import { digestValue } from "./canonical.js";
import { AcceptanceRecordSchema, PassportSchema, type Passport } from "./passport.js";

export {
  SCHEMA_VERSION,
  TruthStatusSchema,
  SourceRefSchema,
  ServiceSchema,
  SetupStepSchema,
  EnvVarSchema,
  ModuleSchema,
  DecisionSchema,
  ClaimSchema,
  RiskSchema,
  IncompleteItemSchema,
  NarrativeSchema,
  PlannedCheckSchema,
  CheckResultSchema,
  RunInfoSchema,
  IntegritySchema,
  PartySchema,
  AcceptanceSchema,
  AcceptanceRecordSchema,
  PassportSchema,
} from "./passport.js";
export type {
  TruthStatus,
  SourceRef,
  Passport,
  RunInfo,
  Claim,
  Risk,
  CheckResult,
  PlannedCheck,
} from "./passport.js";
export { canonicalJson, sha256Hex, digestValue } from "./canonical.js";

/** JSON Schema 2020-12 for passport.json, generated from the Zod model. */
export function passportJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(PassportSchema, {
    target: "draft-2020-12",
    io: "input",
  }) as Record<string, unknown>;
}

/**
 * Canonical digest of a passport.
 * Excludes integrity.passportDigest itself so the digest is well-defined.
 */
export function digestPassport(passport: Passport): string {
  const { passportDigest: _omitted, ...integrity } = passport.integrity;
  return digestValue({ ...passport, integrity });
}

/** Parse + validate an untrusted passport document. */
export function parsePassport(data: unknown): Passport {
  return PassportSchema.parse(data);
}

export type AcceptanceRecord = z.infer<typeof AcceptanceRecordSchema>;

/** Parse + validate an untrusted detached acceptance record. */
export function parseAcceptanceRecord(data: unknown): AcceptanceRecord {
  return AcceptanceRecordSchema.parse(data);
}
