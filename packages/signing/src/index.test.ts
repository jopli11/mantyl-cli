import { describe, expect, it } from "vitest";
import {
  generateSigningKeyPair,
  keyIdFromPublicKey,
  signAccreditation,
  verifyAccreditation,
  type AccreditationRecord,
} from "./index.js";

const RECORD: AccreditationRecord = {
  kind: "mantyl-verified",
  passportDigest: "a".repeat(64),
  evidenceDigest: "b".repeat(64),
  commit: "c".repeat(40),
  policy: { id: "default", version: "1" },
  verifier: { name: "mantyl-worker", version: "0.0.1" },
  verifiedAt: "2026-08-18T12:00:00.000Z",
};

describe("accreditation signing", () => {
  it("signs and verifies a genuine record", () => {
    const keys = generateSigningKeyPair();
    const signed = signAccreditation(RECORD, keys.privateKeyPem, keys.publicKeyPem);

    expect(signed.keyId).toBe(keys.keyId);
    expect(verifyAccreditation(signed, keys.publicKeyPem)).toEqual({ valid: true });
    expect(
      verifyAccreditation(signed, keys.publicKeyPem, {
        passportDigest: RECORD.passportDigest,
        evidenceDigest: RECORD.evidenceDigest,
      })
    ).toEqual({ valid: true });
  });

  it("rejects any tampered field — the binding is total", () => {
    const keys = generateSigningKeyPair();
    const signed = signAccreditation(RECORD, keys.privateKeyPem, keys.publicKeyPem);

    for (const mutate of [
      (r: AccreditationRecord) => ({ ...r, passportDigest: "f".repeat(64) }),
      (r: AccreditationRecord) => ({ ...r, commit: "d".repeat(40) }),
      (r: AccreditationRecord) => ({ ...r, policy: { id: "weaker", version: "1" } }),
      (r: AccreditationRecord) => ({ ...r, verifiedAt: "2026-08-19T00:00:00.000Z" }),
    ]) {
      const forged = { ...signed, record: mutate(signed.record) };
      const result = verifyAccreditation(forged, keys.publicKeyPem);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain("signature");
    }
  });

  it("rejects an accreditation moved to a different passport", () => {
    const keys = generateSigningKeyPair();
    const signed = signAccreditation(RECORD, keys.privateKeyPem, keys.publicKeyPem);
    const result = verifyAccreditation(signed, keys.publicKeyPem, {
      passportDigest: "e".repeat(64),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("different passport");
  });

  it("rejects a signature from a different key", () => {
    const keys = generateSigningKeyPair();
    const otherKeys = generateSigningKeyPair();
    const signed = signAccreditation(RECORD, keys.privateKeyPem, keys.publicKeyPem);

    const swapped = verifyAccreditation(signed, otherKeys.publicKeyPem);
    expect(swapped.valid).toBe(false);
    expect(swapped.reason).toContain("keyId");

    // Even lying about the keyId fails at the signature itself.
    const relabelled = { ...signed, keyId: keyIdFromPublicKey(otherKeys.publicKeyPem) };
    const result = verifyAccreditation(relabelled, otherKeys.publicKeyPem);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("signature");
  });
});
