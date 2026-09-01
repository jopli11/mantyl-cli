/**
 * LLM analysis adapter (architecture spec §4) — interpretation, never
 * verification.
 *
 * Rules enforced here:
 * - the provider is configurable behind AnalysisProvider; "none" is the
 *   default and the pipeline is complete without any LLM
 * - inputs are REDACTED excerpts with the minimum context necessary —
 *   never raw transcripts, never full file contents
 * - output is schema-constrained AND re-validated locally; raw prose that
 *   fails our schema is rejected, not repaired
 * - everything produced here carries status "inferred" — the type system
 *   (NarrativeSchema, AnalysisStatus) prevents it ever being verified
 */

import { z } from "zod";
import type { SourceRef } from "@mantyl/schema";
import type { MantylConfig } from "@mantyl/config";
import { basename } from "node:path";
import { redactText } from "./redaction.js";
import type { ScanResult } from "./scan.js";
import type { Reconciliation } from "@mantyl/evidence";

/* ------------------------------------------------------------- contracts */

/** Redacted, minimal view of the project offered to the model. */
export interface AnalysisInput {
  projectName: string;
  stack: string[];
  /** Every directory group with its file count — the true shape of the repo. */
  directories: string[];
  /** Paths sampled across all directories — representative, not a prefix. */
  filePaths: string[];
  /** Files on disk that git does NOT track — local state, not the delivery. */
  untrackedPaths: string[];
  /** scan.exclude globs — paths matching these were deliberately hidden. */
  excludedGlobs: string[];
  factStatements: string[];
  claimTexts: string[];
  readmeExcerpt: string | null;
}

export const AnalysisOutputSchema = z
  .object({
    /** Architecture narrative — becomes the passport's `inferred` narrative. */
    narrative: z.string(),
    /** Inferred risks with the model's stated basis — advisory, never verified. */
    risks: z.array(
      z
        .object({
          text: z.string(),
          severity: z.enum(["low", "medium", "high"]),
          basis: z.string(),
        })
        .strict()
    ),
  })
  .strict();

export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;

export interface AnalysisProvider {
  readonly name: string;
  analyze(input: AnalysisInput): Promise<AnalysisOutput>;
}

/** The analysis result shaped for passport assembly (always inferred). */
export interface ProjectAnalysis {
  narrative: { status: "inferred"; text: string; refs: SourceRef[] };
  risks: Array<{
    id: string;
    status: "inferred";
    severity: "low" | "medium" | "high";
    text: string;
    refs: SourceRef[];
  }>;
  provider: string;
}

/* ---------------------------------------------------------- input builder */

const MAX_FILE_PATHS = 60;
const MAX_UNTRACKED_PATHS = 20;
const MAX_README_CHARS = 2_000;
const MAX_RISKS = 5;

/** Directory group for a path: two segments deep for nested trees. */
function groupKey(path: string): string {
  const parts = path.split("/");
  if (parts.length >= 3) return parts.slice(0, 2).join("/");
  if (parts.length === 2) return parts[0]!;
  return ".";
}

/**
 * Sample paths round-robin across directory groups. A plain prefix of the
 * sorted file list showed the model an alphabetical slice of the repo and
 * it (correctly) reasoned that the missing directories did not exist —
 * representativeness matters more than count.
 */
function samplePaths(paths: string[], cap: number): { directories: string[]; sample: string[] } {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const key = groupKey(path);
    const group = groups.get(key) ?? [];
    group.push(path);
    groups.set(key, group);
  }
  const keys = [...groups.keys()].sort();
  const directories = keys.map((k) => `${k} (${groups.get(k)!.length} files)`);

  const sample: string[] = [];
  for (let round = 0; sample.length < cap; round++) {
    let added = false;
    for (const key of keys) {
      const group = groups.get(key)!;
      if (round < group.length && sample.length < cap) {
        sample.push(group[round]!);
        added = true;
      }
    }
    if (!added) break;
  }
  return { directories, sample: sample.sort() };
}

/** Build the redacted minimal analysis view from scan + reconciliation. */
export function buildAnalysisInput(
  scan: ScanResult,
  readmeContent: string | null
): AnalysisInput {
  const redact = (text: string): string => redactText(text).text;
  const { directories, sample } = samplePaths(
    scan.repository.files.map((f) => f.path),
    MAX_FILE_PATHS
  );
  return {
    projectName: scan.repository.packageJson?.name ?? basename(scan.context.projectRoot),
    stack: [
      ...(scan.capabilities.usesTypeScript ? ["typescript"] : []),
      ...(scan.capabilities.packageManager ? [scan.capabilities.packageManager] : []),
      ...(scan.capabilities.hasDocker ? ["docker"] : []),
    ],
    directories,
    filePaths: sample,
    untrackedPaths: scan.repository.files
      .filter((f) => f.tracked === false)
      .slice(0, MAX_UNTRACKED_PATHS)
      .map((f) => f.path),
    excludedGlobs: scan.context.config.config.scan.exclude,
    factStatements: scan.facts.map((f) => redact(f.statement)),
    claimTexts: scan.claims.map((c) => redact(c.text)),
    readmeExcerpt:
      readmeContent === null ? null : redact(readmeContent).slice(0, MAX_README_CHARS),
  };
}

