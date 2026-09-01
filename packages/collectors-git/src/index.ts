/**
 * @mantyl/collectors-git — immutable Git observations (spec §4).
 * Observations record what IS, with source references; interpretation
 * happens downstream in the reconciler.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SourceRef } from "@mantyl/schema";

const execFileAsync = promisify(execFile);

export interface CommitObservation {
  sha: string;
  author: string;
  date: string;
  subject: string;
  ref: SourceRef;
}

export interface GitObservation {
  isRepo: boolean;
  head: { sha: string; dirty: boolean } | null;
  /** Most recent first, capped by options.limit. */
  commits: CommitObservation[];
  /** Total commit count on HEAD (null when unknown). */
  commitCount: number | null;
  firstCommitDate: string | null;
  lastCommitDate: string | null;
}

export interface CollectGitOptions {
  /** Maximum commits to include in detail (default 50). */
  limit?: number;
}

const FIELD_SEP = "";
const RECORD_SEP = "";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/**
 * POSIX paths of every git-tracked file (empty when not a repository).
 * Downstream consumers use this to distinguish the delivered repository
 * from local-machine state sitting in the same directory.
 */
export async function listTrackedFiles(projectRoot: string): Promise<Set<string>> {
  try {
    const out = await git(projectRoot, ["ls-files", "-z"]);
    return new Set(out.split("\0").filter((p) => p.length > 0));
  } catch {
    return new Set();
  }
}

export async function collectGit(
  projectRoot: string,
  options: CollectGitOptions = {}
): Promise<GitObservation> {
  const limit = options.limit ?? 50;
  let headSha: string;
  try {
    headSha = (await git(projectRoot, ["rev-parse", "HEAD"])).trim();
  } catch {
    return {
      isRepo: false,
      head: null,
      commits: [],
      commitCount: null,
      firstCommitDate: null,
      lastCommitDate: null,
    };
  }

  const [status, log, countRaw] = await Promise.all([
    git(projectRoot, ["status", "--porcelain"]),
    git(projectRoot, [
      "log",
      `--max-count=${limit}`,
      `--pretty=format:%H${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s${RECORD_SEP}`,
    ]),
    git(projectRoot, ["rev-list", "--count", "HEAD"]).catch(() => null),
  ]);

  const commits: CommitObservation[] = log
    .split(RECORD_SEP)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", author = "", date = "", subject = ""] = record.split(FIELD_SEP);
      return { sha, author, date, subject, ref: { kind: "commit", sha } as const };
    })
    .filter((c) => c.sha.length >= 7);

  return {
    isRepo: true,
    head: { sha: headSha, dirty: status.trim().length > 0 },
    commits,
    commitCount: countRaw === null ? null : Number(countRaw.trim()),
    firstCommitDate: commits.length > 0 ? (commits[commits.length - 1]?.date ?? null) : null,
    lastCommitDate: commits[0]?.date ?? null,
  };
}
