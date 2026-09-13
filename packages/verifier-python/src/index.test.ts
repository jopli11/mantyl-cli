import { describe, expect, it } from "vitest";
import {
  isPythonCheck,
  PIP_VENV,
  planPythonChecks,
  type PythonCapabilities,
} from "./index.js";

const BASE: PythonCapabilities = {
  manager: null,
  requirementsFiles: [],
  hasTests: false,
  pytestDeclared: false,
  ruffDeclared: false,
  mypyDeclared: false,
};

describe("planPythonChecks", () => {
  it("always emits all four checks with reasons — the plan is evidence", () => {
    const plan = planPythonChecks(BASE);
    expect(plan.map((c) => c.id)).toEqual([
      "check-py-install",
      "check-py-test",
      "check-py-lint",
      "check-py-typecheck",
    ]);
    for (const check of plan) {
      expect(check.selected).toBe(false);
      expect(check.reason.length).toBeGreaterThan(0);
      expect(check.skipReason).toBeDefined();
      expect(isPythonCheck(check.id)).toBe(true);
    }
  });

  it("plans a uv project through uv sync and uv run without re-syncing", () => {
    const plan = planPythonChecks({
      ...BASE,
      manager: "uv",
      hasTests: true,
      pytestDeclared: true,
      ruffDeclared: true,
    });
    const byId = Object.fromEntries(plan.map((c) => [c.id, c]));
    expect(byId["check-py-install"]?.command).toBe("pip install uv && uv sync --frozen");
    expect(byId["check-py-install"]?.selected).toBe(true);
    expect(byId["check-py-test"]?.command).toBe("uv run --no-sync python -m pytest");
    expect(byId["check-py-test"]?.selected).toBe(true);
    expect(byId["check-py-lint"]?.selected).toBe(true);
    expect(byId["check-py-typecheck"]?.selected).toBe(false);
    expect(byId["check-py-typecheck"]?.reason).toContain("not a declared dependency");
  });

  it("plans requirements installs into the out-of-workspace venv, every file named", () => {
    const plan = planPythonChecks({
      ...BASE,
      manager: "pip-requirements",
      requirementsFiles: ["requirements-dev.txt", "requirements.txt"],
      hasTests: true,
      pytestDeclared: true,
    });
    const install = plan.find((c) => c.id === "check-py-install");
    expect(install?.command).toBe(
      `python -m venv ${PIP_VENV} && ${PIP_VENV}/bin/pip install -r requirements-dev.txt -r requirements.txt`
    );
    const test = plan.find((c) => c.id === "check-py-test");
    expect(test?.command).toBe(`${PIP_VENV}/bin/python -m pytest`);
  });

  it("refuses to select pytest when tests exist but nothing declares pytest", () => {
    const plan = planPythonChecks({
      ...BASE,
      manager: "pip-project",
      hasTests: true,
      pytestDeclared: false,
    });
    const test = plan.find((c) => c.id === "check-py-test");
    expect(test?.selected).toBe(false);
    expect(test?.reason).toBe("test files present but pytest is not a declared dependency");
  });

  it("keeps install kind as \"install\" so the network rule applies unchanged", () => {
    const plan = planPythonChecks({ ...BASE, manager: "poetry" });
    expect(plan.find((c) => c.id === "check-py-install")?.kind).toBe("install");
    expect(plan.filter((c) => c.kind === "install")).toHaveLength(1);
  });
});
