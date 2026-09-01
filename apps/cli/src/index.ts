#!/usr/bin/env node
/**
 * mantyl — command router (architecture spec §4).
 * Every command is implemented; exit codes are a stable contract
 * (@mantyl/core exit-codes). Honesty rule applies to the CLI itself:
 * warnings are loud, nothing fake-passes, nothing spins forever.
 */

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { DEFAULT_ANALYSIS_MODEL, ExitCode, generateProject, initProject, receiveProject, scanProject, verifyProject } from "@mantyl/core";
import { InvalidConfigError, loadConfig } from "@mantyl/config";
import { SCHEMA_VERSION } from "@mantyl/schema";
import { DockerRunner } from "@mantyl/runner-docker";
import { claudeProjectDir, listSessionFiles } from "@mantyl/adapter-claude-code";
import { collectCursorSessions, cursorAvailability } from "@mantyl/adapter-cursor";
import { codexAvailability, collectCodexSessions } from "@mantyl/adapter-codex";

// The single source of version truth is package.json — read at runtime so
// the bundle, the --version flag and the npm registry can never disagree.
// dist/index.js sits one level below package.json in both dev and publish.
const VERSION: string = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string }
).version;

// Load .env from the working directory if present (ANTHROPIC_API_KEY lives
// there or in the shell environment — never in mantyl.config.json).
try {
  process.loadEnvFile();
} catch {
  // no .env file — the shell environment is the only source
}

const program = new Command();

program
  .name("mantyl")
  .description(
    "The handover layer for AI-built software.\nLocal-first: scan, verify and generate a project passport — no account required."
  )
  .version(`mantyl ${VERSION} (passport schema ${SCHEMA_VERSION})`);

program
  .command("init")
  .description("create mantyl.config.json for this project")
  .option("--force", "overwrite an existing config file")
  .action(async (opts: { force?: boolean }) => {
    const result = await initProject(process.cwd(), { force: opts.force ?? false });
    if (result.outcome === "exists") {
      process.stderr.write(
        `mantyl init: ${result.path} already exists (use --force to overwrite)\n`
      );
      process.exit(ExitCode.Ok);
    }
    process.stdout.write(`created ${result.path}\n`);
    process.stdout.write(
      "defaults: llm off · sandbox network off · redaction on — edit as needed\n"
    );
    process.stdout.write(
      "\nyour first passport, in order:\n" +
        "  1. mantyl doctor      check node, git, docker and agent sessions\n" +
        "  2. mantyl scan        collect facts, claims and decisions\n" +
        "  3. mantyl generate    build the passport and local reports\n"
    );
  });

program
  .command("scan")
  .description("collect repository, Git and agent-session observations")
  .option("--session-dir <dir>", "override the Claude Code session directory")
  .action(async (opts: { sessionDir?: string }) => {
    const result = await scanProject(process.cwd(), {
      toolVersion: VERSION,
      ...(opts.sessionDir ? { sessionDir: opts.sessionDir } : {}),
    });
    const { repository, sessions, facts, claims, decisions, capabilities } = result;
    const scripts = Object.entries(capabilities.scripts)
      .filter(([, present]) => present)
      .map(([name]) => name);
    const line = (label: string, value: string) =>
      process.stdout.write(`  ▸ ${label.padEnd(22)}${value}\n`);
    process.stdout.write(`mantyl scan · ${result.context.projectRoot}\n`);
    line("repository indexed", `${repository.fileCount} files · scripts: ${scripts.join(", ") || "none"}`);
    const bySource = (source: string) => sessions.filter((s) => s.source === source).length;
    const sourceBits = (
      [
        ["claude-code", "claude code"],
        ["cursor", "cursor"],
        ["codex", "codex"],
      ] as const
    )
      .filter(([source]) => bySource(source) > 0)
      .map(([source, label]) => `${bySource(source)} ${label}`);
    line(
      "agent history",
      sessions.length > 0
        ? `${sourceBits.join(" · ")} session(s) · ${claims.filter((c) => c.origin === "agent").length} candidate claim(s)`
        : "no agent sessions found (Claude Code, Cursor or Codex)"
    );
    line("facts extracted", `${facts.length} facts · ${claims.length} claims · ${decisions.length} decisions`);
    for (const warning of result.adapterWarnings) {
      process.stderr.write(
        `  ⚠ ${warning.source} adapter failed mid-collection — its history is MISSING from this scan\n` +
          `      ${warning.message}\n`
      );
    }
    if (!result.redactionEnabled) {
      process.stderr.write("  ⚠ redaction is DISABLED by config — transcript text is unredacted\n");
    }
    line("artefacts", result.artifactsDir);
    line("next", "mantyl verify · executed checks are the strongest evidence");
    process.exit(ExitCode.Ok);
  });

