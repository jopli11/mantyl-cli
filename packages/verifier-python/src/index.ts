/**
 * @mantyl/verifier-python — Python verifier plugin (Phase 3, spec §4).
 * Plans install/test/lint/typecheck checks for Python projects, mirroring
 * @mantyl/verifier-node exactly: a pure planner over detected capabilities,
 * every check recording WHY it was selected or skipped, executed through the
 * same generic executeCheck. The plan itself is evidence.
 */

import type { PlannedCheck } from "@mantyl/schema";

/**
 * The sandbox image Python plans run in. The full bookworm variant ships
 * git, which collectors and git-touching tests require (the same reason the
 * Node runner uses node:22-bookworm over slim).
 */
export const PYTHON_IMAGE = "python:3.12-bookworm";

/**
 * The virtualenv the pip-based install paths create INSIDE the container.
 * It lives outside the copied workspace on purpose: nothing the sandbox
 * installs may appear in the file manifest, and each `docker exec` is a
 * fresh shell, so activation state cannot persist — every command names the
 * venv binaries explicitly instead.
 */
export const PIP_VENV = "/opt/mantyl-venv";

export interface PythonCapabilities {
  /**
   * How dependencies install: a lockfile wins (uv, poetry, pipenv), then
   * requirements files, then an installable pyproject/setup.py. Null means
   * Python source exists but nothing declares its dependencies.
   */
  manager: "uv" | "poetry" | "pipenv" | "pip-requirements" | "pip-project" | null;
  /** Root-level requirements*.txt files, sorted (pip-requirements install). */
  requirementsFiles: string[];
  hasTests: boolean;
  pytestDeclared: boolean;
  ruffDeclared: boolean;
  mypyDeclared: boolean;
}

function installCommand(caps: PythonCapabilities): string {
  switch (caps.manager) {
    case "uv":
      return "pip install uv && uv sync --frozen";
    case "poetry":
      return "pip install poetry && poetry install --no-interaction --no-ansi";
    case "pipenv":
      return "pip install pipenv && pipenv sync --dev";
    case "pip-requirements": {
      const reqs = caps.requirementsFiles.map((f) => `-r ${f}`).join(" ");
      return `python -m venv ${PIP_VENV} && ${PIP_VENV}/bin/pip install ${reqs}`;
    }
    case "pip-project":
      return `python -m venv ${PIP_VENV} && ${PIP_VENV}/bin/pip install .`;
    default:
      return "python --version";
  }
}

function installReason(caps: PythonCapabilities): string {
  switch (caps.manager) {
    case "uv":
      return "dependencies locked with uv (uv.lock)";
    case "poetry":
      return "dependencies locked with poetry (poetry.lock)";
    case "pipenv":
      return "dependencies locked with pipenv (Pipfile.lock)";
    case "pip-requirements":
      return `requirements files present (${caps.requirementsFiles.join(", ")})`;
    case "pip-project":
      return "installable pyproject.toml or setup.py, no lockfile detected";
    default:
      return "Python source present but no dependency manifest found";
  }
}

/** Prefix a tool invocation with the manager's environment entry point. */
function toolCommand(manager: PythonCapabilities["manager"], module: string): string {
  switch (manager) {
    case "uv":
      return `uv run --no-sync python -m ${module}`;
    case "poetry":
      return `poetry run python -m ${module}`;
    case "pipenv":
      return `pipenv run python -m ${module}`;
    default:
      return `${PIP_VENV}/bin/python -m ${module}`;
  }
}

/**
 * Plan the Python check list. Check ids carry the `check-py-` prefix, which
 * is the stack marker verify and receive use to run these in the Python
 * sandbox image rather than the Node one. Tool checks select on the tool
 * being DECLARED as a dependency: running a tool the project never asked
 * for would verify our opinion, not their setup, and a declared tool the
 * install path fails to provide fails honestly with the log saying why.
 */
export function planPythonChecks(caps: PythonCapabilities): PlannedCheck[] {
  const installable = caps.manager !== null;
  const plan: PlannedCheck[] = [
    {
      id: "check-py-install",
      kind: "install",
      command: installCommand(caps),
      reason: installReason(caps),
      selected: installable,
      ...(installable ? {} : { skipReason: "no dependency manifest to install from" }),
    },
  ];

  const test = installable && caps.hasTests && caps.pytestDeclared;
  plan.push({
    id: "check-py-test",
    kind: "test",
    command: toolCommand(caps.manager, "pytest"),
    reason: test
      ? "test files present and pytest is a declared dependency"
      : !installable
        ? "nothing installs pytest"
        : !caps.hasTests
          ? "no test files detected"
          : "test files present but pytest is not a declared dependency",
    selected: test,
    ...(test ? {} : { skipReason: "pytest not runnable from the project's own declarations" }),
  });

  const lint = installable && caps.ruffDeclared;
  plan.push({
    id: "check-py-lint",
    kind: "lint",
    command: toolCommand(caps.manager, "ruff check ."),
    reason: lint ? "ruff is a declared dependency" : "ruff is not a declared dependency",
    selected: lint,
    ...(lint ? {} : { skipReason: "ruff not declared" }),
  });

  const typecheck = installable && caps.mypyDeclared;
  plan.push({
    id: "check-py-typecheck",
    kind: "typecheck",
    command: toolCommand(caps.manager, "mypy ."),
    reason: typecheck ? "mypy is a declared dependency" : "mypy is not a declared dependency",
    selected: typecheck,
    ...(typecheck ? {} : { skipReason: "mypy not declared" }),
  });

  return plan;
}

/** True when a check id belongs to the Python stack (verify/receive routing). */
export function isPythonCheck(checkId: string): boolean {
  return checkId.startsWith("check-py-");
}
