import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileProject } from "./reconcile.js";

const FIXTURE_PROJECT = fileURLToPath(
  new URL("../../../examples/sample-project", import.meta.url)
);
const FIXTURE_SESSIONS = fileURLToPath(
  new URL("../../adapter-claude-code/fixtures", import.meta.url)
);

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantyl-reconcile-"));
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
  now: () => new Date("2026-07-21T11:00:00.000Z"),
};

describe("reconcileProject on the seeded fixture — the contradiction payoff", () => {
  it("contradicts BOTH rate-limiting claims (agent and README) against the repository", async () => {
    const { reconciliation } = await reconcileProject(FIXTURE_PROJECT, {
      ...OPTIONS,
      artifactsDir: await tempDir(),
    });

    const rateLimitClaims = reconciliation.claims.filter((c) => /rate.?limit/i.test(c.text));
    expect(rateLimitClaims.length).toBe(2);
    for (const claim of rateLimitClaims) {
      expect(claim.status).toBe("contradicted");
      expect(claim.contradictions).toContainEqual({ kind: "file", path: "package.json" });
    }
  });

  it("corroborates the auth claim from real source evidence", async () => {
    const { reconciliation } = await reconcileProject(FIXTURE_PROJECT, {
      ...OPTIONS,
      artifactsDir: await tempDir(),
    });
    const auth = reconciliation.claims.find((c) => /bearer-token auth/i.test(c.text));
    expect(auth?.status).toBe("agent-reported");
    expect(auth?.note).toContain("corroborated");
    expect(auth?.refs.some((r) => r.kind === "file" && r.path === "src/server.ts")).toBe(true);
  });

  it("derives risks, incomplete work and unresolved items", async () => {
    const { reconciliation } = await reconcileProject(FIXTURE_PROJECT, {
      ...OPTIONS,
      artifactsDir: await tempDir(),
    });
    expect(reconciliation.risks.some((r) => r.text.includes("API_TOKEN"))).toBe(true);
    expect(reconciliation.incomplete.some((i) => /persistence/i.test(i.title))).toBe(true);
    // no verification.json in a fresh artefacts dir → honest unresolved item
    expect(reconciliation.unresolved.some((u) => u.id === "unresolved:verification")).toBe(true);
  });

  it("writes a deterministic reconciliation artefact", async () => {
    const [dirA, dirB] = [await tempDir(), await tempDir()];
    await reconcileProject(FIXTURE_PROJECT, { ...OPTIONS, artifactsDir: dirA });
    await reconcileProject(FIXTURE_PROJECT, { ...OPTIONS, artifactsDir: dirB });
    const a = await readFile(join(dirA, "reconciliation.json"), "utf8");
    const b = await readFile(join(dirB, "reconciliation.json"), "utf8");
    expect(a).toBe(b);
    expect(a).toContain("contradicted");
  });
});
