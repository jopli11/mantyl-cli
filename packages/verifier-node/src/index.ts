/**
 * @mantyl/verifier-node — Node/TypeScript verifier plugin (spec §4).
 * Plans and executes install/build/typecheck/test/lint checks through the
 * Runner interface. Every result carries command, exit code, timing, a
 * scrubbed-log digest and the environment fingerprint — evidence, not vibes.
 */

import type { CheckResult, PlannedCheck } from "@mantyl/schema";
import { sha256Hex } from "@mantyl/schema";
import type { SandboxCommand, SandboxResult } from "@mantyl/runner-docker";

/** Where a check runs — a RunnerSession bound to a workspace, or a fake. */
export interface CommandTarget {
  run(command: SandboxCommand): Promise<SandboxResult>;
}

export interface NodeCapabilities {
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | null;
  scripts: { build: boolean; test: boolean; lint: boolean; typecheck: boolean };
  usesTypeScript: boolean;
}

function installCommand(pm: NodeCapabilities["packageManager"]): string {
  switch (pm) {
    case "pnpm":
      return "corepack enable && pnpm install --frozen-lockfile";
    case "yarn":
      return "corepack enable && yarn install --immutable";
    case "bun":
      return "npm install -g bun && bun install --frozen-lockfile";
    default:
      return "npm install";
  }
}

function runCommand(pm: NodeCapabilities["packageManager"], script: string): string {
  switch (pm) {
    case "pnpm":
      return `corepack enable && pnpm run ${script}`;
    case "yarn":
      return `corepack enable && yarn run ${script}`;
    case "bun":
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

/**
 * Plan the check list from detected capabilities. Every check records WHY it
 * was selected or skipped — the plan itself is evidence (spec §4).
 */
export function planNodeChecks(caps: NodeCapabilities): PlannedCheck[] {
  const pm = caps.packageManager;
  const plan: PlannedCheck[] = [
    {
      id: "check-install",
      kind: "install",
      command: installCommand(pm),
      reason: pm
        ? `dependencies locked with ${pm}`
        : "package.json present, no lockfile detected",
      selected: true,
    },
  ];

  const scripted: Array<[keyof NodeCapabilities["scripts"], string]> = [
    ["build", "build"],
    ["typecheck", "typecheck"],
    ["test", "test"],
    ["lint", "lint"],
  ];
  for (const [key, script] of scripted) {
    const present = caps.scripts[key];
    plan.push({
      id: `check-${script}`,
      kind: script,
      command: runCommand(pm, script),
      reason: present
        ? `package.json defines a "${script}" script`
        : `no "${script}" script in package.json`,
      selected: present,
      ...(present ? {} : { skipReason: "script not defined" }),
    });
  }
  return plan;
}

export interface ExecuteOptions {
  timeoutMs: number;
  /** Install legitimately needs the registry; everything else stays offline. */
  networkForInstall: boolean;
  /**
   * Secret scrubber applied BEFORE the log is digested or returned — the
   * digest must describe the log as stored, and stored logs are scrubbed.
   */
  scrub?: (text: string) => string;
  now?: () => Date;
}

/** Execute one planned check in the sandbox and shape the evidence record. */
export async function executeCheck(
  target: CommandTarget,
  check: PlannedCheck,
  options: ExecuteOptions
): Promise<{ result: CheckResult; log: string }> {
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  const command: SandboxCommand = {
    command: check.command,
    timeoutMs: options.timeoutMs,
    network: check.kind === "install" ? options.networkForInstall : false,
    // CI mode: package managers must never wait on a TTY prompt in a sandbox.
    env: { CI: "true" },
  };
  const sandbox = await target.run(command);
  const scrub = options.scrub ?? ((text: string) => text);
  const log = scrub(`${sandbox.stdout}\n${sandbox.stderr}`.trim());
  const outcome: CheckResult["outcome"] = sandbox.timedOut
    ? "error"
    : sandbox.exitCode === 0
      ? "passed"
      : "failed";
  return {
    result: {
      checkId: check.id,
      outcome,
      command: check.command,
      ...(sandbox.exitCode !== null ? { exitCode: sandbox.exitCode } : {}),
      startedAt,
      durationMs: sandbox.durationMs,
      logsDigest: sha256Hex(log),
      envFingerprint: sandbox.envFingerprint,
    },
    log,
  };
}
