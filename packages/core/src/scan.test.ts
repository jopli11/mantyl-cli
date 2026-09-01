import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scanProject } from "./scan.js";

/** Fixture project + fixture transcript directory (adapter package). */
const FIXTURE_PROJECT = fileURLToPath(
  new URL("../../../examples/sample-project", import.meta.url)
);
const FIXTURE_SESSIONS = fileURLToPath(
  new URL("../../adapter-claude-code/fixtures", import.meta.url)
);

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantyl-scan-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const OPTIONS = {
  toolVersion: "0.0.0-test",
  sessionDir: FIXTURE_SESSIONS,
  now: () => new Date("2026-07-21T09:00:00.000Z"),
};

describe("scanProject on the seeded fixture", () => {
  it("extracts facts and claims that expose the seeded quirks", async () => {
    const result = await scanProject(FIXTURE_PROJECT, {
      ...OPTIONS,
      artifactsDir: await tempDir(),
    });

    // Fact: undocumented env var discovered.
    const apiToken = result.facts.find((f) => f.id === "fact:env:API_TOKEN");
    expect(apiToken?.data?.documented).toBe(false);
    const port = result.facts.find((f) => f.id === "fact:env:PORT");
    expect(port?.data?.documented).toBe(true);

    // Fact: the persistence TODO.
    expect(result.facts.some((f) => f.kind === "todo" && /persistence/i.test(f.statement))).toBe(
      true
    );

    // Claims from BOTH origins: the agent transcript and the README.
    const agentRateLimit = result.claims.find(
      (c) => c.origin === "agent" && /rate limiting/i.test(c.text)
    );
    expect(agentRateLimit).toBeDefined();
    expect(agentRateLimit?.refs[0]).toMatchObject({ kind: "session" });

    const readmeRateLimit = result.claims.find(
      (c) => c.origin === "readme" && /rate limited/i.test(c.text)
    );
    expect(readmeRateLimit).toBeDefined();
    expect(readmeRateLimit?.refs[0]).toMatchObject({ kind: "file", path: "README.md" });

    // Capabilities feed the M4 planner.
    expect(result.capabilities.scripts.build).toBe(true);
    expect(result.capabilities.scripts.test).toBe(true);
    expect(result.capabilities.usesTypeScript).toBe(true);

    // Decisions from BOTH voices: the agent's choice and the creator's.
    const agentDecision = result.decisions.find((d) => d.origin === "agent");
    expect(agentDecision?.title).toContain("in-memory Map over Postgres");
    expect(agentDecision?.date).toBe("2026-07-18");
    const creatorDecision = result.decisions.find((d) => d.origin === "creator");
    expect(creatorDecision?.title).toContain("bearer tokens");
    expect(creatorDecision?.refs[0]).toMatchObject({ kind: "session" });
  });

  it("writes deterministic artefacts — byte-equal across runs", async () => {
    const [dirA, dirB] = [await tempDir(), await tempDir()];
    await scanProject(FIXTURE_PROJECT, { ...OPTIONS, artifactsDir: dirA });
    await scanProject(FIXTURE_PROJECT, { ...OPTIONS, artifactsDir: dirB });

    for (const name of ["facts.json", "claims.json", "decisions.json", "capabilities.json", "run.json"]) {
      const a = await readFile(join(dirA, name), "utf8");
      const b = await readFile(join(dirB, name), "utf8");
      expect(a, name).toBe(b);
    }
  });

  it("respects scan.exclude from mantyl.config.json end to end", async () => {
    const { cp, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const project = await tempDir();
    await cp(FIXTURE_PROJECT, project, { recursive: true });
    await writeFile(
      join(project, "mantyl.config.json"),
      JSON.stringify({ scan: { exclude: ["src/**"] } })
    );

    const result = await scanProject(project, { ...OPTIONS, artifactsDir: await tempDir() });
    // Excluded source produces no facts: no env refs, no TODO, no modules.
    expect(result.facts.some((f) => f.kind === "env")).toBe(false);
    expect(result.facts.some((f) => f.kind === "todo")).toBe(false);
    expect(result.repository.files.some((f) => f.path.startsWith("src/"))).toBe(false);
  });

  it("never lets the planted transcript secret reach any artefact", async () => {
    const dir = await tempDir();
    await scanProject(FIXTURE_PROJECT, { ...OPTIONS, artifactsDir: dir });
    for (const name of ["facts.json", "claims.json", "decisions.json", "sessions.json", "run.json"]) {
      const content = await readFile(join(dir, name), "utf8");
      expect(content, name).not.toContain("verysecretfixturevalue");
    }
  });
});
