/**
 * Run context — the immutable frame every workflow executes in
 * (architecture spec §5 step 1).
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { loadConfig, type ResolvedConfig } from "@mantyl/config";

const execFileAsync = promisify(execFile);

export interface RunContext {
  toolVersion: string;
  projectRoot: string;
  /** HEAD commit sha, or null when the directory is not a Git repository. */
  commit: string | null;
  /** Whether the working tree has uncommitted changes (false when not a repo). */
  dirty: boolean;
  config: ResolvedConfig;
  startedAt: Date;
}

export interface RunContextOptions {
  toolVersion: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

async function gitState(projectRoot: string): Promise<{ commit: string | null; dirty: boolean }> {
  try {
    const { stdout: sha } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
    });
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: projectRoot,
    });
    return { commit: sha.trim(), dirty: status.trim().length > 0 };
  } catch {
    // Not a git repository, git missing, or a repo with no commits yet —
    // all legitimate states for scan; recorded honestly as commit: null.
    return { commit: null, dirty: false };
  }
}

export async function createRunContext(
  projectRoot: string,
  options: RunContextOptions
): Promise<RunContext> {
  const rootStat = await stat(projectRoot).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`not a directory: ${projectRoot}`);
  }
  const [config, git] = await Promise.all([loadConfig(projectRoot), gitState(projectRoot)]);
  return {
    toolVersion: options.toolVersion,
    projectRoot,
    commit: git.commit,
    dirty: git.dirty,
    config,
    startedAt: (options.now ?? (() => new Date()))(),
  };
}
