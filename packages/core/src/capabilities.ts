/**
 * Deterministic capability detection (spec phase 3).
 * Pure derivation from repository observations — no filesystem access,
 * no interpretation. The verification planner (M4) consumes this.
 */

import type { PythonObservation, RepositoryObservation } from "@mantyl/collectors-repository";

/** Structurally satisfies @mantyl/verifier-python's PythonCapabilities. */
export interface PythonStackCapabilities {
  manager: "uv" | "poetry" | "pipenv" | "pip-requirements" | "pip-project" | null;
  requirementsFiles: string[];
  hasTests: boolean;
  pytestDeclared: boolean;
  ruffDeclared: boolean;
  mypyDeclared: boolean;
}

export interface Capabilities {
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  scripts: {
    build: boolean;
    test: boolean;
    lint: boolean;
    typecheck: boolean;
  };
  usesTypeScript: boolean;
  /** Python verification surface (null when the repo has no Python). */
  python: PythonStackCapabilities | null;
  hasDocker: boolean;
  hasCI: boolean;
  hasMigrations: boolean;
}

/**
 * A tool counts as DECLARED when it appears as a dependency entry in the
 * Python manifests: a quoted PEP 508 string in pyproject.toml, a poetry
 * table key, or a requirements.txt line. A `[tool.x]` config section alone
 * is not a declaration — configuring a tool nothing installs is exactly the
 * kind of contradiction the plan should surface, not paper over.
 */
function declaresTool(py: PythonObservation, tool: string): boolean {
  const quoted = new RegExp(`["']${tool}(?:\\[[^\\]]*\\])?\\s*(?:[><=~!^,;@ ]|["'])`);
  const lineEntry = new RegExp(
    `(?:^|\\r?\\n)[ \\t]*${tool}[ \\t]*(?:[=><~!\\[;#]|\\r?\\n|$)`
  );
  for (const text of [py.pyprojectText ?? "", py.requirementsText]) {
    if (quoted.test(text) || lineEntry.test(text)) return true;
  }
  return false;
}

function detectPythonCapabilities(py: PythonObservation | null): PythonStackCapabilities | null {
  if (!py) return null;
  const installableProject =
    (py.pyprojectText !== null && /(?:^|\r?\n)\[project\]/.test(py.pyprojectText)) ||
    py.hasSetupPy;
  const manager: PythonStackCapabilities["manager"] =
    py.lockfile ??
    (py.requirementsFiles.length > 0
      ? "pip-requirements"
      : installableProject
        ? "pip-project"
        : null);
  return {
    manager,
    requirementsFiles: py.requirementsFiles,
    hasTests: py.testFileCount > 0,
    pytestDeclared: declaresTool(py, "pytest"),
    ruffDeclared: declaresTool(py, "ruff"),
    mypyDeclared: declaresTool(py, "mypy"),
  };
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
    python: detectPythonCapabilities(repo.python ?? null),
    hasDocker: paths.some((p) => p === "Dockerfile" || /^docker-compose\.ya?ml$/.test(p)),
    hasCI: repo.ciConfigPaths.length > 0,
    hasMigrations: repo.migrationPaths.length > 0,
  };
}
