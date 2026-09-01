/**
 * Decision extraction — WHAT WAS CHOSEN, the third strand of the handover
 * story beside facts (what the repository shows) and claims (what was said
 * to be done). Sources: session transcripts via the adapter. Statuses map by
 * who is on record — the agent (agent-reported) or the creator, whose own
 * recorded words are creator-confirmed. No decision is ever verified: choices
 * are attested, not executed.
 */

import type { SourceRef } from "@mantyl/schema";
import type { SessionRecord } from "@mantyl/adapter-claude-code";
import { extractDecisions as extractSessionDecisions } from "@mantyl/adapter-claude-code";

export interface DecisionCandidate {
  id: string;
  title: string;
  rationale: string;
  origin: "agent" | "creator";
  /** ISO date (YYYY-MM-DD) of the recorded statement, when known. */
  date?: string;
  refs: SourceRef[];
}

const MAX_DECISIONS = 20;

export function decisionsFromSessions(sessions: SessionRecord[]): DecisionCandidate[] {
  // Cross-session dedup: continued sessions replay earlier messages in their
  // summaries, so the same decision surfaces repeatedly (and sometimes with
  // different truncation). Key on a normalised title prefix; keep the
  // EARLIEST dated occurrence — that is when the decision was made.
  const byKey = new Map<string, DecisionCandidate>();
  // One message can yield several decisions — ids carry a per-message ordinal.
  const perMessage = new Map<string, number>();
  for (const session of sessions) {
    for (const decision of extractSessionDecisions(session)) {
      const date = decision.timestamp?.slice(0, 10);
      const messageKey = `${decision.sessionId}:${decision.messageId}`;
      const ordinal = perMessage.get(messageKey) ?? 0;
      perMessage.set(messageKey, ordinal + 1);
      const candidate: DecisionCandidate = {
        id: `decision:${decision.origin}:${messageKey}:${ordinal}`,
        title: decision.title,
        rationale: decision.rationale,
        origin: decision.origin,
        ...(date ? { date } : {}),
        refs: [
          {
            kind: "session",
            sessionId: decision.sessionId,
            messageId: decision.messageId,
          },
        ],
      };
      const key = `${decision.origin}:${decision.title.toLowerCase().slice(0, 60)}`;
      const existing = byKey.get(key);
      if (
        existing === undefined ||
        (candidate.date ?? "9999") < (existing.date ?? "9999") ||
        ((candidate.date ?? "") === (existing.date ?? "") && candidate.id < existing.id)
      ) {
        byKey.set(key, candidate);
      }
    }
  }
  // Long transcripts produce far more decision candidates than a recipient
  // can absorb (first-user data: 26 from a five-month chat). Keep the most
  // substantial ones, judged by how much the statement actually says.
  let selected = [...byKey.values()];
  if (selected.length > MAX_DECISIONS) {
    selected = selected
      .sort((a, b) => b.rationale.length - a.rationale.length || (a.id < b.id ? -1 : 1))
      .slice(0, MAX_DECISIONS);
  }

  // Chronological order — the decision log reads as the project's history.
  return selected.sort(
    (a, b) => (a.date ?? "").localeCompare(b.date ?? "") || (a.id < b.id ? -1 : 1)
  );
}