program
  .command("verify")
  .description("execute verification checks in an isolated sandbox")
  .action(async () => {
    const result = await verifyProject(process.cwd(), { toolVersion: VERSION });
    process.stdout.write(`mantyl verify · ${process.cwd()}\n`);
    if (!result.sandbox.available) {
      process.stderr.write(`  ⚠ sandbox unavailable: ${result.sandbox.reason}\n`);
      process.stderr.write(
        "  checks recorded as skipped — evidence stays honest, nothing fake-passes\n"
      );
    }
    const marks = { passed: "✓", failed: "✕", skipped: "⚠", error: "✕" } as const;
    for (const check of result.results) {
      const mark = marks[check.outcome];
      process.stdout.write(
        `  ${mark} ${check.checkId.replace("check-", "").padEnd(12)}${check.outcome}` +
          `${check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ""} · ${check.durationMs}ms\n`
      );
    }
    process.stdout.write(`  ▸ evidence → ${result.artifactsDir}\n`);
    if (!result.sandbox.available) {
      process.stdout.write(
        "  ▸ next: start Docker Desktop and re-run, or mantyl generate (checks stay skipped)\n"
      );
      process.exit(ExitCode.SandboxUnavailable);
    }
    process.stdout.write("  ▸ next: mantyl generate\n");
    const failed = result.results.some((r) => r.outcome === "failed" || r.outcome === "error");
    process.exit(failed ? ExitCode.VerificationFailed : ExitCode.Ok);
  });

program
  .command("generate")
  .description("build passport.json and local reports")
  .option("--session-dir <dir>", "override the Claude Code session directory")
  .option("--no-llm", "skip LLM analysis for this run regardless of config")
  .action(async (opts: { sessionDir?: string; llm: boolean }) => {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { renderPassportMarkdown } = await import("@mantyl/renderer-markdown");
    const { renderPassportHtml } = await import("@mantyl/renderer-html");

    const result = await generateProject(process.cwd(), {
      toolVersion: VERSION,
      ...(opts.sessionDir ? { sessionDir: opts.sessionDir } : {}),
      ...(opts.llm === false ? { noLlm: true } : {}),
    });
    await writeFile(
      join(result.artifactsDir, "passport.md"),
      renderPassportMarkdown(result.passport),
      "utf8"
    );
    await writeFile(
      join(result.artifactsDir, "passport.html"),
      renderPassportHtml(result.passport),
      "utf8"
    );

    const p = result.passport;
    const counts = (status: string) =>
      [...p.claims, ...p.risks].filter((item) => item.status === status).length;
    process.stdout.write(`mantyl generate · ${p.project.name}\n`);
    process.stdout.write(
      `  ▸ passport            ${result.passportPath}\n` +
        `  ▸ reports             passport.md · passport.html\n` +
        `  ▸ claims              ${p.claims.length} (${counts("contradicted")} contradicted)\n` +
        `  ▸ decisions           ${p.decisions.length}\n` +
        `  ▸ risks & unknowns    ${p.risks.length}\n` +
        `  ▸ checks recorded     ${p.verification.results.length}\n` +
        `  ▸ digest              ${p.integrity.passportDigest}\n`
    );
    if (result.analysis === null) {
      process.stdout.write(
        `  ▸ analysis            off (${opts.llm === false ? "--no-llm" : "llm.provider: none"})\n`
      );
    } else {
      process.stdout.write(
        `  ▸ analysis            ${result.analysis.provider} — interpretation only, all output marked inferred\n`
      );
    }
    process.stdout.write(
      `  ▸ next                mantyl publish · a shareable hosted link, your choice\n`
    );
    process.exit(ExitCode.Ok);
  });

