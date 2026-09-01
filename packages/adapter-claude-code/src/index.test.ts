import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractClaims, extractDecisions, parseSessionFile } from "./index.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/sample-session.jsonl", import.meta.url));

/**
 * Minimal test redactor. The adapter package deliberately does NOT depend on
 * @mantyl/core (that would create a workspace dependency cycle — core depends
 * on this adapter); in production, core supplies its full redactor here.
 */
const redactor = (text: string): string =>
  text.replace(/\bsk-ant-[A-Za-z0-9_-]{10,}/g, "[REDACTED:test-key]");

describe("adapter-claude-code", () => {
  it("refuses to run without an explicit redactor (fail-closed)", async () => {
    await expect(parseSessionFile(FIXTURE)).rejects.toThrow(/redactor is required/);
  });

  it("parses sessions fail-soft and redacts transcript content", async () => {
    const session = await parseSessionFile(FIXTURE, redactor);
    expect(session.sessionId).toBe("fixture-session-01");
    expect(session.messages).toHaveLength(6);
    expect(session.malformedLines).toBe(1);

    // The planted API key in the user message must not survive.
    const allText = session.messages.map((m) => m.text).join("\n");
    expect(allText).not.toContain("sk-ant-api03-verysecretfixturevalue0001");
    expect(allText).toContain("[REDACTED:");
  });

  it("skips quoted and code-context claims — discussing a claim is not asserting it", async () => {
    const session = {
      sessionId: "s-quote",
      source: "claude-code" as const,
      path: "test.jsonl",
      malformedLines: 0,
      messages: [
        {
          id: "m1",
          role: "assistant" as const,
          timestamp: null,
          text: 'The fixture plants the claim "I implemented rate limiting" which the repo contradicts.',
        },
        {
          id: "m2",
          role: "assistant" as const,
          timestamp: null,
          text: "Note that `I added retries` appears only in a code comment.",
        },
        {
          id: "m3",
          role: "assistant" as const,
          timestamp: null,
          text: "```\nI configured the deploy pipeline\n```",
        },
        {
          id: "m4",
          role: "assistant" as const,
          timestamp: null,
          text: "Done — I added bearer-token auth to the server module.",
        },
      ],
    };
    const claims = extractClaims(session);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.text).toContain("bearer-token auth");
    expect(claims[0]?.messageId).toBe("m4");
  });

  it("extracts decisions from both roles with origin — quote-aware", async () => {
    const session = await parseSessionFile(FIXTURE, redactor);
    const decisions = extractDecisions(session);

    const agent = decisions.find((d) => d.origin === "agent");
    expect(agent?.title).toContain("in-memory Map over Postgres");
    // Rationale keeps the "because …"; title stops before it.
    expect(agent?.rationale).toContain("because the fixture must run");
    expect(agent?.title).not.toContain("because");
    expect(agent?.messageId).toBe("a-004");

    const creator = decisions.find((d) => d.origin === "creator");
    expect(creator?.title).toContain("bearer tokens instead of session cookies");
    expect(creator?.messageId).toBe("u-002");

    // Discussing a decision is not making one.
    const quoted = extractDecisions({
      ...session,
      messages: [
        {
          id: "m-q",
          role: "assistant",
          timestamp: null,
          text: 'The transcript contains "I chose Postgres over Redis for the queue" as a claim.',
        },
        {
          id: "m-q2",
          role: "user",
          timestamp: null,
          // The decision phrase starts MID-quote — parity, not lookback, catches it.
          text: 'Earlier you noted "as I said, lets go with Redis for caching" but ignore that.',
        },
      ],
    });
    expect(quoted).toHaveLength(0);
  });

  it("rejects conversational wants — talking is not deciding", async () => {
    const session = await parseSessionFile(FIXTURE, redactor);
    const decisions = extractDecisions({
      ...session,
      messages: [
        { id: "t1", role: "user" as const, timestamp: null, text: "i want to read it" },
        { id: "t2", role: "user" as const, timestamp: null, text: "I want to ask you a serious question about the future" },
        { id: "t3", role: "user" as const, timestamp: null, text: "i want to go through some checks with you" },
        {
          id: "t4",
          role: "user" as const,
          timestamp: null,
          text: "I want to replace the session store with signed JWTs across the api",
        },
      ],
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.messageId).toBe("t4");
  });

  it("extracts candidate claims from assistant messages with refs", async () => {
    const session = await parseSessionFile(FIXTURE, redactor);
    const claims = extractClaims(session);
    const texts = claims.map((c) => c.text);
    expect(texts.some((t) => /rate limiting/i.test(t))).toBe(true);
    expect(texts.some((t) => /bearer-token auth/i.test(t))).toBe(true);
    for (const claim of claims) {
      expect(claim.sessionId).toBe("fixture-session-01");
      expect(claim.messageId).toMatch(/^a-/);
    }
  });
});
