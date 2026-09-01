import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectGit } from "./index.js";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantyl-git-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("collectGit", () => {
  it("reports non-repos honestly", async () => {
    const obs = await collectGit(await tempDir());
    expect(obs.isRepo).toBe(false);
    expect(obs.head).toBeNull();
    expect(obs.commits).toEqual([]);
  });

  it("observes commits, head and dirty state", async () => {
    const dir = await tempDir();
    git(dir, "init", "-b", "main");
    git(dir, "config", "user.email", "fixture@example.com");
    git(dir, "config", "user.name", "Fixture Author");
    await writeFile(join(dir, "a.txt"), "one\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "first commit");
    await writeFile(join(dir, "b.txt"), "two\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "second commit");

    const clean = await collectGit(dir);
    expect(clean.isRepo).toBe(true);
    expect(clean.head?.dirty).toBe(false);
    expect(clean.commitCount).toBe(2);
    expect(clean.commits).toHaveLength(2);
    expect(clean.commits[0]?.subject).toBe("second commit");
    expect(clean.commits[0]?.author).toBe("Fixture Author");
    expect(clean.commits[0]?.ref).toEqual({ kind: "commit", sha: clean.commits[0]?.sha });
    expect(clean.lastCommitDate).toBeTruthy();

    await writeFile(join(dir, "b.txt"), "changed\n");
    const dirty = await collectGit(dir);
    expect(dirty.head?.dirty).toBe(true);
    // 30s: six git spawns are fast on a host but exceed vitest's 5s default
    // inside the containerized verification sandbox.
  }, 30_000);
});
