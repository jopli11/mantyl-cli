import { describe, expect, it } from "vitest";
import type { PythonObservation, RepositoryObservation } from "@mantyl/collectors-repository";
import { detectCapabilities } from "./capabilities.js";

function repoWithPython(python: PythonObservation | null): RepositoryObservation {
  return {
    files: [],
    fileCount: 0,
    truncated: false,
    packageJson: null,
    lockfile: null,
    hasTsconfig: false,
    readmePath: null,
    python,
    envReferences: [],
    envDocumented: null,
    todos: [],
    ciConfigPaths: [],
    migrationPaths: [],
  };
}

const PY_BASE: PythonObservation = {
  pyFileCount: 2,
  testFileCount: 1,
  hasPyproject: false,
  pyprojectText: null,
  hasSetupPy: false,
  requirementsFiles: [],
  requirementsText: "",
  lockfile: null,
  ref: { kind: "file", path: "app.py" },
};

describe("python capability detection", () => {
  it("is null when the repo has no Python at all", () => {
    expect(detectCapabilities(repoWithPython(null)).python).toBeNull();
  });

  it("lockfiles pick the manager ahead of requirements", () => {
    const caps = detectCapabilities(
      repoWithPython({ ...PY_BASE, lockfile: "uv", requirementsFiles: ["requirements.txt"] })
    );
    expect(caps.python?.manager).toBe("uv");
  });

  it("an installable pyproject without lockfile or requirements is pip-project", () => {
    const caps = detectCapabilities(
      repoWithPython({
        ...PY_BASE,
        hasPyproject: true,
        pyprojectText: '[project]\nname = "x"\ndependencies = ["pytest>=8"]\n',
      })
    );
    expect(caps.python?.manager).toBe("pip-project");
    expect(caps.python?.pytestDeclared).toBe(true);
  });

  it("a [tool.ruff] config section alone does not count as a declaration", () => {
    const caps = detectCapabilities(
      repoWithPython({
        ...PY_BASE,
        hasPyproject: true,
        pyprojectText: '[project]\nname = "x"\n\n[tool.ruff]\nline-length = 100\n',
      })
    );
    expect(caps.python?.ruffDeclared).toBe(false);
  });

  it("detects declarations in requirements lines, quoted PEP 508 and poetry tables", () => {
    const fromRequirements = detectCapabilities(
      repoWithPython({
        ...PY_BASE,
        requirementsFiles: ["requirements.txt"],
        requirementsText: "pytest\nruff>=0.4\n",
      })
    );
    expect(fromRequirements.python?.pytestDeclared).toBe(true);
    expect(fromRequirements.python?.ruffDeclared).toBe(true);
    expect(fromRequirements.python?.mypyDeclared).toBe(false);

    const fromGroups = detectCapabilities(
      repoWithPython({
        ...PY_BASE,
        hasPyproject: true,
        pyprojectText: '[project]\nname = "x"\n\n[dependency-groups]\ndev = ["mypy>=1.0"]\n',
      })
    );
    expect(fromGroups.python?.mypyDeclared).toBe(true);

    const fromPoetry = detectCapabilities(
      repoWithPython({
        ...PY_BASE,
        hasPyproject: true,
        pyprojectText:
          '[tool.poetry]\nname = "x"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8.0"\n',
        lockfile: "poetry",
      })
    );
    expect(fromPoetry.python?.pytestDeclared).toBe(true);
    expect(fromPoetry.python?.manager).toBe("poetry");
  });
});
