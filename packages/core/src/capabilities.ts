/**
 * Deterministic capability detection (spec phase 3).
 * Pure derivation from repository observations — no filesystem access,
 * no interpretation. The verification planner (M4) consumes this.
 */

import type { RepositoryObservation } from "@mantyl/collectors-repository";

export interface Capabilities {
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  scripts: {
    build: boolean;
    test: boolean;
    lint: boolean;
    typecheck: boolean;
  };
  usesTypeScript: boolean;
  hasDocker: boolean;
  hasCI: boolean;
  hasMigrations: boolean;
}

export function detectCapabilities(repo: RepositoryObservation): Capabilities {
  const scripts = repo.packageJson?.scripts ?? {};
  const paths = repo.files.map((f) => f.path);
  return {
    packageManager: repo.lockfile,
    scripts: {
      build: "build" in scripts,
      test: "test" in scripts,
      lint: "lint" in scripts,
      typecheck: "typecheck" in scripts,
    },
    usesTypeScript:
      repo.hasTsconfig || repo.files.some((f) => /\.(ts|tsx|mts|cts)$/.test(f.path)),
    hasDocker: paths.some((p) => p === "Dockerfile" || /^docker-compose\.ya?ml$/.test(p)),
    hasCI: repo.ciConfigPaths.length > 0,
    hasMigrations: repo.migrationPaths.length > 0,
  };
}
