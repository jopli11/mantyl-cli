/**
 * `mantyl verify` — canonical data flow steps 6–7 (spec §5): plan checks
 * from detected capabilities, execute them in the sandbox, capture
 * reproducible evidence.
 *
 * Honesty rules: an unavailable sandbox produces SKIPPED results with the
 * reason recorded — never fake passes. Logs are secret-scrubbed before they
 * are written or digested.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, type CheckResult, type PlannedCheck } from "@mantyl/schema";
import { collectRepository } from "@mantyl/collectors-repository";
import type { Runner, RunnerAvailability } from "@mantyl/runner-docker";
import { DockerRunner } from "@mantyl/runner-docker";
import { executeCheck, planNodeChecks } from "@mantyl/verifier-node";
import { createRunContext } from "./run-context.js";
import { detectCapabilities } from "./capabilities.js";
import { redactText } from "./redaction.js";

export interface VerifyResult {
  plan: PlannedCheck[];
  results: CheckResult[];
  sandbox: RunnerAvailability;
  artifactsDir: string;
}

export interface VerifyOptions {
  toolVersion: string;
  /** Injectable runner (tests use a fake; default is Docker). */
  runner?: Runner;
  artifactsDir?: string;
  now?: () => Date;
}

export async function verifyProject(
  projectRoot: string,
  options: VerifyOptions
): Promise<VerifyResult> {
  const context = await createRunContext(projectRoot, {
    toolVersion: options.toolVersion,
    ...(options.now ? { now: options.now } : {}),
  });
  const repository = await collectRepository(projectRoot);
  const capabilities = detectCapabilities(repository);
  const plan = repository.packageJson ? planNodeChecks(capabilities) : [];

  const runner = options.runner ?? new DockerRunner();
  const sandbox = await runner.available();

  const artifactsDir = options.artifactsDir ?? join(projectRoot, ".mantyl");
  const logsDir = join(artifactsDir, "logs");
  await mkdir(logsDir, { recursive: true });

  const results: CheckResult[] = [];
  const timeoutMs = context.config.config.verify.timeoutSeconds * 1000;
  const networkForInstall = true; // registry access is the install plugin's declared requirement
  const now = options.now ?? (() => new Date());

  // One sandbox session for the whole plan: install's node_modules must
  // still exist when build and test run. Network starts on for install and
  // is cut permanently before the first offline check.
  const session = sandbox.available
    ? await runner.session(projectRoot, { network: networkForInstall })
    : null;
  let networkConnected = networkForInstall;

  try {
    for (const check of plan) {
      if (!check.selected) continue;
      if (session === null) {
        results.push({
          checkId: check.id,
          outcome: "skipped",
          command: check.command,
          startedAt: now().toISOString(),
          durationMs: 0,
          envFingerprint: `unavailable:${sandbox.reason ?? "sandbox missing"}`,
        });
        continue;
      }
      if (networkConnected && check.kind !== "install") {
        await session.disconnectNetwork();
        networkConnected = false;
      }
      try {
        const { result, log } = await executeCheck({ run: (cmd) => session.exec(cmd) }, check, {
          timeoutMs,
          networkForInstall,
          scrub: (text) => redactText(text).text,
          ...(options.now ? { now: options.now } : {}),
        });
        await writeFile(join(logsDir, `${check.id}.log`), log, "utf8");
        results.push(result);
      } catch (err) {
        // A dead session (earlier timeout) is evidence too — never silent.
        results.push({
          checkId: check.id,
          outcome: "error",
          command: check.command,
          startedAt: now().toISOString(),
          durationMs: 0,
          envFingerprint: `session:${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } finally {
    await session?.close();
  }

  await writeFile(
    join(artifactsDir, "verification.json"),
    `${canonicalJson({ plan, results, sandbox })}\n`,
    "utf8"
  );

  return { plan, results, sandbox, artifactsDir };
}
