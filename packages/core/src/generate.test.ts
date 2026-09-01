import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parsePassport } from "@mantyl/schema";
import { renderPassportMarkdown } from "@mantyl/renderer-markdown";
import { renderPassportHtml } from "@mantyl/renderer-html";
import type { Runner, SandboxCommand, SandboxResult } from "@mantyl/runner-docker";
import { generateProject } from "./generate.js";
import { receiveProject } from "./receive.js";
import { verifyProject } from "./verify.js";

const FIXTURE_PROJECT = fileURLToPath(
  new URL("../../../examples/sample-project", import.meta.url)
);
const FIXTURE_SESSIONS = fileURLToPath(
  new URL("../../adapter-claude-code/fixtures", import.meta.url)
);

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantyl-generate-"));
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
  now: () => new Date("2026-07-21T13:00:00.000Z"),
};

class PassingRunner implements Runner {
  available() {
    return Promise.resolve({ available: true, version: "test" });
  }
  run(_workspace: string, _command: SandboxCommand): Promise<SandboxResult> {
    return this.pass();
  }
  session() {
    return Promise.resolve({
      exec: () => this.pass(),
      disconnectNetwork: () => Promise.resolve(),
      close: () => Promise.resolve(),
    });
  }
  private pass(): Promise<SandboxResult> {
    return Promise.resolve({
      exitCode: 0,
      timedOut: false,
      stdout: "ok",
      stderr: "",
      durationMs: 5,
      envFingerprint: "test:runner",
    });
  }
}

/** Copy the fixture into a temp dir so tests can verify/tamper freely. */
async function fixtureCopy(): Promise<string> {
  const dir = await tempDir();
  await cp(FIXTURE_PROJECT, dir, { recursive: true });
  return dir;
}

describe("generateProject", () => {
  it("produces a schema-valid passport exposing every seeded truth", async () => {
    const project = await fixtureCopy();
    await verifyProject(project, { ...OPTIONS, runner: new PassingRunner() });
    const result = await generateProject(project, OPTIONS);

    // Round-trips through the schema from disk.
    const onDisk = parsePassport(
      JSON.parse(await readFile(result.passportPath, "utf8"))
    );
    expect(onDisk.project.name).toBe("notes-api");

    // Seeded truths, discovered end-to-end by the pipeline:
    const contradicted = onDisk.claims.filter((c) => c.status === "contradicted");
    expect(contradicted.length).toBe(2); // agent + README rate-limiting claims
    expect(onDisk.setup.env.some((e) => e.name === "API_TOKEN" && !e.documented)).toBe(true);
    // Decisions carry the voice of whoever is on record.
    expect(
      onDisk.decisions.some((d) => d.status === "creator-confirmed" && /bearer tokens/.test(d.title))
    ).toBe(true);
    expect(
      onDisk.decisions.some((d) => d.status === "agent-reported" && /in-memory Map/.test(d.title))
    ).toBe(true);
    expect(onDisk.incomplete.some((i) => /persistence/i.test(i.title))).toBe(true);
    expect(onDisk.verification.results.every((r) => r.outcome === "passed")).toBe(true);
    expect(onDisk.setup.steps.some((s) => s.status === "locally-verified")).toBe(true);

    // Integrity stamped and self-consistent.
    expect(onDisk.integrity.passportDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(onDisk.integrity.fileManifestDigest).toBe(result.manifest.digest);
  });

  it("renderers are deterministic pure consumers", async () => {
    const project = await fixtureCopy();
    const result = await generateProject(project, OPTIONS);

    const md1 = renderPassportMarkdown(result.passport);
    const md2 = renderPassportMarkdown(result.passport);
    expect(md1).toBe(md2);
    expect(md1).toContain("CONTRADICTED");
    expect(md1).toContain("API_TOKEN");
    expect(md1).toContain("not a certification");

    const html1 = renderPassportHtml(result.passport);
    const html2 = renderPassportHtml(result.passport);
    expect(html1).toBe(html2);
    expect(html1).toContain("CONTRADICTED");
    expect(html1).toContain("#FFC400"); // Signal Console tokens travelled with it
  });

  it("no artefact leaks the planted transcript secret", async () => {
    const project = await fixtureCopy();
    const result = await generateProject(project, OPTIONS);
    const surfaces = [
      JSON.stringify(result.passport),
      renderPassportMarkdown(result.passport),
      renderPassportHtml(result.passport),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain("verysecretfixturevalue");
    }
  });
});

describe("receiveProject — the recipient's independent verdict", () => {
  it("accepts an untampered delivery", async () => {
    const project = await fixtureCopy();
    await verifyProject(project, { ...OPTIONS, runner: new PassingRunner() });
    const generated = await generateProject(project, OPTIONS);

    const { report } = await receiveProject(project, {
      toolVersion: "0.0.0-test",
      passportPath: generated.passportPath,
      runner: new PassingRunner(),
    });
    expect(report.passportValid).toBe(true);
    expect(report.passportDigestMatch).toBe(true);
    expect(report.fileManifest.match).toBe(true);
    expect(report.checks.every((c) => c.match)).toBe(true);
    expect(report.diverged).toBe(false);
  });

  it("detects a tampered repository and names the file", async () => {
    const project = await fixtureCopy();
    const generated = await generateProject(project, OPTIONS);

    // Tamper AFTER the passport was issued.
    await writeFile(
      join(project, "src", "store.ts"),
      "// tampered after handover\nexport const notes = [];\n"
    );

    const { report } = await receiveProject(project, {
      toolVersion: "0.0.0-test",
      passportPath: generated.passportPath,
      skipChecks: true,
    });
    expect(report.fileManifest.match).toBe(false);
    expect(report.fileManifest.modified).toContain("src/store.ts");
    expect(report.diverged).toBe(true);
  });

  it("rejects a tampered passport via digest self-check", async () => {
    const project = await fixtureCopy();
    const generated = await generateProject(project, OPTIONS);

    const doctored = JSON.parse(await readFile(generated.passportPath, "utf8"));
    // Quietly soften a contradicted claim — the classic forgery.
    doctored.claims = doctored.claims.map((c: { status: string }) =>
      c.status === "contradicted" ? { ...c, status: "agent-reported" } : c
    );
    const forgedPath = join(await tempDir(), "passport.json");
    await writeFile(forgedPath, JSON.stringify(doctored));

    const { report } = await receiveProject(project, {
      toolVersion: "0.0.0-test",
      passportPath: forgedPath,
      skipChecks: true,
    });
    expect(report.passportDigestMatch).toBe(false);
    expect(report.diverged).toBe(true);
  });
});
