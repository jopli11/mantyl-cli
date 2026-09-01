/**
 * `mantyl accept` — the closing act of the handover (trust-and-ci-prd
 * H7, detached shape). The recipient independently validates the
 * delivery first (receive is the gate: divergence refuses acceptance),
 * sees every open finding by id, and then a canonical acceptance record
 * binding the exact passport digest is written OUTSIDE passport.json so
 * published digests stay immutable.
 *
 * Two stages by design: prepareAccept gathers the evidence the person
 * must see, recordAcceptance writes what they agreed to. The prompt in
 * between belongs to the CLI, not this module.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalJson,
  digestPassport,
  parseAcceptanceRecord,
  type AcceptanceRecord,
  type Passport,
} from "@mantyl/schema";
import { receiveProject, type ReceiveOptions, type ReceiveReport } from "./receive.js";

/** An item the recipient should see before accepting, by passport id. */
export interface OpenFinding {
  id: string;
  kind: "contradicted-claim" | "risk" | "incomplete" | "unresolved";
  text: string;
}

/**
 * The findings an acceptance acknowledges: contradictions the evidence
 * called out, recorded risks, incomplete work, and anything unresolved.
 * Pure and ordered as rendered so the CLI list matches the reports.
 */
export function openFindings(passport: Passport): OpenFinding[] {
  const findings: OpenFinding[] = [];
  for (const claim of passport.claims) {
    if (claim.status === "contradicted") {
      findings.push({ id: claim.id, kind: "contradicted-claim", text: claim.text });
    }
  }
  for (const risk of passport.risks) {
    findings.push({
      id: risk.id,
      kind: risk.status === "unresolved" ? "unresolved" : "risk",
      text: `(${risk.severity}) ${risk.text}`,
    });
  }
  for (const item of passport.incomplete) {
    findings.push({ id: item.id, kind: "incomplete", text: item.title });
  }
  return findings;
}

export interface PrepareAcceptResult {
  report: ReceiveReport;
  /** null when the passport failed schema validation. */
  passport: Passport | null;
  openFindings: OpenFinding[];
  /** True when acceptance must be refused: the delivery diverged. */
  refused: boolean;
}

/**
 * Stage one: run the recipient's independent validation and surface
 * what acceptance would acknowledge. A diverged report refuses —
 * accepting an unverified delivery is exactly what the product exists
 * to prevent.
 */
export async function prepareAccept(
  repoPath: string,
  options: ReceiveOptions
): Promise<PrepareAcceptResult> {
  const { report, passport } = await receiveProject(repoPath, options);
  return {
    report,
    passport,
    openFindings: passport !== null && !report.diverged ? openFindings(passport) : [],
    refused: report.diverged,
  };
}

export interface RecordAcceptanceOptions {
  acceptedBy: { name: string; organisation?: string | undefined };
  /** Finding ids the recipient saw and acknowledged. */
  acknowledgedFindings: string[];
  /** Override artefact directory (default {repoPath}/.mantyl). */
  artifactsDir?: string;
  now?: () => Date;
}

export interface RecordAcceptanceResult {
  record: AcceptanceRecord;
  path: string;
}

/**
 * Stage two: write the canonical acceptance record beside the other
 * artefacts. The digest is recomputed from the passport that receive
 * just validated, never trusted from the document, so the record binds
 * what was actually checked.
 */
export async function recordAcceptance(
  repoPath: string,
  passport: Passport,
  options: RecordAcceptanceOptions
): Promise<RecordAcceptanceResult> {
  const now = options.now ?? (() => new Date());
  const timestamp = now();
  const record = parseAcceptanceRecord({
    kind: "mantyl-acceptance",
    recordVersion: "1",
    passportDigest: digestPassport(passport),
    acceptedBy: {
      name: options.acceptedBy.name,
      ...(options.acceptedBy.organisation
        ? { organisation: options.acceptedBy.organisation }
        : {}),
      date: timestamp.toISOString().slice(0, 10),
    },
    acknowledgedFindings: [...options.acknowledgedFindings].sort(),
    acceptedAt: timestamp.toISOString(),
  });

  const dir = options.artifactsDir ?? join(repoPath, ".mantyl");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "acceptance.json");
  await writeFile(path, `${canonicalJson(record)}\n`, "utf8");
  return { record, path };
}