/* -------------------------------------------------------------- providers */

const SYSTEM_PROMPT = `You are the analysis stage of Mantyl, a software-handover tool.
You interpret a scanned repository for the person INHERITING it.

Rules:
- You see redacted excerpts only; never speculate about content you were not shown.
- "directories" is the complete directory map with true file counts; "filePaths" is a
  sample drawn from across those directories, NOT an exhaustive list — absence of a
  path from filePaths is never evidence it does not exist.
- "untrackedPaths" are files present on the local disk but NOT committed to the
  repository: treat them as local machine state, not part of the delivered project.
- "excludedGlobs" are path patterns the project deliberately excluded from this
  scan; directories matching them may well exist in the repository even though
  nothing under them appears here — their absence is configuration, not evidence.
- Describe architecture plainly for a capable engineer seeing the project cold.
- Risks must state their basis in the provided facts or file list — no invented specifics.
- You provide interpretation only. Nothing you write is verification; deterministic checks handle that.`;

/**
 * Default analysis model. Sonnet-tier: analysis is schema-constrained
 * extraction gated by local re-validation, so a top-tier model buys nothing.
 * Override per-project via llm.model in mantyl.config.json.
 */
export const DEFAULT_ANALYSIS_MODEL = "claude-sonnet-5";

/** Claude API provider — schema-constrained via structured outputs. */
export class AnthropicAnalysisProvider implements AnalysisProvider {
  readonly name = "anthropic";
  constructor(private readonly model: string = DEFAULT_ANALYSIS_MODEL) {}

  async analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    if (!process.env["ANTHROPIC_API_KEY"]) {
      throw new Error(
        "analysis: ANTHROPIC_API_KEY is not set. Set it as an environment variable " +
          "(never in a file), or set llm.provider to \"none\" in mantyl.config.json."
      );
    }
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    const response = await client.messages.create({
      model: this.model,
      // Roomy: a grown repository produced a truncated-JSON crash at 4096.
      max_tokens: 16_000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      output_config: {
        format: {
          type: "json_schema",
          schema: z.toJSONSchema(AnalysisOutputSchema, { target: "draft-2020-12" }),
        },
      },
      messages: [
        {
          role: "user",
          content: `Analyse this project and return the narrative and inferred risks.\n\n${JSON.stringify(input, null, 2)}`,
        },
      ],
    });

    if (response.stop_reason === "max_tokens") {
      throw new Error("analysis: output truncated at the token limit — raise max_tokens");
    }
    const text = response.content.find((block) => block.type === "text")?.text;
    if (!text) {
      throw new Error(`analysis: model returned no text output (stop: ${response.stop_reason})`);
    }
    // Local re-validation is the gate: schema-invalid output is rejected.
    return AnalysisOutputSchema.parse(JSON.parse(text));
  }
}

/* ------------------------------------------------------------ orchestration */

export function providerFromConfig(config: MantylConfig): AnalysisProvider | null {
  if (config.llm.provider === "none") return null;
  return new AnthropicAnalysisProvider(config.llm.model ?? DEFAULT_ANALYSIS_MODEL);
}

/**
 * Run analysis if a provider is configured. Returns null on "none" — the
 * pipeline is complete without it (--no-llm is first-class).
 */
export async function analyzeProject(
  scan: ScanResult,
  _reconciliation: Reconciliation,
  provider: AnalysisProvider | null,
  readmeContent: string | null
): Promise<ProjectAnalysis | null> {
  if (provider === null) return null;

  const input = buildAnalysisInput(scan, readmeContent);
  const output = await provider.analyze(input);

  const moduleRefs: SourceRef[] = scan.repository.files
    .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f.path))
    .slice(0, 10)
    .map((f) => ({ kind: "file", path: f.path }));

  return {
    narrative: {
      status: "inferred",
      text: output.narrative,
      refs: moduleRefs,
    },
    risks: output.risks.slice(0, MAX_RISKS).map((risk, index) => ({
      id: `risk:inferred:${index}`,
      status: "inferred" as const,
      severity: risk.severity,
      text: `${risk.text} (basis: ${risk.basis})`,
      refs: moduleRefs.slice(0, 3),
    })),
    provider: provider.name,
  };
}
