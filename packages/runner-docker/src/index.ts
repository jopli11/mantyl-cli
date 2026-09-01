/**
 * @mantyl/runner-docker — the sandbox (architecture spec §4).
 * Executes untrusted project commands in isolation: resource limits,
 * timeouts, and network DISABLED by default. Docker is the MVP runtime,
 * abstracted behind the Runner interface so alternatives can follow.
 *
 * Isolation model: the workspace is COPIED into the container (docker cp),
 * never bind-mounted — container writes cannot touch the host tree.
 */

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Never copied into the sandbox: host dependency trees (platform-specific
 * binaries that break the container's package manager), VCS internals,
 * Mantyl's own evidence directory, and framework build caches. The sandbox
 * verifies the project from source, exactly as a recipient would.
 */
const EXCLUDED_COPY_DIRS = new Set(["node_modules", ".git", ".mantyl", ".next"]);

/** Same rule as the repository walker: secret env files stay on the host. */
const ENV_DOC_FILES = new Set([".env.example", ".env.sample", ".env.template"]);
function isSecretEnvFile(name: string): boolean {
  return name === ".env" || (name.startsWith(".env.") && !ENV_DOC_FILES.has(name));
}

/** Whether a workspace-relative path is copied into the sandbox. */
export function shouldStage(relPath: string): boolean {
  if (relPath === "") return true;
  const parts = relPath.split(/[\\/]/);
  if (parts.some((part) => EXCLUDED_COPY_DIRS.has(part))) return false;
  return !isSecretEnvFile(parts[parts.length - 1]!);
}

/** Filtered copy of the workspace for docker cp — caller removes it. */
async function stageWorkspace(workspacePath: string): Promise<string> {
  const staging = await mkdtemp(join(tmpdir(), "mantyl-stage-"));
  await cp(workspacePath, staging, {
    recursive: true,
    filter: (src) => shouldStage(relative(workspacePath, src)),
  });
  return staging;
}

export interface RunnerAvailability {
  available: boolean;
  version?: string;
  reason?: string;
}

export interface SandboxCommand {
  /** Shell command executed inside the sandbox via `sh -lc`. */
  command: string;
  timeoutMs: number;
  /** Network access — off unless a policy explicitly enables it. */
  network?: boolean;
  cpus?: number;
  memoryMb?: number;
  env?: Record<string, string>;
}

export interface SandboxResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Identifies the execution environment for the evidence record. */
  envFingerprint: string;
}

export interface SessionOptions {
  /** Initial network access; disconnectNetwork() is one-way off. */
  network: boolean;
  cpus?: number;
  memoryMb?: number;
}

/**
 * A persistent sandbox: one container, sequential commands, shared state.
 * Install's node_modules must still exist when build and test run — separate
 * containers per check verify nothing real.
 */
export interface RunnerSession {
  exec(command: SandboxCommand): Promise<SandboxResult>;
  /** Cut network access for every subsequent exec. Irreversible. */
  disconnectNetwork(): Promise<void>;
  close(): Promise<void>;
}

export interface Runner {
  available(): Promise<RunnerAvailability>;
  run(workspacePath: string, command: SandboxCommand): Promise<SandboxResult>;
  session(workspacePath: string, options: SessionOptions): Promise<RunnerSession>;
}

const MAX_CAPTURE = 2 * 1024 * 1024; // 2 MiB per stream — logs are evidence, not archives

export class DockerRunner implements Runner {
  /**
   * Non-slim by default: verification re-runs a project's real toolchain,
   * and slim images lack git — collectors and any git-touching test fail
   * with ENOENT instead of exercising the code (found by self-verify).
   */
  constructor(readonly image: string = "node:22-bookworm") {}

