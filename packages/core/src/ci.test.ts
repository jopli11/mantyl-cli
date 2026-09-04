import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ExitCode } from "./exit-codes.js";
import { ciSummary, githubOutputLines, githubStepSummaryMarkdown } from "./ci.js";
import { generateProject } from "./generate.js";
import type { Passport } from "@mantyl/schema";

const FIXTURE_PROJECT = fileURLToPath(
  new URL("../../../examples/sample-project", import.meta.url)
);
const FIXTURE_SESSIONS = fileURLToPath(
  new URL("../../adapter-claude-code/fixtures", import.meta.url)
);

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantyl-ci-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function fixturePassport(): Promise<Passport> {
  const { passport } = await generateProject(FIXTURE_PROJECT, {
    toolVersion: "0.0.0-test",
    sessionDir: FIXTURE_SESSIONS,
    now: () => new Date("2026-09-02T12:00:00.000Z"),
    artifactsDir: await tempDir(),
  });
  return passport;
}

function withChecks(
  passport: Passport,
  outcomes: Array<"passed" | "failed" | "skipped" | "error">
): Passport {
  return {
    ...passport,
    verification: {
      plan: passport.verification.plan,
      results: outcomes.map((outcome, i) => ({
        checkId: `check-${i}`,
        outcome,
        command: "pnpm test",
        startedAt: "2026-09-02T12:00:00.000Z",
        durationMs: 10,
        ...(outcome === "passed" || outcome === "failed" ? { exitCode: outcome === "passed" ? 0 : 1 } : {}),
      })),
    },
  };
}

describe("ciSummary", () => {
  it("derives counts and a passed verdict from a clean run", async () => {
    const passport = withChecks(await fixturePassport(), ["passed", "passed"]);
    const summary = ciSummary(passport, true);
    expect(summary.verdict).toBe("passed");
    expect(summary.exitCode).toBe(ExitCode.Ok);
    expect(summary.checksPassed).toBe(2);
    expect(summary.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.contradicted).toBeGreaterThan(0); // the fixture's planted claims
  });

  it("fails when any executed check failed or errored, even with the sandbox up", async () => {
    const passport = withChecks(await fixturePassport(), ["passed", "failed"]);
    const summary = ciSummary(passport, true);
    expect(summary.verdict).toBe("failed");
    expect(summary.exitCode).toBe(ExitCode.VerificationFailed);

    const errored = ciSummary(withChecks(passport, ["passed", "error"]), true);
    expect(errored.verdict).toBe("failed");
  });

  it("reports no-sandbox with exit 5 when nothing could execute", async () => {
    const passport = withChecks(await fixturePassport(), ["skipped", "skipped"]);
    const summary = ciSummary(passport, false);
    expect(summary.verdict).toBe("no-sandbox");
    expect(summary.exitCode).toBe(ExitCode.SandboxUnavailable);
    expect(summary.checksSkipped).toBe(2);
  });

  it("a failure recorded on a sandbox-less run still reads failed, not no-sandbox", async () => {
    const passport = withChecks(await fixturePassport(), ["failed", "skipped"]);
    expect(ciSummary(passport, false).verdict).toBe("failed");
  });
});

describe("GitHub outputs", () => {
  it("emits stable key=value lines", async () => {
    const summary = ciSummary(withChecks(await fixturePassport(), ["passed"]), true);
    const lines = githubOutputLines(summary);
    expect(lines).toContain("verdict=passed");
    expect(lines).toContain(`passport-digest=${summary.digest}`);
    expect(lines.every((l) => /^[a-z-]+=/.test(l))).toBe(true);
  });

  it("renders a summary with no em dashes and the honest no-sandbox line", async () => {
    const summary = ciSummary(withChecks(await fixturePassport(), ["skipped"]), false);
    const md = githubStepSummaryMarkdown(summary);
    expect(md).toContain("No checks executed");
    expect(md).toContain("nothing fake-passes");
    expect(md).not.toContain("—");
    expect(md).toContain("not a certification");
  });
});