program
  .command("receive")
  .description("independently validate a passport against a received repository")
  .argument("[path]", "path to the received repository", ".")
  .option("--passport <file>", "passport to validate against")
  .option("--skip-checks", "compare digests only; do not re-execute checks")
  .action(async (path: string, opts: { passport?: string; skipChecks?: boolean }) => {
    const { resolve } = await import("node:path");
    const { stat } = await import("node:fs/promises");
    const repoPath = resolve(path);
    const target = await stat(repoPath).catch(() => null);
    if (target === null || !target.isDirectory()) {
      process.stderr.write(
        `mantyl receive: ${repoPath} is not a directory — pass the path to the received repository\n`
      );
      process.exit(ExitCode.NotAProject);
    }
    const { report } = await receiveProject(repoPath, {
      toolVersion: VERSION,
      ...(opts.passport ? { passportPath: resolve(opts.passport) } : {}),
      ...(opts.skipChecks ? { skipChecks: true } : {}),
    });

    const mark = (v: boolean | null) => (v === null ? "—" : v ? "✓" : "✕");
    process.stdout.write(`mantyl receive · ${repoPath}\n`);
    process.stdout.write(`  ${report.passportValid ? "✓" : "✕"} passport schema valid\n`);
    process.stdout.write(`  ${mark(report.passportDigestMatch)} passport digest\n`);
    process.stdout.write(`  ${mark(report.fileManifest.match)} file manifest\n`);
    for (const kind of ["modified", "added", "removed"] as const) {
      for (const file of report.fileManifest[kind]) {
        process.stdout.write(`      ${kind}: ${file}\n`);
      }
    }
    process.stdout.write(`  ${mark(report.commitMatch)} commit\n`);
    if (!report.sandbox.available) {
      process.stdout.write(`  ⚠ checks not re-executed: ${report.sandbox.reason}\n`);
    }
    for (const check of report.checks) {
      process.stdout.write(
        `  ${check.match ? "✓" : "✕"} ${check.checkId}: recorded ${check.recorded}, reproduced ${check.reproduced}` +
          `${check.retried ? " (after one retry)" : ""}\n`
      );
    }
    process.stdout.write(
      report.diverged
        ? `  ✕ DIVERGED — do not accept without investigating\n`
        : `  ✓ no divergence detected\n`
    );
    if (!report.diverged) {
      process.stdout.write(
        "  ▸ this recheck is independent and repeatable any time · mantyl.dev\n"
      );
    }
    process.exit(report.diverged ? ExitCode.ReceiveDivergence : ExitCode.Ok);
  });

