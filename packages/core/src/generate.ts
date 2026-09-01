/**
 * `mantyl generate` — canonical data flow steps 8–10 (spec §5):
 * assemble passport.json from scan + verification + reconciliation (+
 * optional analysis), validate it against the canonical schema, stamp
 * digests, and write the integrity manifest. Renderers consume the result
 * downstream — they never re-run analysis.
 */

import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  canonicalJson,
  digestPassport,
  digestValue,
  PassportSchema,
  SCHEMA_VERSION,
  type CheckResult,
  type Passport,
  type PlannedCheck,
} from "@mantyl/schema";
import type { Reconciliation } from "@mantyl/evidence";
import { analyzeProject, providerFromConfig, type ProjectAnalysis } from "./analysis.js";
import { buildFileManifest, type FileManifest } from "./manifest.js";
import { reconcileProject } from "./reconcile.js";
import type { ScanOptions, ScanResult } from "./scan.js";

export interface GenerateResult {
  passport: Passport;
  passportPath: string;
  manifest: FileManifest;
  analysis: ProjectAnalysis | null;
  artifactsDir: string;
}

async function readVerification(
  artifactsDir: string
): Promise<{ plan: PlannedCheck[]; results: CheckResult[] }> {
  try {
    const raw = await readFile(join(artifactsDir, "verification.json"), "utf8");
    const parsed = JSON.parse(raw) as { plan?: PlannedCheck[]; results?: CheckResult[] };
    return { plan: parsed.plan ?? [], results: parsed.results ?? [] };
  } catch {
    return { plan: [], results: [] };
  }
}

