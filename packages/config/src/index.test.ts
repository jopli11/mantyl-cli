import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_FILENAME,
  defaultConfig,
  InvalidConfigError,
  loadConfig,
  resolveConfig,
} from "./index.js";

let dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mantyl-config-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe("@mantyl/config", () => {
  it("defaults are safe: no LLM, no network, redaction on", () => {
    const config = defaultConfig();
    expect(config.llm.provider).toBe("none");
    expect(config.verify.network).toBe(false);
    expect(config.redaction.enabled).toBe(true);
  });

  it("falls back to defaults when no config file exists", async () => {
    const resolved = await loadConfig(await tempDir());
    expect(resolved.source).toBe("defaults");
    expect(resolved.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("loads and validates a config file", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, CONFIG_FILENAME),
      JSON.stringify({ project: { name: "notes-api" }, llm: { provider: "anthropic" } })
    );
    const resolved = await loadConfig(dir);
    expect(resolved.source).toBe("file");
    expect(resolved.config.project.name).toBe("notes-api");
    expect(resolved.config.llm.provider).toBe("anthropic");
  });

  it("rejects unknown keys and malformed JSON loudly", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, CONFIG_FILENAME), JSON.stringify({ nonsense: true }));
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(InvalidConfigError);

    await writeFile(join(dir, CONFIG_FILENAME), "{not json");
    await expect(loadConfig(dir)).rejects.toBeInstanceOf(InvalidConfigError);
  });

  it("digest is stable across key order", () => {
    const a = resolveConfig({ project: { name: "x" }, llm: { provider: "none" } }, "file");
    const b = resolveConfig({ llm: { provider: "none" }, project: { name: "x" } }, "file");
    expect(a.digest).toBe(b.digest);
  });
});
