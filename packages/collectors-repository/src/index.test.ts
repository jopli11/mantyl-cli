import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectRepository, globToRegExp } from "./index.js";

describe("globToRegExp", () => {
  it("matches segments, depths and single chars correctly", () => {
    expect(globToRegExp("examples/**").test("examples/a/b.ts")).toBe(true);
    expect(globToRegExp("examples/**").test("examples2/a.ts")).toBe(false);
    expect(globToRegExp("**/fixtures/**").test("packages/x/fixtures/a.jsonl")).toBe(true);
    expect(globToRegExp("**/fixtures/**").test("fixtures/a.jsonl")).toBe(true);
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/README.md")).toBe(false);
    expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/?.ts").test("src/ab.ts")).toBe(false);
  });
});

/** The seeded fixture project — quirks here must be DISCOVERED, not assumed. */
const FIXTURE = fileURLToPath(
  new URL("../../../examples/sample-project", import.meta.url)
);

describe("collectRepository on the seeded fixture", () => {
  it("discovers the undocumented API_TOKEN env reference", async () => {
    const obs = await collectRepository(FIXTURE);
    const names = obs.envReferences.map((e) => e.name);
    expect(names).toContain("API_TOKEN");
    expect(names).toContain("PORT");

    const apiToken = obs.envReferences.find((e) => e.name === "API_TOKEN")!;
    expect(apiToken.refs[0]).toMatchObject({ kind: "file", path: "src/server.ts" });

    // documented set lacks API_TOKEN — the derived contradiction M3 will surface
    expect(obs.envDocumented?.names).toEqual(["PORT"]);
  });

  it("harvests the seeded persistence TODO with file/line evidence", async () => {
    const obs = await collectRepository(FIXTURE);
    const todo = obs.todos.find((t) => t.text.includes("persistence"));
    expect(todo).toBeDefined();
    expect(todo?.ref).toMatchObject({ kind: "file", path: "src/store.ts" });
  });

  it("observes package scripts, readme and project shape", async () => {
    const obs = await collectRepository(FIXTURE);
    expect(obs.packageJson?.name).toBe("notes-api");
    expect(Object.keys(obs.packageJson?.scripts ?? {})).toEqual(
      expect.arrayContaining(["build", "test"])
    );
    expect(obs.hasTsconfig).toBe(true);
    expect(obs.readmePath).toBe("README.md");
    expect(obs.truncated).toBe(false);
    expect(obs.files.length).toBeGreaterThan(3);
  });

  it("exclude globs remove files from every downstream surface", async () => {
    const obs = await collectRepository(FIXTURE, { exclude: ["src/**", "tests/**"] });
    expect(obs.files.some((f) => f.path.startsWith("src/"))).toBe(false);
    expect(obs.files.some((f) => f.path.startsWith("tests/"))).toBe(false);
    // No env refs or TODOs survive when their source files are excluded.
    expect(obs.envReferences).toEqual([]);
    expect(obs.todos).toEqual([]);
    // Non-excluded files remain.
    expect(obs.files.some((f) => f.path === "package.json")).toBe(true);
  });

  it("detects bracket-notation env access, not just dot form", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "mantyl-envbracket-"));
    try {
      await writeFile(
        join(dir, "index.ts"),
        'const a = process.env.DOT_VAR;\nconst b = process.env["BRACKET_VAR"];\nconst c = process.env[\'SINGLE_VAR\'];\n'
      );
      const obs = await collectRepository(dir);
      const names = obs.envReferences.map((e) => e.name).sort();
      expect(names).toEqual(["BRACKET_VAR", "DOT_VAR", "SINGLE_VAR"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never lists secret env files; documented examples stay", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "mantyl-envwalk-"));
    try {
      await writeFile(join(dir, ".env"), "SECRET=x\n");
      await writeFile(join(dir, ".env.local"), "SECRET=y\n");
      await writeFile(join(dir, ".env.example"), "SECRET=\n");
      await writeFile(join(dir, "index.js"), "console.log(1)\n");

      const obs = await collectRepository(dir);
      const paths = obs.files.map((f) => f.path);
      expect(paths).not.toContain(".env");
      expect(paths).not.toContain(".env.local");
      expect(paths).toContain(".env.example");
      expect(paths).toContain("index.js");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic across runs", async () => {
    const a = JSON.stringify(await collectRepository(FIXTURE));
    const b = JSON.stringify(await collectRepository(FIXTURE));
    expect(a).toBe(b);
  });
});
