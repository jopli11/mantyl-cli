import { describe, expect, it } from "vitest";
import { digestPassport, PassportSchema, SCHEMA_VERSION, type Passport } from "@mantyl/schema";
import { generateSigningKeyPair } from "./index.js";
import {
  buildPassportStatement,
  DSSE_PAYLOAD_TYPE,
  PASSPORT_PREDICATE_TYPE,
  preAuthEncoding,
  signStatement,
  verifyEnvelope,
  verifyPassportAttestation,
} from "./attestation.js";

const POLICY = { id: "default", version: "1", digest: "c".repeat(64) };

function fixturePassport(name = "notes-api"): Passport {
  const draft = PassportSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    run: {
      toolVersion: "0.0.0-test",
      timestamp: "2026-09-02T12:00:00.000Z",
      commit: "abc123def456abc123def456abc123def456abcd",
      configDigest: "d".repeat(64),
    },
    project: { name, stack: ["node"], services: [] },
    setup: { steps: [], env: [] },
    architecture: { modules: [] },
    decisions: [],
    claims: [],
    risks: [],
    incomplete: [],
    verification: { plan: [], results: [] },
    integrity: { evidenceDigest: "a".repeat(64), fileManifestDigest: "b".repeat(64) },
  });
  draft.integrity.passportDigest = digestPassport(draft);
  return draft;
}

const OPTS = { toolVersion: "0.0.0-test", now: () => new Date("2026-09-02T12:00:00.000Z") };

describe("PAE", () => {
  it("matches the DSSE specification's worked example", () => {
    const pae = preAuthEncoding("http://example.com/HelloWorld", Buffer.from("hello world"));
    expect(pae.toString("utf8")).toBe(
      "DSSEv1 29 http://example.com/HelloWorld 11 hello world"
    );
  });
});

describe("passport attestations, Mantyl-key path", () => {
  const keys = generateSigningKeyPair();
  const passport = fixturePassport();

  it("builds, signs and verifies a statement bound to the passport", () => {
    const statement = buildPassportStatement(passport, POLICY, OPTS);
    expect(statement.predicateType).toBe(PASSPORT_PREDICATE_TYPE);
    expect(statement.subject[0]?.digest.sha256).toBe(digestPassport(passport));
    expect(statement.predicate.policy).toEqual(POLICY);

    const envelope = signStatement(statement, keys.privateKeyPem, keys.publicKeyPem);
    expect(envelope.payloadType).toBe(DSSE_PAYLOAD_TYPE);

    const opened = verifyEnvelope(envelope, keys.publicKeyPem);
    expect(opened.valid).toBe(true);
    expect(opened.statement?.predicate.commit).toBe(passport.run.commit);

    expect(verifyPassportAttestation(envelope, keys.publicKeyPem, passport).valid).toBe(true);
  });

  it("refuses to attest a passport whose stamped digest disagrees with its content", () => {
    const forged = fixturePassport();
    forged.integrity.passportDigest = "f".repeat(64);
    expect(() => buildPassportStatement(forged, POLICY, OPTS)).toThrow(/refused/);
  });

  it("a tampered payload fails with the signature reason", () => {
    const envelope = signStatement(
      buildPassportStatement(passport, POLICY, OPTS),
      keys.privateKeyPem,
      keys.publicKeyPem
    );
    const tamperedStatement = JSON.parse(
      Buffer.from(envelope.payload, "base64").toString("utf8")
    ) as Record<string, unknown>;
    (tamperedStatement.predicate as Record<string, unknown>).commit = "0".repeat(40);
    const tampered = {
      ...envelope,
      payload: Buffer.from(JSON.stringify(tamperedStatement)).toString("base64"),
    };
    expect(verifyEnvelope(tampered, keys.publicKeyPem)).toMatchObject({
      valid: false,
      reason: "signature does not verify",
    });
  });

  it("a different key is refused by keyid before any crypto runs", () => {
    const envelope = signStatement(
      buildPassportStatement(passport, POLICY, OPTS),
      keys.privateKeyPem,
      keys.publicKeyPem
    );
    const other = generateSigningKeyPair();
    expect(verifyEnvelope(envelope, other.publicKeyPem)).toMatchObject({
      valid: false,
      reason: "no signature from the expected key",
    });
  });

  it("an attestation for one passport does not verify against another", () => {
    const envelope = signStatement(
      buildPassportStatement(passport, POLICY, OPTS),
      keys.privateKeyPem,
      keys.publicKeyPem
    );
    const other = fixturePassport("other-project");
    const verdict = verifyPassportAttestation(envelope, keys.publicKeyPem, other);
    expect(verdict).toMatchObject({
      valid: false,
      reason: "the attested subject digest does not match this passport",
    });
  });
});
