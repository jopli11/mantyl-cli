/**
 * Claim extraction (spec §4) — what someone SAID, kept strictly apart from
 * facts. Sources: agent transcripts (via the adapter) and assertive README
 * statements. No truth status is assigned here — that is the reconciler's
 * job (M5).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceRef } from "@mantyl/schema";
import type { AgentClaim, SessionRecord } from "@mantyl/adapter-claude-code";
import { extractClaims as extractAgentClaims } from "@mantyl/adapter-claude-code";

export interface ClaimCandidate {
  id: string;
  text: string;
  origin: "agent" | "readme";
  refs: SourceRef[];
}

export function claimsFromSessions(sessions: SessionRecord[]): ClaimCandidate[] {
  // Continued sessions replay earlier messages, minting the same claim
  // repeatedly (first-user data: identical claims three times over). Key on
  // normalised text; the first occurrence wins.
  const byText = new Map<string, ClaimCandidate>();
  for (const session of sessions) {
    const agentClaims: AgentClaim[] = extractAgentClaims(session);
    agentClaims.forEach((claim, index) => {
      const key = claim.text.toLowerCase().replace(/\s+/g, " ").slice(0, 80);
      if (byText.has(key)) return;
      byText.set(key, {
        id: `claim:agent:${claim.sessionId}:${claim.messageId}:${index}`,
        text: claim.text,
        origin: "agent",
        refs: [{ kind: "session", sessionId: claim.sessionId, messageId: claim.messageId }],
      });
    });
  }
  return [...byText.values()];
}

/**
 * Assertive present-tense statements in the README ("X is/are <past
 * participle>") — the classic shape of unverified documentation claims.
 * Deliberately conservative; commands and prose descriptions are ignored.
 */
const README_CLAIM = /\b(?:is|are)\s+(?:\w+\s){0,2}?\w+(?:ed|ted|ised|ized)\b[^.\n]*/i;

export async function claimsFromReadme(
  projectRoot: string,
  readmePath: string | null
): Promise<ClaimCandidate[]> {
  if (!readmePath) return [];
  const raw = await readFile(join(projectRoot, readmePath), "utf8").catch(() => null);
  if (raw === null) return [];
  const claims: ClaimCandidate[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Only bullet/plain sentences — skip code blocks and headings.
    if (/^\s*(#|```|\||>)/.test(line)) continue;
    const cleaned = line.replace(/<!--.*?-->/g, "").trim();
    const match = README_CLAIM.exec(cleaned);
    if (!match) continue;
    const sentence = cleaned.replace(/^[-*+]\s*/, "").trim();
    if (sentence.length < 12 || sentence.length > 240) continue;
    claims.push({
      id: `claim:readme:${i + 1}`,
      text: sentence,
      origin: "readme",
      refs: [{ kind: "file", path: readmePath, lines: [i + 1, i + 1] }],
    });
  }
  return claims;
}
