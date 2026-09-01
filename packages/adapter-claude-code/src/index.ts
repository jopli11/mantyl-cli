/**
 * @mantyl/adapter-claude-code — Claude Code session-store adapter (spec §4).
 * Parses local Claude Code project transcripts (JSONL) into normalised
 * session records, and extracts candidate claims as AGENT-REPORTED material.
 *
 * Rules:
 * - transcripts are sensitive: all extracted text passes through the caller-
 *   supplied redactor BEFORE leaving this module (fail-closed: the default
 *   redactor throws rather than silently passing text through)
 * - parsing is fail-soft: malformed lines are counted, never fatal
 * - claims extracted here are candidates with refs; truth status is assigned
 *   by the reconciler, never here
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export interface SessionMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string | null;
}

export interface SessionRecord {
  sessionId: string;
  /** Which agent's store produced this session (adapters share the contract). */
  source: "claude-code" | "cursor" | "codex";
  path: string;
  messages: SessionMessage[];
  /** Lines that could not be parsed — recorded, not hidden. */
  malformedLines: number;
}

export interface AgentClaim {
  text: string;
  sessionId: string;
  messageId: string;
}

export type Redactor = (text: string) => string;

/** Fail-closed default: forces callers to make redaction explicit. */
const REFUSE: Redactor = () => {
  throw new Error(
    "adapter-claude-code: a redactor is required — pass redactText from @mantyl/core, " +
      "or an identity function if redaction is explicitly disabled by config"
  );
};

/**
 * Claude Code stores project transcripts under
 * ~/.claude/projects/<munged-absolute-path>/<session>.jsonl where the path is
 * munged by replacing every path separator (and colon) with "-".
 */
export function claudeProjectDir(projectRoot: string, home: string = homedir()): string {
  const munged = resolve(projectRoot).split(sep).join("-").replace(/[:.]/g, "-");
  return join(home, ".claude", "projects", munged);
}

