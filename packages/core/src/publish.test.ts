import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PassportInvalidError, preparePublish } from "./publish.js";

const GOLDEN = fileURLToPath(
  new URL("../../../examples/sample-passport/passport.json", import.meta.url)
);

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function projectWithPassport(mutate?: (doc: Record<string, unknown>) => void): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantyl-publish-"));
  dirs.push(dir);
  await mkdir(join(dir, ".mantyl"), { recursive: true });
  const doc = JSON.parse(await readFile(GOLDEN, "utf8")) as Record<string, unknown>;
  mutate?.(doc);
  await writeFile(join(dir, ".mantyl", "passport.json"), JSON.stringify(doc), "utf8");
  return dir;
}

describe("preparePublish — local pre-flight", () => {
  it("prepares a genuine passport with canonical body and digest", async () => {
    const dir = await projectWithPassport();
    const prepared = await preparePublish(dir);
    expect(prepared.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.passport.project.name).toBeTruthy();
    // Canonical body round-trips to the same document.
    expect(JSON.parse(prepared.body)).toEqual(JSON.parse(await readFile(join(dir, ".mantyl", "passport.json"), "utf8")));
  });

  it("refuses a passport modified after generation", async () => {
    const dir = await projectWithPassport((doc) => {
      (doc.project as { name: string }).name = "renamed-after-signing";
    });
    await expect(preparePublish(dir)).rejects.toThrow(PassportInvalidError);
    await expect(preparePublish(dir)).rejects.toThrow(/digest self-check FAILED/);
  });

  it("refuses when no passport exists, pointing at generate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mantyl-publish-empty-"));
    dirs.push(dir);
    await expect(preparePublish(dir)).rejects.toThrow(/run `mantyl generate` first/);
  });
});
