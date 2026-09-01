import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@mantyl/adapter-claude-code";
import { decisionsFromSessions } from "./decisions.js";

function session(id: string, messages: Array<[string, "user" | "assistant", string, string]>): SessionRecord {
  return {
    sessionId: id,
    source: "claude-code",
    path: `${id}.jsonl`,
    malformedLines: 0,
    messages: messages.map(([mid, role, text, timestamp]) => ({
      id: mid,
      role,
      text,
      timestamp,
    })),
  };
}

describe("decisionsFromSessions", () => {
  it("dedupes replayed decisions across sessions, keeping the earliest", () => {
    const original = session("s1", [
      ["m1", "user", "lets go with Next.js for the site build", "2026-07-15T10:00:00.000Z"],
    ]);
    // A continued session replays the decision (differently truncated).
    const continuation = session("s2", [
      ["m1", "user", "lets go with Next.js for the site build please", "2026-07-20T09:00:00.000Z"],
    ]);

    const decisions = decisionsFromSessions([continuation, original]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.date).toBe("2026-07-15");
    expect(decisions[0]?.refs[0]).toMatchObject({ sessionId: "s1" });
  });

  it("orders the decision log chronologically", () => {
    const s = session("s1", [
      ["m1", "user", "lets go with pnpm workspaces across the whole repo", "2026-07-18T10:00:00.000Z"],
      ["m2", "user", "lets switch to a single monorepo layout for everything", "2026-07-16T10:00:00.000Z"],
    ]);
    const decisions = decisionsFromSessions([s]);
    expect(decisions.map((d) => d.date)).toEqual(["2026-07-16", "2026-07-18"]);
  });
});