export async function listSessionFiles(
  projectRoot: string,
  options: { home?: string; sessionDir?: string } = {}
): Promise<string[]> {
  const dir = options.sessionDir ?? claudeProjectDir(projectRoot, options.home);
  try {
    const entries = await readdir(dir);
    return entries
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

interface TranscriptLine {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

/** Flatten Claude message content (string or content-block array) to text. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const b = block as { type?: string; text?: string };
      return b.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

export async function parseSessionFile(
  path: string,
  redact: Redactor = REFUSE
): Promise<SessionRecord> {
  const raw = await readFile(path, "utf8");
  const messages: SessionMessage[] = [];
  let sessionId = "";
  let malformedLines = 0;

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let entry: TranscriptLine;
    try {
      entry = JSON.parse(line) as TranscriptLine;
    } catch {
      malformedLines += 1;
      continue;
    }
    if (entry.sessionId && !sessionId) sessionId = entry.sessionId;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = contentToText(entry.message?.content);
    if (text.length === 0) continue;
    messages.push({
      id: entry.uuid ?? `line-${messages.length}`,
      role,
      text: redact(text),
      timestamp: entry.timestamp ?? null,
    });
  }

  return {
    sessionId: sessionId || path,
    source: "claude-code",
    path,
    messages,
    malformedLines,
  };
}

export async function collectSessions(
  projectRoot: string,
  redact: Redactor,
  options: { home?: string; sessionDir?: string } = {}
): Promise<SessionRecord[]> {
  const files = await listSessionFiles(projectRoot, options);
  return Promise.all(files.map((file) => parseSessionFile(file, redact)));
}

/**
 * Heuristic candidate-claim extraction from assistant messages: first-person
 * completed-work statements. Deliberately conservative — the reconciler and
 * (optionally) the LLM analysis adapter refine these; nothing here assigns a
 * truth status.
 *
 * Quote-aware: a match inside quotation marks, backticks or code blocks is a
 * QUOTATION (the assistant talking *about* a claim), not an assertion — those
 * are skipped. Learned from dogfooding: transcripts that discuss claims must
 * not mint them.
 */
const CLAIM_PATTERN =
  /\bI(?:'ve| have)? (?:now )?(added|implemented|enabled|configured|set up|created|fixed|wired|integrated|deployed)\b[^.!\n]{3,140}/gi;

/** Placeholder for stripped code spans (U+E000, private use) — invisible in most editors; also acts as a skip marker. */
const CODE_MARK = "";

/** Characters that mark the match as quoted/narrated rather than asserted. */
const QUOTE_CHARS = new Set(['"', "'", "“", "‘", "«", "`", "(", CODE_MARK]);

function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, CODE_MARK) // fenced blocks
    .replace(/`[^`\n]*`/g, CODE_MARK); // inline spans
}

function isQuoted(text: string, matchIndex: number): boolean {
  for (let i = matchIndex - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t") continue;
    return QUOTE_CHARS.has(ch) || insideQuotes(text, matchIndex);
  }
  return false;
}

/**
 * Quote-parity check: a match that starts mid-sentence INSIDE a quoted span
 * (an odd number of straight quotes before it, or an unclosed curly quote)
 * is someone being quoted, not someone deciding. The immediate-lookback
 * check misses these — found by dogfooding against real session summaries.
 */
function insideQuotes(text: string, matchIndex: number): boolean {
  let straight = 0;
  let curly = 0;
  for (let i = 0; i < matchIndex; i++) {
    const ch = text[i]!;
    if (ch === '"') straight += 1;
    else if (ch === "“") curly += 1;
    else if (ch === "”") curly -= 1;
  }
  return straight % 2 === 1 || curly > 0;
}

export function extractClaims(session: SessionRecord): AgentClaim[] {
  const claims: AgentClaim[] = [];
  for (const message of session.messages) {
    if (message.role !== "assistant") continue;
    const text = stripCode(message.text);
    for (const match of text.matchAll(CLAIM_PATTERN)) {
      if (isQuoted(text, match.index)) continue;
      if (match[0].includes(CODE_MARK)) continue;
      claims.push({
        text: match[0].trim(),
        sessionId: session.sessionId,
        messageId: message.id,
      });
    }
  }
  return claims;
}

export interface SessionDecision {
  /** The choice itself — the statement up to any stated rationale. */
  title: string;
  /** The full statement including "because …" when present. */
  rationale: string;
  /** Who is on record: the agent, or the creator (user messages). */
  origin: "agent" | "creator";
  sessionId: string;
  messageId: string;
  timestamp: string | null;
}

/**
 * Heuristic decision extraction — WHAT WAS CHOSEN, kept apart from claims
 * (what was done). Assistant statements are the agent on record; user
 * statements are the creator on record. Same quote-awareness as claims:
 * discussing a decision is not making one.
 */
const AGENT_DECISION_PATTERN =
  /\b(?:I|we)(?:'ve| have|'ll| will)? ?(?:decided(?: to| on| against)?|chose|opted(?: for| to)?|settled on|went with|(?:am|are)? ?going with)\b[^.!\n]{3,180}/gi;

const CREATOR_DECISION_PATTERNS = [
  /\blets?(?:'s)? (?:go with|use|switch to|stick with|pick|drop)\b[^.!\n]{3,180}/gi,
  /\bI want (?:this|it|us)? ?to\b[^.!\n]{3,180}/gi,
  /\bwe(?:'re| are) (?:rebranding|switching|pivoting|moving)\b[^.!\n]{3,180}/gi,
];

const RATIONALE_SPLIT = /\s+(?:because|since|so that)\s+/i;

function decisionFromMatch(
  matched: string,
  origin: SessionDecision["origin"],
  session: SessionRecord,
  message: SessionMessage
): SessionDecision {
  const statement = matched.trim();
  const split = RATIONALE_SPLIT.exec(statement);
  return {
    title: (split ? statement.slice(0, split.index) : statement).slice(0, 140).trim(),
    rationale: statement,
    origin,
    sessionId: session.sessionId,
    messageId: message.id,
    timestamp: message.timestamp,
  };
}

/**
 * Conversational openers after "I want to …" that signal talk, not a
 * decision. Real first-user data: "i want to read it", "I want to ask you a
 * serious question" and similar minted decisions from a five-month
 * transcript. Wanting to discuss something is not deciding something.
 */
const CONVERSATIONAL_OPENER =
  /^(?:ask|read|see|check|discuss|talk|chat|know|understand|look|show|hear|go(?: through| over| on)?|move on)\b/i;

function isSubstantiveDecision(decision: SessionDecision): boolean {
  const title = decision.title.toLowerCase();
  const tail = title.replace(/^.*?\bto\s+/, "").replace(/^(?:go with|use|switch to|stick with|pick|drop)\s+/, "");
  if (CONVERSATIONAL_OPENER.test(tail)) return false;
  // A choice needs an object: at least four words of actual content.
  return tail.trim().split(/\s+/).length >= 4;
}

export function extractDecisions(session: SessionRecord): SessionDecision[] {
  const decisions: SessionDecision[] = [];
  const seen = new Set<string>();
  for (const message of session.messages) {
    const text = stripCode(message.text);
    const patterns =
      message.role === "assistant" ? [AGENT_DECISION_PATTERN] : CREATOR_DECISION_PATTERNS;
    const origin = message.role === "assistant" ? ("agent" as const) : ("creator" as const);
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (isQuoted(text, match.index)) continue;
        if (match[0].includes(CODE_MARK)) continue;
        const decision = decisionFromMatch(match[0], origin, session, message);
        if (!isSubstantiveDecision(decision)) continue;
        const key = decision.title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        decisions.push(decision);
      }
    }
  }
  return decisions;
}
