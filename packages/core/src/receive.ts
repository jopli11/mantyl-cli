/**
 * `mantyl receive` — the recipient's side of the handover.
 * Given a received repository and the passport that came with it, verify
 * independently: schema validity, digest agreement, per-file divergence,
 * commit match, and (sandbox permitting) re-executed checks. Trust becomes
 * two-sided: the inheritor never has to take the passport's word for it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson, digestPassport, parsePassport, type Passport } from "@mantyl/schema";
import { collectRepository } from "@mantyl/collectors-repository";
import { listTrackedFiles } from "@mantyl/collectors-git";
import type { Runner, RunnerAvailability } from "@mantyl/runner-docker";
import { DockerRunner } from "@mantyl/runner-docker";
import { executeCheck } from "@mantyl/verifier-node";
import { buildFileManifest, diffManifests } from "./manifest.js";
import { createRunContext } from "./run-context.js";
import { redactText } from "./redaction.js";

export interface CheckComparison {
  checkId: string;
  recorded: string;
  reproduced: string;
  match: boolean;
  /** True when the first reproduction mismatched and a retry decided it. */
  retried?: boolean;
}

export interface ReceiveReport {
  passportValid: boolean;
  passportDigestMatch: boolean | null;
  fileManifest: {
    match: boolean | null;
    added: string[];
    removed: string[];
    modified: string[];
  };
  commitMatch: boolean | null;
  sandbox: RunnerAvailability;
  checks: CheckComparison[];
  /** The verdict: false when any comparable dimension diverged. */
  diverged: boolean;
}

export interface ReceiveOptions {
  toolVersion: string;
  passportPath?: string;
  runner?: Runner;
  /** Skip re-executing checks (digest comparison only). */
  skipChecks?: boolean;
  now?: () => Date;
}

export async function receiveProject(
  repoPath: string,
  options: ReceiveOptions
): Promise<{ report: ReceiveReport; passport: Passport | null }> {
  const passportPath = options.passportPath ?? join(repoPath, "passport.json");
  const raw = await readFile(passportPath, "utf8");

  let passport: Passport;
  try {
    passport = parsePassport(JSON.parse(raw));
  } catch {
    return {
      report: {
        passportValid: false,
        passportDigestMatch: null,
        fileManifest: { match: null, added: [], removed: [], modified: [] },
        commitMatch: null,
        sandbox: { available: false, reason: "not attempted" },
        checks: [],
        diverged: true,
      },
      passport: null,
    };
  }

  // 1. Passport self-consistency: recompute the digest over what we were handed.
  const passportDigestMatch =
    passport.integrity.passportDigest === undefined
      ? null
      : digestPassport(passport) === passport.integrity.passportDigest;

  // 2. File manifest: recompute over the received tree — under the SAME
  // rules the generator used (scan.exclude from the project config, and
  // untracked files set aside as local state), or every excluded fixture
  // and local settings file reads as tampering.
  const context = await createRunContext(repoPath, {
    toolVersion: options.toolVersion,
    ...(options.now ? { now: options.now } : {}),
  });
  const [repository, trackedPaths] = await Promise.all([
    collectRepository(repoPath, { exclude: context.config.config.scan.exclude }),
    listTrackedFiles(repoPath),
  ]);
  const files =
    trackedPaths.size > 0
      ? repository.files.map((f) => ({ ...f, tracked: trackedPaths.has(f.path) }))
      : repository.files;
  const manifest = await buildFileManifest(repoPath, files);

  let manifestReport: ReceiveReport["fileManifest"] = {
    match: null,
    added: [],
    removed: [],
    modified: [],
  };
  if (passport.integrity.fileManifestDigest !== undefined) {
    const match = manifest.digest === passport.integrity.fileManifestDigest;
    let detail = { added: [] as string[], removed: [] as string[], modified: [] as string[] };
    if (!match) {
      // Per-file detail requires the recorded manifest (integrity.json travels
      // alongside the passport when available).
      const recorded = await readFile(join(repoPath, ".mantyl", "integrity.json"), "utf8")
        .then((text) => (JSON.parse(text) as { files?: Record<string, string> }).files ?? null)
        .catch(() => null);
      if (recorded) detail = diffManifests(recorded, manifest.files);
    }
    manifestReport = { match, ...detail };
  }

  // 3. Commit comparison.
  const commitMatch =
    passport.run.commit === null || context.commit === null
      ? null
      : passport.run.commit === context.commit;

  // 4. Re-execute the recorded verification plan in OUR sandbox.
  const runner = options.runner ?? new DockerRunner();
  const sandbox = options.skipChecks
    ? { available: false, reason: "checks skipped by request" }
    : await runner.available();

  const checks: CheckComparison[] = [];
  if (sandbox.available && !options.skipChecks) {
    const timeoutMs = context.config.config.verify.timeoutSeconds * 1000;
    // Same session model as verify: one container, install state persists,
    // network cut permanently after install.
    const session = await runner.session(repoPath, { network: true });
    let networkConnected = true;
    try {
      for (const planned of passport.verification.plan) {
        if (!planned.selected) continue;
        const recorded =
          passport.verification.results.find((r) => r.checkId === planned.id)?.outcome ??
          "not-recorded";
        if (networkConnected && planned.kind !== "install") {
          await session.disconnectNetwork();
          networkConnected = false;
        }
        const execOptions = {
          timeoutMs,
          networkForInstall: true,
          scrub: (text: string) => redactText(text).text,
          ...(options.now ? { now: options.now } : {}),
        };
        let { result, log } = await executeCheck(
          { run: (cmd) => session.exec(cmd) },
          planned,
          execOptions
        );
        // A reproduction mismatch gets ONE retry before declaring divergence:
        // a resource-starved container produces flaky test runs, and a signed
        // "diverged" verdict must not rest on scheduler luck. The retry is
        // recorded — never silent.
        let retried = false;
        // "error" means timeout — the session is dead, a retry cannot run.
        if (result.outcome !== recorded && result.outcome !== "error") {
          retried = true;
          ({ result, log } = await executeCheck(
            { run: (cmd) => session.exec(cmd) },
            planned,
            execOptions
          ));
        }
        // The recipient's evidence too: a failed reproduction is only
        // actionable if the log survives.
        await mkdir(join(repoPath, ".mantyl", "logs"), { recursive: true });
        await writeFile(
          join(repoPath, ".mantyl", "logs", `receive-${planned.id}.log`),
          log,
          "utf8"
        ).catch(() => undefined);
        checks.push({
          checkId: planned.id,
          recorded,
          reproduced: result.outcome,
          match: recorded === result.outcome,
          ...(retried ? { retried: true } : {}),
        });
      }
    } finally {
      await session.close();
    }
  }

  const diverged =
    passportDigestMatch === false ||
    manifestReport.match === false ||
    commitMatch === false ||
    checks.some((c) => !c.match);

  const report: ReceiveReport = {
    passportValid: true,
    passportDigestMatch,
    fileManifest: manifestReport,
    commitMatch,
    sandbox,
    checks,
    diverged,
  };

  await writeFile(
    join(repoPath, ".mantyl", "receive-report.json"),
    `${canonicalJson(report)}\n`,
    "utf8"
  ).catch(() => undefined); // .mantyl may not exist on a fresh clone — report still returned

  return { report, passport };
}
