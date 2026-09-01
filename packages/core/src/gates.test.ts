/**
 * The two release gates from the implementation plan, built for real:
 *
 * 1. Determinism gate — the full pipeline run twice against the seeded
 *    fixture produces byte-identical passports, digests included. Any
 *    accidental timestamp, map-ordering or randomness regression fails
 *    here before it ships.
 * 2. Secret-leak gate — the planted credential in the fixture transcript
 *    reaches NO artefact the pipeline writes. Renderers are pure
 *    consumers of passport.json (proven in their own tests), so a clean
 *    artefact directory means clean reports too.
 */

import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { generateProject } from "./generate.js";

const FIXTURE_PROJECT = fileURLToPath(
  new URL("../../../examples/sample-project", import.meta.url)
);
const FIXTURE_SESSIONS = fileURLToPath(
  new URL("../../adapter-claude-code/fixtures", import.meta.url)
);

/** The credential planted in the fixture transcript, and its fragments. */
const PLANTED_SECRET = ["sk-ant-api03-", "verysecretfixturevalue0001"].join("");
const PLANTED_FRAGMENT = "verysecretfixturevalue";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantyl-gates-"));
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

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) {
      out.push(...(await listFilesRecursive(path)));
    } else {
      out.push(path);
    }
  }
  return out;
}

describe("release gates", () => {
  it("determinism: two full runs produce byte-identical passports", async () => {
    const [dirA, dirB] = [await tempDir(), await tempDir()];
    const runA = await generateProject(FIXTURE_PROJECT, { ...OPTIONS, artifactsDir: dirA });
    const runB = await generateProject(FIXTURE_PROJECT, { ...OPTIONS, artifactsDir: dirB });

    expect(runA.passport.integrity.passportDigest).toBe(runB.passport.integrity.passportDigest);

    const filesA = (await listFilesRecursive(dirA)).map((p) => p.slice(dirA.length)).sort();
    const filesB = (await listFilesRecursive(dirB)).map((p) => p.slice(dirB.length)).sort();
    expect(filesA).toEqual(filesB);

    for (const relative of filesA) {
      const a = await readFile(join(dirA, relative));
      const b = await readFile(join(dirB, relative));
      expect(a.equals(b), `artefact differs across runs: ${relative}`).toBe(true);
    }
  }, 30_000);

  it("secret-leak: the planted credential reaches no artefact", async () => {
    const dir = await tempDir();
    await generateProject(FIXTURE_PROJECT, { ...OPTIONS, artifactsDir: dir });

    const files = await listFilesRecursive(dir);
    expect(files.length).toBeGreaterThan(5);
    for (const path of files) {
      const content = await readFile(path, "utf8");
      expect(content, path).not.toContain(PLANTED_SECRET);
      expect(content, path).not.toContain(PLANTED_FRAGMENT);
    }
  }, 30_000);
});
