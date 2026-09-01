import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "@mantyl/config";
import {
  analyzeProject,
  buildAnalysisInput,
  providerFromConfig,
  AnalysisOutputSchema,
  AnthropicAnalysisProvider,
  DEFAULT_ANALYSIS_MODEL,
  type AnalysisInput,
  type AnalysisOutput,
  type AnalysisProvider,
} from "./analysis.js";
import { reconcileProject } from "./reconcile.js";
import { scanProject } from "./scan.js";

const FIXTURE_PROJECT = fileURLToPath(
  new URL("../../../examples/sample-project", import.meta.url)
);
const FIXTURE_SESSIONS = fileURLToPath(
  new URL("../../adapter-claude-code/fixtures", import.meta.url)
);

const OPTIONS = {
  toolVersion: "0.0.0-test",
  sessionDir: FIXTURE_SESSIONS,
  now: () => new Date("2026-07-21T12:00:00.000Z"),
};

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantyl-analysis-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

class FakeProvider implements AnalysisProvider {
  readonly name = "fake";
  lastInput: AnalysisInput | null = null;
  constructor(private readonly output: AnalysisOutput) {}
  analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    this.lastInput = input;
    return Promise.resolve(this.output);
  }
}

describe("analysis adapter", () => {
  it("provider 'none' (the default) skips analysis entirely — no-llm is first-class", async () => {
    expect(providerFromConfig(defaultConfig())).toBeNull();

    const scan = await scanProject(FIXTURE_PROJECT, {
      ...OPTIONS,
      artifactsDir: await tempDir(),
    });
    const result = await analyzeProject(scan, { claims: [], risks: [], incomplete: [], unresolved: [] }, null, null);
    expect(result).toBeNull();
  });

  it("analysis output is forced to inferred status with refs", async () => {
    const { scan, reconciliation } = await reconcileProject(FIXTURE_PROJECT, {
      ...OPTIONS,
      artifactsDir: await tempDir(),
    });
    const provider = new FakeProvider({
      narrative: "A single-process HTTP API with an in-memory store.",
      risks: [
        { text: "State is lost on restart", severity: "medium", basis: "no database dependency" },
      ],
    });

    const analysis = await analyzeProject(scan, reconciliation, provider, "readme text");
    expect(analysis?.narrative.status).toBe("inferred");
    expect(analysis?.narrative.refs.length).toBeGreaterThan(0);
    expect(analysis?.risks[0]?.status).toBe("inferred");
    expect(analysis?.provider).toBe("fake");
  });

  it("builds a redacted, minimal input — planted secrets never reach the provider", async () => {
    const scan = await scanProject(FIXTURE_PROJECT, {
      ...OPTIONS,
      artifactsDir: await tempDir(),
    });
    const readmeWithSecret =
      "Setup: export API_TOKEN=sk-ant-api03-plantedsecretvalue000042 then run.";
    const input = buildAnalysisInput(scan, readmeWithSecret);

    expect(JSON.stringify(input)).not.toContain("plantedsecretvalue");
    expect(input.readmeExcerpt).toContain("[REDACTED:");
    // Minimal context: paths and statements only — no file contents, no transcripts.
    expect(input.filePaths.length).toBeLessThanOrEqual(60);
    expect(Object.keys(input).sort()).toEqual([
      "claimTexts",
      "directories",
      "excludedGlobs",
      "factStatements",
      "filePaths",
      "projectName",
      "readmeExcerpt",
      "stack",
      "untrackedPaths",
    ]);
  });

  it("samples file paths across directories — never an alphabetical prefix", async () => {
    const scan = await scanProject(FIXTURE_PROJECT, {
      ...OPTIONS,
      artifactsDir: await tempDir(),
    });
    // Simulate a repo where a naive first-60 prefix would only show aaa/:
    const files = [
      ...Array.from({ length: 100 }, (_, i) => ({ path: `aaa/sub/f${String(i).padStart(3, "0")}.ts`, size: 1 })),
      { path: "packages/core/index.ts", size: 1 },
      { path: "zzz/last.ts", size: 1, tracked: false },
    ];
    const input = buildAnalysisInput(
      { ...scan, repository: { ...scan.repository, files } },
      null
    );

    // Every directory group is represented in both the map and the sample.
    expect(input.directories).toEqual([
      "aaa/sub (100 files)",
      "packages/core (1 files)",
      "zzz (1 files)",
    ]);
    expect(input.filePaths).toContain("packages/core/index.ts");
    expect(input.filePaths).toContain("zzz/last.ts");
    expect(input.filePaths.length).toBeLessThanOrEqual(60);
    // Untracked files are separated out as local-only state.
    expect(input.untrackedPaths).toEqual(["zzz/last.ts"]);
  });

  it("defaults to a cost-efficient model; config llm.model overrides it", () => {
    // Analysis is schema-gated extraction — sonnet tier, never opus/fable.
    expect(DEFAULT_ANALYSIS_MODEL).toBe("claude-sonnet-5");

    const config = { ...defaultConfig(), llm: { provider: "anthropic" as const } };
    expect(providerFromConfig(config)).toBeInstanceOf(AnthropicAnalysisProvider);
  });

  it("fails fast with a clear message when ANTHROPIC_API_KEY is missing", async () => {
    const saved = process.env["ANTHROPIC_API_KEY"];
    delete process.env["ANTHROPIC_API_KEY"];
    try {
      const provider = new AnthropicAnalysisProvider();
      await expect(
        provider.analyze({
          projectName: "x",
          stack: [],
          directories: [],
          filePaths: [],
          untrackedPaths: [],
          excludedGlobs: [],
          factStatements: [],
          claimTexts: [],
          readmeExcerpt: null,
        })
      ).rejects.toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env["ANTHROPIC_API_KEY"] = saved;
    }
  });

  it("rejects schema-invalid model output rather than repairing it", () => {
    expect(() =>
      AnalysisOutputSchema.parse({ narrative: "ok", risks: [{ text: "x" }] })
    ).toThrow();
    expect(() =>
      AnalysisOutputSchema.parse({ narrative: "ok", risks: [], extra: "nope" })
    ).toThrow();
  });
});