function assemblePassport(
  scan: ScanResult,
  reconciliation: Reconciliation,
  verification: { plan: PlannedCheck[]; results: CheckResult[] },
  analysis: ProjectAnalysis | null
): Passport {
  const passedChecks = new Set(
    verification.results.filter((r) => r.outcome === "passed").map((r) => r.checkId)
  );

  const envFacts = scan.facts.filter((f) => f.kind === "env");
  const plannedSteps = verification.plan
    .filter((check) => check.selected && (check.kind === "install" || check.kind === "build"))
    .map((check) => ({
      id: `setup:${check.id}`,
      status: passedChecks.has(check.id)
        ? ("locally-verified" as const)
        : ("repository-confirmed" as const),
      refs: passedChecks.has(check.id)
        ? [{ kind: "check" as const, checkId: check.id }]
        : [{ kind: "file" as const, path: "package.json" }],
      command: check.command,
    }));

  // No verification plan yet → derive repository-confirmed steps from the
  // declared scripts. Honest ceiling: never above repository-confirmed.
  const pm = scan.capabilities.packageManager ?? "npm";
  const fallbackSteps = [
    { key: "install", command: `${pm} install` },
    ...(scan.capabilities.scripts.build ? [{ key: "build", command: `${pm} run build` }] : []),
    ...(scan.capabilities.scripts.test ? [{ key: "test", command: `${pm} test` }] : []),
  ].map((step) => ({
    id: `setup:${step.key}`,
    status: "repository-confirmed" as const,
    refs: [{ kind: "file" as const, path: "package.json" }],
    command: step.command,
  }));
  const setupSteps = plannedSteps.length > 0 ? plannedSteps : fallbackSteps;

  // Workspace packages (any non-root package.json) are the module map in a
  // monorepo; single-package projects fall back to top-level src/ files.
  const workspaceDirs = scan.repository.files
    .filter((f) => f.path.endsWith("/package.json"))
    .map((f) => f.path.replace(/\/package\.json$/, ""));
  const modules =
    workspaceDirs.length > 0
      ? workspaceDirs.slice(0, 24).map((dir) => ({
          id: `module:${dir}`,
          status: "repository-confirmed" as const,
          refs: [{ kind: "file" as const, path: `${dir}/package.json` }],
          name: dir.split("/").pop()!,
          path: dir,
        }))
      : scan.repository.files
          .filter((f) => /^src\/.*\.(ts|tsx|js|mjs)$/.test(f.path))
          .slice(0, 12)
          .map((f) => ({
            id: `module:${f.path}`,
            status: "repository-confirmed" as const,
            refs: [{ kind: "file" as const, path: f.path }],
            name: f.path.replace(/^src\//, "").replace(/\.\w+$/, ""),
            path: f.path,
          }));

  const risks = [
    ...reconciliation.risks.map((risk) => ({
      id: risk.id,
      status: risk.status,
      refs: risk.refs,
      severity: risk.severity,
      text: risk.text,
      ...(risk.remediation ? { remediation: risk.remediation } : {}),
    })),
    ...(analysis?.risks.map((risk) => ({
      id: risk.id,
      status: risk.status,
      refs: risk.refs,
      severity: risk.severity,
      text: risk.text,
    })) ?? []),
    // Unresolved items surface as unresolved-status risks — visible, never hidden.
    ...reconciliation.unresolved.map((item) => ({
      id: item.id,
      status: "unresolved" as const,
      refs: [],
      severity: "medium" as const,
      text: item.reason,
      remediation: item.remediation,
    })),
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    run: {
      toolVersion: scan.context.toolVersion,
      timestamp: scan.context.startedAt.toISOString(),
      commit: scan.context.commit,
      configDigest: scan.context.config.digest,
    },
    project: {
      // No root package.json name (common in monorepos) → the folder name
      // beats "unknown" (first-user feedback: "Project passport — unknown").
      name: scan.repository.packageJson?.name ?? basename(scan.context.projectRoot),
      stack: [
        ...(scan.capabilities.usesTypeScript ? ["typescript"] : ["javascript"]),
        "node",
      ],
      services: [],
    },
    setup: {
      steps: setupSteps,
      env: envFacts.map((fact) => ({
        id: fact.id.replace(/^fact:/, ""),
        status: "repository-confirmed" as const,
        refs: fact.refs,
        name: String(fact.data?.name),
        documented: Boolean(fact.data?.documented),
      })),
    },
    architecture: {
      ...(analysis ? { narrative: analysis.narrative } : {}),
      modules,
    },
    // Decisions carry the status of whoever is on record: the agent, or the
    // creator whose own recorded words confirm the choice. Never verified —
    // choices are attested, not executed.
    decisions: scan.decisions.map((decision) => ({
      id: decision.id,
      status:
        decision.origin === "creator" ? ("creator-confirmed" as const) : ("agent-reported" as const),
      refs: decision.refs,
      title: decision.title,
      rationale: decision.rationale,
      ...(decision.date ? { date: decision.date } : {}),
    })),
    claims: reconciliation.claims.map((claim) => ({
      id: claim.id,
      status: claim.status,
      refs: claim.refs,
      text: claim.text,
      contradictions: claim.contradictions,
    })),
    risks,
    incomplete: reconciliation.incomplete.map((item) => ({
      id: item.id,
      status: item.status,
      refs: item.refs,
      title: item.title,
    })),
    verification,
    integrity: {},
  };
}

export async function generateProject(
  projectRoot: string,
  options: ScanOptions & {
    readmeForAnalysis?: string | null;
    /** Skip LLM analysis for this run regardless of config (--no-llm). */
    noLlm?: boolean;
  }
): Promise<GenerateResult> {
  const { scan, reconciliation } = await reconcileProject(projectRoot, options);
  const verification = await readVerification(scan.artifactsDir);

  const provider = options.noLlm ? null : providerFromConfig(scan.context.config.config);
  let readme: string | null = options.readmeForAnalysis ?? null;
  if (readme === null && provider !== null && scan.repository.readmePath) {
    readme = await readFile(join(projectRoot, scan.repository.readmePath), "utf8").catch(
      () => null
    );
  }
  // Analysis is optional BY DESIGN: a provider failure degrades to a
  // passport without a narrative, never to a crashed generate. Found live
  // when a truncated LLM response killed the whole pipeline.
  let analysis: ProjectAnalysis | null = null;
  try {
    analysis = await analyzeProject(scan, reconciliation, provider, readme);
  } catch (err) {
    process.stderr.write(
      `  ⚠ analysis failed and was skipped: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }

  const manifest = await buildFileManifest(projectRoot, scan.repository.files);
  const evidenceDigest = digestValue({
    facts: scan.facts,
    claims: scan.claims,
    reconciliation,
    verification,
  });

  const draft = assemblePassport(scan, reconciliation, verification, analysis);
  draft.integrity = {
    evidenceDigest,
    fileManifestDigest: manifest.digest,
  };
  draft.integrity.passportDigest = digestPassport(draft);

  // The schema is the gate — an invalid assembly must never be written.
  const passport = PassportSchema.parse(draft);

  const passportPath = join(scan.artifactsDir, "passport.json");
  await writeFile(passportPath, `${canonicalJson(passport)}\n`, "utf8");
  await writeFile(
    join(scan.artifactsDir, "integrity.json"),
    `${canonicalJson({ ...passport.integrity, files: manifest.files })}\n`,
    "utf8"
  );

  return {
    passport,
    passportPath,
    manifest,
    analysis,
    artifactsDir: scan.artifactsDir,
  };
}
