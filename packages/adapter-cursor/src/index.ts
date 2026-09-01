/**
 * @mantyl/adapter-cursor — Cursor session-store adapter (beta).
 *
 * Cursor's chat storage is UNDOCUMENTED and reverse-engineered from real
 * installations (Aug 2026 layout):
 * - {userDir}/workspaceStorage/{hash}/workspace.json maps a storage hash to
 *   a project folder URI
 * - {userDir}/workspaceStorage/{hash}/state.vscdb (SQLite, ItemTable) holds
 *   the key "composer.composerData" listing that workspace's composers
 * - {userDir}/globalStorage/state.vscdb (SQLite, cursorDiskKV) holds every
 *   message as a "bubbleId:{composerId}:{bubbleId}" row; type 1 is the
 *   user, type 2 the assistant, with text and createdAt fields
 *
 * Rules match the Claude Code adapter: a caller-supplied redactor is
 * REQUIRED (fail-closed), parsing is fail-soft, and everything maps into
 * the shared SessionRecord contract so claims and decisions extraction
 * work unchanged. SQLite comes from node:sqlite (Node 22.13+); on older
 * runtimes Cursor support reports itself unavailable instead of crashing.
 */

import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Redactor, SessionMessage, SessionRecord } from "@mantyl/adapter-claude-code";

/** Fail-closed default: forces callers to make redaction explicit. */
const REFUSE: Redactor = () => {
  throw new Error(
    "adapter-cursor: a redactor is required — pass redactText from @mantyl/core, " +
      "or an identity function if redaction is explicitly disabled by config"
  );
};

/** Cursor's per-user data directory for this platform. */
export function cursorUserDir(home: string = homedir()): string {
  if (process.platform === "win32") {
    return join(process.env["APPDATA"] ?? join(home, "AppData", "Roaming"), "Cursor", "User");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User");
  }
  return join(home, ".config", "Cursor", "User");
}

export interface CursorAvailability {
  available: boolean;
  reason?: string;
}

/** Whether this runtime and machine can read Cursor session stores. */
/**
 * The specifier is computed so bundlers cannot rewrite it: tsup/esbuild
 * strips the node: prefix from "node:sqlite" (no bare "sqlite" builtin
 * exists), which broke the published CLI while source builds passed.
 */
const SQLITE_SPECIFIER = ["node", "sqlite"].join(":");

export async function cursorAvailability(
  options: { cursorUserDir?: string } = {}
): Promise<CursorAvailability> {
  if ((await importSqlite()) === null) {
    return {
      available: false,
      reason: "reading Cursor stores needs Node 22.13 or newer (node:sqlite)",
    };
  }
  const dir = options.cursorUserDir ?? cursorUserDir();
  try {
    await readdir(join(dir, "workspaceStorage"));
    return { available: true };
  } catch {
    return { available: false, reason: `no Cursor installation found at ${dir}` };
  }
}

/* ------------------------------------------------------------ sqlite glue */

type SqliteModule = typeof import("node:sqlite");

