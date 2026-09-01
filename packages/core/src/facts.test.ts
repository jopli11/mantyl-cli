import { describe, expect, it } from "vitest";
import type { RepositoryObservation } from "@mantyl/collectors-repository";
import type { GitObservation } from "@mantyl/collectors-git";
import { extractFacts } from "./facts.js";
import { detectCapabilities } from "./capabilities.js";

const NO_GIT: GitObservation = {
  isRepo: false,
  head: null,
  commits: [],
  commitCount: null,
  firstCommitDate: null,
  lastCommitDate: null,
};

function repoWith(envReferences: RepositoryObservation["envReferences"]): RepositoryObservation {
  return {
    files: [],
    truncated: false,
    packageJson: null,
    lockfile: null,
    hasTsconfig: false,
    readmePath: null,
    envReferences,
    envDocumented: null,
    todos: [],
    ciConfigPaths: [],
    migrationPaths: [],
  };
}

describe("platform-provided env vars", () => {
  it("never demands documentation for what the platform supplies", () => {
    const repo = repoWith([
      { name: "NODE_ENV", refs: [{ kind: "file", path: "src/lib/prisma.ts", lines: [7, 7] }] },
      { name: "VERCEL_GIT_COMMIT_SHA", refs: [{ kind: "file", path: "src/app/layout.tsx", lines: [89, 89] }] },
      { name: "DATABASE_URL", refs: [{ kind: "file", path: "src/db.ts", lines: [3, 3] }] },
    ]);
    const facts = extractFacts(repo, NO_GIT, detectCapabilities(repo));
    const byName = Object.fromEntries(
      facts.filter((f) => f.kind === "env").map((f) => [f.data?.name, f])
    );
    expect(byName["NODE_ENV"]?.statement).toContain("provided by the runtime or platform");
    expect(byName["NODE_ENV"]?.data?.documented).toBe(true);
    expect(byName["VERCEL_GIT_COMMIT_SHA"]?.data?.documented).toBe(true);
    // Real application secrets still surface as undocumented.
    expect(byName["DATABASE_URL"]?.data?.documented).toBe(false);
  });
});

describe("env facts vs test fixtures", () => {
  it("drops env vars referenced only by test files; keeps runtime refs", () => {
    const repo = repoWith([
      {
        name: "TEST_ONLY_VAR",
        refs: [
          { kind: "file", path: "src/index.test.ts", lines: [3, 3] },
          { kind: "file", path: "tests/setup.ts", lines: [1, 1] },
        ],
      },
      {
        name: "RUNTIME_VAR",
        refs: [
          { kind: "file", path: "src/server.spec.ts", lines: [9, 9] },
          { kind: "file", path: "src/server.ts", lines: [12, 12] },
        ],
      },
    ]);

    const facts = extractFacts(repo, NO_GIT, detectCapabilities(repo));
    const envFacts = facts.filter((f) => f.kind === "env");

    expect(envFacts.map((f) => f.data?.name)).toEqual(["RUNTIME_VAR"]);
    // Test-file refs are stripped even from the surviving fact.
    expect(envFacts[0]?.refs).toEqual([{ kind: "file", path: "src/server.ts", lines: [12, 12] }]);
  });
});
