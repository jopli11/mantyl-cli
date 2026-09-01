/**
 * @mantyl/adapter-codex — OpenAI Codex CLI session-store adapter (beta).
 *
 * Codex is OpenAI's coding agent (the "ChatGPT for code" with a real local
 * store; the ChatGPT desktop app keeps conversations in the cloud with no
 * project scoping, so Codex is the adapter-able surface). Layout observed
 * on real installations (Aug 2026):
 * - ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 * - line one is {type: "session_meta", payload: {id, cwd, ...}} — cwd is
 *   the project mapping
 * - messages are {type: "response_item", payload: {type: "message", role,
 *   content: [{type: "input_text" | "output_text", text}]}}; reasoning,
 *   tool calls and world_state lines are skipped, and role "developer"
 *   carries injected instructions rather than conversation
 *
 * Rules match the other adapters: caller-supplied redactor REQUIRED
 * (fail-closed), parsing fail-soft, output is the shared SessionRecord
 * contract so claims and decisions extraction work unchanged.
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Redactor, SessionMessage, SessionRecord } from "@mantyl/adapter-claude-code";

/** Fail-closed default: forces callers to make redaction explicit. */
const REFUSE: Redactor = () => {
  throw new Error(
    "adapter-codex: a redactor is required — pass redactText from @mantyl/core, " +
      "or an identity function if redaction is explicitly disabled by config"
  );
};

/** Codex CLI's session directory for this user. */
export function codexSessionsDir(home: string = homedir()): string {
  return join(home, ".codex", "sessions");
}

export interface CodexAvailability {
  available: boolean;
  reason?: string;
}

export async function codexAvailability(
  options: { codexSessionsDir?: string } = {}
): Promise<CodexAvailability> {
  const dir = options.codexSessionsDir ?? codexSessionsDir();
  try {
    await readdir(dir);
    return { available: true };
  } catch {
    return { available: false, reason: `no Codex CLI sessions found at ${dir}` };
  }
}

/** Normalise a path for comparison: forward slashes, lowercase on win32. */
function normalisePath(p: string): string {
  const forward = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? forward.toLowerCase() : forward;
}

interface SessionMetaLine {
  type?: string;
  timestamp?: string;
  payload?: { id?: string; session_id?: string; cwd?: string };
}

interface ResponseItemLine {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    id?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

/** Recursively list every rollout .jsonl under the sessions tree. */
async function listRolloutFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listRolloutFiles(full)));
    } else if (entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out.sort();
}

export async function collectCodexSessions(
  projectRoot: string,
  redact: Redactor = REFUSE,
  options: { codexSessionsDir?: string } = {}
): Promise<SessionRecord[]> {
  // Redaction is enforced before any store is touched.
  redact("");

  const dir = options.codexSessionsDir ?? codexSessionsDir();
  const target = normalisePath(resolve(projectRoot).split(sep).join("/"));
  const sessions: SessionRecord[] = [];

  for (const file of await listRolloutFiles(dir)) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    // The first line names the session and its working directory.
    let meta: SessionMetaLine;
    try {
      meta = JSON.parse(lines[0]!) as SessionMetaLine;
    } catch {
      continue;
    }
    if (meta.type !== "session_meta") continue;
    const cwd = meta.payload?.cwd;
    if (!cwd || normalisePath(cwd.split(sep).join("/")) !== target) continue;

    let malformedLines = 0;
    const messages: SessionMessage[] = [];
    for (const line of lines.slice(1)) {
      let entry: ResponseItemLine;
      try {
        entry = JSON.parse(line) as ResponseItemLine;
      } catch {
        malformedLines += 1;
        continue;
      }
      if (entry.type !== "response_item" || entry.payload?.type !== "message") continue;
      const role = entry.payload.role;
      // "developer" lines are injected instructions, not conversation.
      if (role !== "user" && role !== "assistant") continue;
      const text = (entry.payload.content ?? [])
        .map((c) => c.text ?? "")
        .filter((t) => t.length > 0)
        .join("\n")
        .trim();
      if (text.length === 0) continue;
      messages.push({
        id: entry.payload.id ?? `line-${messages.length}`,
        role,
        text: redact(text),
        timestamp: entry.timestamp ?? null,
      });
    }
    if (messages.length === 0) continue;

    sessions.push({
      sessionId: meta.payload?.id ?? meta.payload?.session_id ?? file,
      source: "codex",
      path: file,
      messages,
      malformedLines,
    });
  }

  sessions.sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
  return sessions;
}