program
  .command("accept")
  .description("validate a received delivery and record your acceptance")
  .argument("[path]", "path to the received repository", ".")
  .option("--passport <file>", "passport to accept (default <path>/passport.json)")
  .option("--skip-checks", "compare digests only; do not re-execute checks")
  .option("--name <name>", "who is accepting, for the record")
  .option("--organisation <org>", "organisation for the record")
  .option("--yes", "acknowledge the listed findings without prompting")
  .action(
    async (
      path: string,
      opts: {
        passport?: string;
        skipChecks?: boolean;
        name?: string;
        organisation?: string;
        yes?: boolean;
      }
    ) => {
      const { resolve } = await import("node:path");
      const { stat } = await import("node:fs/promises");
      const { prepareAccept, recordAcceptance } = await import("@mantyl/core");
      const repoPath = resolve(path);
      const target = await stat(repoPath).catch(() => null);
      if (target === null || !target.isDirectory()) {
        process.stderr.write(
          `mantyl accept: ${repoPath} is not a directory — pass the path to the received repository\n`
        );
        process.exit(ExitCode.NotAProject);
      }

      process.stdout.write(`mantyl accept · ${repoPath}\n`);
      const prepared = await prepareAccept(repoPath, {
        toolVersion: VERSION,
        ...(opts.passport ? { passportPath: resolve(opts.passport) } : {}),
        ...(opts.skipChecks ? { skipChecks: true } : {}),
      });

      const { report } = prepared;
      const mark = (v: boolean | null) => (v === null ? "—" : v ? "✓" : "✕");
      process.stdout.write(`  ${report.passportValid ? "✓" : "✕"} passport schema valid\n`);
      process.stdout.write(`  ${mark(report.passportDigestMatch)} passport digest\n`);
      process.stdout.write(`  ${mark(report.fileManifest.match)} file manifest\n`);
      process.stdout.write(`  ${mark(report.commitMatch)} commit\n`);
      if (!report.sandbox.available && !opts.skipChecks) {
        process.stdout.write(`  ⚠ checks not re-executed: ${report.sandbox.reason}\n`);
      }
      for (const check of report.checks) {
        process.stdout.write(
          `  ${check.match ? "✓" : "✕"} ${check.checkId}: recorded ${check.recorded}, reproduced ${check.reproduced}\n`
        );
      }

      if (prepared.refused || prepared.passport === null) {
        process.stderr.write(
          "  ✕ DIVERGED — acceptance refused. Investigate with mantyl receive before accepting.\n"
        );
        process.exit(ExitCode.ReceiveDivergence);
      }
      const passport = prepared.passport;

      const findings = prepared.openFindings;
      if (findings.length > 0) {
        process.stdout.write(
          `\n  accepting acknowledges these ${findings.length} open finding(s):\n`
        );
        for (const finding of findings) {
          process.stdout.write(`    [${finding.kind}] ${finding.id}\n        ${finding.text}\n`);
        }
      } else {
        process.stdout.write("\n  no open findings: no contradictions, risks or incomplete work recorded.\n");
      }

      const ask = async (question: string): Promise<string> => {
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(question);
        rl.close();
        return answer.trim();
      };

      if (!opts.yes) {
        const answer = (
          await ask(
            findings.length > 0
              ? `  acknowledge the finding(s) above and accept this delivery? [y/N] `
              : "  accept this delivery? [y/N] "
          )
        ).toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          process.stdout.write("  not accepted.\n");
          process.exit(ExitCode.Ok);
        }
      }

      let name = opts.name;
      while (!name) {
        name = await ask("  your name for the record: ");
      }

      const { record, path: recordPath } = await recordAcceptance(repoPath, passport, {
        acceptedBy: {
          name,
          ...(opts.organisation ? { organisation: opts.organisation } : {}),
        },
        acknowledgedFindings: findings.map((finding) => finding.id),
      });

      process.stdout.write(
        `  ✓ accepted             ${record.acceptedBy.name} · ${record.acceptedBy.date}\n` +
          `  ▸ record              ${recordPath}\n` +
          `  ▸ binds digest        ${record.passportDigest}\n` +
          `  ▸ acknowledged        ${record.acknowledgedFindings.length} finding(s)\n` +
          "  ▸ next                send acceptance.json back to your deliverer and keep it beside the passport\n"
      );
      process.exit(ExitCode.Ok);
    }
  );

