/**
 * @mantyl/collectors-repository — immutable repository observations (spec §4).
 * Everything here is directly observable in the working tree and carries a
 * SourceRef. No interpretation, no LLM, no network.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { SourceRef } from "@mantyl/schema";

export interface FileEntry {
  path: string;
  size: number;
  /** Whether git tracks this file (absent when git state is unknown). */
  tracked?: boolean;
}

export interface EnvReference {
  name: string;
  refs: SourceRef[];
}

export interface TodoEntry {
  text: string;
  ref: SourceRef;
}

export interface PackageJsonObservation {
  name: string | null;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  packageManager: string | null;
  ref: SourceRef;
}

export interface RepositoryObservation {
  files: FileEntry[];
  fileCount: number;
  truncated: boolean;
  packageJson: PackageJsonObservation | null;
  lockfile: "pnpm" | "npm" | "yarn" | "bun" | null;
  hasTsconfig: boolean;
  readmePath: string | null;
  envReferences: EnvReference[];
  /** Variable names documented in .env.example (null when absent). */
  envDocumented: { path: string; names: string[] } | null;
  todos: TodoEntry[];
  ciConfigPaths: string[];
  migrationPaths: string[];
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  ".mantyl",
  ".vercel",
  ".turbo",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

const MAX_FILES = 10_000;
const MAX_SCAN_BYTES = 1_000_000;

export interface CollectRepositoryOptions {
  /** POSIX glob patterns (relative to root) to exclude from collection. */
  exclude?: string[];
}

/**
 * Minimal glob → RegExp: supports "**" (any depth), "*" (within a segment)
 * and "?" (single char). Deliberately small — no dependency, no surprises.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more whole segments; trailing "**" matches rest
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`^${out}$`);
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function extOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx);
}

const ENV_DOC_FILES = new Set([".env.example", ".env.sample", ".env.template"]);

/**
 * Secret-bearing env files never enter the walk: they are local-machine
 * state, and listing them (or hashing them into the manifest) would make
 * every receive diverge on a file the recipient must never have anyway.
 * The documented example/sample/template variants stay — they are docs.
 */
function isSecretEnvFile(name: string): boolean {
  return name === ".env" || (name.startsWith(".env.") && !ENV_DOC_FILES.has(name));
}

async function walk(root: string): Promise<{ files: FileEntry[]; truncated: boolean }> {
  const files: FileEntry[] = [];
  const queue: string[] = [root];
  let truncated = false;
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return { files, truncated };
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSecretEnvFile(entry.name)) continue;
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      files.push({ path: toPosix(relative(root, full)), size: info.size });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, truncated };
}

async function readPackageJson(root: string): Promise<PackageJsonObservation | null> {
  try {
    const raw = await readFile(join(root, "package.json"), "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    return {
      name: typeof data.name === "string" ? data.name : null,
      scripts:
        typeof data.scripts === "object" && data.scripts !== null
          ? (data.scripts as Record<string, string>)
          : {},
      dependencies: Object.keys((data.dependencies as object) ?? {}),
      devDependencies: Object.keys((data.devDependencies as object) ?? {}),
      packageManager: typeof data.packageManager === "string" ? data.packageManager : null,
      ref: { kind: "file", path: "package.json" },
    };
  } catch {
    return null;
  }
}

async function detectLockfile(root: string): Promise<RepositoryObservation["lockfile"]> {
  const candidates: Array<[string, RepositoryObservation["lockfile"]]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["package-lock.json", "npm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
  ];
  for (const [file, kind] of candidates) {
    const isFile = await stat(join(root, file)).then(
      (s) => s.isFile(),
      () => false
    );
    if (isFile) return kind;
  }
  return null;
}

function scanSource(
  path: string,
  content: string,
  envRefs: Map<string, SourceRef[]>,
  todos: TodoEntry[]
): void {
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    // Matches both dot and bracket-quoted env access forms. (Worded this way
    // so the scanner never matches its own comment when scanning itself.)
    const envAccess = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])/g;
    for (const match of line.matchAll(envAccess)) {
      const name = (match[1] ?? match[2])!;
      const refs = envRefs.get(name) ?? [];
      refs.push({ kind: "file", path, lines: [lineNo, lineNo] });
      envRefs.set(name, refs);
    }
    const todo = /(?:\/\/|\/\*|#|\*)\s*(TODO|FIXME)[:\s](.{0,160})/.exec(line);
    if (todo) {
      todos.push({
        text: `${todo[1]}: ${todo[2]!.trim()}`,
        ref: { kind: "file", path, lines: [lineNo, lineNo] },
      });
    }
  }
}

async function readEnvExample(root: string): Promise<RepositoryObservation["envDocumented"]> {
  for (const candidate of [".env.example", ".env.sample", ".env.template"]) {
    try {
      const raw = await readFile(join(root, candidate), "utf8");
      const names = raw
        .split(/\r?\n/)
        .map((line) => /^([A-Z][A-Z0-9_]*)\s*=/.exec(line.trim())?.[1])
        .filter((name): name is string => Boolean(name));
      return { path: candidate, names };
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

export async function collectRepository(
  projectRoot: string,
  options: CollectRepositoryOptions = {}
): Promise<RepositoryObservation> {
  const walked = await walk(projectRoot);
  const excludePatterns = (options.exclude ?? []).map(globToRegExp);
  const files =
    excludePatterns.length === 0
      ? walked.files
      : walked.files.filter((f) => !excludePatterns.some((re) => re.test(f.path)));
  const truncated = walked.truncated;

  const envRefs = new Map<string, SourceRef[]>();
  const todos: TodoEntry[] = [];
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(extOf(file.path)) || file.size > MAX_SCAN_BYTES) continue;
    const content = await readFile(join(projectRoot, file.path), "utf8").catch(() => null);
    if (content !== null) scanSource(file.path, content, envRefs, todos);
  }

  const paths = files.map((f) => f.path);
  const ciConfigPaths = paths.filter(
    (p) =>
      p.startsWith(".github/workflows/") ||
      p === ".gitlab-ci.yml" ||
      p === ".circleci/config.yml" ||
      p === "azure-pipelines.yml"
  );
  const migrationPaths = paths.filter((p) => /(^|\/)(migrations?|prisma\/migrations)\//i.test(p));
  const readmePath = paths.find((p) => /^readme\.(md|txt)$/i.test(p)) ?? null;

  return {
    files,
    fileCount: files.length,
    truncated,
    packageJson: await readPackageJson(projectRoot),
    lockfile: await detectLockfile(projectRoot),
    hasTsconfig: paths.includes("tsconfig.json"),
    readmePath,
    envReferences: [...envRefs.entries()]
      .map(([name, refs]) => ({ name, refs }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
    envDocumented: await readEnvExample(projectRoot),
    todos,
    ciConfigPaths,
    migrationPaths,
  };
}
