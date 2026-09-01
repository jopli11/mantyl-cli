import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DockerRunner, shouldStage } from "./index.js";

/**
 * Integration tests — run only where a Docker daemon is reachable (CI's
 * ubuntu runners; locally when Docker Desktop is up). The availability
 * check itself always runs: it must answer, not hang.
 */
const runner = new DockerRunner();
const availability = await runner.available();

let dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantyl-sandbox-"));
  dirs.push(dir);
  return dir;
}

describe("DockerRunner.available", () => {
  it("answers definitively either way", () => {
    expect(typeof availability.available).toBe("boolean");
    if (!availability.available) {
      expect(availability.reason).toBeTruthy();
    }
  });
});

describe("shouldStage — what enters the sandbox", () => {
  it("excludes host dependency trees, VCS, evidence, caches and secret env files", () => {
    expect(shouldStage("src/index.ts")).toBe(true);
    expect(shouldStage("package.json")).toBe(true);
    expect(shouldStage(".env.example")).toBe(true);
    expect(shouldStage("node_modules/left-pad/index.js")).toBe(false);
    expect(shouldStage("apps/web/node_modules/x.js")).toBe(false);
    expect(shouldStage(".git/HEAD")).toBe(false);
    expect(shouldStage(".mantyl/passport.json")).toBe(false);
    expect(shouldStage("apps/web/.next/cache/x")).toBe(false);
    expect(shouldStage(".env")).toBe(false);
    expect(shouldStage(".env.local")).toBe(false);
    // Windows separators normalise too.
    expect(shouldStage("apps\\web\\node_modules\\x.js")).toBe(false);
  });
});

describe.runIf(availability.available)("DockerRunner sandbox (integration)", () => {
  it("runs a command against a copied-in workspace", async () => {
    const dir = await workspace();
    await writeFile(join(dir, "hello.txt"), "from-the-host\n");
    const result = await runner.run(dir, {
      command: "cat hello.txt && echo sandbox-ok",
      timeoutMs: 120_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("from-the-host");
    expect(result.stdout).toContain("sandbox-ok");
    expect(result.envFingerprint).toContain("docker:");
  }, 180_000);

  it("blocks the network by default — offline is provable", async () => {
    const dir = await workspace();
    const result = await runner.run(dir, {
      // getent/nslookup vary by image; node is guaranteed in the node image.
      command:
        "node -e \"fetch('https://registry.npmjs.org', {signal: AbortSignal.timeout(5000)}).then(()=>{console.log('NETWORK-UP');process.exit(0)}).catch(()=>{console.log('NETWORK-BLOCKED');process.exit(3)})\"",
      timeoutMs: 60_000,
    });
    expect(result.stdout).toContain("NETWORK-BLOCKED");
    expect(result.exitCode).toBe(3);
  }, 180_000);

  it("enforces timeouts by killing the container", async () => {
    const dir = await workspace();
    const result = await runner.run(dir, {
      command: "sleep 60",
      timeoutMs: 3_000,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  }, 180_000);

  it("session: state persists across execs, network disconnect is provable", async () => {
    const dir = await workspace();
    await writeFile(join(dir, ".env"), "SECRET=never-in-the-sandbox\n");
    const session = await runner.session(dir, { network: true });
    try {
      // Secret env files never entered the copy.
      const ls = await session.exec({ command: "ls -a", timeoutMs: 60_000 });
      expect(ls.stdout).not.toContain(".env");

      const write = await session.exec({
        command: "echo persisted > state.txt",
        timeoutMs: 60_000,
      });
      expect(write.exitCode).toBe(0);
      // Same container: the file written by the previous exec is still there.
      const read = await session.exec({ command: "cat state.txt", timeoutMs: 60_000 });
      expect(read.stdout).toContain("persisted");

      await session.disconnectNetwork();
      const net = await session.exec({
        command:
          "node -e \"fetch('https://registry.npmjs.org', {signal: AbortSignal.timeout(5000)}).then(()=>{console.log('NETWORK-UP');process.exit(0)}).catch(()=>{console.log('NETWORK-BLOCKED');process.exit(3)})\"",
        timeoutMs: 60_000,
      });
      expect(net.stdout).toContain("NETWORK-BLOCKED");
    } finally {
      await session.close();
    }
  }, 300_000);
});
