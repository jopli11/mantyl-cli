/**
 * Passport attestations (trust-and-ci-prd C3): the passport as a signed
 * in-toto Statement in a DSSE envelope, so the ecosystem's tooling and
 * mental model (GitHub artifact attestations, SLSA, sigstore) apply to
 * Mantyl's evidence. Ride the rails, never a parallel scheme.
 *
 * Two signing paths by design: the Mantyl Ed25519 key (this module,
 * fully local and offline-verifiable) and Sigstore keyless for the free
 * tier in CI (the Action's side; it produces the same envelope shape
 * with a certificate in place of a fixed key, and is exercised in the
 * gated Actions test bed, never locally).
 */

import { createHash, sign as edSign, verify as edVerify } from "node:crypto";
import { canonicalJson, digestPassport, type Passport } from "@mantyl/schema";
import { keyIdFromPublicKey } from "./index.js";

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
/** The PRD names this dev.mantyl.passport/v1; the URI form is canonical. */
export const PASSPORT_PREDICATE_TYPE = "https://mantyl.dev/attestations/passport/v1";
export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";

export interface PassportPredicate {
  passportDigest: string;
  evidenceDigest: string | null;
  fileManifestDigest: string | null;
  commit: string | null;
  policy: { id: string; version: string; digest: string };
  /**
   * What the passport's own recorded checks showed: passed, failed or
   * no-sandbox. The signer attests the document AND states its verdict
   * plainly; an attestation of a failing passport is honest, visible,
   * and never mistakable for a clean one.
   */
  verdict: "passed" | "failed" | "no-sandbox";
  toolVersion: string;
  generatedAt: string;
  [key: string]: unknown;
}

/** Derive the verdict from the passport's recorded check results. */
export function passportVerdict(passport: Passport): PassportPredicate["verdict"] {
  const results = passport.verification.results;
  if (results.some((r) => r.outcome === "failed" || r.outcome === "error")) return "failed";
  if (results.some((r) => r.outcome === "passed")) return "passed";
  return "no-sandbox";
}

export interface InTotoStatement {
  _type: typeof STATEMENT_TYPE;
  subject: Array<{ name: string; digest: { sha256: string } }>;
  predicateType: typeof PASSPORT_PREDICATE_TYPE;
  predicate: PassportPredicate;
}

export interface DsseEnvelope {
  payloadType: typeof DSSE_PAYLOAD_TYPE;
  /** base64 of the canonical statement bytes. */
  payload: string;
  signatures: Array<{ keyid: string; sig: string }>;
}

/**
 * Build the statement for a passport. The subject digest is the
 * canonical passport digest, RECOMPUTED from the document, never
 * trusted from its integrity block; a passport whose stamped digest
 * disagrees with its content cannot be attested.
 */
export function buildPassportStatement(
  passport: Passport,
  policy: { id: string; version: string; digest: string },
  options: { toolVersion: string; now?: () => Date }
): InTotoStatement {
  const recomputed = digestPassport(passport);
  const stamped = passport.integrity.passportDigest;
  if (stamped !== undefined && stamped !== recomputed) {
    throw new Error(
      "attestation refused: the passport's stamped digest does not match its content"
    );
  }
  return {
    _type: STATEMENT_TYPE,
    subject: [{ name: passport.project.name, digest: { sha256: recomputed } }],
    predicateType: PASSPORT_PREDICATE_TYPE,
    predicate: {
      passportDigest: recomputed,
      evidenceDigest: passport.integrity.evidenceDigest ?? null,
      fileManifestDigest: passport.integrity.fileManifestDigest ?? null,
      commit: passport.run.commit,
      policy,
      verdict: passportVerdict(passport),
      toolVersion: options.toolVersion,
      generatedAt: (options.now?.() ?? new Date()).toISOString(),
    },
  };
}

/** DSSE pre-authentication encoding: what the signature actually covers. */
export function preAuthEncoding(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${type.length} `, "utf8"),
    type,
    Buffer.from(` ${payload.length} `, "utf8"),
    payload,
  ]);
}

/** Sign a statement with the Mantyl Ed25519 key path. */
export function signStatement(
  statement: InTotoStatement,
  privateKeyPem: string,
  publicKeyPem: string
): DsseEnvelope {
  const payload = Buffer.from(canonicalJson(statement), "utf8");
  const sig = edSign(null, preAuthEncoding(DSSE_PAYLOAD_TYPE, payload), privateKeyPem);
  return {
    payloadType: DSSE_PAYLOAD_TYPE,
    payload: payload.toString("base64"),
    signatures: [{ keyid: keyIdFromPublicKey(publicKeyPem), sig: sig.toString("base64") }],
  };
}

export interface AttestationVerifyResult {
  valid: boolean;
  reason?: string;
  statement?: InTotoStatement;
}

/** Verify a DSSE envelope against a public key; every failure is named. */
export function verifyEnvelope(
  envelope: DsseEnvelope,
  publicKeyPem: string
): AttestationVerifyResult {
  if (envelope.payloadType !== DSSE_PAYLOAD_TYPE) {
    return { valid: false, reason: `unexpected payloadType ${envelope.payloadType}` };
  }
  const expectedKeyId = keyIdFromPublicKey(publicKeyPem);
  const signature = envelope.signatures.find((s) => s.keyid === expectedKeyId);
  if (!signature) {
    return { valid: false, reason: "no signature from the expected key" };
  }
  const payload = Buffer.from(envelope.payload, "base64");
  const ok = edVerify(
    null,
    preAuthEncoding(envelope.payloadType, payload),
    publicKeyPem,
    Buffer.from(signature.sig, "base64")
  );
  if (!ok) return { valid: false, reason: "signature does not verify" };

  let statement: InTotoStatement;
  try {
    statement = JSON.parse(payload.toString("utf8")) as InTotoStatement;
  } catch {
    return { valid: false, reason: "payload is not valid JSON" };
  }
  if (statement._type !== STATEMENT_TYPE) {
    return { valid: false, reason: `unexpected statement type ${statement._type}` };
  }
  if (statement.predicateType !== PASSPORT_PREDICATE_TYPE) {
    return { valid: false, reason: `unexpected predicate type ${statement.predicateType}` };
  }
  return { valid: true, statement };
}

/**
 * The recipient's question: does this envelope attest THIS passport?
 * Verifies the envelope, then binds the subject digest to the passport
 * document actually in hand.
 */
export function verifyPassportAttestation(
  envelope: DsseEnvelope,
  publicKeyPem: string,
  passport: Passport
): AttestationVerifyResult {
  const verified = verifyEnvelope(envelope, publicKeyPem);
  if (!verified.valid || !verified.statement) return verified;

  const actual = digestPassport(passport);
  const subject = verified.statement.subject[0];
  if (!subject || subject.digest.sha256 !== actual) {
    return {
      valid: false,
      reason: "the attested subject digest does not match this passport",
      statement: verified.statement,
    };
  }
  if (verified.statement.predicate.passportDigest !== actual) {
    return {
      valid: false,
      reason: "the predicate's passport digest does not match this passport",
      statement: verified.statement,
    };
  }
  return { valid: true, statement: verified.statement };
}

/** Convenience: sha256 of the canonical envelope, for logs and receipts. */
export function envelopeDigest(envelope: DsseEnvelope): string {
  return createHash("sha256").update(canonicalJson(envelope)).digest("hex");
}