program
  .command("verified")
  .description("request independent Mantyl Verified verification of the passport (beta)")
  // www, not the apex: the apex 308-redirects and a multipart body
  // does not survive the follow.
  .option("--endpoint <url>", "Mantyl host", "https://www.mantyl.dev")
  .option("--token <token>", "submit token (or MANTYL_TOKEN env)")
  .option("--yes", "skip the consent prompt")
  .action(async (opts: { endpoint: string; token?: string; yes?: boolean }) => {
    const { preparePublish, packProject, PassportInvalidError, PackError } = await import(
      "@mantyl/core"
    );

    let prepared, bundle;
    try {
      prepared = await preparePublish(process.cwd());
      bundle = await packProject(process.cwd());
    } catch (err) {
      if (err instanceof PassportInvalidError || err instanceof PackError) {
        process.stderr.write(`mantyl verified: ${err.message}\n`);
        process.exit(ExitCode.PassportInvalid);
      }
      throw err;
    }
    if (prepared.passport.run.commit !== bundle.commit) {
      process.stderr.write(
        "mantyl verified: the passport was generated at a different commit — regenerate it first\n"
      );
      process.exit(ExitCode.PassportInvalid);
    }

    process.stdout.write(`mantyl verified · ${prepared.passport.project.name}\n`);
    process.stdout.write(
      `  ▸ passport digest     ${prepared.digest}\n` +
        `  ▸ commit              ${bundle.commit.slice(0, 7)}\n` +
        `  ▸ upload              ${bundle.fileCount} tracked files · ${(bundle.bytes.length / 1024).toFixed(0)} KB compressed\n` +
        `  ▸ destination         ${opts.endpoint}\n` +
        `  ▸ retention           working copy destroyed after the verification run\n`
    );

    if (!opts.yes) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (
        await rl.question("  upload source for independent verification? [y/N] ")
      ).trim().toLowerCase();
      rl.close();
      if (answer !== "y" && answer !== "yes") {
        process.stdout.write("  not uploaded.\n");
        process.exit(ExitCode.Ok);
      }
    }

    const token = opts.token ?? process.env["MANTYL_TOKEN"];
    const form = new FormData();
    form.set("passport", prepared.body);
    form.set("bundle", new Blob([new Uint8Array(bundle.bytes)]), "bundle.tgz");

    // The re-run promise: if the last run from this project failed, its
    // job id claims one free re-submission. The server validates the
    // entitlement; an ineligible claim simply falls through to payment.
    const { readFile: readLastJob, writeFile: writeLastJob } = await import("node:fs/promises");
    const { join: joinPath } = await import("node:path");
    const lastJobPath = joinPath(process.cwd(), ".mantyl", "last-verified.json");
    try {
      const last = JSON.parse(await readLastJob(lastJobPath, "utf8")) as { jobId?: string };
      if (typeof last.jobId === "string" && /^[0-9a-f]{24}$/.test(last.jobId)) {
        form.set("rerunOf", last.jobId);
      }
    } catch {
      // no previous run recorded
    }
    const submitted = await fetch(`${opts.endpoint.replace(/\/$/, "")}/api/verify-jobs`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: form,
    });
    if (!submitted.ok) {
      const text = await submitted.text();
      let detail = text.slice(0, 200);
      try {
        detail = (JSON.parse(text) as { error?: string }).error ?? detail;
      } catch {
        // non-JSON body
      }
      process.stderr.write(`mantyl verified: submission failed (${submitted.status}): ${detail}\n`);
      process.exit(ExitCode.GenericError);
    }
    const { id, status, checkoutUrl, rerun } = (await submitted.json()) as {
      id: string;
      status: string;
      checkoutUrl?: string;
      rerun?: string;
    };
    try {
      await writeLastJob(lastJobPath, JSON.stringify({ jobId: id }), "utf8");
    } catch {
      // .mantyl missing is fine; the re-run claim is best-effort
    }

    if (rerun === "granted") {
      process.stdout.write(
        `  ▸ job                 ${id}\n` +
          "  ✓ free re-run applied — the previous failed run covers this one\n"
      );
    }

    if (status === "awaiting_payment" && checkoutUrl) {
      process.stdout.write(
        `  ▸ job                 ${id}\n` +
          `  ▸ payment             this verification needs a credit (£19 to £49 by project size)\n` +
          `  ▸ checkout            ${checkoutUrl}\n` +
          "  opening the checkout in your browser — this run resumes when payment lands\n"
      );
      const { spawn } = await import("node:child_process");
      const opener =
        process.platform === "win32"
          ? ["cmd", ["/c", "start", "", checkoutUrl]]
          : process.platform === "darwin"
            ? ["open", [checkoutUrl]]
            : ["xdg-open", [checkoutUrl]];
      try {
        spawn(opener[0] as string, opener[1] as string[], {
          detached: true,
          stdio: "ignore",
        }).unref();
      } catch {
        // no browser available: the printed URL is enough
      }
    } else if (rerun !== "granted") {
      process.stdout.write(`  ▸ job                 ${id} — waiting for the worker\n`);
    }

    // Bounded polling: the run continues server-side whether or not this
    // process keeps watching, so give up after an hour and say where to
    // look instead of spinning forever on a closed checkout tab.
    const POLL_INTERVAL_MS = 10_000;
    const POLL_DEADLINE_MS = 60 * 60 * 1000;
    const pollStarted = Date.now();
    let paymentAnnounced = false;
    for (;;) {
      if (Date.now() - pollStarted > POLL_DEADLINE_MS) {
        process.stderr.write(
          `  ⚠ still no result after an hour — this watcher is giving up, the job is not\n` +
            `      job ${id} continues server-side; check ${opts.endpoint.replace(/\/$/, "")}/checkout/${id}\n` +
            "      or re-run mantyl verified later to claim its outcome\n"
        );
        process.exit(ExitCode.GenericError);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      const polled = await fetch(`${opts.endpoint.replace(/\/$/, "")}/api/verify-jobs/${id}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!polled.ok) continue;
      const job = (await polled.json()) as {
        status: string;
        detail?: string;
        checks?: Array<{ checkId: string; reproduced: string; match: boolean }>;
      };
      if (job.status === "awaiting_payment") continue;
      if (job.status === "queued" || job.status === "running") {
        if (status === "awaiting_payment" && !paymentAnnounced) {
          paymentAnnounced = true;
          process.stdout.write("  ✓ credit applied — waiting for the worker\n");
        }
        continue;
      }

      for (const check of job.checks ?? []) {
        process.stdout.write(
          `  ${check.match && check.reproduced === "passed" ? "✓" : "✕"} ${check.checkId}: ${check.reproduced}\n`
        );
      }
      if (job.status === "verified") {
        process.stdout.write(
          "  ✓ MANTYL VERIFIED — independently re-executed and signed\n" +
            "  ▸ the mark now shows on the hosted passport if published\n"
        );
        process.exit(ExitCode.Ok);
      }
      process.stderr.write(
        `  ✕ not verified (${job.status})${job.detail ? `: ${job.detail}` : ""}\n`
      );
      process.exit(ExitCode.VerificationFailed);
    }
  });

program
  .command("doctor")
  .description("check the local environment (git, docker, agent session stores)")
  .action(async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const ok = (label: string, detail: string) =>
      process.stdout.write(`  ✓ ${label.padEnd(20)}${detail}\n`);
    const warn = (label: string, detail: string) =>
      process.stdout.write(`  ⚠ ${label.padEnd(20)}${detail}\n`);

    process.stdout.write(`mantyl doctor\n`);
    ok("node", process.version);

    try {
      const { stdout } = await execFileAsync("git", ["--version"]);
      ok("git", stdout.trim());
    } catch {
      warn("git", "not found — commit history cannot be collected");
    }

    const docker = await new DockerRunner().available();
    if (docker.available) {
      ok("docker", `server ${docker.version} — sandbox verification available`);
    } else {
      warn("docker", `${docker.reason ?? "unavailable"}`);
      process.stdout.write(
        "      verify will record checks as unresolved (never fake-passed) until Docker is available\n"
      );
    }

    try {
      const { config } = await loadConfig(process.cwd());
      if (config.llm.provider === "anthropic") {
        const model = config.llm.model ?? DEFAULT_ANALYSIS_MODEL;
        if (process.env["ANTHROPIC_API_KEY"]) {
          ok("anthropic", `ANTHROPIC_API_KEY set · model ${model}`);
        } else {
          warn("anthropic", "llm.provider is \"anthropic\" but ANTHROPIC_API_KEY is not set");
          process.stdout.write(
            "      set it as an environment variable (never in a file) or generate will fail\n"
          );
        }
      }
    } catch {
      // invalid config is reported properly by `mantyl config`; doctor stays best-effort
    }

    const sessionFiles = await listSessionFiles(process.cwd());
    if (sessionFiles.length > 0) {
      ok("claude code", `${sessionFiles.length} session file(s) for this project`);
    } else {
      warn("claude code", "no sessions found for this folder");
      process.stdout.write(
        `      looked in ${claudeProjectDir(process.cwd())}\n` +
          "      run mantyl from the project root you used with Claude Code\n"
      );
    }

    const cursor = await cursorAvailability();
    if (!cursor.available) {
      warn("cursor", cursor.reason ?? "unavailable");
    } else {
      const { redactText } = await import("@mantyl/core");
      const cursorSessions = await collectCursorSessions(process.cwd(), (text) =>
        redactText(text).text
      ).catch(() => []);
      if (cursorSessions.length > 0) {
        ok("cursor", `${cursorSessions.length} session(s) for this project (beta)`);
      } else {
        warn("cursor", "installed, but no sessions found for this folder (beta)");
      }
    }

    const codex = await codexAvailability();
    if (!codex.available) {
      warn("codex", codex.reason ?? "unavailable");
    } else {
      const { redactText } = await import("@mantyl/core");
      const codexSessions = await collectCodexSessions(process.cwd(), (text) =>
        redactText(text).text
      ).catch(() => []);
      if (codexSessions.length > 0) {
        ok("codex", `${codexSessions.length} session(s) for this project (beta)`);
      } else {
        warn("codex", "installed, but no sessions found for this folder (beta)");
      }
    }
    process.exit(ExitCode.Ok);
  });

program
  .command("config")
  .description("show or validate the resolved configuration")
  .action(async () => {
    try {
      const resolved = await loadConfig(process.cwd());
      process.stdout.write(`${JSON.stringify(resolved.config, null, 2)}\n`);
      process.stdout.write(`source: ${resolved.source}\ndigest: ${resolved.digest}\n`);
    } catch (err) {
      if (err instanceof InvalidConfigError) {
        process.stderr.write(`mantyl config: ${err.message}\n`);
        process.exit(ExitCode.InvalidConfig);
      }
      throw err;
    }
  });

program
  .command("publish")
  .description("host the approved passport at a shareable URL (explicit, opt-in)")
  .option("--endpoint <url>", "Mantyl host to publish to", "https://www.mantyl.dev")
  .option("--yes", "skip the confirmation prompt")
  .action(async (opts: { endpoint: string; yes?: boolean }) => {
    const { preparePublish, publishPassport, PassportInvalidError } = await import(
      "@mantyl/core"
    );

    let prepared;
    try {
      prepared = await preparePublish(process.cwd());
    } catch (err) {
      if (err instanceof PassportInvalidError) {
        process.stderr.write(`mantyl publish: ${err.message}\n`);
        process.exit(ExitCode.PassportInvalid);
      }
      throw err;
    }

    process.stdout.write(`mantyl publish · ${prepared.passport.project.name}\n`);
    process.stdout.write(
      `  ▸ digest              ${prepared.digest}\n` +
        `  ▸ destination         ${opts.endpoint}\n` +
        `  ▸ payload             the passport document only — never source code\n`
    );

    if (!opts.yes) {
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question("  publish? [y/N] ")).trim().toLowerCase();
      rl.close();
      if (answer !== "y" && answer !== "yes") {
        process.stdout.write("  not published.\n");
        process.exit(ExitCode.Ok);
      }
    }

    try {
      const result = await publishPassport(prepared, opts.endpoint);
      process.stdout.write(
        `  ✓ hosted              ${result.url}\n` +
          (result.deduplicated
            ? `  ▸ already hosted — this passport digest was published before\n`
            : `  ▸ delete token        ${result.deleteToken} (shown ONCE — save it to unpublish)\n`) +
          `  ▸ readme badge        [![Mantyl passport](${opts.endpoint}/api/badge/${result.id})](${result.url})\n` +
          `  ▸ next                mantyl verified · an independent, signed run of the checks\n`
      );
      process.exit(ExitCode.Ok);
    } catch (err) {
      process.stderr.write(`mantyl publish: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(ExitCode.GenericError);
    }
  });

program.parse();
