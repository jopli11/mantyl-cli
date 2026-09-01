/**
 * Fact extraction (spec §4) — observable, repository-confirmed statements.
 * Facts are strictly separated from claims: a fact is what the repository
 * SHOWS; a claim is what someone SAID. The reconciler (M5) joins them.
 */

import type { SourceRef } from "@mantyl/schema";
import type { GitObservation } from "@mantyl/collectors-git";
import type { RepositoryObservation } from "@mantyl/collectors-repository";
import type { Capabilities } from "./capabilities.js";

export interface Fact {
  /** Stable, deterministic id — same repo state ⇒ same id. */
  id: string;
  kind: string;
  statement: string;
  refs: SourceRef[];
  data?: Record<string, unknown>;
}

const TEST_FILE_PATH = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Variables the runtime or hosting platform provides — demanding they be
 * documented in .env.example is noise, not a finding (first-user feedback:
 * NODE_ENV and VERCEL_GIT_COMMIT_SHA flagged as undocumented risks).
 */
const PLATFORM_ENV = /^(?:NODE_ENV|CI|TZ|NEXT_RUNTIME|GITHUB_ACTIONS|RUNNER_[A-Z_]+|VERCEL(?:_[A-Z_]+)?|NEXT_PUBLIC_VERCEL_[A-Z_]+)$/;

export function extractFacts(
  repo: RepositoryObservation,
  git: GitObservation,
  caps: Capabilities
): Fact[] {
  const facts: Fact[] = [];
  const pkgRef = repo.packageJson?.ref;

  if (repo.packageJson?.name && pkgRef) {
    facts.push({
      id: "fact:package:name",
      kind: "package",
      statement: `Package name is "${repo.packageJson.name}"`,
      refs: [pkgRef],
      data: { name: repo.packageJson.name },
    });
  }

  if (caps.packageManager && pkgRef) {
    facts.push({
      id: "fact:package:manager",
      kind: "package",
      statement: `Dependencies are locked with ${caps.packageManager}`,
      refs: [pkgRef],
      data: { packageManager: caps.packageManager },
    });
  }

  for (const [name, present] of Object.entries(caps.scripts)) {
    if (present && pkgRef) {
      facts.push({
        id: `fact:script:${name}`,
        kind: "script",
        statement: `package.json defines a "${name}" script`,
        refs: [pkgRef],
        data: { script: name, command: repo.packageJson?.scripts[name] },
      });
    }
  }

  if (caps.usesTypeScript) {
    facts.push({
      id: "fact:stack:typescript",
      kind: "stack",
      statement: "The project uses TypeScript",
      refs: repo.hasTsconfig ? [{ kind: "file", path: "tsconfig.json" }] : pkgRef ? [pkgRef] : [],
    });
  }

  const documented = new Set(repo.envDocumented?.names ?? []);
  for (const env of repo.envReferences) {
    // Env vars referenced ONLY by test files are test fixtures, not setup
    // requirements for the delivered software — no fact, no phantom risk.
    const runtimeRefs = env.refs.filter(
      (ref) => !(ref.kind === "file" && TEST_FILE_PATH.test(ref.path))
    );
    if (runtimeRefs.length === 0) continue;
    const isPlatform = PLATFORM_ENV.test(env.name);
    const isDocumented = documented.has(env.name) || isPlatform;
    facts.push({
      id: `fact:env:${env.name}`,
      kind: "env",
      statement: isPlatform
        ? `Environment variable ${env.name} is provided by the runtime or platform`
        : isDocumented
          ? `Environment variable ${env.name} is referenced and documented`
          : `Environment variable ${env.name} is referenced but NOT documented`,
      refs: [
        ...runtimeRefs,
        ...(isDocumented && repo.envDocumented
          ? [{ kind: "file", path: repo.envDocumented.path } satisfies SourceRef]
          : []),
      ],
      data: { name: env.name, documented: isDocumented },
    });
  }

  repo.todos.forEach((todo, index) => {
    facts.push({
      id: `fact:todo:${index}`,
      kind: "todo",
      statement: todo.text,
      refs: [todo.ref],
    });
  });

  if (caps.hasCI) {
    facts.push({
      id: "fact:ci:present",
      kind: "ci",
      statement: "CI configuration is present",
      refs: repo.ciConfigPaths.map((path) => ({ kind: "file", path }) satisfies SourceRef),
    });
  }

  if (caps.hasMigrations) {
    facts.push({
      id: "fact:migrations:present",
      kind: "migrations",
      statement: "Database migrations are present",
      refs: repo.migrationPaths.slice(0, 10).map(
        (path) => ({ kind: "file", path }) satisfies SourceRef
      ),
    });
  }

  if (git.isRepo && git.head) {
    facts.push({
      id: "fact:git:head",
      kind: "git",
      statement: git.head.dirty
        ? `HEAD is ${git.head.sha.slice(0, 7)} with uncommitted changes`
        : `HEAD is ${git.head.sha.slice(0, 7)} with a clean working tree`,
      refs: [{ kind: "commit", sha: git.head.sha }],
      data: { sha: git.head.sha, dirty: git.head.dirty, commitCount: git.commitCount },
    });
  }

  return facts.sort((a, b) => (a.id < b.id ? -1 : 1));
}