  async available(): Promise<RunnerAvailability> {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["version", "--format", "{{.Server.Version}}"],
        { timeout: 10_000 }
      );
      return { available: true, version: stdout.trim() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT/.test(message)) {
        return { available: false, reason: "docker CLI not found — install Docker" };
      }
      return {
        available: false,
        reason: "docker daemon not reachable — is Docker Desktop / dockerd running?",
      };
    }
  }

  /**
   * Pull the image explicitly if absent. `docker create` pulls implicitly,
   * but inside create's short timeout — a first run on a clean machine got
   * SIGTERMed mid-download (found by self-verify). Pulls get pull budgets.
   */
  private async ensureImage(): Promise<void> {
    try {
      await execFileAsync("docker", ["image", "inspect", this.image], { timeout: 30_000 });
    } catch {
      await execFileAsync("docker", ["pull", this.image], {
        timeout: 600_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    }
  }

  async session(workspacePath: string, options: SessionOptions): Promise<RunnerSession> {
    const name = `mantyl-${randomUUID()}`;
    await this.ensureImage();
    await execFileAsync(
      "docker",
      [
        "create",
        "--name",
        name,
        "--network",
        options.network ? "bridge" : "none",
        "--cpus",
        String(options.cpus ?? 2),
        "--memory",
        `${options.memoryMb ?? 4096}m`,
        "--workdir",
        "/work",
        this.image,
        "sleep",
        "infinity",
      ],
      { timeout: 60_000 }
    );
    try {
      const staging = await stageWorkspace(workspacePath);
      try {
        await execFileAsync("docker", ["cp", `${staging}/.`, `${name}:/work`], {
          timeout: 300_000,
          maxBuffer: 16 * 1024 * 1024,
        });
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      await execFileAsync("docker", ["start", name], { timeout: 60_000 });
    } catch (err) {
      execFile("docker", ["rm", "-f", name], () => undefined);
      throw err;
    }
    return new DockerSession(name, this.image);
  }

  async run(workspacePath: string, command: SandboxCommand): Promise<SandboxResult> {
    const name = `mantyl-${randomUUID()}`;
    const started = Date.now();
    await this.ensureImage();

    const createArgs = [
      "create",
      "--name",
      name,
      "--network",
      command.network ? "bridge" : "none",
      "--cpus",
      String(command.cpus ?? 2),
      "--memory",
      `${command.memoryMb ?? 2048}m`,
      "--workdir",
      "/work",
    ];
    for (const [key, value] of Object.entries(command.env ?? {})) {
      createArgs.push("--env", `${key}=${value}`);
    }
    createArgs.push(this.image, "sh", "-lc", command.command);

    try {
      await execFileAsync("docker", createArgs, { timeout: 60_000 });
      await execFileAsync("docker", ["cp", `${workspacePath}/.`, `${name}:/work`], {
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
      });

      const result = await new Promise<Omit<SandboxResult, "durationMs" | "envFingerprint">>(
        (resolvePromise) => {
          const child = spawn("docker", ["start", "-a", name]);
          let stdout = "";
          let stderr = "";
          let timedOut = false;

          const timer = setTimeout(() => {
            timedOut = true;
            execFile("docker", ["kill", name], () => undefined);
          }, command.timeoutMs);

          child.stdout.on("data", (chunk: Buffer) => {
            if (stdout.length < MAX_CAPTURE) stdout += chunk.toString("utf8");
          });
          child.stderr.on("data", (chunk: Buffer) => {
            if (stderr.length < MAX_CAPTURE) stderr += chunk.toString("utf8");
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            resolvePromise({
              exitCode: timedOut ? null : code,
              timedOut,
              stdout,
              stderr,
            });
          });
        }
      );

      return {
        ...result,
        durationMs: Date.now() - started,
        envFingerprint: `docker:${this.image}`,
      };
    } finally {
      execFile("docker", ["rm", "-f", name], () => undefined);
    }
  }
}

class DockerSession implements RunnerSession {
  private dead = false;
  constructor(
    private readonly name: string,
    private readonly image: string
  ) {}

  exec(command: SandboxCommand): Promise<SandboxResult> {
    if (this.dead) {
      return Promise.reject(new Error("sandbox session is closed (earlier timeout or close)"));
    }
    const started = Date.now();
    return new Promise((resolvePromise) => {
      const args = ["exec"];
      for (const [key, value] of Object.entries(command.env ?? {})) {
        args.push("--env", `${key}=${value}`);
      }
      args.push(this.name, "sh", "-lc", command.command);

      const child = spawn("docker", args);
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      // A timed-out exec kills the whole container: shared state is no
      // longer trustworthy, so the session dies with it.
      const timer = setTimeout(() => {
        timedOut = true;
        this.dead = true;
        execFile("docker", ["kill", this.name], () => undefined);
      }, command.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_CAPTURE) stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_CAPTURE) stderr += chunk.toString("utf8");
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolvePromise({
          exitCode: timedOut ? null : code,
          timedOut,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          envFingerprint: `docker:${this.image}`,
        });
      });
    });
  }

  async disconnectNetwork(): Promise<void> {
    // Already-disconnected (or network=none) sessions are fine — the goal
    // state "no network" is what matters, not the transition.
    await execFileAsync("docker", ["network", "disconnect", "bridge", this.name]).catch(
      () => undefined
    );
  }

  async close(): Promise<void> {
    this.dead = true;
    await new Promise<void>((resolvePromise) =>
      execFile("docker", ["rm", "-f", this.name], () => resolvePromise())
    );
  }
}
