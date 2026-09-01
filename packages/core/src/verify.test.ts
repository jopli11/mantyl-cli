import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Runner, SandboxCommand, SandboxResult } from "@mantyl/runner-docker";
import { verifyProject } from "./verify.js";

const FIXTURE_PROJECT = fileURLToPath(
  new URL("../../../examples/sample-project", import.meta.url)
);

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantyl-verify-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

class UnavailableRunner implements Runner {
  available() {
    return Promise.resolve({ available: false, reason: "test: no sandbox" });
  }
  run(): Promise<SandboxResult> {
    throw new Error("must never be called when unavailable");
  }
  session(): never {
    throw new Error("must never be called when unavailable");
  }
}

class RecordingRunner implements Runner {
  commands: SandboxCommand[] = [];
  /** commands.length at the moment the network was disconnected. */
  disconnectedAfter: number | null = null;
  closed = false;
  constructor(private readonly outcomes: Array<{ exitCode: number; stdout?: string }>) {}
  available() {
    return Promise.resolve({ available: true, version: "recording" });
  }
  run(_workspace: string, command: SandboxCommand): Promise<SandboxResult> {
    return this.exec(command);
  }
  session() {
    return Promise.resolve({
      exec: (command: SandboxCommand) => this.exec(command),
      disconnectNetwork: () => {
        this.disconnectedAfter ??= this.commands.length;
        return Promise.resolve();
      },
      close: () => {
        this.closed = true;
        return Promise.resolve();
      },
    });
  }
  private exec(command: SandboxCommand): Promise<SandboxResult> {
    this.commands.push(command);
    const scripted = this.outcomes[this.commands.length - 1] ?? { exitCode: 0 };
    return Promise.resolve({
      exitCode: scripted.exitCode,
      timedOut: false,
      stdout: scripted.stdout ?? "",
      stderr: "",
      durationMs: 5,
      envFingerprint: "recording:test",
    });
  }
}

const OPTIONS = { toolVersion: "0.0.0-test", now: () => new Date("2026-07-21T10:00:00.000Z") };

describe("verifyProject", () => {
  it("records skipped results when the sandbox is unavailable — never fake passes", async () => {
    const artifactsDir = await tempDir();
    const result = await verifyProject(FIXTURE_PROJECT, {
      ...OPTIONS,
      runner: new UnavailableRunner(),
      artifactsDir,
    });
    expect(result.sandbox.available).toBe(false);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((r) => r.outcome === "skipped")).toBe(true);
    expect(result.results[0]?.envFingerprint).toContain("test: no sandbox");

    const artefact = JSON.parse(await readFile(join(artifactsDir, "verification.json"), "utf8"));
    expect(artefact.sandbox.available).toBe(false);
  });

  it("executes selected checks in plan order and writes scrubbed logs", async () => {
    const artifactsDir = await tempDir();
    const runner = new RecordingRunner([
      { exitCode: 0, stdout: "installed with token=ghp_abcdefghijklmnopqrstuv0123456789" },
      { exitCode: 0 },
      { exitCode: 1 },
    ]);
    const result = await verifyProject(FIXTURE_PROJECT, {
      ...OPTIONS,
      runner,
      artifactsDir,
    });

    // fixture has build+test scripts → install, build, test executed
    expect(runner.commands.length).toBe(3);
    expect(runner.commands[0]?.network).toBe(true); // install
    expect(runner.commands[1]?.network).toBe(false); // build stays offline
    // One session: network cut exactly after install, session closed at end.
    expect(runner.disconnectedAfter).toBe(1);
    expect(runner.closed).toBe(true);
    // Sandboxed package managers must run in CI mode — no TTY prompts.
    expect(runner.commands.every((c) => c.env?.CI === "true")).toBe(true);

    const outcomes = result.results.map((r) => `${r.checkId}:${r.outcome}`);
    expect(outcomes).toEqual([
      "check-install:passed",
      "check-build:passed",
      "check-test:failed",
    ]);

    const installLog = await readFile(join(artifactsDir, "logs", "check-install.log"), "utf8");
    expect(installLog).not.toContain("ghp_abcdefghijklmnopqrstuv0123456789");
    expect(installLog).toContain("[REDACTED:");
  });
});
