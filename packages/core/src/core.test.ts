import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunContext } from "./run-context.js";
import { initProject } from "./init.js";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantyl-core-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe("initProject", () => {
  it("creates a valid default config, then reports exists", async () => {
    const dir = await tempDir();
    const first = await initProject(dir);
    expect(first.outcome).toBe("created");
    const written = JSON.parse(await readFile(first.path, "utf8"));
    expect(written.llm.provider).toBe("none");

    const second = await initProject(dir);
    expect(second.outcome).toBe("exists");

    const forced = await initProject(dir, { force: true });
    expect(forced.outcome).toBe("created");
  });
});

describe("createRunContext", () => {
  it("captures config digest and handles non-git directories honestly", async () => {
    const dir = await tempDir();
    const now = new Date("2026-07-20T14:00:00.000Z");
    const ctx = await createRunContext(dir, { toolVersion: "0.0.0", now: () => now });
    expect(ctx.commit).toBeNull();
    expect(ctx.dirty).toBe(false);
    expect(ctx.config.source).toBe("defaults");
    expect(ctx.config.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.startedAt).toBe(now);
  });

  it("rejects a project root that is not a directory", async () => {
    await expect(
      createRunContext(join(await tempDir(), "missing"), { toolVersion: "0.0.0" })
    ).rejects.toThrow(/not a directory/);
  });
});
