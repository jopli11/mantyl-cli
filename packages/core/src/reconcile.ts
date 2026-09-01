/**
 * Reconciliation workflow — canonical data flow step 8 (spec §5).
 * Joins the scan's facts/claims with verification evidence via the pure
 * reconciler in @mantyl/evidence, and writes the reconciliation artefact.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalJson,
  type CheckResult,
  type PlannedCheck,
  type SourceRef,
} from "@mantyl/schema";
import {
  CLAIM_LEXICON,
  reconcile,
  type Reconciliation,
  type ReconcilerInput,
} from "@mantyl/evidence";
import { scanProject, type ScanOptions, type ScanResult } from "./scan.js";

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const MAX_HITS_PER_LABEL = 5;

/**
 * Search project source for each lexicon mechanism. Reuses the lexicon's
 * claim patterns — they are deliberately loose enough to match identifiers
 * ("rateLimit", "express-rate-limit") as well as prose.
 */
async function searchLexiconHits(
  projectRoot: string,
  scan: ScanResult
): Promise<Record<string, SourceRef[]>> {
  const hits: Record<string, SourceRef[]> = {};
  for (const file of scan.repository.files) {
    if (!SOURCE_EXTENSIONS.test(file.path)) continue;
    const content = await readFile(join(projectRoot, file.path), "utf8").catch(() => null);
    if (content === null) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const entry of CLAIM_LEXICON) {
        const existing = hits[entry.label] ?? [];
        if (existing.length >= MAX_HITS_PER_LABEL) continue;
        if (entry.claimPattern.test(lines[i]!)) {
          existing.push({ kind: "file", path: file.path, lines: [i + 1, i + 1] });
          hits[entry.label] = existing;
        }
      }
    }
  }
  return hits;
}

async function readVerification(
  artifactsDir: string
): Promise<{ plan: PlannedCheck[]; results: CheckResult[] } | null> {
  try {
    const raw = await readFile(join(artifactsDir, "verification.json"), "utf8");
    const parsed = JSON.parse(raw) as { plan?: PlannedCheck[]; results?: CheckResult[] };
    if (!Array.isArray(parsed.plan) || !Array.isArray(parsed.results)) return null;
    return { plan: parsed.plan, results: parsed.results };
  } catch {
    return null;
  }
}

export interface ReconcileProjectResult {
  scan: ScanResult;
  reconciliation: Reconciliation;
}

export async function reconcileProject(
  projectRoot: string,
  options: ScanOptions
): Promise<ReconcileProjectResult> {
  const scan = await scanProject(projectRoot, options);
  const termHits = await searchLexiconHits(projectRoot, scan);
  const verification = await readVerification(scan.artifactsDir);

  const input: ReconcilerInput = {
    facts: scan.facts,
    claims: scan.claims,
    verification,
    termHits,
    dependencyNames: [
      ...(scan.repository.packageJson?.dependencies ?? []),
      ...(scan.repository.packageJson?.devDependencies ?? []),
    ],
    manifestRef: scan.repository.packageJson?.ref ?? null,
  };
  const reconciliation = reconcile(input);

  await writeFile(
    join(scan.artifactsDir, "reconciliation.json"),
    `${canonicalJson(reconciliation)}\n`,
    "utf8"
  );

  return { scan, reconciliation };
}
