/**
 * @mantyl/signing — the Mantyl Verified accreditation layer (spec §4).
 *
 * An accreditation is a signed statement that Mantyl's own infrastructure
 * independently re-executed a passport's verification plan and it passed
 * under a named policy. The signature binds the passport digest, evidence
 * digest, commit, policy and verifier version, so it can never be moved to
 * a different passport or a different state of the code.
 *
 * Rules:
 * - Ed25519 via node:crypto; no external services, no custom crypto
 * - the CLI NEVER holds a private key: accreditations are issued
 *   server-side only, and this package's signing half runs there
 * - verification is public: anyone with the published public key can
 *   check an accreditation offline
 */

import {
  createHash,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { canonicalJson } from "@mantyl/schema";

/** What the signature covers. Every field is required on purpose. */
export interface AccreditationRecord {
  /** Always "mantyl-verified" — the status this record justifies. */
  kind: "mantyl-verified";
  /** Digest of the passport this accredits (integrity.passportDigest). */
  passportDigest: string;
  /** Digest of the evidence bundle behind the passport. */
  evidenceDigest: string;
  /** Commit the verification ran against (null when not a git repo). */
  commit: string | null;
  /** The policy that had to pass, with its version. */
  policy: { id: string; version: string };
  /** Verifier identity and version that executed the checks. */
  verifier: { name: string; version: string };
  /** ISO timestamp of the verification run. */
  verifiedAt: string;
}

export interface SignedAccreditation {
  record: AccreditationRecord;
  /** base64url Ed25519 signature over the canonical record bytes. */
  signature: string;
  /** Fingerprint of the signing public key: sha256 of its DER, 16 hex. */
  keyId: string;
}

export interface SigningKeyPair {
  /** PKCS8 PEM. Server-side secret — never ships in any client. */
  privateKeyPem: string;
  /** SPKI PEM. Published so anyone can verify accreditations. */
  publicKeyPem: string;
  keyId: string;
}

/** Fingerprint a public key: sha256 over the PEM body, first 16 hex. */
export function keyIdFromPublicKey(publicKeyPem: string): string {
  const body = publicKeyPem.replace(/-----[^-]+-----|\s/g, "");
  return createHash("sha256").update(Buffer.from(body, "base64")).digest("hex").slice(0, 16);
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKeyPem, publicKeyPem, keyId: keyIdFromPublicKey(publicKeyPem) };
}

/** Canonical bytes the signature covers — deterministic by construction. */
function recordBytes(record: AccreditationRecord): Buffer {
  return Buffer.from(canonicalJson(record), "utf8");
}

export function signAccreditation(
  record: AccreditationRecord,
  privateKeyPem: string,
  publicKeyPem: string
): SignedAccreditation {
  if (record.kind !== "mantyl-verified") {
    throw new Error("signing: only mantyl-verified records exist");
  }
  const signature = edSign(null, recordBytes(record), privateKeyPem);
  return {
    record,
    signature: signature.toString("base64url"),
    keyId: keyIdFromPublicKey(publicKeyPem),
  };
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verify an accreditation against a public key and, optionally, the
 * passport it claims to accredit. Any mismatch is named, never swallowed.
 */
export function verifyAccreditation(
  signed: SignedAccreditation,
  publicKeyPem: string,
  expected?: { passportDigest?: string; evidenceDigest?: string }
): VerifyResult {
  if (signed.record.kind !== "mantyl-verified") {
    return { valid: false, reason: "record kind is not mantyl-verified" };
  }
  if (signed.keyId !== keyIdFromPublicKey(publicKeyPem)) {
    return { valid: false, reason: "keyId does not match the provided public key" };
  }
  let signatureOk = false;
  try {
    signatureOk = edVerify(
      null,
      recordBytes(signed.record),
      publicKeyPem,
      Buffer.from(signed.signature, "base64url")
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) {
    return { valid: false, reason: "signature does not verify over the record" };
  }
  if (expected?.passportDigest && expected.passportDigest !== signed.record.passportDigest) {
    return { valid: false, reason: "accreditation is for a different passport" };
  }
  if (expected?.evidenceDigest && expected.evidenceDigest !== signed.record.evidenceDigest) {
    return { valid: false, reason: "accreditation is for different evidence" };
  }
  return { valid: true };
}

export {
  STATEMENT_TYPE,
  PASSPORT_PREDICATE_TYPE,
  DSSE_PAYLOAD_TYPE,
  buildPassportStatement,
  preAuthEncoding,
  signStatement,
  verifyEnvelope,
  verifyPassportAttestation,
  envelopeDigest,
} from "./attestation.js";
export type {
  PassportPredicate,
  InTotoStatement,
  DsseEnvelope,
  AttestationVerifyResult,
} from "./attestation.js";
export { passportVerdict } from "./attestation.js";
