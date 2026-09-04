import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  evaluatePolicy,
  getPolicy,
  POLICIES,
  policyCanonicalJson,
  policyDigest,
  PolicyDocumentSchema,
  type PolicyReport,
} from "./index.js";

function passingReport(overrides: Partial<PolicyReport> = {}): PolicyReport {
  return {
    passportValid: true,
    passportDigestMatch: true,
    fileManifest: { match: true },
    sandbox: { available: true },
    checks: [
      { checkId: "check-install", recorded: "passed", reproduced: "passed", match: true },
      { checkId: "check-test", recorded: "passed", reproduced: "passed", match: true },
    ],
    ...overrides,
  };
}

describe("the default@1 document", () => {
  it("is schema-valid, registered, and retrievable by name", () => {
    expect(PolicyDocumentSchema.parse(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
    expect(POLICIES).toContain(DEFAULT_POLICY);
    expect(getPolicy("default", "1")).toBe(DEFAULT_POLICY);
    expect(getPolicy("default", "2")).toBeNull();
    expect(getPolicy("nope", "1")).toBeNull();
  });

  it("encodes exactly the six conditions of docs/verification-policy.md", () => {
    expect(DEFAULT_POLICY.rules).toEqual({
      requireValidPassport: true,
      requirePassportDigestMatch: true,
      requireManifestMatch: true,
      requireSandbox: true,
      minimumChecks: 1,
      requireAllChecksReproducePassed: true,
    });
  });

  it("has a deterministic digest and canonical serialisation", () => {
    expect(policyDigest(DEFAULT_POLICY)).toBe(policyDigest(getPolicy("default", "1")!));
    expect(policyDigest(DEFAULT_POLICY)).toMatch(/^[0-9a-f]{64}$/);
    const canonical = policyCanonicalJson(DEFAULT_POLICY);
    expect(canonical).toBe(policyCanonicalJson(DEFAULT_POLICY));
    expect(JSON.parse(canonical)).toEqual(DEFAULT_POLICY);
  });
});

describe("evaluatePolicy under default@1", () => {
  const judge = (report: PolicyReport) => evaluatePolicy(DEFAULT_POLICY, report);

  it("passes only the fully clean report, naming the policy", () => {
    expect(judge(passingReport())).toEqual({
      passed: true,
      policy: { id: "default", version: "1" },
    });
  });

  it("refuses an invalid passport, with the reason named", () => {
    const verdict = judge(passingReport({ passportValid: false }));
    expect(verdict).toMatchObject({
      passed: false,
      reasons: ["passport failed schema validation"],
    });
  });

  it("refuses when the sandbox is unavailable: skipped checks never earn a signature", () => {
    const verdict = judge(
      passingReport({
        sandbox: { available: false },
        checks: [
          { checkId: "check-install", recorded: "passed", reproduced: "skipped", match: false },
        ],
      })
    );
    expect(verdict.passed).toBe(false);
    if (!verdict.passed) {
      expect(verdict.reasons).toContain("sandbox unavailable on worker");
      expect(verdict.reasons).toContain("checks did not reproduce as passed");
    }
  });

  it("refuses a passport digest mismatch", () => {
    const verdict = judge(passingReport({ passportDigestMatch: false }));
    expect(verdict).toMatchObject({ passed: false, reasons: ["passport digest mismatch"] });
  });

  it("refuses manifest tampering", () => {
    const verdict = judge(passingReport({ fileManifest: { match: false } }));
    expect(verdict).toMatchObject({
      passed: false,
      reasons: ["uploaded source does not match the passport manifest"],
    });
  });

  it("refuses an empty check plan: nothing executed means nothing verified", () => {
    const verdict = judge(passingReport({ checks: [] }));
    expect(verdict).toMatchObject({
      passed: false,
      reasons: ["no checks in the recorded plan"],
    });
  });

  it("refuses when any single check fails to reproduce", () => {
    const verdict = judge(
      passingReport({
        checks: [
          { checkId: "check-install", recorded: "passed", reproduced: "passed", match: true },
          { checkId: "check-test", recorded: "passed", reproduced: "failed", match: false },
        ],
      })
    );
    expect(verdict).toMatchObject({
      passed: false,
      reasons: ["checks did not reproduce as passed"],
    });
  });

  it("refuses a check that reproduces a recorded failure: matching is not passing", () => {
    const verdict = judge(
      passingReport({
        checks: [{ checkId: "check-test", recorded: "failed", reproduced: "failed", match: true }],
      })
    );
    expect(verdict.passed).toBe(false);
  });

  it("composes every applicable reason instead of stopping at the first", () => {
    const verdict = judge(
      passingReport({
        passportValid: false,
        passportDigestMatch: false,
        fileManifest: { match: false },
        sandbox: { available: false },
        checks: [],
      })
    );
    expect(verdict.passed).toBe(false);
    if (!verdict.passed) expect(verdict.reasons).toHaveLength(5);
  });

  it("null digest and manifest results do not refuse on their own", () => {
    const verdict = judge(
      passingReport({ passportDigestMatch: null, fileManifest: { match: null } })
    );
    expect(verdict.passed).toBe(true);
  });
});

describe("evaluatePolicy is generic over documents", () => {
  it("a hypothetical lax policy passes what default@1 refuses", () => {
    const lax = PolicyDocumentSchema.parse({
      id: "lax-test",
      version: "1",
      title: "Test-only lax policy",
      summary: "Fixture policy for engine tests; never registered, never signable.",
      rules: {
        requireValidPassport: true,
        requirePassportDigestMatch: true,
        requireManifestMatch: true,
        requireSandbox: false,
        minimumChecks: 0,
        requireAllChecksReproducePassed: false,
      },
    });
    const report = passingReport({ sandbox: { available: false }, checks: [] });
    expect(evaluatePolicy(lax, report).passed).toBe(true);
    expect(evaluatePolicy(DEFAULT_POLICY, report).passed).toBe(false);
    // Registry stays closed: test fixtures are not signable policies.
    expect(getPolicy("lax-test", "1")).toBeNull();
  });

  it("minimumChecks above one names the threshold in the refusal", () => {
    const strict = PolicyDocumentSchema.parse({
      ...DEFAULT_POLICY,
      id: "strict-test",
      rules: { ...DEFAULT_POLICY.rules, minimumChecks: 3 },
    });
    const verdict = evaluatePolicy(strict, passingReport());
    expect(verdict).toMatchObject({
      passed: false,
      reasons: ["fewer than 3 checks in the recorded plan"],
    });
  });
});
