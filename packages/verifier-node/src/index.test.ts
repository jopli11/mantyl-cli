import { describe, expect, it } from "vitest";
import { sha256Hex } from "@mantyl/schema";
import type { SandboxCommand, SandboxResult } from "@mantyl/runner-docker";
import { executeCheck, planNodeChecks } from "./index.js";

const CAPS = {
  packageManager: "pnpm" as const,
  scripts: { build: true, test: true, lint: false, typecheck: false },
  usesTypeScript: true,
};

describe("planNodeChecks", () => {
  it("selects checks from capabilities and records reasons for skips", () => {
    const plan = planNodeChecks(CAPS);
    const byId = Object.fromEntries(plan.map((c) => [c.id, c]));

    expect(byId["check-install"]?.selected).toBe(true);
    expect(byId["check-install"]?.command).toContain("pnpm install --frozen-lockfile");
    expect(byId["check-build"]?.selected).toBe(true);
    expect(byId["check-lint"]?.selected).toBe(false);
    expect(byId["check-lint"]?.skipReason).toBe("script not defined");
    expect(plan.every((c) => c.reason.length > 0)).toBe(true);
  });

  it("falls back to npm when no lockfile is detected", () => {
    const plan = planNodeChecks({ ...CAPS, packageManager: null });
    expect(plan[0]?.command).toBe("npm install");
  });
});

class ScriptedTarget {
  constructor(private readonly result: Partial<SandboxResult>) {}
  lastCommand: SandboxCommand | null = null;
  run(command: SandboxCommand): Promise<SandboxResult> {
    this.lastCommand = command;
    return Promise.resolve({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      durationMs: 10,
      envFingerprint: "scripted:test",
      ...this.result,
    });
  }
}

describe("executeCheck", () => {
  it("digests the SCRUBBED log — digest describes what is stored", async () => {
    const runner = new ScriptedTarget({
      stdout: "installing...\ntoken=ghp_abcdefghijklmnopqrstuv0123456789",
    });
    const plan = planNodeChecks(CAPS);
    const scrub = (text: string) => text.replace(/ghp_[A-Za-z0-9]+/g, "[REDACTED]");
    const { result, log } = await executeCheck(runner, plan[0]!, {
      timeoutMs: 1000,
      networkForInstall: true,
      scrub,
    });
    expect(log).not.toContain("ghp_");
    expect(result.logsDigest).toBe(sha256Hex(log));
    expect(result.outcome).toBe("passed");
  });

  it("keeps the network off for non-install checks", async () => {
    const runner = new ScriptedTarget({});
    const plan = planNodeChecks(CAPS);
    const build = plan.find((c) => c.id === "check-build")!;
    await executeCheck(runner, build, { timeoutMs: 1000, networkForInstall: true });
    expect(runner.lastCommand?.network).toBe(false);

    const install = plan.find((c) => c.id === "check-install")!;
    await executeCheck(runner, install, { timeoutMs: 1000, networkForInstall: true });
    expect(runner.lastCommand?.network).toBe(true);
  });

  it("maps timeouts to error outcomes with no exit code", async () => {
    const runner = new ScriptedTarget({ exitCode: null, timedOut: true });
    const plan = planNodeChecks(CAPS);
    const { result } = await executeCheck(runner, plan[0]!, {
      timeoutMs: 5,
      networkForInstall: false,
    });
    expect(result.outcome).toBe("error");
    expect(result.exitCode).toBeUndefined();
  });
});
