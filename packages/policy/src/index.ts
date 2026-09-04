/**
 * @mantyl/policy — verification policies as versioned data
 * (trust-and-ci-prd C4). A policy is a document, not code: its rules
 * are named fields, its digest is the canonical-JSON digest, and every
 * accreditation and attestation names the policy it was judged under.
 * The prose contract lives in docs/verification-policy.md; this module
 * is its executable form, and the two describing the same thing is a
 * tested invariant.
 *
 * A policy version is IMMUTABLE once anything has been signed under
 * it. Changing any rule means adding a new document here with a new
 * version, never editing an existing one.
 */

import { z } from "zod";
import { digestValue, canonicalJson } from "@mantyl/schema";

/* ------------------------------------------------------------ document */

export const PolicyRulesSchema = z
  .object({
    /** The submitted passport must parse against the canonical schema. */
    requireValidPassport: z.boolean(),
    /** Recomputed passport digest must match the one the passport carries. */
    requirePassportDigestMatch: z.boolean(),
    /** Uploaded source must match the passport's file manifest exactly. */
    requireManifestMatch: z.boolean(),
    /** The sandbox must have been available: checks actually executed. */
    requireSandbox: z.boolean(),
    /** Minimum number of checks in the recorded plan. */
    minimumChecks: z.number().int().nonnegative(),
    /** Every check must match its recording AND reproduce as passed. */
    requireAllChecksReproducePassed: z.boolean(),
  })
  .strict();

export const PolicyDocumentSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    version: z.string().regex(/^[0-9]+$/),
    title: z.string().min(1),
    /** One-paragraph plain statement of what passing this policy means. */
    summary: z.string().min(1),
    rules: PolicyRulesSchema,
  })
  .strict();

export type PolicyRules = z.infer<typeof PolicyRulesSchema>;
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

/** Canonical digest of a policy document — what an attestation can pin. */
export function policyDigest(document: PolicyDocument): string {
  return digestValue(document);
}

/** Canonical bytes for publishing at /policies/<id>/<version>. */
export function policyCanonicalJson(document: PolicyDocument): string {
  return canonicalJson(document);
}

/* ------------------------------------------------------------ registry */

/**
 * default@1 — the policy behind every accreditation issued to date,
 * previously hardcoded in the worker. The wording here matches
 * docs/verification-policy.md deliberately.
 */
export const DEFAULT_POLICY: PolicyDocument = PolicyDocumentSchema.parse({
  id: "default",
  version: "1",
  title: "Full reproduction",
  summary:
    "The delivered source, exactly as uploaded, independently reproduced every result the passport recorded: the passport is schema-valid with a matching digest, the source matches the file manifest byte for byte, the sandbox executed a plan of at least one check, and every check both matched its recording and reproduced as passed. Not a quality judgement: the signature proves the recorded checks reproduce, exactly as stated, no more and no less.",
  rules: {
    requireValidPassport: true,
    requirePassportDigestMatch: true,
    requireManifestMatch: true,
    requireSandbox: true,
    minimumChecks: 1,
    requireAllChecksReproducePassed: true,
  },
});

export const POLICIES: readonly PolicyDocument[] = [DEFAULT_POLICY];

export function getPolicy(id: string, version: string): PolicyDocument | null {
  return POLICIES.find((p) => p.id === id && p.version === version) ?? null;
}

/* ---------------------------------------------------------- evaluation */

/** The subset of a receive report a policy reads. */
export interface PolicyReport {
  passportValid: boolean;
  /** null means not evaluated. */
  passportDigestMatch: boolean | null;
  fileManifest: { match: boolean | null };
  sandbox: { available: boolean };
  checks: Array<{ checkId: string; recorded: string; reproduced: string; match: boolean }>;
}

export type PolicyVerdict =
  | { passed: true; policy: { id: string; version: string } }
  | { passed: false; policy: { id: string; version: string }; reasons: string[] };

/**
 * Judge a report against a policy document. Every refusal names all of
 * its reasons, never just the first: an accreditation can never exist
 * with an empty justification, and a refusal is always actionable.
 */
export function evaluatePolicy(
  document: PolicyDocument,
  report: PolicyReport
): PolicyVerdict {
  const { rules } = document;
  const checks = report.checks;
  const reasons = [
    rules.requireValidPassport &&
      !report.passportValid &&
      "passport failed schema validation",
    rules.requireSandbox &&
      !report.sandbox.available &&
      "sandbox unavailable on worker",
    rules.requirePassportDigestMatch &&
      report.passportDigestMatch === false &&
      "passport digest mismatch",
    rules.requireManifestMatch &&
      report.fileManifest.match === false &&
      "uploaded source does not match the passport manifest",
    checks.length < rules.minimumChecks &&
      (rules.minimumChecks === 1
        ? "no checks in the recorded plan"
        : `fewer than ${rules.minimumChecks} checks in the recorded plan`),
    rules.requireAllChecksReproducePassed &&
      checks.some((c) => !c.match || c.reproduced !== "passed") &&
      "checks did not reproduce as passed",
  ].filter((reason): reason is string => typeof reason === "string");

  const policy = { id: document.id, version: document.version };
  return reasons.length === 0 ? { passed: true, policy } : { passed: false, policy, reasons };
}