/** Import node:sqlite without its experimental warning polluting CLI output. */
async function importSqlite(): Promise<SqliteModule | null> {
  const originalEmit = process.emitWarning.bind(process);
  (process as { emitWarning: typeof process.emitWarning }).emitWarning = ((
    warning: string | Error,
    ...rest: unknown[]
  ) => {
    if (String(warning instanceof Error ? warning.message : warning).includes("SQLite")) return;
    (originalEmit as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return (await import(SQLITE_SPECIFIER)) as SqliteModule;
  } catch {
    return null;
  } finally {
    (process as { emitWarning: typeof process.emitWarning }).emitWarning = originalEmit;
  }
}

/**
 * Open a Cursor database read-only. Cursor holds these open while running,
 * so a direct read-only open is tried first and a temp copy is the
 * fallback; the caller always gets a close() that also removes any copy.
 */
async function openDatabase(
  sqlite: SqliteModule,
  path: string
): Promise<{ db: InstanceType<SqliteModule["DatabaseSync"]>; close: () => Promise<void> } | null> {
  try {
    const db = new sqlite.DatabaseSync(path, { readOnly: true });
    return { db, close: async () => db.close() };
  } catch {
    try {
      const dir = await mkdtemp(join(tmpdir(), "mantyl-cursor-"));
      const copy = join(dir, "state.vscdb");
      await copyFile(path, copy);
      const db = new sqlite.DatabaseSync(copy, { readOnly: true });
      return {
        db,
        close: async () => {
          db.close();
          await rm(dir, { recursive: true, force: true });
        },
      };
    } catch {
      return null;
    }
  }
}

/* --------------------------------------------------------- workspace match */

/** Normalise a path for comparison: forward slashes, lowercase on win32. */
function normalisePath(p: string): string {
  const forward = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? forward.toLowerCase() : forward;
}

/** Parse Cursor's workspace.json folder URI into a comparable path. */
function folderUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let rest = decodeURIComponent(uri.slice("file://".length));
  rest = rest.replace(/^\/+/, "");
  // Windows drive letters arrive as "c:/Users/…"; POSIX paths need the
  // leading slash restored.
  if (!/^[a-zA-Z]:/.test(rest)) rest = `/${rest}`;
  return normalisePath(rest);
}

/**
 * Find every workspaceStorage hash directory for a project. Real
 * installations map one folder to SEVERAL storage dirs (re-opens across
 * Cursor versions), each holding part of the history — first-match loses
 * sessions.
 */
async function findWorkspaceDirs(
  storageRoot: string,
  projectRoot: string
): Promise<string[]> {
  const target = normalisePath(resolve(projectRoot).split(sep).join("/"));
  let entries: string[];
  try {
    entries = await readdir(storageRoot);
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const entry of entries) {
    try {
      const raw = await readFile(join(storageRoot, entry, "workspace.json"), "utf8");
      const folder = (JSON.parse(raw) as { folder?: string }).folder;
      if (folder && folderUriToPath(folder) === target) {
        matches.push(join(storageRoot, entry));
      }
    } catch {
      // no workspace.json or malformed — not a match, never fatal
    }
  }
  return matches.sort();
}

/* ------------------------------------------------------------- collection */

interface ComposerEntry {
  composerId: string;
  name?: string;
  createdAt?: number;
}

interface BubbleRow {
  type?: number;
  text?: string;
  bubbleId?: string;
  createdAt?: number | string;
}

export async function collectCursorSessions(
  projectRoot: string,
  redact: Redactor = REFUSE,
  options: { cursorUserDir?: string } = {}
): Promise<SessionRecord[]> {
  // Redaction is enforced before any store is touched.
  redact("");

  const sqlite = await importSqlite();
  if (sqlite === null) return [];

  const userDir = options.cursorUserDir ?? cursorUserDir();
  const workspaceDirs = await findWorkspaceDirs(join(userDir, "workspaceStorage"), projectRoot);
  if (workspaceDirs.length === 0) return [];

  // 1. The composer index, unioned across every storage dir for the project.
  const byId = new Map<string, ComposerEntry>();
  for (const workspaceDir of workspaceDirs) {
    const wsHandle = await openDatabase(sqlite, join(workspaceDir, "state.vscdb"));
    if (wsHandle === null) continue;
    try {
      const row = wsHandle.db
        .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
        .get() as { value?: string | Uint8Array } | undefined;
      if (row?.value) {
        const text =
          typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
        const data = JSON.parse(text) as { allComposers?: ComposerEntry[] };
        for (const c of data.allComposers ?? []) {
          if (typeof c.composerId === "string" && !byId.has(c.composerId)) {
            byId.set(c.composerId, c);
          }
        }
      }
    } catch {
      // malformed index in one storage dir — the others still count
    } finally {
      await wsHandle.close();
    }
  }
  const composers = [...byId.values()];
  if (composers.length === 0) return [];

  // 2. Messages from the global store, one query per composer.
  const globalHandle = await openDatabase(
    sqlite,
    join(userDir, "globalStorage", "state.vscdb")
  );
  if (globalHandle === null) return [];

  const sessions: SessionRecord[] = [];
  try {
    const stmt = globalHandle.db.prepare(
      "SELECT key, value FROM cursorDiskKV WHERE key LIKE ? ESCAPE '\\'"
    );
    for (const composer of composers) {
      const escaped = composer.composerId.replace(/[\\%_]/g, (ch) => `\\${ch}`);
      let rows: Array<{ key: string; value: string | Uint8Array }>;
      try {
        rows = stmt.all(`bubbleId:${escaped}:%`) as Array<{
          key: string;
          value: string | Uint8Array;
        }>;
      } catch {
        continue;
      }
      let malformedLines = 0;
      const messages: SessionMessage[] = [];
      for (const row of rows) {
        try {
          const text =
            typeof row.value === "string" ? row.value : Buffer.from(row.value).toString("utf8");
          const bubble = JSON.parse(text) as BubbleRow;
          if (bubble.type !== 1 && bubble.type !== 2) continue;
          const content = (bubble.text ?? "").trim();
          if (content.length === 0) continue; // tool-only bubbles carry no prose
          const created = typeof bubble.createdAt === "number" ? bubble.createdAt : null;
          messages.push({
            id: bubble.bubbleId ?? row.key.split(":")[2] ?? `row-${messages.length}`,
            role: bubble.type === 1 ? "user" : "assistant",
            text: redact(content),
            timestamp: created !== null ? new Date(created).toISOString() : null,
          });
        } catch {
          malformedLines += 1;
        }
      }
      if (messages.length === 0) continue;
      messages.sort((a, b) => (a.timestamp ?? "9999").localeCompare(b.timestamp ?? "9999"));
      sessions.push({
        sessionId: composer.composerId,
        source: "cursor",
        path: join(userDir, "globalStorage", "state.vscdb"),
        messages,
        malformedLines,
      });
    }
  } finally {
    await globalHandle.close();
  }

  sessions.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
  return sessions;
}
