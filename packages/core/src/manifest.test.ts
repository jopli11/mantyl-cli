import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFileManifest, diffManifests } from "./manifest.js";

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe("buildFileManifest", () => {
  it("skips untracked files — local state never fingerprints the delivery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mantyl-manifest-"));
    dirs.push(dir);
    await writeFile(join(dir, "tracked.ts"), "export {};\n");
    await writeFile(join(dir, "local-settings.json"), "{}\n");

    const manifest = await buildFileManifest(dir, [
      { path: "tracked.ts", size: 11, tracked: true },
      { path: "local-settings.json", size: 3, tracked: false },
    ]);
    expect(Object.keys(manifest.files)).toEqual(["tracked.ts"]);

    // Unknown tracked state (no git) keeps the file — both sides see the same.
    const withoutGit = await buildFileManifest(dir, [
      { path: "tracked.ts", size: 11 },
      { path: "local-settings.json", size: 3 },
    ]);
    expect(Object.keys(withoutGit.files)).toEqual(["local-settings.json", "tracked.ts"]);
  });

  it("diffManifests names added, removed and modified paths", () => {
    const diff = diffManifests(
      { "a.ts": "1", "b.ts": "2", "c.ts": "3" },
      { "a.ts": "1", "b.ts": "CHANGED", "d.ts": "4" }
    );
    expect(diff).toEqual({ added: ["d.ts"], removed: ["c.ts"], modified: ["b.ts"] });
  });
});
